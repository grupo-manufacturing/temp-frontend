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
let activeTab = 'home';
let facebookSdkReady = null;
let latestWhatsappSignupSession = null;

let inboxRows = [];
/** threadUserId (IGSID) -> { username, name } | null — from GET /messages */
let threadProfiles = {};
let selectedThreadId = null;
let businessIgUsername = '';
let instagramAccount = { igUserId: '—', igUsername: '—' };
let whatsappAccount = { phoneNumberId: '—', wabaId: '—' };

function participantUsername(tid) {
  var p = threadProfiles[tid];
  if (p && typeof p.username === 'string' && p.username.trim()) {
    return p.username.trim();
  }
  return '';
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

function shortId(id) {
  var s = String(id);
  if (s.length <= 14) return s;
  return s.slice(0, 6) + '…' + s.slice(-6);
}

function truncate(str, max) {
  var t = String(str || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + '…';
}

function formatTimeAgo(timestamp) {
  if (!timestamp) return '';
  var now = Date.now();
  var diff = now - timestamp;
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
  } else {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
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

function setInstagramStatus(text) {
  var el = document.getElementById('instagram-status');
  if (el) {
    // Rebuild with status dot preserved
    var isConnected = isInstagramConnected;
    var isWaiting = !isConnected && text && text.toLowerCase().indexOf('connect') !== -1;
    var dotCls = isConnected ? 'status-dot--on' : isWaiting ? 'status-dot--wait' : 'status-dot--off';
    el.innerHTML = '<span class="status-dot ' + dotCls + '" aria-hidden="true"></span>' + safeText(text);
  }
  // Update badge
  var badge = document.getElementById('ig-badge');
  if (badge) {
    badge.textContent = isInstagramConnected ? 'Connected' : 'Not connected';
    badge.classList.toggle('is-connected', isInstagramConnected);
  }
  // Update card border
  var card = document.getElementById('ig-card');
  if (card) card.classList.toggle('is-connected', isInstagramConnected);
}

function setWhatsappStatus(text) {
  var el = document.getElementById('whatsapp-status');
  if (el) {
    var isConnected = isWhatsappConnected;
    var isWaiting = !isConnected && text && text.toLowerCase().indexOf('connect') !== -1;
    var dotCls = isConnected ? 'status-dot--on' : isWaiting ? 'status-dot--wait' : 'status-dot--off';
    el.innerHTML = '<span class="status-dot ' + dotCls + '" aria-hidden="true"></span>' + safeText(text);
  }
  // Update badge
  var badge = document.getElementById('wa-badge');
  if (badge) {
    badge.textContent = isWhatsappConnected ? 'Connected' : 'Not connected';
    badge.classList.toggle('is-connected', isWhatsappConnected);
  }
  // Update card border
  var card = document.getElementById('wa-card');
  if (card) card.classList.toggle('is-connected', isWhatsappConnected);
}


function isChannelConnected(channel) {
  return channel === 'whatsapp' ? isWhatsappConnected : isInstagramConnected;
}


function updateComposerState() {
  var ta = document.getElementById('reply-input');
  var btn = document.getElementById('reply-send');
  var ok = Boolean(selectedThreadId) && isChannelConnected(activeChannel);
  var who = activeChannel === 'instagram' && businessIgUsername ? '@' + businessIgUsername : 'your account';
  
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
    // Update button styling based on active channel
    btn.className = 'btn-send-reply' + (activeChannel === 'whatsapp' && ok ? ' whatsapp-style' : '');
  }
}

function updateInboxChrome() {
  var bar = document.getElementById('inbox-signed-in');
  var h = document.getElementById('inbox-business-handle');
  var hint = document.getElementById('channel-hint');
  if (bar && h) {
    if (activeChannel === 'instagram' && businessIgUsername) {
      h.textContent = '@' + businessIgUsername;
      bar.removeAttribute('hidden');
    } else {
      bar.setAttribute('hidden', '');
    }
  }
  if (hint) {
    hint.textContent =
      activeChannel === 'instagram'
        ? '24h reply window · Instagram rules'
        : '24h service window · WhatsApp rules';
  }
}

// Tab Management
function switchTab(tabName) {
  if (activeTab === tabName) return;
  
  activeTab = tabName;
  
  // Update sidebar tabs
  document.querySelectorAll('.sidebar-tab').forEach(tab => {
    if (tab.dataset.tab === tabName) {
      tab.classList.add('is-active');
    } else {
      tab.classList.remove('is-active');
    }
  });
  
  // Update tab content
  document.querySelectorAll('.tab-content').forEach(content => {
    if (content.dataset.tab === tabName) {
      content.classList.add('is-active');
    } else {
      content.classList.remove('is-active');
    }
  });
  
  // Special handling for inbox tab
  if (tabName === 'inbox') {
    refreshMessages();
    updateInboxChrome();
  }
  
  // Update connection status displays
  updateConnectionStatusDisplays();
}

function updateConnectionStatusDisplays() {
  // Update home tab status
  updateHomeTabStatus();
  
  // Update integration tab status  
  updateIntegrationTabStatus();
}

function updateHomeTabStatus() {
  var igStatusEl = document.getElementById('ig-status-home');
  var waStatusEl = document.getElementById('wa-status-home');
  
  if (igStatusEl) {
    var igBadge = igStatusEl.querySelector('.status-badge');
    if (igBadge) {
      if (isInstagramConnected) {
        igBadge.textContent = 'Connected';
        igBadge.className = 'status-badge status-badge--connected';
      } else {
        igBadge.textContent = 'Not connected';
        igBadge.className = 'status-badge status-badge--disconnected';
      }
    }
  }
  
  if (waStatusEl) {
    var waBadge = waStatusEl.querySelector('.status-badge');
    if (waBadge) {
      if (isWhatsappConnected) {
        waBadge.textContent = 'Connected';
        waBadge.className = 'status-badge status-badge--connected';
      } else {
        waBadge.textContent = 'Not connected';
        waBadge.className = 'status-badge status-badge--disconnected';
      }
    }
  }
}

function updateIntegrationTabStatus() {
  // Update platform badges in integration tab
  var igBadge = document.getElementById('ig-badge');
  var waBadge = document.getElementById('wa-badge');
  
  if (igBadge) {
    if (isInstagramConnected) {
      igBadge.textContent = 'Connected';
      igBadge.className = 'platform-badge platform-badge--connected';
    } else {
      igBadge.textContent = 'Not connected';
      igBadge.className = 'platform-badge';
    }
  }
  
  if (waBadge) {
    if (isWhatsappConnected) {
      waBadge.textContent = 'Connected';
      waBadge.className = 'platform-badge platform-badge--connected';
    } else {
      waBadge.textContent = 'Not connected';
      waBadge.className = 'platform-badge';
    }
  }
  
  // Show/hide account section
  var accountSection = document.getElementById('account-section');
  if (accountSection) {
    if (isInstagramConnected || isWhatsappConnected) {
      accountSection.removeAttribute('hidden');
      updateAccountDetails();
    } else {
      accountSection.setAttribute('hidden', '');
    }
  }
}

function updateAccountDetails() {
  var label1 = document.getElementById('account-field-label-1');
  var label2 = document.getElementById('account-field-label-2');
  var value1 = document.getElementById('account-field-value-1');
  var value2 = document.getElementById('account-field-value-2');
  
  // Debug logging
  console.log('Updating account details:', {
    isInstagramConnected: isInstagramConnected,
    isWhatsappConnected: isWhatsappConnected,
    instagramAccount: instagramAccount,
    whatsappAccount: whatsappAccount
  });
  
  // Show details for the most recently connected or both if both are connected
  if (isWhatsappConnected && isInstagramConnected) {
    // Show WhatsApp if both are connected (most recent setup)
    if (label1) label1.textContent = 'Phone Number ID';
    if (label2) label2.textContent = 'WABA ID';
    if (value1) value1.textContent = whatsappAccount.phoneNumberId || '—';
    if (value2) value2.textContent = whatsappAccount.wabaId || '—';
  } else if (isWhatsappConnected) {
    if (label1) label1.textContent = 'Phone Number ID';
    if (label2) label2.textContent = 'WABA ID';
    if (value1) value1.textContent = whatsappAccount.phoneNumberId || '—';
    if (value2) value2.textContent = whatsappAccount.wabaId || '—';
  } else if (isInstagramConnected) {
    if (label1) label1.textContent = 'User ID';
    if (label2) label2.textContent = 'Username';
    if (value1) value1.textContent = instagramAccount.igUserId || '—';
    if (value2) value2.textContent = instagramAccount.igUsername || '—';
  }
}

function renderInboxUi() {
  var listEl = document.getElementById('thread-list');
  var chatEl = document.getElementById('chat-stream');
  var headerEl = document.getElementById('inbox-chat-header');
  if (!listEl || !chatEl) return;

  updateInboxChrome();

  if (!isChannelConnected(activeChannel)) {
    selectedThreadId = null;
    listEl.innerHTML = '<div class="empty-state"><div class="empty-state-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M8 2v3m8-3v3m-9 8h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v6a2 2 0 002 2z" stroke="currentColor" stroke-width="2"/></svg></div><div class="empty-state-title">Channel not connected</div></div>';
    if (headerEl) headerEl.innerHTML = '';
    chatEl.innerHTML =
      '<div class="empty-state">' +
      '<div class="empty-state-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none"><path d="M8 2v3m8-3v3m-9 8h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v6a2 2 0 002 2z" stroke="currentColor" stroke-width="1.5"/></svg></div>' +
      '<div class="empty-state-title">Connect ' + safeText(activeChannel === 'whatsapp' ? 'WhatsApp' : 'Instagram') + '</div>' +
      '<div class="empty-state-desc">Connect your ' + safeText(activeChannel) + ' account to start messaging from this inbox.</div>' +
      '<button type="button" class="connect-channel-btn" id="inbox-connect-channel" onclick="switchTab(\'integration\')">Go to Integration</button>' +
      '</div>';
    updateComposerState();
    return;
  }

  var grouped = groupThreads(inboxRows);
  var order = grouped.order;
  var by = grouped.by;

  if (!order.length) {
    listEl.innerHTML = '<div class="empty-state"><div class="empty-state-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="currentColor" stroke-width="1.5"/></svg></div><div class="empty-state-title">No conversations</div></div>';
    selectedThreadId = null;
    if (headerEl) headerEl.innerHTML = '';
    chatEl.innerHTML = '<div class="empty-state"><div class="empty-state-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="currentColor" stroke-width="1.5"/></svg></div><div class="empty-state-title">No conversations yet</div><div class="empty-state-desc">When someone messages your ' + safeText(activeChannel) + ' account, conversations will appear here.</div></div>';
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
      var uname = participantUsername(tid);
      var nameLine = uname ? '@' + safeText(uname) : (activeChannel === 'instagram' ? 'Instagram User' : 'WhatsApp User');
      var avatarText = uname ? safeText(uname.charAt(0).toUpperCase()) : (activeChannel === 'instagram' ? 'IG' : 'WA');
      var avatarClass = activeChannel === 'whatsapp' ? 'thread-avatar whatsapp-avatar' : 'thread-avatar';
      var timeAgo = msgs.length ? formatTimeAgo(msgs[msgs.length - 1].at) : '';
      
      return (
        '<div class="thread-item' +
        active + 
        channelClass +
        '" data-thread-id="' +
        escapeHtmlAttr(tid) +
        '">' +
        '<div class="' + avatarClass + '">' +
        avatarText +
        '</div>' +
        '<div class="thread-content">' +
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
        '</div>'
      );
    })
    .join('');

  if (headerEl && selectedThreadId) {
    var hu = participantUsername(selectedThreadId);
    var nameLine = hu ? '@' + safeText(hu) : (activeChannel === 'instagram' ? 'Instagram User' : 'WhatsApp User');
    var avatarText = hu ? safeText(hu.charAt(0).toUpperCase()) : (activeChannel === 'instagram' ? 'IG' : 'WA');
    var statusText = 'Active on ' + (activeChannel === 'instagram' ? 'Instagram' : 'WhatsApp');
    
    headerEl.innerHTML =
      '<div class="chat-header-avatar">' +
      avatarText +
      '</div>' +
      '<div class="chat-header-info">' +
      '<div class="chat-header-name">' +
      nameLine +
      '</div>' +
      '<div class="chat-header-status">' +
      statusText +
      '</div>' +
      '</div>';
  } else if (headerEl) {
    headerEl.innerHTML = '';
  }

  var stream = selectedThreadId && by[selectedThreadId] ? by[selectedThreadId] : [];
  if (!stream.length) {
    chatEl.innerHTML = '<div class="empty-state"><div class="empty-state-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="currentColor" stroke-width="1.5"/></svg></div><div class="empty-state-title">Start the conversation</div><div class="empty-state-desc">Send a message to begin chatting</div></div>';
  } else {
    chatEl.innerHTML = stream
      .map(function (msg) {
        var isOut = msg.direction === 'out';
        var channelClass = activeChannel === 'whatsapp' ? ' channel-whatsapp' : '';
        var messageClass = 'chat-message chat-message--' + (isOut ? 'out' : 'in') + channelClass;
        var timeFormatted = formatMessageTime(msg.at);
        
        return (
          '<div class="' + messageClass + '">' +
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

// Initialize app on page load
function initializeApp() {
  // Set up tab navigation
  document.querySelectorAll('.sidebar-tab').forEach(tab => {
    tab.addEventListener('click', function() {
      switchTab(this.dataset.tab);
    });
  });
  
  // Set up channel tabs in inbox
  document.querySelectorAll('.channel-tab').forEach(tab => {
    tab.addEventListener('click', function() {
      switchChannel(this.dataset.channel);
    });
  });
  
  // Initialize with home tab
  switchTab('home');
  
  // Update initial connection status
  updateConnectionStatusDisplays();
}

function switchChannel(channel) {
  if (activeChannel === channel) return;
  
  activeChannel = channel;
  
  // Update channel tab UI
  document.querySelectorAll('.channel-tab').forEach(tab => {
    if (tab.dataset.channel === channel) {
      tab.classList.add('is-active');
      tab.setAttribute('aria-selected', 'true');
    } else {
      tab.classList.remove('is-active');
      tab.setAttribute('aria-selected', 'false');
    }
  });
  
  // Refresh inbox for new channel
  if (activeTab === 'inbox') {
    renderInboxUi();
    updateComposerState();
    updateInboxChrome();
  }
}

function setInstagramLoading(loading, text) {
  var row = document.getElementById('instagram-loading');
  var lbl = document.getElementById('instagram-loading-text');
  if (!row) return;
  if (lbl && text) lbl.textContent = text;
  if (loading) {
    row.removeAttribute('hidden');
  } else {
    row.setAttribute('hidden', '');
  }
}

function setError(msg) {
  var el = document.getElementById('global-error');
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.removeAttribute('hidden');
  } else {
    el.setAttribute('hidden', '');
  }
}

function clearGlobalMessages() {
  setError('');
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
  if (event.origin && !String(event.origin).endsWith('facebook.com')) {
    // ignore non-Meta session messages here; Instagram callback uses a direct postMessage payload below
  } else {
    try {
      var wa = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      if (wa && wa.type === 'WA_EMBEDDED_SIGNUP') {
        latestWhatsappSignupSession = wa.data || null;
      }
    } catch (_) {
      /* ignore parse errors from unrelated sdk messages */
    }
  }

  var payload = typeof event.data === 'object' ? event.data : null;
  if (payload && payload.type === 'INSTAGRAM_BUSINESS_LOGIN') {
    if (payload.status === 'success') {
      setInstagramConnected(payload.data || {});
    } else {
      setInstagramLoading(false);
      setInstagramStatus('Not connected.');
      setError(payload.error || 'Authorization failed.');
      showStep(1);
    }
  }
});

function setInstagramConnected(info) {
  isInstagramConnected = true;
  businessIgUsername = info.igUsername ? String(info.igUsername) : '';
  instagramAccount.igUserId = info.igUserId || '—';
  instagramAccount.igUsername = info.igUsername || '—';
  var btn = document.getElementById('connect-instagram-btn');
  if (btn) btn.textContent = 'Reconnect';
  setInstagramStatus('Connected. Webhooks ready.');
  activeChannel = 'instagram';
  // Account details will be updated by updateConnectionStatusDisplays
  // Switch to integration tab to show account details
  switchTab('integration');
  updateConnectionStatusDisplays();
  refreshMessages();
  startMessagePolling();
}

function connectInstagram() {
  clearGlobalMessages();
  setInstagramStatus('Connecting…');

  var popup = window.open(
    INSTAGRAM_OAUTH_URL,
    'instagram_business_login',
    'width=560,height=720,menubar=no,toolbar=no,status=no'
  );

  if (!popup) {
    setInstagramStatus('Not connected.');
    setError('Pop-up blocked. Allow pop-ups and try again.');
    return;
  }

  var watcher = setInterval(function () {
    if (popup.closed) {
      clearInterval(watcher);
      if (!isInstagramConnected) {
        setInstagramStatus('Not connected.');
      }
    }
  }, 500);
}

function connectWhatsapp() {
  clearGlobalMessages();
  setWhatsappStatus('Connecting…');
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
      whatsappAccount.wabaId = (result && result.whatsapp && result.whatsapp.waba_id) || '—';
      activeChannel = 'whatsapp';
      setWhatsappStatus('Connected. Webhooks ready.');
      var btn = document.getElementById('connect-whatsapp-btn');
      if (btn) btn.textContent = 'Reconnect WhatsApp';
      
      // Switch to integration tab to show account details
      switchTab('integration');
      updateConnectionStatusDisplays();
      
      // Update channel selection
      switchChannel('whatsapp');
      
      startMessagePolling();
      refreshMessages();
    })
    .catch(function (err) {
      setWhatsappStatus('Not connected.');
      setError(err.message || String(err));
    });
}

function startMessagePolling() {
  if (poller) return;
  poller = setInterval(refreshMessages, 3000);
}

function refreshMessages() {
  if (!isInstagramConnected && !isWhatsappConnected) return Promise.resolve();
  if (!isChannelConnected(activeChannel)) {
    inboxRows = [];
    renderInboxUi();
    return Promise.resolve();
  }

  var listEl = document.getElementById('thread-list');
  var chatEl = document.getElementById('chat-stream');
  if (!listEl || !chatEl) return Promise.resolve();

  setInboxError('');

  return fetch(API + '/messages?tenant_id=' + encodeURIComponent(TENANT_ID) + '&channel=' + encodeURIComponent(activeChannel))
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
      if (activeTab === 'inbox') {
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

document.getElementById('chat-stream').addEventListener('click', function (e) {
  var btn = e.target.closest('#inbox-connect-channel');
  if (!btn) return;
  if (activeChannel === 'whatsapp') {
    connectWhatsapp();
  } else {
    connectInstagram();
  }
});

document.getElementById('reply-send').addEventListener('click', sendReply);

document.querySelectorAll('[data-channel]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    activeChannel = btn.getAttribute('data-channel') === 'whatsapp' ? 'whatsapp' : 'instagram';
    document.querySelectorAll('[data-channel]').forEach(function (b) {
      b.classList.toggle('is-active', b === btn);
    });
    selectedThreadId = null;
    // Account details are handled automatically by updateConnectionStatusDisplays
    refreshMessages();
  });
});

document.getElementById('reply-input').addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendReply();
  }
});

// Initialize the application
initializeApp();