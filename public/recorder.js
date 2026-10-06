/*!
 * Consent recorder: records a form session with rrweb and turns the submission into a consent certificate.
 *
 *   <script src="https://YOUR-SERVER/recorder.js" defer></script>
 *   <form data-consent-form>
 *     <input type="tel" name="phone" data-consent-phone>
 *     <label><input type="checkbox" data-consent-checkbox> <span data-consent-text>I agree to be contacted…</span></label>
 *     <button>Submit</button>
 *   </form>
 *
 * Privacy: every input is masked in the recording (the replay shows **** instead of what was typed).
 * Phone and email are sent once at submit, and the server stores them only as keyed hashes.
 */
(function () {
  'use strict';
  if (window.ConsentRecorder) return;

  var script = document.currentScript;
  var API = new URL(script.src).origin;
  var FLUSH_INTERVAL_MS = 4000;
  var FINALIZE_TIMEOUT_MS = 6000;
  var FIELD = script.getAttribute('data-field') || 'consent_certificate_url';

  var state = { sessionId: null, token: null, seq: 0, buffer: [], queue: Promise.resolve(), result: null, finalizing: null };

  function request(path, body, keepalive) {
    var headers = { 'Content-Type': 'application/json' };
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    return fetch(API + path, {
      method: 'POST', headers: headers, body: JSON.stringify(body),
      credentials: 'omit', mode: 'cors', keepalive: !!keepalive
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  // Uploads are queued so chunks arrive in order; each chunk keeps its seq, so retries are safe.
  function flush(keepalive) {
    if (!state.sessionId || !state.buffer.length) return state.queue;
    var chunk = { seq: state.seq++, events: state.buffer.splice(0) };
    var path = '/api/sessions/' + state.sessionId + '/events';
    state.queue = state.queue.then(function () {
      return request(path, chunk, keepalive).catch(function () {
        return new Promise(function (r) { setTimeout(r, 1000); }).then(function () { return request(path, chunk, keepalive); });
      });
    }).catch(function (err) { console.warn('[consent-recorder] upload failed', err); });
    return state.queue;
  }

  function text(el) { return el ? (el.innerText || el.textContent || '').trim() : ''; }
  function value(scope, selector) { var el = scope.querySelector(selector); return el ? el.value : ''; }

  /** Finish the recording and get a certificate. Safe to call more than once. */
  function finalize(scope) {
    if (state.result) return Promise.resolve(state.result);
    if (state.finalizing) return state.finalizing;
    scope = scope || document;
    var checkbox = scope.querySelector('[data-consent-checkbox]');
    var payload = {
      consent: { text: text(scope.querySelector('[data-consent-text]')), checked: checkbox ? !!checkbox.checked : undefined },
      lead: { phone: value(scope, '[data-consent-phone]'), email: value(scope, '[data-consent-email]') }
    };
    state.finalizing = flush().then(function () {
      return request('/api/sessions/' + state.sessionId + '/finalize', payload);
    }).then(function (result) {
      state.result = result;
      if (state.stop) state.stop();
      return result;
    });
    return state.finalizing;
  }

  function attachToForms() {
    document.addEventListener('submit', function (event) {
      var form = event.target;
      if (!form.matches || !form.matches('form[data-consent-form]') || form.__consentDone) return;
      event.preventDefault();
      var done = function (result) {
        if (result) {
          var input = form.querySelector('input[name="' + FIELD + '"]') || document.createElement('input');
          input.type = 'hidden'; input.name = FIELD; input.value = result.certificateUrl;
          form.appendChild(input);
        }
        form.__consentDone = true;
        HTMLFormElement.prototype.submit.call(form); // bypasses this listener
      };
      var timeout = new Promise(function (resolve) { setTimeout(resolve, FINALIZE_TIMEOUT_MS); });
      Promise.race([finalize(form), timeout]).then(done, function (err) {
        console.warn('[consent-recorder] finalize failed', err);
        done(null); // never block the visitor's submission
      });
    }, true);
  }

  function loadRrweb(callback) {
    if (window.rrweb && window.rrweb.record) return callback();
    var s = document.createElement('script');
    s.src = API + '/vendor/rrweb.min.js';
    s.onload = callback;
    s.onerror = function () { console.warn('[consent-recorder] could not load rrweb'); };
    document.head.appendChild(s);
  }

  function start() {
    request('/api/sessions', { pageUrl: location.href }).then(function (session) {
      state.sessionId = session.sessionId;
      state.token = session.uploadToken;
      loadRrweb(function () {
        state.stop = window.rrweb.record({
          emit: function (event) { state.buffer.push(event); },
          maskAllInputs: true,                                // never record what people type
          maskTextSelector: '[data-consent-mask]',            // mask any other sensitive text
          blockSelector: '[data-consent-block], .rr-block',   // leave elements out entirely
          recordCanvas: false,
          collectFonts: false
        });
        setInterval(flush, FLUSH_INTERVAL_MS);
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'hidden') flush(true);
        });
      });
    }).catch(function (err) {
      console.warn('[consent-recorder] not recording:', err.message);
    });
  }

  window.ConsentRecorder = {
    finalize: finalize,
    get sessionId() { return state.sessionId; }
  };

  attachToForms();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
