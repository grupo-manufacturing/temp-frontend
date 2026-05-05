const API = 'https://temp-backend-idyb.onrender.com';
const INSTAGRAM_OAUTH_URL =
  'https://www.instagram.com/oauth/authorize?force_reauth=true&client_id=1438252244655087&redirect_uri=https://temp-backend-idyb.onrender.com/auth/instagram/callback&response_type=code&scope=instagram_business_basic%2Cinstagram_business_manage_messages%2Cinstagram_business_manage_comments%2Cinstagram_business_content_publish%2Cinstagram_business_manage_insights';

let poller = null;
let isInstagramConnected = false;
let currentStep = 1;
const TOTAL_STEPS = 5;

let inboxRows = [];
let selectedThreadId = null;

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

function normalizeMessage(raw) {
  if (raw && typeof raw === 'object' && raw.threadUserId) {
    return {
      threadUserId: String(raw.threadUserId),
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
  if (el) el.textContent = text;
}

function updateFlowProgress(step) {
  var label = document.getElementById('flow-progress');
  if (label) {
    label.textContent = step + ' / ' + TOTAL_STEPS;
  }
  var bar = document.getElementById('track-fill');
  if (bar) {
    bar.style.width = ((step - 1) / (TOTAL_STEPS - 1) * 100) + '%';
  }
  var wrap = document.getElementById('progress-bar');
  if (wrap) wrap.setAttribute('aria-valuenow', String(step));
}

function updateComposerState() {
  var ta = document.getElementById('reply-input');
  var btn = document.getElementById('reply-send');
  var ok = Boolean(selectedThreadId);
  if (ta) {
    ta.disabled = !ok;
    ta.placeholder = ok ? 'Write a reply…' : 'Select a chat to reply…';
  }
  if (btn) btn.disabled = !ok;
}

function renderInboxUi() {
  var listEl = document.getElementById('thread-list');
  var chatEl = document.getElementById('chat-stream');
  if (!listEl || !chatEl) return;

  var grouped = groupThreads(inboxRows);
  var order = grouped.order;
  var by = grouped.by;

  if (!order.length) {
    listEl.innerHTML = '<p class="muted" style="font-size:0.8125rem;padding:0.35rem 0;">No conversations yet.</p>';
    selectedThreadId = null;
    chatEl.innerHTML = '<div class="chat-empty">Nothing to show.</div>';
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
      var active = tid === selectedThreadId ? ' is-active' : '';
      return (
        '<button type="button" class="thread-pick' +
        active +
        '" data-thread-id="' +
        escapeHtmlAttr(tid) +
        '">' +
        safeText(shortId(tid)) +
        '<span class="thread-pick-preview">' +
        safeText(prev || '(empty)') +
        '</span></button>'
      );
    })
    .join('');

  var stream = selectedThreadId && by[selectedThreadId] ? by[selectedThreadId] : [];
  if (!stream.length) {
    chatEl.innerHTML = '<div class="chat-empty">Nothing to show.</div>';
  } else {
    chatEl.innerHTML = stream
      .map(function (msg) {
        var cls = msg.direction === 'out' ? 'bubble bubble-out' : 'bubble bubble-in';
        return '<div class="' + cls + '">' + safeText(msg.text) + '</div>';
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

function showStep(step) {
  var safeStep = Math.max(1, Math.min(TOTAL_STEPS, step));
  if (safeStep >= 3 && !isInstagramConnected) {
    currentStep = 1;
  } else {
    currentStep = safeStep;
  }

  if (currentStep === 1) {
    setInstagramLoading(false);
  }

  document.querySelectorAll('.flow-step').forEach(function (node) {
    var isActive = Number(node.getAttribute('data-step')) === currentStep;
    node.classList.toggle('is-active', isActive);
  });
  updateFlowProgress(currentStep);

  if (currentStep === 4 && isInstagramConnected) {
    refreshMessages();
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

window.addEventListener('message', function (event) {
  var payload = typeof event.data === 'object' ? event.data : null;
  if (payload && payload.type === 'INSTAGRAM_BUSINESS_LOGIN') {
    if (payload.status === 'success') {
      setInstagramConnected(payload.data || {});
      showStep(3);
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
  document.getElementById('ig-user-id').textContent = info.igUserId || '—';
  document.getElementById('ig-username').textContent = info.igUsername || '—';
  var btn = document.getElementById('connect-instagram-btn');
  if (btn) btn.textContent = 'Reconnect';
  setInstagramStatus('Connected. Webhooks ready.');
  setInstagramLoading(false);
  refreshMessages();
  startMessagePolling();
}

function connectInstagram() {
  clearGlobalMessages();
  showStep(2);
  setInstagramLoading(true, 'Complete login in the popup…');
  setInstagramStatus('Connecting…');

  var popup = window.open(
    INSTAGRAM_OAUTH_URL,
    'instagram_business_login',
    'width=560,height=720,menubar=no,toolbar=no,status=no'
  );

  if (!popup) {
    setInstagramLoading(false);
    setInstagramStatus('Not connected.');
    setError('Pop-up blocked. Allow pop-ups and try again.');
    showStep(1);
    return;
  }

  var watcher = setInterval(function () {
    if (popup.closed) {
      clearInterval(watcher);
      if (!isInstagramConnected) {
        setInstagramLoading(false);
        setInstagramStatus('Not connected.');
      }
    }
  }, 500);
}

function startMessagePolling() {
  if (poller) return;
  poller = setInterval(refreshMessages, 3000);
}

function refreshMessages() {
  if (!isInstagramConnected) return Promise.resolve();

  var listEl = document.getElementById('thread-list');
  var chatEl = document.getElementById('chat-stream');
  if (!listEl || !chatEl) return Promise.resolve();

  setInboxError('');

  return fetch(API + '/messages')
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
      if (!Array.isArray(data)) return;
      data.forEach(function (raw) {
        var n = normalizeMessage(raw);
        if (n) inboxRows.push(n);
      });
      renderInboxUi();
    })
    .catch(function (err) {
      var msg = err.message || String(err);
      if (currentStep === 4) {
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

  fetch(API + '/instagram/send-message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient_id: selectedThreadId, message: text })
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

document.querySelectorAll('[data-next-step]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    showStep(Number(btn.getAttribute('data-next-step')));
  });
});

document.querySelectorAll('[data-prev-step]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    showStep(Number(btn.getAttribute('data-prev-step')));
  });
});

showStep(1);
