/**
 * Comm100 Auto Login — content script.
 *
 * Deliberately thin: the sign-in itself happens in the service worker against the HTTP API.
 * This script only (a) kicks off that work, (b) forwards the app's own `retUrl` when it lands
 * on the sign-in page, (c) pre-fills the form when the API cannot complete the sign-in alone
 * (two-factor, bad password), and (d) captures credentials typed by a human so they are
 * remembered for next time.
 *
 * Must stay dependency-free: content scripts cannot use ES module imports.
 */

(() => {
  'use strict';

  if (window.__comm100AutoLoginLoaded) return;
  window.__comm100AutoLoginLoaded = true;

  // Mirrors isSupportedHost() in shared/api.js — content scripts cannot import it. The manifest's
  // matches decide this first; this is the belt to that pair of braces.
  const SUPPORTED_HOST = /(^|\.)(comm100dev\.io|comm100staging\.com|comm100\.io)$/i;
  const hostname = location.hostname;
  const isLocalDashboard = hostname === 'localhost' || hostname === '127.0.0.1';
  if (!SUPPORTED_HOST.test(hostname) && !isLocalDashboard) return;

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

  // ------------------------------------------------------------- form helpers

  const findEmailInput = () => document.querySelector('input[name="email"], input[type="email"]');
  const findPasswordInput = () => document.querySelector('input[type="password"]');

  /** React (formik) ignores a plain `.value =`; go through the native setter and notify. */
  function setNativeValue(element, value) {
    const proto =
      element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function waitForSignInForm(timeoutMs) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const check = () => {
        const email = findEmailInput();
        const password = findPasswordInput();
        if (email && password) {
          resolve({ email, password });
          return true;
        }
        if (Date.now() > deadline) {
          resolve(null);
          return true;
        }
        return false;
      };
      if (check()) return;
      const observer = new MutationObserver(() => {
        if (check()) observer.disconnect();
      });
      observer.observe(document.documentElement || document, { childList: true, subtree: true });
      const timer = setInterval(() => {
        if (check() || Date.now() > deadline) {
          clearInterval(timer);
          observer.disconnect();
        }
      }, 250);
    });
  }

  // ------------------------------------------------------------- redirect back

  function destinationFrom(result) {
    // Where the user was originally going always wins.
    const retUrl = new URLSearchParams(location.search).get('retUrl');
    if (retUrl && /^https:\/\//i.test(retUrl)) return retUrl;
    // Otherwise land where the panel itself lands after a manual sign-in, rather than on the bare
    // dashboard root — that is the entry point it expects to be handed a fresh session at.
    if (result && result.entryUrl) return result.entryUrl;
    if (result && result.portalUrl && result.siteId) {
      return `${result.portalUrl}/ui/${result.siteId}/entry/?fromlogin=1`;
    }
    if (result && result.dashboardUrl) return result.dashboardUrl;
    return null;
  }

  function leaveSignInPage(result) {
    if (!isSignInPath()) return false;
    const destination = destinationFrom(result);
    if (!destination || destination === location.href) return false;
    // Recorded so the activity log can tell a bounce-recovery apart from a reload.
    send({ type: 'notify', kind: 'redirect', detail: `login page -> ${destination}` });
    location.replace(destination);
    return true;
  }

  // ------------------------------------------------------------- manual fallback

  async function prefillForm(result) {
    const form = await waitForSignInForm(20000);
    if (!form) return;
    if (result.email) setNativeValue(form.email, result.email);
    if (result.password) setNativeValue(form.password, result.password);
    window.__comm100AutoLoginPrefilled = true;
  }

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

  // ------------------------------------------------------------- sign-in cover

  const COVER_ID = '__comm100_autologin_cover';

  /**
   * The control panel may decide it is signed out and route to /login before a background
   * sign-in has finished. Instead of letting the form appear and then vanish, cover it for the
   * duration of the attempt: it is removed the moment the attempt resolves — on success the page
   * navigates away, on failure the form is revealed for the user.
   */
  function coverSignInPage() {
    if (document.getElementById(COVER_ID) || !document.documentElement) return;

    const style = document.createElement('style');
    style.id = `${COVER_ID}_style`;
    style.textContent = '#login{visibility:hidden!important}';

    const notice = document.createElement('div');
    notice.id = COVER_ID;
    notice.textContent = 'Signing in…';
    notice.setAttribute(
      'style',
      'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
        'font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#6b7280'
    );

    (document.head || document.documentElement).appendChild(style);
    (document.body || document.documentElement).appendChild(notice);
  }

  function uncoverSignInPage() {
    const notice = document.getElementById(COVER_ID);
    if (notice) notice.remove();
    const style = document.getElementById(`${COVER_ID}_style`);
    if (style) style.remove();
  }

  // ------------------------------------------------------------- main

  /**
   * The site this page belongs to, read straight from the URL.
   *
   * Comm100 puts it in the path (`/ui/10008/entry/`) and, on the sign-in page, inside the
   * `retUrl` parameter. Passing it to the worker matters: every test branch shares the
   * `comm100dev.io` cookie domain, so a `token_*` cookie alone cannot say which branch is signed
   * in, and the worker would otherwise have to ask the route service.
   */
  function siteIdFromLocation() {
    const direct = location.pathname.match(/^\/ui\/(\d+)(?:\/|$)/i);
    if (direct) return direct[1];
    const retUrl = new URLSearchParams(location.search).get('retUrl');
    if (retUrl) {
      const inner = retUrl.match(/\/ui\/(\d+)(?:\/|$|\?)/i);
      if (inner) return inner[1];
    }
    return null;
  }

  const ensureAuth = () => send({ type: 'ensureAuth', hostname, domain, siteId: siteIdFromLocation() });

  /**
   * A bounce cannot be allowed to become a loop, but it must still be recoverable: the control
   * panel can route to /login more than once in a session (for instance when a cookie is removed
   * while a tab is already open), so allow a few trips rather than exactly one.
   *
   * The count lives in `sessionStorage` rather than a variable because what is being counted is
   * *navigations*, and a per-document counter resets on every trip — which is exactly how a
   * dashboard that rejects the session it was handed becomes an endless bounce between /login and
   * /ui/…. `sessionStorage` survives same-origin navigation, so the budget is per tab per dashboard.
   */
  /** Poll interval for the history-API backstop, and how long to wait after an attempt. */
  const POLL_INTERVAL_MS = 2000;
  const POLL_BACKOFF_MS = 15000;
  const MAX_REDIRECTS = 3;
  const REDIRECT_WINDOW_MS = 60000;
  const REDIRECT_KEY = '__comm100_autologin_redirects';

  function recentRedirects() {
    try {
      const raw = sessionStorage.getItem(REDIRECT_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((at) => typeof at === 'number' && Date.now() - at < REDIRECT_WINDOW_MS);
    } catch {
      return [];
    }
  }

  function noteRedirect() {
    const history = recentRedirects();
    history.push(Date.now());
    try {
      sessionStorage.setItem(REDIRECT_KEY, JSON.stringify(history));
    } catch {
      // Storage unavailable; the guard still applies within this document.
    }
  }

  function leaveSignInPageOnce(result) {
    const history = recentRedirects();
    if (history.length >= MAX_REDIRECTS) {
      // Out of budget: the dashboard keeps sending us back, so signing in is not what it wants.
      // Leave the form visible instead of bouncing the user forever.
      send({
        type: 'notify',
        kind: 'redirect-stopped',
        detail: `${history.length} bounces in a minute — leaving the sign-in page alone`
      });
      return false;
    }
    if (!leaveSignInPage(result)) return false;
    noteRedirect();
    return true;
  }

  /**
   * Refusals worth running the attempt for, purely so the worker records why: the popup shows them
   * and "it did nothing" otherwise looks identical to a broken extension.
   */
  const EXPLAINABLE_REFUSALS = new Set(['no-account', 'site-mismatch', 'unresolved']);

  /** One attempt. Safe to call from several triggers; overlapping calls collapse into one. */
  let busy = false;
  /** When the last attempt finished, so the poll below can back off instead of churning. */
  let lastAttemptAt = 0;

  async function authenticate() {
    if (busy) return;
    busy = true;

    // Ask first (local-only, no network) whether a sign-in is actually about to happen, so the
    // form is only ever covered when we are genuinely signing in.
    let covered = false;
    let peek = null;
    if (isSignInPath()) {
      peek = await send({ type: 'canAutoLogin', hostname, domain, siteId: siteIdFromLocation() });
      if (peek && peek.eligible) {
        coverSignInPage();
        covered = true;
        setTimeout(uncoverSignInPage, 10000); // safety net if a reply never arrives
      }
    }

    // A refusal is not "nothing happened": it is the thing the popup explains, and the record is
    // written by the attempt. It costs no network, and the poll backs off, so this stays rare.
    const worthTrying =
      !isSignInPath() ||
      !peek ||
      peek.eligible ||
      peek.reason === 'signed-in' ||
      EXPLAINABLE_REFUSALS.has(peek.reason);
    if (!worthTrying) {
      busy = false;
      return;
    }

    try {
      const result = await ensureAuth();
      if (covered) uncoverSignInPage();
      if (!result) return;

      if (result.ok) {
        leaveSignInPageOnce(result);
        return;
      }

      if (result.needsManual && isSignInPath()) prefillForm(result);
    } finally {
      lastAttemptAt = Date.now();
      busy = false;
    }
  }

  // ------------------------------------------------------------- SPA route changes

  /**
   * The control panel is a single-page app, so it can move to /login without loading a document —
   * no new content script, no `webNavigation` event. Watch the history instead, otherwise a session
   * that vanishes mid-session leaves the sign-in page sitting there.
   */
  function watchRouteChanges() {
    const onRouteChange = () => {
      if (isSignInPath()) authenticate();
    };

    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      if (typeof original !== 'function') continue;
      history[method] = function patched(...args) {
        const result = original.apply(this, args);
        queueMicrotask(onRouteChange);
        return result;
      };
    }

    window.addEventListener('popstate', onRouteChange);
    window.addEventListener('hashchange', onRouteChange);
    // Backstop for route changes that bypass the history API entirely — and deliberately slow.
    // The real signals are the history hooks above; a one-second poll that retried every tick would
    // wake the worker, spend a storage read and append an activity entry every second for as long as
    // the sign-in page is on screen (which is exactly when the log is being read to find out why).
    setInterval(() => {
      if (!isSignInPath()) return;
      if (Date.now() - lastAttemptAt < POLL_BACKOFF_MS) return;
      onRouteChange();
    }, POLL_INTERVAL_MS);
  }

  async function main() {
    watchUserSignIn();
    watchRouteChanges();
    authenticate();
  }

  main();
})();
