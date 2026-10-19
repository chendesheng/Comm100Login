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

  // Raw capture only. Nothing here may alter, mask, or truncate what was sent or received.
  function bodyText(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) return value.toString();
    if (typeof FormData !== 'undefined' && value instanceof FormData) {
      try { return JSON.stringify([...value.entries()]); } catch { return ''; }
    }
    if (typeof value === 'object') {
      try { return JSON.stringify(value); } catch { return String(value); }
    }
    return String(value);
  }

  function headersArray(headers) {
    try { return [...headers]; } catch { return []; }
  }

  function parseHeaders(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return [];
    return raw.trim().split(/[\r\n]+/).flatMap((line) => {
      const index = line.indexOf(':');
      return index < 1 ? [] : [[line.slice(0, index).trim(), line.slice(index + 1).trim()]];
    });
  }

  function sendTrace(trace) {
    try {
      window.postMessage({ source: 'comm100-request-hook', type: 'api-trace',
        trace: { ...trace, time: Date.now() } }, location.origin);
    }
    catch { /* tracing must never change request behavior */ }
  }

  async function captureFetch(requestClone, responseClone) {
    try {
      const [requestBody, responseBody] = await Promise.all([requestClone.text(), responseClone.text()]);
      sendTrace({
        url: requestClone.url,
        method: requestClone.method,
        statusCode: responseClone.status,
        requestHeaders: headersArray(requestClone.headers),
        requestBody,
        responseHeaders: headersArray(responseClone.headers),
        responseBody
      });
    } catch { /* tracing must never change request behavior */ }
  }

  async function captureFetchError(requestClone, error) {
    try {
      const requestBody = await requestClone.text();
      sendTrace({
        url: requestClone.url,
        method: requestClone.method,
        statusCode: 0,
        requestHeaders: headersArray(requestClone.headers),
        requestBody,
        responseHeaders: [],
        responseBody: String(error?.message || error)
      });
    } catch { /* tracing must never change request behavior */ }
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
    const retry = jwt ? request.clone() : null;
    const sent = jwt ? authenticated(request, jwt) : request;
    let sampleRequest = null;
    try { sampleRequest = sent.clone(); } catch { /* Unclonable body: trace not captured. */ }
    let response;
    try {
      response = await nativeFetch.call(this, sent);
    } catch (error) {
      if (sampleRequest) void captureFetchError(sampleRequest, error);
      throw error;
    }
    if (sampleRequest) {
      try { void captureFetch(sampleRequest, response.clone()); } catch { /* tracing only */ }
    }
    // Only an explicit authentication rejection is replayed; permission failures and network
    // errors may have other causes. Keep the original body, method, credentials and signal.
    if (!jwt || response.status !== 401) return response;
    const renewed = await withAbort(session(url, jwt), request.signal);
    request.signal.throwIfAborted();
    if (!renewed || renewed === jwt) return response;
    response.body?.cancel().catch(() => {});
    const retried = authenticated(retry, renewed);
    let retrySample = null;
    try { retrySample = retried.clone(); } catch { /* tracing only */ }
    let final;
    try {
      final = await nativeFetch.call(this, retried);
    } catch (error) {
      if (retrySample) void captureFetchError(retrySample, error);
      throw error;
    }
    if (retrySample) {
      try { void captureFetch(retrySample, final.clone()); } catch { /* tracing only */ }
    }
    return final;
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

  function requestHeaders(state) {
    const headers = [];
    for (const [name, value] of state.headers) {
      if (!state.jwt || name.toLowerCase() !== 'authorization') headers.push([name, value]);
    }
    if (state.jwt) headers.push(['Authorization', `Bearer ${state.jwt}`]);
    return headers;
  }

  function captureXhr(target, state) {
    let responseBody;
    if (target.responseType === '' || target.responseType === 'text') responseBody = target.responseText;
    else if (target.responseType === 'json') responseBody = JSON.stringify(target.response);
    else if (target.responseType === 'document') responseBody = target.response?.documentElement?.outerHTML ?? '';
    else responseBody = '';
    if (target.status === 0 && state.failure) responseBody = state.failure;
    sendTrace({
      url: state.url,
      method: state.method,
      statusCode: target.status,
      requestHeaders: requestHeaders(state),
      requestBody: bodyText(state.body),
      responseHeaders: parseHeaders(target.getAllResponseHeaders()),
      responseBody
    });
  }

  function listen(target) {
    if (listening.has(target)) return;
    listening.add(target);
    for (const type of ['error', 'timeout']) {
      target.addEventListener(type, () => {
        const state = requests.get(target);
        if (!state || state.aborted || state.replaying) return;
        state.failure = type === 'timeout' ? 'XHR timeout' : 'XHR network error';
      }, true);
    }
    for (const type of ['readystatechange', 'load', 'loadend']) {
      target.addEventListener(type, (event) => {
        const state = requests.get(target);
        if (!state || state.replaying || state.aborted) return;
        if (state.reopening) { event.stopImmediatePropagation(); return; }
        if (type === 'loadend' && target.readyState === 4 && state.startedAt) {
          try { captureXhr(target, state); } catch { /* tracing only */ }
        }
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
            state.startedAt = Date.now();
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
      requests.set(this, { url, openArgs: args, headers: [], sent: false,
        method: String(args[0] || '').toUpperCase(), body: null, startedAt: 0, failure: null });
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
        state.startedAt = Date.now();
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
