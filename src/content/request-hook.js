/** Runs in the page's MAIN world at document_start, before the app captures fetch/XHR. */
(() => {
  'use strict';
  if (!/(^|\.)(comm100dev\.io|comm100staging\.com|comm100\.io)$/i.test(location.hostname)) return;
  if (window.__comm100RequestHook) return;
  window.__comm100RequestHook = true;
  if (!/^\/(?:ui(?:\/|$)|login\/?$|$)/i.test(location.pathname)) return;

  const nativeFetch = window.fetch;
  const xhr = window.XMLHttpRequest.prototype;
  const nativeOpen = xhr.open;
  const nativeSend = xhr.send;
  const nativeAbort = xhr.abort;
  const nativeHeader = xhr.setRequestHeader;
  const pending = new Map();
  let sequence = 0;

  function apiUrl(value) {
    if (!/^\/ui(\/|$)/i.test(location.pathname)) return null;
    try {
      const url = new URL(value, location.href);
      return url.origin === location.origin && url.pathname.startsWith('/api/') &&
        !/^\/api\/login\//i.test(url.pathname) ? url.href : null;
    } catch { return null; }
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin ||
        data?.source !== 'comm100-session-bridge' || data.type !== 'session-response') return;
    const entry = pending.get(data.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(data.id);
    entry.resolve(/^\/ui(\/|$)/i.test(location.pathname) && data.ok && typeof data.jwt === 'string' ? data.jwt : null);
  });

  function session(url, rejectedToken = null) {
    if (!apiUrl(url)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const id = `${Date.now()}-${++sequence}`;
      // Route lookup and JWT login each have a 20-second timeout in the worker.
      const timer = setTimeout(() => { pending.delete(id); resolve(null); }, 45000);
      pending.set(id, { resolve, timer });
      window.postMessage({ source: 'comm100-request-hook', type: 'session-request', id, url, rejectedToken }, location.origin);
    });
  }

  function withAbort(promise, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  function authenticated(request, jwt) {
    if (!jwt) return request;
    const headers = new Headers(request.headers);
    headers.set('Authorization', `Bearer ${jwt}`);
    return new Request(request, { headers });
  }

  window.fetch = async function (input, init) {
    const url = apiUrl(input instanceof Request ? input.url : input);
    if (!url) return nativeFetch.call(this, input, init);
    const request = new Request(input, init);
    const jwt = await withAbort(session(url), request.signal);
    request.signal.throwIfAborted();
    if (!jwt) return nativeFetch.call(this, request);
    const retry = request.clone();
    const response = await nativeFetch.call(this, authenticated(request, jwt));
    // Only an explicit authentication rejection is replayed; permission failures and network
    // errors may have other causes. Keep the original body, method, credentials and signal.
    if (response.status !== 401) return response;
    const renewed = await withAbort(session(url, jwt), request.signal);
    request.signal.throwIfAborted();
    if (!renewed || renewed === jwt) return response;
    response.body?.cancel().catch(() => {});
    return nativeFetch.call(this, authenticated(retry, renewed));
  };

  const requests = new WeakMap();
  const listening = new WeakSet();

  function flushHeaders(target, state, jwt) {
    for (const [name, value] of state.headers) {
      if (!jwt || name.toLowerCase() !== 'authorization') nativeHeader.call(target, name, value);
    }
    if (jwt) nativeHeader.call(target, 'Authorization', `Bearer ${jwt}`);
  }

  function deliverRejection(target, state) {
    state.holding = false;
    state.replaying = true;
    for (const type of ['readystatechange', 'load', 'loadend']) target.dispatchEvent(new Event(type));
    state.replaying = false;
  }

  function waitForSession(target, state, rejectedToken = null) {
    let timer;
    if (target.timeout > 0) {
      timer = setTimeout(() => {
        if (state.aborted || requests.get(target) !== state) return;
        state.aborted = true;
        nativeAbort.call(target);
        target.dispatchEvent(new ProgressEvent('timeout'));
        target.dispatchEvent(new ProgressEvent('loadend'));
      }, target.timeout);
    }
    return session(state.url, rejectedToken).finally(() => clearTimeout(timer));
  }

  function listen(target) {
    if (listening.has(target)) return;
    listening.add(target);
    for (const type of ['readystatechange', 'load', 'loadend']) {
      target.addEventListener(type, (event) => {
        const state = requests.get(target);
        if (!state || state.replaying || state.aborted) return;
        if (state.reopening) { event.stopImmediatePropagation(); return; }
        if (state.jwt && !state.retried && target.readyState >= 2 && target.status === 401) state.holding = true;
        if (!state.holding) return;
        event.stopImmediatePropagation();
        if (type !== 'loadend' || state.renewing) return;
        state.renewing = true;
        waitForSession(target, state, state.jwt).then((renewed) => {
          if (state.aborted || requests.get(target) !== state) return;
          if (!renewed || renewed === state.jwt) { deliverRejection(target, state); return; }
          state.retried = true;
          state.holding = false;
          state.jwt = renewed;
          // open() resets native request headers and response settings. Restore all of them.
          const settings = { timeout: target.timeout, responseType: target.responseType, withCredentials: target.withCredentials };
          state.reopening = true;
          try {
            nativeOpen.apply(target, state.openArgs);
            Object.assign(target, settings);
            flushHeaders(target, state, renewed);
            state.reopening = false;
            nativeSend.call(target, state.body);
          } catch {
            state.reopening = false;
            state.jwt = null;
            target.dispatchEvent(new Event('error'));
            target.dispatchEvent(new Event('loadend'));
          }
        });
      }, true);
    }
  }

  xhr.open = function (...args) {
    const previous = requests.get(this);
    if (previous) previous.aborted = true;
    requests.delete(this);
    const url = apiUrl(args[1]);
    // Synchronous XHR cannot await an extension message. Keep its native behavior.
    if (url && args[2] !== false) {
      listen(this);
      requests.set(this, { url, openArgs: args, headers: [], sent: false });
    }
    return nativeOpen.apply(this, args);
  };

  xhr.setRequestHeader = function (name, value) {
    const state = requests.get(this);
    if (!state) return nativeHeader.call(this, name, value);
    if (this.readyState !== 1 || state.sent) throw new DOMException('Request is not open', 'InvalidStateError');
    // Validate and normalize without setting the native header: native XHR appends duplicate
    // values, so applying the app's stale bearer now would prevent replacing it after renewal.
    const header = new Headers([[name, value]]);
    state.headers.push([...header][0]);
  };

  xhr.send = function (body = null) {
    const state = requests.get(this);
    if (!state) return nativeSend.call(this, body);
    if (state.sent || this.readyState !== 1) throw new DOMException('Request is not open', 'InvalidStateError');
    state.sent = true;
    state.body = body;
    waitForSession(this, state).then((jwt) => {
      if (state.aborted || requests.get(this) !== state) return;
      state.jwt = jwt;
      try {
        flushHeaders(this, state, jwt);
        nativeSend.call(this, body);
      } catch {
        this.dispatchEvent(new Event('error'));
        this.dispatchEvent(new Event('loadend'));
      }
    });
  };

  xhr.abort = function () {
    const state = requests.get(this);
    const waiting = state?.sent && !state.aborted && (this.readyState === 1 || (this.readyState === 4 && state.holding));
    if (state) state.aborted = true;
    const result = nativeAbort.call(this);
    if (waiting) {
      this.dispatchEvent(new Event('abort'));
      this.dispatchEvent(new Event('loadend'));
    }
    return result;
  };
})();
