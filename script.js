const API = 'https://temp-backend-idyb.onrender.com';
let poller = null;
let isConnected = false;
let waEmbeddedSession = null;
let currentStep = 1;
const TOTAL_STEPS = 5;

function safeText(value) {
  return String(value == null ? '' : value).replace(/</g, '&lt;');
}

function setStatus(text) {
  document.getElementById('connect-status').textContent = text;
}

function updateFlowProgress(step) {
  const el = document.getElementById('flow-progress');
  if (el) {
    el.innerHTML = '<span class="pill-dot"></span>Step ' + step + ' of ' + TOTAL_STEPS;
  }
  const fill = document.getElementById('track-fill');
  if (fill) {
    fill.style.width = ((step - 1) / (TOTAL_STEPS - 1) * 100) + '%';
  }
  document.querySelectorAll('.track-dot').forEach(function (dot) {
    const n = Number(dot.getAttribute('data-step-dot'));
    dot.classList.remove('active', 'done');
    if (n === step) dot.classList.add('active');
    else if (n < step) dot.classList.add('done');
  });
}

function showStep(step) {
  const safeStep = Math.max(1, Math.min(TOTAL_STEPS, step));
  if (safeStep >= 3 && !isConnected) {
    currentStep = 1;
  } else {
    currentStep = safeStep;
  }

  const steps = document.querySelectorAll('.flow-step');
  steps.forEach(function (node) {
    const isActive = Number(node.getAttribute('data-step')) === currentStep;
    node.classList.toggle('is-active', isActive);
    if (isActive) {
      node.removeAttribute('hidden');
    } else {
      node.setAttribute('hidden', '');
    }
  });
  updateFlowProgress(currentStep);
}

function setOAuthLoading(loading, text) {
  const row = document.getElementById('oauth-loading');
  const label = document.getElementById('oauth-loading-text');
  if (!row) return;
  if (label && text) {
    label.textContent = text;
  }
  if (loading) {
    row.removeAttribute('hidden');
  } else {
    row.setAttribute('hidden', '');
  }
}

function setAlert(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.removeAttribute('hidden');
  } else {
    el.setAttribute('hidden', '');
  }
}

function clearGlobalMessages() {
  setAlert('global-error', '');
  setAlert('global-success', '');
}

function clearSendMessages() {
  setAlert('send-error', '');
  setAlert('send-success', '');
}

window.addEventListener('message', function (event) {
  if (!String(event.origin || '').endsWith('facebook.com')) return;
  let data;
  try {
    data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
  } catch (e) {
    return;
  }
  if (!data || data.type !== 'WA_EMBEDDED_SIGNUP') return;

  const ev = data.event;
  if (
    ev === 'FINISH' ||
    ev === 'FINISH_ONLY_WABA' ||
    ev === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' ||
    ev === 'FINISH_OBO_MIGRATION' ||
    ev === 'FINISH_GRANT_ONLY_API_ACCESS'
  ) {
    const d = data.data || {};
    waEmbeddedSession = {
      waba_id: d.waba_id || (d.waba_ids && d.waba_ids[0]) || null,
      phone_number_id: d.phone_number_id || null
    };
  }
});

function waitForEmbeddedSignupData(maxMs) {
  if (waEmbeddedSession && waEmbeddedSession.waba_id) {
    return Promise.resolve(waEmbeddedSession);
  }
  return new Promise(function (resolve) {
    const t0 = Date.now();
    const id = setInterval(function () {
      if (waEmbeddedSession && waEmbeddedSession.waba_id) {
        clearInterval(id);
        resolve(waEmbeddedSession);
      } else if (Date.now() - t0 > maxMs) {
        clearInterval(id);
        resolve(waEmbeddedSession || {});
      }
    }, 100);
  });
}

window.fbAsyncInit = function () {
  FB.init({
    appId: '1339299584731362',
    autoLogAppEvents: true,
    cookie: true,
    xfbml: true,
    version: 'v19.0'
  });
};

function setConnectedWorkspace(info) {
  isConnected = true;
  document.getElementById('waba-id').textContent = info.wabaId || '-';
  document.getElementById('phone-id').textContent = info.phoneNumberId || '-';
  document.getElementById('connect-btn').textContent = 'Reconnect WhatsApp';
  setStatus('Status: Connected and ready to message customers');
  setAlert('global-success', 'Account connected successfully. You can now send and receive customer messages.');
  setOAuthLoading(false);
  showStep(3);
  refreshMessages();
  startMessagePolling();
}

function startMessagePolling() {
  if (poller) return;
  poller = setInterval(refreshMessages, 3000);
}

function refreshMessages() {
  if (!isConnected) return;
  fetch(API + '/messages')
    .then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) {
          throw new Error((data && data.error) || 'Unable to load replies');
        }
        return data;
      });
    })
    .then(function (data) {
      const list = document.getElementById('msg-list');
      if (!Array.isArray(data) || !data.length) {
        list.innerHTML = '<div class="chat-empty">No customer replies yet.</div>';
        return;
      }
      list.innerHTML = data
        .map(function (m) {
          return '<div class="chat-msg">' + safeText(m) + '</div>';
        })
        .join('');
      list.scrollTop = list.scrollHeight;
    })
    .catch(function (err) {
      setAlert('global-error', 'Unable to load customer replies: ' + (err.message || String(err)));
    });
}

function connectWhatsApp() {
  clearGlobalMessages();
  waEmbeddedSession = null;
  showStep(2);
  setOAuthLoading(true, 'Opening Embedded Signup...');
  setStatus('Status: Connecting to Meta...');

  FB.login(
    function (response) {
      const code = response && response.authResponse && response.authResponse.code;
      if (!code) {
        setOAuthLoading(false);
        setStatus('Status: Connection cancelled');
        setAlert('global-error', 'Connection was cancelled before authorization completed.');
        showStep(1);
        return;
      }

      setOAuthLoading(true, 'Finalizing account setup...');
      setStatus('Status: Finalizing account setup...');
      fetch(API + '/exchange-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code })
      })
        .then(function (res) {
          return res.json().then(function (data) {
            if (!res.ok) {
              const detail =
                (data.details && data.details.error && data.details.error.message) || data.error;
              throw new Error(detail || 'Token exchange failed');
            }
            return data;
          });
        })
        .then(function (data) {
          return waitForEmbeddedSignupData(5000).then(function (session) {
            return fetch(API + '/onboard-user', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                access_token: data.access_token,
                waba_id: session.waba_id || undefined,
                phone_number_id: session.phone_number_id || undefined
              })
            });
          });
        })
        .then(function (res) {
          return res.json().then(function (j) {
            if (!res.ok) {
              const msg =
                (j.details && j.details.error && j.details.error.message) || j.error || 'Setup failed';
              throw new Error(msg);
            }
            return j;
          });
        })
        .then(function (info) {
          setConnectedWorkspace(info);
        })
        .catch(function (err) {
          setOAuthLoading(false);
          setStatus('Status: Connection failed');
          setAlert('global-error', 'Unable to connect account: ' + (err.message || String(err)));
          showStep(1);
        });
    },
    {
      config_id: '865515573285412',
      response_type: 'code',
      override_default_response_type: true,
      extras: {
        setup: {}
      }
    }
  );
}

document.querySelectorAll('[data-next-step]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    const nextStep = Number(btn.getAttribute('data-next-step'));
    showStep(nextStep);
  });
});

document.querySelectorAll('[data-prev-step]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    const prevStep = Number(btn.getAttribute('data-prev-step'));
    showStep(prevStep);
  });
});

showStep(1);

// ── Send Message ──────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function () {
  var msgArea = document.getElementById('send-msg');
  var charCount = document.getElementById('char-count');
  if (msgArea && charCount) {
    msgArea.addEventListener('input', function () {
      var len = msgArea.value.length;
      charCount.textContent = len;
      charCount.style.color = len > 900 ? '#f08080' : '';
    });
  }
});

function sendMessage() {
  var to = (document.getElementById('send-to').value || '').trim();
  var message = (document.getElementById('send-msg').value || '').trim();
  var btn = document.getElementById('send-btn');

  setAlert('send-error', '');
  setAlert('send-success', '');

  if (!to) {
    setAlert('send-error', 'Please enter a recipient phone number (include country code, no + sign).');
    return;
  }
  if (!message) {
    setAlert('send-error', 'Please enter a message before sending.');
    return;
  }
  if (message.length > 1024) {
    setAlert('send-error', 'Message is too long. Please keep it under 1024 characters.');
    return;
  }

  btn.disabled = true;
  var original = btn.innerHTML;
  btn.innerHTML = '<div class="spinner" style="width:14px;height:14px;border-width:2px;margin:0 auto;"></div>';

  fetch(API + '/send-message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: to, message: message })
  })
    .then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) {
          var detail =
            (data.details && data.details.error && data.details.error.message) ||
            data.error ||
            'Send failed';
          throw new Error(detail);
        }
        return data;
      });
    })
    .then(function () {
      setAlert('send-success', 'Message sent successfully! It should appear in the recipient\'s WhatsApp shortly.');
      document.getElementById('send-msg').value = '';
      var charCount = document.getElementById('char-count');
      if (charCount) charCount.textContent = '0';
    })
    .catch(function (err) {
      setAlert('send-error', 'Failed to send: ' + (err.message || String(err)));
    })
    .finally(function () {
      btn.disabled = false;
      btn.innerHTML = original;
    });
}