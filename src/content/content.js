/** Dashboard authentication bridge and manual login credential capture. */
(() => {
  'use strict';

  if (window.__comm100AutoLoginLoaded) return;
  window.__comm100AutoLoginLoaded = true;

  // Mirrors isSupportedHost() in shared/api.js — content scripts cannot import it. The manifest's
  // matches decide this first; this is the belt to that pair of braces.
  const SUPPORTED_HOST = /(^|\.)(comm100dev\.io|comm100staging\.com|comm100\.io)$/i;
  const TRACE_MESSAGE_MAX = 256 * 1024 * 1024;
  const hostname = location.hostname;
  if (!SUPPORTED_HOST.test(hostname)) return;

  /**
   * The credential scope — the host, port included. Credentials are saved per dashboard, so this
   * is what the worker matches accounts on, and it has to travel with every message: the port is
   * part of the identity of the local dashboard.
   */
  const domain = location.host;

  /** Paths that render the sign-in form (`/` serves the same app). */
  const isSignInPath = () => {
    const p = location.pathname.toLowerCase();
    return p === '/' || p === '/login' || p === '/login/';
  };

  /**
   * Only the sign-in page and the control panel are interesting. Everything else under
   * /login/ (forgot password, SSO, reset link, 2FA) must be left alone — otherwise asking for
   * a password reset would silently sign the user back in.
   */
  const isAppPath = () => {
    const p = location.pathname.toLowerCase();
    return isSignInPath() || /^\/ui(\/|$)/.test(p);
  };

  if (!isAppPath()) return;

  const send = (message) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(response || null);
        });
      } catch {
        resolve(null);
      }
    });

  // MAIN-world code cannot call extension APIs. Only forward same-origin API requests;
  // the worker validates the browser-provided sender again and never returns credentials.
  window.addEventListener('message', async (event) => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin ||
        data?.source !== 'comm100-request-hook') return;
    if (data.type === 'api-trace') {
      const trace = data.trace;
      if (!trace || typeof trace !== 'object') return;
      let serialized;
      try { serialized = JSON.stringify(trace); } catch { return; }
      if (serialized.length > TRACE_MESSAGE_MAX) return;
      void send({ type: 'captureTrace', trace });
      return;
    }
    if (data.type !== 'session-request' || typeof data.id !== 'string') return;
    let target;
    try { target = new URL(data.url, location.href); } catch { return; }
    if (target.origin !== location.origin || !target.pathname.startsWith('/api/') ||
        target.pathname.toLowerCase().startsWith('/api/login/')) return;
    const result = /^\/ui(\/|$)/i.test(location.pathname) ? await send({
      type: 'requestSession',
      url: target.href,
      rejectedToken: typeof data.rejectedToken === 'string' ? data.rejectedToken : null
    }) : null;
    window.postMessage({
      source: 'comm100-session-bridge', type: 'session-response', id: data.id,
      ok: Boolean(result?.ok), jwt: result?.ok ? result.jwt : null
    }, location.origin);
  });

  // ------------------------------------------------------------- form helpers

  const findEmailInput = () => document.querySelector('input[name="email"], input[type="email"]');
  const findPasswordInput = () => document.querySelector('input[type="password"]');

  function captureCredentials() {
    const email = findEmailInput();
    const password = findPasswordInput();
    if (!email || !password) return;
    const emailValue = (email.value || '').trim();
    const passwordValue = password.value || '';
    if (!emailValue || !passwordValue) return;
    // No site is sent: which site an email uses on a dashboard comes from the route service, and a
    // successful sign-in is what records it. The address bar only *claims* a site.
    send({ type: 'captureCredentials', hostname, domain, email: emailValue, password: passwordValue });
  }

  function watchUserSignIn() {
    document.addEventListener(
      'submit',
      () => {
        captureCredentials();
      },
      true
    );
    document.addEventListener(
      'click',
      (event) => {
        const target = event.target;
        const button = target && target.closest ? target.closest('button') : null;
        if (!button) return;
        if (!/sign\s*in|log\s*in/i.test((button.textContent || '').trim())) return;
        captureCredentials();
      },
      true
    );
  }

  // Authentication belongs to dashboard pages. Login pages only capture manual credentials.
  const isDashboardPath = () => /^\/ui(\/|$)/i.test(location.pathname);
  let busy = false;
  async function authenticate() {
    if (busy || !isDashboardPath()) return;
    busy = true;
    try {
      await send({ type: 'ensureAuth', hostname, domain, url: location.href,
        siteId: location.pathname.match(/^\/ui\/(\d+)(?:\/|$)/i)?.[1] || null });
    } finally {
      busy = false;
    }
  }

  // The isolated world cannot reliably observe the page's patched history methods. The worker
  // also watches history navigation; this poll catches transitions missed by either world.
  let previousUrl;
  function onRouteChange() {
    if (previousUrl === location.href) return;
    previousUrl = location.href;
    send({ type: 'pageMode' });
    authenticate();
  }
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      queueMicrotask(onRouteChange);
      return result;
    };
  }
  window.addEventListener('popstate', onRouteChange);
  window.addEventListener('hashchange', onRouteChange);
  setInterval(onRouteChange, 2000);
  watchUserSignIn();
  onRouteChange();
})();
