const API = 'https://temp-backend-idyb.onrender.com';
const INSTAGRAM_OAUTH_URL =
  'https://www.instagram.com/oauth/authorize?force_reauth=true&client_id=1438252244655087&redirect_uri=https://temp-backend-idyb.onrender.com/auth/instagram/callback&response_type=code&scope=instagram_business_basic%2Cinstagram_business_manage_messages';
const META_APP_ID = '1339299584731362';
const WHATSAPP_EMBEDDED_CONFIG_ID = '865515573285412';
const GRAPH_API_VERSION = 'v25.0';
const TENANT_ID = 'default';

let poller = null;
let isInstagramConnected = false;
let isWhatsappConnected = false;
let activeChannel = 'instagram';
let currentView = 'home';
let facebookSdkReady = null;
let latestWhatsappSignupSession = null;

let inboxRows = [];
/** threadUserId (IGSID) -> { username, name } | null — from GET /messages */
let threadProfiles = {};
let selectedThreadId = null;
let instagramAccount = { igUserId: '—', igUsername: '—' };
let whatsappAccount = { phoneNumberId: '—', wabaId: '—' };
/** Where to navigate after IG / WhatsApp onboarding completes (`inbox` or `connected`). */
let oauthLanding = 'connected';

function participantUsername(tid) {
  var p = threadProfiles[tid];
  if (p && typeof p.username === 'string' && p.username.trim()) {
    return p.username.trim();
  }
  return '';
}

function threadDisplayLabel(tid, channel) {
  var label = participantUsername(tid);
  if (!label) {
    return channel === 'instagram' ? 'Instagram User' : 'WhatsApp User';
  }
  if (channel === 'instagram') {
    return '@' + label;
  }
  return label;
}

function threadAvatarInitial(tid, channel) {
  var label = participantUsername(tid);
  if (!label) {
    return channel === 'instagram' ? 'IG' : 'WA';
  }
  if (channel === 'whatsapp') {
    var digitsOnly = /^[\d\s+().-]+$/.test(label.trim());
    if (digitsOnly) {
      var d = label.replace(/\D/g, '');
      if (d.length >= 1) return d.slice(-1);
    }
    return String(label).charAt(0).toUpperCase();
  }
  return String(label).charAt(0).toUpperCase();
}

function safeText(value) {
  return String(value == null ? '' : value).replace(/</g, '&lt;');
}

function escapeHtmlAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function truncate(str, max) {
  var t = String(str || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + '…';
}

function formatTimeAgo(timestamp) {
  if (!timestamp) return '';
  var diff = Date.now() - timestamp;
  var minutes = Math.floor(diff / 60000);
  var hours = Math.floor(diff / 3600000);
  var days = Math.floor(diff / 86400000);
  if (days > 0) return days + 'd';
  if (hours > 0) return hours + 'h';
  if (minutes > 0) return minutes + 'm';
  return 'now';
}

function formatMessageTime(timestamp) {
  if (!timestamp) return '';
  var date = new Date(timestamp);
  var now = new Date();
  var isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function normalizeMessage(raw) {
  if (raw && typeof raw === 'object' && raw.threadUserId) {
    return {
      threadUserId: String(raw.threadUserId),
      channel: raw.channel === 'whatsapp' ? 'whatsapp' : 'instagram',
      direction: raw.direction === 'out' ? 'out' : 'in',
      text: String(raw.text != null ? raw.text : ''),
      at: typeof raw.at === 'number' ? raw.at : 0
    };
  }
  var s = String(raw || '');
  var m = /^\[IG:([^\]]+)\]\s*([\s\S]+)$/.exec(s);
  if (m) {
    return {
      threadUserId: m[1],
      channel: 'instagram',
      direction: 'in',
      text: m[2],
      at: 0
    };
  }
  return null;
}

function groupThreads(rows) {
  var by = {};
  rows.forEach(function (msg) {
    if ((msg.channel || 'instagram') !== activeChannel) return;
    if (!by[msg.threadUserId]) by[msg.threadUserId] = [];
    by[msg.threadUserId].push(msg);
  });
  Object.keys(by).forEach(function (tid) {
    by[tid].sort(function (a, b) {
      return (a.at || 0) - (b.at || 0);
    });
  });
  var ids = Object.keys(by);
  ids.sort(function (a, b) {
    function last(atid) {
      var arr = by[atid];
      var lastAt = 0;
      arr.forEach(function (x) {
        if ((x.at || 0) > lastAt) lastAt = x.at || 0;
      });
      return lastAt;
    }
    return last(b) - last(a);
  });
  return { by: by, order: ids };
}

function syncInboxChannelAttr() {
  var inbox = document.getElementById('view-inbox');
  if (inbox) inbox.setAttribute('data-active-channel', activeChannel);
}

function refreshInboxConnectActions() {
  var wrap = document.getElementById('inbox-connect-actions');
  if (!wrap) return;
  if (currentView !== 'inbox') {
    wrap.innerHTML = '';
    wrap.hidden = true;
    return;
  }
  var needIg = !isInstagramConnected;
  var needWa = !isWhatsappConnected;
  if (!needIg && !needWa) {
    wrap.innerHTML = '';
    wrap.hidden = true;
    return;
  }
  var html = '<span class="inbox-add-label">Add channel</span>';
  if (needIg) {
    html +=
      '<button type="button" class="inbox-connect-btn inbox-connect-btn--ig" data-connect="instagram">＋ Instagram</button>';
  }
  if (needWa) {
    html +=
      '<button type="button" class="inbox-connect-btn inbox-connect-btn--wa" data-connect="whatsapp">＋ WhatsApp</button>';
  }
  wrap.innerHTML = html;
  wrap.hidden = false;
}

function resolveOAuthLanding() {
  updateConnectedPanels();
  var landing = oauthLanding;
  oauthLanding = 'connected';
  if (landing === 'inbox') {
    showView('inbox');
  } else {
    showView('connected');
    refreshMessages();
  }
}

function showView(name) {
  currentView = name;
  var home = document.getElementById('view-home');
  var conn = document.getElementById('view-connected');
  var inbox = document.getElementById('view-inbox');
  if (home) home.hidden = name !== 'home';
  if (conn) conn.hidden = name !== 'connected';
  if (inbox) inbox.hidden = name !== 'inbox';
  if (name === 'inbox') {
    syncInboxChannelAttr();
    updateInboxChannelSwitch();
    refreshMessages();
  }
  refreshInboxConnectActions();
}

function leaveInbox() {
  setInboxError('');
  if (isInstagramConnected || isWhatsappConnected) {
    showView('connected');
  } else {
    showView('home');
  }
}

function goToInbox() {
  if (!isInstagramConnected && !isWhatsappConnected) return;
  if (isInstagramConnected && !isWhatsappConnected) {
    activeChannel = 'instagram';
  } else if (!isInstagramConnected && isWhatsappConnected) {
    activeChannel = 'whatsapp';
  }
  updateInboxChannelSwitch();
  showView('inbox');
}

function updateConnectedPanels() {
  var igPanel = document.getElementById('panel-instagram');
  var waPanel = document.getElementById('panel-whatsapp');
  var goBtn = document.getElementById('btn-go-inbox');

  if (igPanel) {
    if (isInstagramConnected) {
      igPanel.hidden = false;
      var uid = document.getElementById('ig-value-user-id');
      var uname = document.getElementById('ig-value-username');
      if (uid) uid.textContent = instagramAccount.igUserId || '—';
      if (uname) uname.textContent = instagramAccount.igUsername || '—';
    } else {
      igPanel.hidden = true;
    }
  }

  if (waPanel) {
    if (isWhatsappConnected) {
      waPanel.hidden = false;
      var pid = document.getElementById('wa-value-phone-id');
      var wid = document.getElementById('wa-value-waba-id');
      if (pid) pid.textContent = whatsappAccount.phoneNumberId || '—';
      if (wid) wid.textContent = whatsappAccount.wabaId || '—';
    } else {
      waPanel.hidden = true;
    }
  }

  if (goBtn) {
    goBtn.disabled = !isInstagramConnected && !isWhatsappConnected;
  }
}

function updateInboxChannelSwitch() {
  var wrap = document.getElementById('inbox-channel-switch');
  if (!wrap) return;
  var both = isInstagramConnected && isWhatsappConnected;
  if (both) {
    wrap.hidden = false;
    wrap.innerHTML =
      '<button type="button" data-channel="instagram" class="' +
      (activeChannel === 'instagram' ? 'is-active' : '') +
      '">Instagram</button>' +
      '<button type="button" data-channel="whatsapp" class="' +
      (activeChannel === 'whatsapp' ? 'is-active' : '') +
      '">WhatsApp</button>';
  } else {
    wrap.hidden = true;
    wrap.innerHTML = '';
    if (isInstagramConnected) activeChannel = 'instagram';
    else if (isWhatsappConnected) activeChannel = 'whatsapp';
  }
  if (currentView === 'inbox') syncInboxChannelAttr();
}

function isChannelConnected(channel) {
  return channel === 'whatsapp' ? isWhatsappConnected : isInstagramConnected;
}

function updateComposerState() {
  var ta = document.getElementById('reply-input');
  var btn = document.getElementById('reply-send');
  var ok = Boolean(selectedThreadId) && isChannelConnected(activeChannel);

  if (ta) {
    ta.disabled = !ok;
    ta.placeholder = ok
      ? 'Type a message…'
      : isChannelConnected(activeChannel)
        ? 'Select a conversation…'
        : 'Connect ' + activeChannel + ' to send messages…';
  }

  if (btn) {
    btn.disabled = !ok;
  }
}

function switchChannel(channel) {
  if (activeChannel === channel) return;
  activeChannel = channel;
  selectedThreadId = null;
  syncInboxChannelAttr();
  updateInboxChannelSwitch();
  if (currentView === 'inbox') {
    refreshMessages();
  }
}

function renderInboxUi() {
  var listEl = document.getElementById('thread-list');
  var chatEl = document.getElementById('chat-stream');
  var headerEl = document.getElementById('inbox-chat-header');
  if (!listEl || !chatEl) return;

  if (!isChannelConnected(activeChannel)) {
    selectedThreadId = null;
    listEl.innerHTML =
      '<div class="empty-state">This channel is not linked yet. Use Add channel in the header, or go Home via Back.</div>';
    if (headerEl) headerEl.textContent = '';
    chatEl.innerHTML =
      '<div class="empty-state"><p>Use Add channel in the header to link Instagram or WhatsApp without leaving Inbox.</p>' +
      '<button type="button" class="btn btn-block" style="margin-top:0.75rem;max-width:200px;">Back to home</button></div>';
    var backBtn = chatEl.querySelector('button');
    if (backBtn) {
      backBtn.addEventListener('click', function () {
        showView('home');
      });
    }
    updateComposerState();
    return;
  }

  var grouped = groupThreads(inboxRows);
  var order = grouped.order;
  var by = grouped.by;

  if (!order.length) {
    listEl.innerHTML =
      '<div class="empty-state">No conversations yet</div>';
    selectedThreadId = null;
    if (headerEl) headerEl.textContent = '';
    chatEl.innerHTML =
      '<div class="empty-state">When someone messages you, threads will appear in the column on the left.</div>';
    updateComposerState();
    return;
  }

  if (selectedThreadId && !by[selectedThreadId]) {
    selectedThreadId = order[0] || null;
  }
  if (!selectedThreadId) {
    selectedThreadId = order[0];
  }

  listEl.innerHTML = order
    .map(function (tid) {
      var msgs = by[tid];
      var lastText = msgs.length ? msgs[msgs.length - 1].text : '';
      var prev = truncate(lastText, 48);
      var active = tid === selectedThreadId ? ' is-selected' : '';
      var channelClass = activeChannel === 'whatsapp' ? ' channel-whatsapp' : '';
      var nameLine = safeText(threadDisplayLabel(tid, activeChannel));
      var avatarText = safeText(threadAvatarInitial(tid, activeChannel));
      var timeAgo = msgs.length ? formatTimeAgo(msgs[msgs.length - 1].at) : '';

      return (
        '<div class="thread-item' +
        active +
        channelClass +
        '" data-thread-id="' +
        escapeHtmlAttr(tid) +
        '">' +
        '<div class="thread-item-inner">' +
        '<div class="thread-avatar">' +
        avatarText +
        '</div>' +
        '<div class="thread-body">' +
        '<div class="thread-meta">' +
        '<div class="thread-name">' +
        nameLine +
        '</div>' +
        '<div class="thread-time">' +
        safeText(timeAgo) +
        '</div>' +
        '</div>' +
        '<div class="thread-preview">' +
        safeText(prev || 'No messages yet') +
        '</div>' +
        '</div>' +
        '</div>' +
        '</div>'
      );
    })
    .join('');

  if (headerEl && selectedThreadId) {
    headerEl.textContent = threadDisplayLabel(selectedThreadId, activeChannel);
  } else if (headerEl) {
    headerEl.textContent = '';
  }

  var stream = selectedThreadId && by[selectedThreadId] ? by[selectedThreadId] : [];
  if (!stream.length) {
    chatEl.innerHTML =
      '<div class="empty-state">No messages in this conversation yet.</div>';
  } else {
    chatEl.innerHTML = stream
      .map(function (msg) {
        var isOut = msg.direction === 'out';
        var channelClass = activeChannel === 'whatsapp' ? ' channel-whatsapp' : '';
        var messageClass =
          'chat-message chat-message--' + (isOut ? 'out' : 'in') + channelClass;
        var timeFormatted = formatMessageTime(msg.at);

        return (
          '<div class="' +
          messageClass +
          '">' +
          '<div class="message-bubble">' +
          safeText(msg.text) +
          '</div>' +
          '<div class="message-time">' +
          safeText(timeFormatted) +
          '</div>' +
          '</div>'
        );
      })
      .join('');
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  updateComposerState();
}

function setInboxError(msg) {
  var el = document.getElementById('inbox-error');
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.removeAttribute('hidden');
  } else {
    el.setAttribute('hidden', '');
  }
}

function setError(msg) {
  ['global-error', 'global-error-connected'].forEach(function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.removeAttribute('hidden');
    } else {
      el.textContent = '';
      el.setAttribute('hidden', '');
    }
  });
}

function clearGlobalMessages() {
  setError('');
}

function initializeApp() {
  var wrap = document.getElementById('inbox-channel-switch');
  if (wrap) {
    wrap.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-channel]');
      if (!btn || !wrap.contains(btn)) return;
      switchChannel(btn.getAttribute('data-channel'));
    });
  }

  var top = document.getElementById('inbox-top');
  if (top) {
    top.addEventListener('click', function (e) {
      var addBtn = e.target.closest('[data-connect]');
      if (!addBtn || !top.contains(addBtn)) return;
      var p = addBtn.getAttribute('data-connect');
      if (p === 'instagram') connectInstagram();
      else if (p === 'whatsapp') connectWhatsapp();
    });
  }

  showView('home');
  updateConnectedPanels();
}

function ensureFacebookSdk() {
  if (window.FB) return Promise.resolve(window.FB);
  if (facebookSdkReady) return facebookSdkReady;
  facebookSdkReady = new Promise(function (resolve, reject) {
    window.fbAsyncInit = function () {
      window.FB.init({
        appId: META_APP_ID,
        autoLogAppEvents: true,
        xfbml: true,
        version: GRAPH_API_VERSION
      });
      resolve(window.FB);
    };
    var script = document.createElement('script');
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.onerror = function () {
      reject(new Error('Failed to load Facebook SDK'));
    };
    document.head.appendChild(script);
  });
  return facebookSdkReady;
}

function completeWhatsappSignup(code) {
  return fetch(API + '/whatsapp/embedded-signup/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenant_id: TENANT_ID,
      code: code,
      session_info: latestWhatsappSignupSession || {}
    })
  }).then(function (res) {
    return res.text().then(function (raw) {
      var data = null;
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch (_) {
          data = null;
        }
      }
      if (!res.ok) {
        if (res.status === 404) {
          throw new Error(
            'Backend route /whatsapp/embedded-signup/complete not found. Deploy latest backend before retrying.'
          );
        }
        throw new Error(
          (data && data.error) ||
            (raw && raw.slice(0, 140)) ||
            'WhatsApp onboarding failed'
        );
      }
      if (!data || typeof data !== 'object') {
        throw new Error('Unexpected backend response while completing WhatsApp signup.');
      }
      return data;
    });
  });
}

window.addEventListener('message', function (event) {
  var allowWa = !event.origin || String(event.origin).endsWith('facebook.com');
  if (allowWa) {
    try {
      var wa = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      if (wa && wa.type === 'WA_EMBEDDED_SIGNUP') {
        latestWhatsappSignupSession = wa.data || null;
      }
    } catch (_) {}
  }

  var payload = typeof event.data === 'object' ? event.data : null;
  if (payload && payload.type === 'INSTAGRAM_BUSINESS_LOGIN') {
    if (payload.status === 'success') {
      setInstagramConnected(payload.data || {});
    } else {
      var igErr = payload.error || 'Authorization failed.';
      if (currentView === 'inbox') {
        setInboxError(igErr);
      } else {
        setError(igErr);
      }
      var igBtn = document.getElementById('connect-instagram-btn');
      if (igBtn && !isInstagramConnected) igBtn.textContent = 'Connect Instagram';
    }
  }
});

function setInstagramConnected(info) {
  isInstagramConnected = true;
  instagramAccount.igUserId = info.igUserId || '—';
  instagramAccount.igUsername = info.igUsername || '—';

  var btn = document.getElementById('connect-instagram-btn');
  if (btn) btn.textContent = 'Reconnect Instagram';

  activeChannel = 'instagram';
  clearGlobalMessages();
  startMessagePolling();
  resolveOAuthLanding();
}

function connectInstagram() {
  oauthLanding = currentView === 'inbox' ? 'inbox' : 'connected';
  setInboxError('');
  clearGlobalMessages();
  var igBtn = document.getElementById('connect-instagram-btn');
  var igLabel = igBtn ? igBtn.textContent : '';
  if (igBtn && !isInstagramConnected) igBtn.textContent = 'Opening…';

  var popup = window.open(
    INSTAGRAM_OAUTH_URL,
    'instagram_business_login',
    'width=560,height=720,menubar=no,toolbar=no,status=no'
  );

  if (!popup) {
    if (igBtn && !isInstagramConnected) igBtn.textContent = igLabel || 'Connect Instagram';
    var popMsg = 'Pop-up blocked. Allow pop-ups and try again.';
    if (currentView === 'inbox') {
      setInboxError(popMsg);
    } else {
      setError(popMsg);
    }
    return;
  }

  var watcher = setInterval(function () {
    if (popup.closed) {
      clearInterval(watcher);
      if (!isInstagramConnected && igBtn) {
        igBtn.textContent = igLabel || 'Connect Instagram';
      }
    }
  }, 500);
}

function connectWhatsapp() {
  oauthLanding = currentView === 'inbox' ? 'inbox' : 'connected';
  setInboxError('');
  clearGlobalMessages();

  ensureFacebookSdk()
    .then(function (FB) {
      return new Promise(function (resolve, reject) {
        FB.login(
          function (response) {
            if (!response || !response.authResponse || !response.authResponse.code) {
              reject(new Error('WhatsApp Embedded Signup canceled or failed'));
              return;
            }
            resolve(response.authResponse.code);
          },
          {
            config_id: WHATSAPP_EMBEDDED_CONFIG_ID,
            response_type: 'code',
            override_default_response_type: true,
            extras: { setup: {} }
          }
        );
      });
    })
    .then(function (code) {
      return completeWhatsappSignup(code);
    })
    .then(function (result) {
      isWhatsappConnected = true;
      whatsappAccount.phoneNumberId =
        (result && result.whatsapp && result.whatsapp.phone_number_id) || '—';
      whatsappAccount.wabaId =
        (result && result.whatsapp && result.whatsapp.waba_id) || '—';
      activeChannel = 'whatsapp';

      var btn = document.getElementById('connect-whatsapp-btn');
      if (btn) btn.textContent = 'Reconnect WhatsApp';

      clearGlobalMessages();
      startMessagePolling();
      resolveOAuthLanding();
    })
    .catch(function (err) {
      var m = err.message || String(err);
      if (currentView === 'inbox') {
        setInboxError(m);
      } else {
        setError(m);
      }
    });
}

function startMessagePolling() {
  if (poller) return;
  poller = setInterval(refreshMessages, 3000);
}

function refreshMessages() {
  if (!isInstagramConnected && !isWhatsappConnected) {
    renderInboxUi();
    return Promise.resolve();
  }
  if (!isChannelConnected(activeChannel)) {
    inboxRows = [];
    renderInboxUi();
    return Promise.resolve();
  }

  var listEl = document.getElementById('thread-list');
  var chatEl = document.getElementById('chat-stream');
  if (!listEl || !chatEl) return Promise.resolve();

  setInboxError('');

  return fetch(
    API +
      '/messages?tenant_id=' +
      encodeURIComponent(TENANT_ID) +
      '&channel=' +
      encodeURIComponent(activeChannel)
  )
    .then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) {
          throw new Error((data && data.error) || 'Unable to load messages');
        }
        return data;
      });
    })
    .then(function (data) {
      inboxRows = [];
      threadProfiles = {};
      var list = data;
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        if (data.profiles && typeof data.profiles === 'object') {
          threadProfiles = data.profiles;
        }
        list = Array.isArray(data.messages) ? data.messages : [];
      }
      if (!Array.isArray(list)) return;
      list.forEach(function (raw) {
        var n = normalizeMessage(raw);
        if (n) inboxRows.push(n);
      });
      renderInboxUi();
    })
    .catch(function (err) {
      var msg = err.message || String(err);
      if (currentView === 'inbox') {
        setInboxError(msg);
      } else {
        setError('Inbox: ' + msg);
      }
    });
}

function sendReply() {
  var ta = document.getElementById('reply-input');
  var sendBtn = document.getElementById('reply-send');
  if (!selectedThreadId || !ta || !sendBtn) return;

  var text = (ta.value || '').trim();
  if (!text) return;

  setInboxError('');
  sendBtn.disabled = true;

  var isWhatsapp = activeChannel === 'whatsapp';
  var endpoint = isWhatsapp ? '/whatsapp/send-message' : '/instagram/send-message';
  var body = isWhatsapp
    ? { tenant_id: TENANT_ID, to: selectedThreadId, message: text }
    : { recipient_id: selectedThreadId, message: text };

  fetch(API + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
    .then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) {
          var detail =
            (data.details && data.details.error && data.details.error.message) ||
            data.error ||
            'Send failed';
          throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
        }
        return data;
      });
    })
    .then(function () {
      ta.value = '';
      return refreshMessages();
    })
    .catch(function (err) {
      setInboxError(err.message || String(err));
    })
    .finally(function () {
      updateComposerState();
    });
}

document.getElementById('thread-list').addEventListener('click', function (e) {
  var btn = e.target.closest('[data-thread-id]');
  if (!btn) return;
  selectedThreadId = btn.getAttribute('data-thread-id');
  renderInboxUi();
});

document.getElementById('reply-send').addEventListener('click', sendReply);

document.getElementById('reply-input').addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendReply();
  }
});

initializeApp();
