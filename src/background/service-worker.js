/**
 * Background orchestration.
 *
 * The happy path never touches the login page: resolve site -> get JWT -> exchange for the
 * session cookie -> the dashboard loads already authenticated. The only navigation is the one
 * the user asked for (a login-page bounce is redirected to its own `retUrl`).
 */

import {
  crossPlatformLogin,
  dashboardOriginFor,
  dashboardUrlFor,
  entryUrlFor,
  domainKeyForUrl,
  getByEmail,
  isSupportedHost,
  jwtLogin,
  needsSecondFactor,
  normalizeSite,
  ownsSiteOnHost,
  pickSite,
  registrableDomain,
  routeOriginFor
} from '../shared/api.js';
import { platformDomainFor } from '../shared/platforms.js';
import {
  TOKEN_RE,
  clearSessionCookies,
  ensureSessionCookies,
  findSession,
  getAllCookies,
  getCookie,
  hasSession,
  isJwtFresh,
  sessionRemainingMs,
  tokenCookieName
} from '../shared/cookies.js';
import * as store from '../shared/storage.js';
import {
  COOKIE_HEADER_BUDGET_BYTES,
  cookieHeaderBytes,
  isSessionPruned,
  restoreSessionTracking,
  trimSessionCookies
} from '../shared/cookie-budget.js';

/**
 * Outcomes that mean "there was nothing to do", which must not be logged on every poll.
 *
 * They are still *decisions* the popup can explain (the refusal banner, the paused banner), just not
 * history: a sign-in page left open would otherwise append one line a second and evict everything
 * worth reading from a log capped at 40 entries.
 */
const QUIET_OUTCOMES = new Set(['cooldown', 'paused', 'logged-out', 'no-account']);

/** host + site -> in-flight promise, so concurrent tabs share one login attempt. */
const inFlight = new Map();

/**
 * `${host}|${siteId}` -> { until } — when we believe the session is good.
 *
 * A blocking navigation listener must answer *synchronously* and `chrome.cookies` is async, so the
 * decision is served from this map. `until: 0` is a positive statement that the session is gone
 * (the cookie watchdog sets it); an absent entry means "never checked", which is deliberately not
 * treated as bad — otherwise the first navigation after every browser start would be held.
 */
const sessionCache = new Map();
const sessionKey = (host, siteId) => `${host}|${siteId}`;

function rememberSession(host, siteId, expiresAt, jwt = null) {
  const until = expiresAt && expiresAt > Date.now() ? expiresAt : Date.now() + 5 * 60 * 1000;
  const previous = sessionCache.get(sessionKey(host, siteId)) || {};
  sessionCache.set(sessionKey(host, siteId), { until, jwt: jwt || previous.jwt || null });
}

/** Read the current cookie; a cached token can outlive a manual sign-in or cookie replacement. */
async function tokenFor(host, siteId) {
  const name = tokenCookieName(siteId);
  const cookie = await getCookie(dashboardOriginFor(host), name);
  return cookie && cookie.value ? cookie.value : null;
}

const log = (...args) => console.log('[Comm100 Auto Login]', ...args);

/**
 * Logs to the console *and* to the rolling activity log the popup shows. Every decision that could
 * explain an unexpected reload goes through here, because guessing at which path did it has already
 * cost several rounds.
 */
const note = (kind, detail) =>
  store.recordEvent(kind, detail).catch(() => {
    // diagnostics must never break the extension
  });

// ---------------------------------------------------------------- messaging

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message && message.type;
  if (!type) return undefined;

  (async () => {
    try {
      switch (type) {
        case 'requestSession':
          sendResponse(await requestSession(message, sender));
          break;
        case 'ensureAuth':
          sendResponse(
            await ensureAuth({
              ...message,
              tabId: message.tabId ?? sender.tab?.id ?? null,
              url: message.url || sender.tab?.url || null
            })
          );
          break;
        case 'notify':
          await store.recordEvent(message.kind, message.detail);
          sendResponse({ ok: true });
          break;
        case 'canAutoLogin':
          sendResponse(await canAutoLogin(message));
          break;
        case 'sessionStatus':
          sendResponse(await sessionStatus(message.origin, message.siteId));
          break;
        case 'logout':
          sendResponse(await logout(message.origin, message.host));
          break;
        case 'captureCredentials':
          sendResponse(await captureCredentials({ ...message, host: message.host || sender.tab?.url }));
          break;
        case 'verifyAccount':
          sendResponse(
            await verifyAccount(message.accountId, String(message.hostname || message.host || '').toLowerCase())
          );
          break;
        case 'resetFailures':
          await store.clearFailures(String(message.hostname || message.host || '').toLowerCase());
          await setBadge(null);
          sendResponse({ ok: true });
          break;
        case 'getState':
          sendResponse({ state: await store.getState() });
          break;
        default:
          sendResponse({ ok: false, reason: 'unknown-message' });
      }
    } catch (err) {
      log('message failed', type, err);
      sendResponse({ ok: false, reason: 'exception', error: String((err && err.message) || err) });
    }
  })();

  return true; // keep the channel open for the async response
});

// ---------------------------------------------------------------- session

// The page hook owns retries for these documents. The non-blocking webRequest backstop
// must not race it and start a second renewal for the same rejected request.
const guardedFrames = new Set();
const requestRenewals = new Map();
const frameKey = (details) => `${details.tabId}|${details.frameId ?? 0}`;

async function requestSession(message, sender) {
  let page, target;
  try {
    page = new URL(sender.url);
    target = new URL(message.url);
  } catch {
    return { ok: false, reason: 'invalid-request' };
  }
  if (sender.tab?.id == null || page.origin !== target.origin || !routeOriginFor(page.host) ||
      !/^\/(?:ui(?:\/|$)|login\/?$|$)/i.test(page.pathname) ||
      !target.pathname.startsWith('/api/') || /^\/api\/login\//i.test(target.pathname)) {
    return { ok: false, reason: 'unsupported-request' };
  }
  guardedFrames.add(frameKey({ tabId: sender.tab.id, frameId: sender.frameId }));
  const state = await store.getState();
  if (store.isSuppressed(state, page.host)) return { ok: false, reason: 'logged-out' };
  if (state.hostState[page.host]?.paused) return { ok: false, reason: 'paused' };
  const options = {
    domain: page.host, url: page.href, tabId: sender.tab.id,
    siteId: siteIdFromUrl(page.href) || store.normalizeSiteId(target.searchParams.get('siteId')),
    minRemainingMs: JWT_SKEW_MS, force: true
  };
  let result = await ensureAuth(options);
  if (!result.ok) return { ok: false, reason: result.reason };
  let jwt = await tokenFor(page.host, result.siteId);
  if (message.rejectedToken && jwt === message.rejectedToken) {
    const now = Date.now();
    const recent = (requestRenewals.get(page.host) || []).filter((at) => now - at < REAUTH_WINDOW_MS);
    if (!inFlight.has(`${page.host}|${result.siteId}`)) {
      if (recent.length >= MAX_REAUTH_PER_WINDOW) return { ok: false, reason: 'retry-limit' };
      recent.push(now);
      requestRenewals.set(page.host, recent);
    }
    result = await ensureAuth({ ...options, force: true, forceRefresh: true, rejectedToken: jwt });
    if (!result.ok) return { ok: false, reason: result.reason };
    jwt = await tokenFor(page.host, result.siteId);
  }
  return { ok: Boolean(jwt), jwt };
}

async function sessionStatus(origin, siteId = null) {
  if (!origin) return { signedIn: false, reason: 'no-origin' };
  const wanted = store.normalizeSiteId(siteId);
  if (wanted) {
    // Every branch shares one cookie domain, so "any token_* cookie" is a different branch's session
    // as often as not: `token_10008` says nothing about livechat6dash. When the page names a site,
    // report *that* site's session and nothing else.
    const session = await hasSession(origin, wanted);
    return { ...session, cookieNames: [] };
  }
  return findSession(origin);
}

/**
 * The credential scope for a request: host, port included (`livechat6dash.testing.comm100dev.io`,
 * `localhost:34500`).
 *
 * An explicit `domain` (the content script's `location.host`) is authoritative. Falling back to the
 * URL answers it too, and only when neither exists does the platform list decide — that last step
 * is what recovers the port for `http://localhost:34500`, where the hostname alone is ambiguous.
 */
function resolveDomain(domain, url, host) {
  return (
    store.normalizeDomain(domain) ||
    domainKeyForUrl(url) ||
    platformDomainFor(host) ||
    store.normalizeDomain(host)
  );
}

// ---------------------------------------------------------------- ensureAuth

/**
 * Guarantees a valid session for `host`.
 *
 * There is no on/off setting: signing in is what the extension is for, and turning *it* off is what
 * disabling the extension is for. `paused` (a rejected password) and the post-sign-out suppression
 * are the two states that hold a sign-in back, and both are recoverable from the popup.
 *
 * `targetHost` is the credential scope, not just a hostname: it is what the account is matched on,
 * what the route cache and failure counters are keyed by, and what the header rule is scoped to.
 *
 * Two independent overrides, because "the user asked" and "a request was rejected" are not the same
 * thing:
 *   - `force`         — the caller has a reason to move now, so the retry cooldown does not apply.
 *                       Set by the 401 middleware and by the popup.
 *   - `userInitiated` — a human clicked something, so a previous credential failure (paused) or a
 *                       just-performed sign-out is theirs to override. Only the popup sets it.
 * Neither may skip the *pause* on its own: retrying a rejected password cannot fix it and spends
 * attempts against the account lockout.
 */
async function ensureAuth({
  host,
  hostname,
  domain = null,
  tabId,
  force = false,
  userInitiated = false,
  siteId = null,
  url = null,
  minRemainingMs = 0,
  forceRefresh = false,
  rejectedToken = null,
  ignoreCooldown = false
}) {
  const targetHost = resolveDomain(domain, url, hostname || host);
  if (!targetHost) return { ok: false, reason: 'no-host' };

  const routeBase = routeOriginFor(targetHost);
  if (!routeBase) return { ok: false, reason: 'unsupported-host' };

  const urlSiteId = siteId || siteIdFromUrl(url);

  const flightKey = `${targetHost}|${urlSiteId || ''}`;
  const existing = inFlight.get(flightKey);
  if (existing) {
    const result = await existing;
    // A proactive check may already have been in progress when a 401 arrived. That check
    // can return the rejected cookie, so follow it with the requested conditional renewal.
    if (forceRefresh && rejectedToken && result.ok &&
        await tokenFor(targetHost, result.siteId) === rejectedToken) {
      return ensureAuth({ domain: targetHost, siteId: urlSiteId, tabId, force, userInitiated,
        minRemainingMs, forceRefresh, rejectedToken, ignoreCooldown });
    }
    return result;
  }

  const task = runEnsureAuth({
    targetHost,
    routeBase,
    tabId,
    force,
    userInitiated,
    urlSiteId,
    minRemainingMs,
    forceRefresh,
    rejectedToken,
    ignoreCooldown
  })
    .then(async (result) => {
      // Only outcomes that describe something happening are worth the activity log. "Nothing to do"
      // reasons repeat for as long as a sign-in page is open, and they would push the interesting
      // history out of a capped log — the refusal banner in the popup covers the one that matters.
      if (!QUIET_OUTCOMES.has(result && result.reason)) {
        note('sign-in', `${targetHost} -> ${result && result.ok ? 'ok' : (result && result.reason) || 'failed'}`);
      }
      if (result && result.ok && result.siteId) {
        await restoreSessionTracking(targetHost, result.siteId);
        const jwt = await tokenFor(targetHost, result.siteId);
        if (jwt) await publishSessionHeader(targetHost, jwt);
      }
      return result;
    })
    .finally(() => {
      inFlight.delete(flightKey);
    });
  inFlight.set(flightKey, task);
  return task;
}

/** `/ui/10008/entry/` -> `10008`; also understood inside a `retUrl` query parameter. */
function siteIdFromUrl(url) {
  if (!url) return null;
  const direct = String(url).match(/\/ui\/(\d+)(?:\/|$|\?)/);
  if (direct) return direct[1];
  try {
    const retUrl = new URL(url).searchParams.get('retUrl');
    if (retUrl) {
      const inner = retUrl.match(/\/ui\/(\d+)(?:\/|$|\?)/);
      if (inner) return inner[1];
    }
  } catch {
    // not a parseable URL
  }
  return null;
}

/**
 * Short-circuit result for "a valid session already exists". Clears failure history, and promotes
 * a password the user typed when the live session proves it works.
 */
async function alreadySignedIn(state, account, site, host) {
  const hs = state.hostState[host] || {};
  if (hs.consecutiveFailures || hs.paused) await store.clearFailures(host);
  if (account.pendingPassword) {
    await store.markSuccess({ accountId: account.id, host, domain: host, site });
  }
  // Keep the site id on the account for the popup; a live session is the cheapest possible proof
  // of which site this dashboard signed us into.
  if (String(account.siteId || '') !== String(site.siteId)) {
    await store.noteSite({ accountId: account.id, site, domain: host });
  }
  await setBadge(null);
  return {
    ok: true,
    alreadySignedIn: true,
    email: account.email,
    siteId: site.siteId,
    portalUrl: site.portalUrl,
    dashboardUrl: dashboardUrlFor(site.portalUrl, site.siteId),
    entryUrl: entryUrlFor(site.portalUrl, site.siteId)
  };
}

/**
 * The site this account already owns on this dashboard, if anything is known.
 *
 * `siteId` is recorded on the account when a sign-in succeeds, so after the first login this is a
 * free, offline answer — and it is the account's site, not whatever a URL happens to say.
 */
function knownSiteFor(account, host) {
  if (!account || !account.siteId) return null;
  let portalHost = null;
  try {
    portalHost = account.portalUrl ? new URL(account.portalUrl).host.toLowerCase() : null;
  } catch {
    portalHost = null;
  }
  // A recorded site for a *different* host says nothing about this one.
  if (portalHost && portalHost !== host) return null;
  return { siteId: String(account.siteId), portalUrl: account.portalUrl || dashboardOriginFor(host) };
}

/**
 * Decides which site this attempt is for — and what still needs proving before signing in for it.
 *
 * The dashboard's URL (`/ui/{siteId}/…`) names a site, and for a long time that was taken as the
 * authoritative answer: quick, and no route lookup. But a URL can name *any* site id —
 * `/ui/10012/` on `livechat6dash` is a real site of that branch and yet belongs to somebody else —
 * while `jwtToken/login` hands out a token for it to any account that asks. The panel then rejects
 * that token on every API call and reloads itself, which is the "jumps to login forever" loop.
 *
 * The site the account is *recorded* for always wins. Anything else is returned as a `gate` — a
 * claim that must be settled before a sign-in, but which must not stand in the way of recognising a
 * session that already exists: a live session for the site is proof, not a claim.
 *
 * Returns `{ site, gate?, resolved? }`, or `{ site: null, reason, message }` when there is nothing
 * to check a session for at all.
 */
async function resolveSite({ state, account, targetHost, routeBase, urlSiteId, tabOrigin, settings }) {
  const known = knownSiteFor(account, targetHost) || store.getCachedRoute(state, targetHost, account.email);

  if (!urlSiteId) {
    if (known) return { site: known };
    return lookupSite({ account, targetHost, routeBase, partnerId: settings.partnerId });
  }

  const asked = { siteId: String(urlSiteId), portalUrl: tabOrigin };

  if (known) {
    if (String(known.siteId) === String(urlSiteId)) return { site: known };
    return {
      site: asked,
      gate: {
        kind: 'mismatch',
        requestedSiteId: String(urlSiteId),
        recordedSiteId: String(known.siteId),
        email: account.email,
        message: `${targetHost} has ${account.email} on site ${known.siteId}, not site ${urlSiteId}. Sign in by hand to add a credential for ${urlSiteId}.`
      }
    };
  }

  // Nothing recorded for this credential on this dashboard, so the URL's claim is all there is.
  return { site: asked, gate: { kind: 'confirm-url', requestedSiteId: String(urlSiteId) } };
}

/**
 * Settles a gate. `null` means the sign-in may go ahead.
 *
 * Only ever called once a sign-in is actually needed — see the ordering in runEnsureAuth.
 */
async function checkGate(gate, { account, targetHost, routeBase, settings }) {
  if (!gate) return null;
  if (gate.kind === 'mismatch') {
    return { ok: false, reason: 'site-mismatch', ...gate };
  }

  // `confirm-url`: ask the route service — the only authority on which sites an email belongs to.
  const lookup = await getByEmail(routeBase, account.email, settings.partnerId);
  const answered =
    Array.isArray(lookup.sites) ||
    // `100` is "no such email", which is an answer too — and a negative one.
    lookup.errorCode === 100;
  if (!answered) {
    // Could not ask (offline, 5xx). The URL is the only hint left, and the storm and redirect
    // budgets bound what a wrong guess can cost.
    note('site-unverified', `${targetHost}: could not confirm the URL's site (${lookup.errorMessage || 'no answer'})`);
    return null;
  }
  if (ownsSiteOnHost(lookup, targetHost, gate.requestedSiteId)) return null;

  const owned = normalizeSite(pickSite(lookup, targetHost));
  if (!owned) {
    return {
      ok: false,
      reason: 'no-route',
      errorCode: lookup.errorCode,
      message: lookup.errorMessage || `${targetHost} has no site for ${account.email}.`
    };
  }
  return {
    ok: false,
    reason: 'site-mismatch',
    requestedSiteId: String(gate.requestedSiteId ?? ''),
    accountSiteId: null,
    ownedSiteId: owned.siteId,
    email: account.email,
    message: `${targetHost} does not serve the site this page asked for for ${account.email} — its site here is ${owned.siteId}. Signing in for it would hand the dashboard a session it rejects.`
  };
}


/** Resolves the site from the route service alone (no site id in the URL to go on). */
async function lookupSite({ account, targetHost, routeBase, partnerId }) {
  const lookup = await getByEmail(routeBase, account.email, partnerId);
  const normalized = normalizeSite(pickSite(lookup, targetHost));
  if (!normalized) {
    return {
      site: null,
      reason: 'no-route',
      errorCode: lookup.errorCode,
      message: lookup.errorMessage || 'Could not resolve the Comm100 site for this email.'
    };
  }
  return { site: normalized, resolved: true };
}

async function runEnsureAuth({
  targetHost,
  routeBase,
  tabId,
  force,
  userInitiated,
  urlSiteId,
  minRemainingMs = 0,
  forceRefresh = false,
  rejectedToken = null,
  ignoreCooldown = false
}) {
  const state = await store.getState();
  const settings = state.settings;

  const account = store.pickAccount(state, targetHost, urlSiteId);
  if (!account) {
    // Worth saying out loud, because doing nothing looks exactly like a broken extension. The two
    // reasons are worth telling apart: nothing saved for this dashboard at all, or nothing saved for
    // the *site* this URL names — in which case signing in by hand is the answer, and it is the one
    // thing we deliberately do not do for the user.
    const elsewhere = Array.from(new Set(store.usableAccounts(state).map((a) => a.domain).filter(Boolean)));
    const othersHere = urlSiteId ? store.otherSitesOn(state, targetHost, urlSiteId) : [];
    const refusal = {
      ok: false,
      reason: 'no-account',
      domain: targetHost,
      requestedSiteId: urlSiteId ? String(urlSiteId) : null,
      message: urlSiteId
        ? `No saved credential for site ${urlSiteId} on ${targetHost}.` +
          (othersHere.length ? ` Saved here: ${othersHere.join(', ')}.` : '') +
          ' Sign in by hand once and it will be remembered.'
        : elsewhere.length
          ? `No saved account for ${targetHost}. Saved: ${elsewhere.join(', ')}`
          : `No saved account for ${targetHost}.`
    };
    await store.noteRefusal(targetHost, { reason: refusal.reason, siteId: refusal.requestedSiteId, message: refusal.message });
    return refusal;
  }

  // The dashboard's own origin, so `http://localhost:34500` is not silently turned into https.
  const tabOrigin = dashboardOriginFor(targetHost);

  const resolution = await resolveSite({ state, account, targetHost, routeBase, urlSiteId, tabOrigin, settings });
  if (!resolution.site) {
    // Not even a site to look for a session under.
    await store.noteRefusal(targetHost, { ...resolution, siteId: resolution.requestedSiteId ?? null });
    return { ok: false, reason: resolution.reason, ...resolution };
  }
  const site = resolution.site;

  // A decision is worth remembering: it is the authority the next visit is checked against.
  if (resolution.resolved) await store.putRoute(targetHost, account.email, site);

  const current = await hasSession(site.portalUrl, site.siteId);
  // A session that is valid but about to lapse does not satisfy a renewal request, or the
  // keep-alive would keep reporting "already signed in" until it expired on the page.
  // `forceRefresh` also ignores a session the server has already rejected (a 401 while the cookie
  // still looked fine locally).
  const lapsing =
    current.ok &&
    ((forceRefresh && (!rejectedToken || await tokenFor(targetHost, site.siteId) === rejectedToken)) ||
      (minRemainingMs > 0 && current.expiresAt !== null && current.expiresAt - Date.now() < minRemainingMs));
  if (current.ok && !lapsing) {
    // Deliberately before the gate below. A live session for this site is *proof* — of the password,
    // and of which site this credential belongs to — so a claim that has not been checked yet must
    // not stand in the way of recognising it. Gates exist to stop logins, nothing else.
    rememberSession(targetHost, site.siteId, current.expiresAt);
    return alreadySignedIn(state, account, site, targetHost);
  }

  const hs = state.hostState[targetHost] || {};
  // A rejected password is not something a retry can fix, and every retry spends an attempt against
  // the account lockout — so only a human may override a pause or a deliberate sign-out.
  if (!userInitiated) {
    if (hs.paused) return { ok: false, reason: 'paused', failures: hs.consecutiveFailures || 0, email: account.email };
    if (store.isSuppressed(state, targetHost)) return { ok: false, reason: 'logged-out', email: account.email };
  }
  // The cooldown exists to stop background retries hammering the API. A navigation or an API call
  // the user actually triggered is not a background retry, so callers acting on one pass `force` —
  // otherwise the watchdog's own replant would lock out the very request that came to rescue it.
  if (!force && !userInitiated && !ignoreCooldown && store.isCoolingDown(state, targetHost)) {
    return { ok: false, reason: 'cooldown', email: account.email };
  }

  // A sign-in is genuinely about to happen, so now the claim is settled: nothing is attempted for a
  // site this credential cannot work on, so the dashboard is never fed a session it will reject —
  // which is exactly what a reload loop is made of.
  const blocked = await checkGate(resolution.gate, { account, targetHost, routeBase, settings });
  if (blocked) {
    await store.noteRefusal(targetHost, { ...blocked, siteId: blocked.requestedSiteId ?? urlSiteId });
    return blocked;
  }

  log('signing in', targetHost, account.email, 'site', site.siteId);
  await store.noteAttempt(targetHost);
  await setBadge('...');

  const login = await jwtLogin(site.portalUrl, {
    email: account.email,
    password: store.effectivePassword(account),
    siteId: site.siteId
  });

  if (needsSecondFactor(login) && !login.jwtToken) {
    await setBadge(null);
    return {
      ok: false,
      reason: 'mfa',
      needsManual: true,
      email: account.email,
      password: store.effectivePassword(account),
      siteId: site.siteId,
      portalUrl: site.portalUrl,
      message: 'This account needs two-factor verification.'
    };
  }

  if (!login.jwtToken || (login.errorCode && login.errorCode !== 0)) {
    const failure = await store.markFailure(targetHost);
    await setBadge(failure.paused ? '!' : null);
    return {
      ok: false,
      reason: login.errorCode === 101 ? 'bad-credentials' : 'api-error',
      needsManual: true,
      email: account.email,
      // No password: it was just rejected, so pre-filling it would only repeat the failure.
      errorCode: login.errorCode,
      failures: failure.failures,
      paused: failure.paused,
      message: login.errorMessage || 'Sign-in failed.'
    };
  }

  // Plant the cookie first and let the server-side bookkeeping follow. The page only needs the
  // cookie, and the JWT is self-contained (an authenticated endpoint accepts it without this call),
  // so awaiting it here would only add a round trip to the critical path.
  crossPlatformLogin(site.portalUrl, login.jwtToken, site.siteId).catch((err) => {
    log('CrossPlatformLogin failed, but the cookie is already planted', err);
  });
  const planted = await ensureSessionCookies(site.portalUrl, site.siteId, login.jwtToken, login.expireTime, {
    force: lapsing
  });

  if (!planted.ok) {
    const failure = await store.markFailure(targetHost);
    await setBadge(failure.paused ? '!' : null);
    return {
      ok: false,
      reason: 'cookie-not-planted',
      needsManual: true,
      email: account.email,
      password: store.effectivePassword(account),
      siteId: site.siteId,
      portalUrl: site.portalUrl,
      failures: failure.failures,
      message: 'Signed in, but the session cookie could not be stored.'
    };
  }

  await store.markSuccess({
    accountId: account.id,
    host: targetHost,
    domain: targetHost,
    site: { ...site, lastEmail: account.email }
  });
  rememberSession(targetHost, site.siteId, planted.session && planted.session.expiresAt, login.jwtToken);
  await setBadge(null);
  log('signed in', targetHost, account.email, 'site', site.siteId, 'planted', planted.planted);

  return {
    ok: true,
    alreadySignedIn: false,
    planted: planted.planted,
    email: account.email,
    siteId: site.siteId,
    portalUrl: site.portalUrl,
    dashboardUrl: dashboardUrlFor(site.portalUrl, site.siteId),
    entryUrl: entryUrlFor(site.portalUrl, site.siteId),
    expiresAt: planted.session && planted.session.expiresAt
  };
}

// ---------------------------------------------------------------- logout

/**
 * Signing out.
 *
 * Removing the session cookies IS the logout: the control panel decides whether it is signed in
 * purely by looking for `token_{siteId}`, so once the cookies are gone the next navigation lands
 * on /login.
 *
 * `POST /api/login/accounts/logout` exists but belongs to the login service and rejects a
 * JWT-cookie session with 401 AuthenticationFailed (verified against a live session), so it is
 * attempted best-effort only — never depended on. The JWT itself stays valid until its `exp`
 * (~2 hours) even after logout, so this is a client-side sign-out, not server-side revocation.
 */
async function logout(origin, host) {
  if (!origin) return { ok: false, reason: 'no-origin' };

  let apiOk = false;
  let status = 0;
  try {
    const res = await fetch(`${origin}/api/login/accounts/logout`, {
      method: 'POST',
      credentials: 'include',
      redirect: 'manual',
      cache: 'no-store'
    });
    status = res.status;
    // status 0 == opaque redirect (the usual "logged out, now go to /login" response)
    apiOk = res.status === 0 || (res.status >= 200 && res.status < 400);
  } catch (err) {
    log('logout request failed, clearing cookies anyway', err);
  }

  if (host) {
    await store.noteLogout(String(host).toLowerCase());
    const ids = ruleIds.get(String(host).toLowerCase());
    if (ids && chrome.declarativeNetRequest) {
      await headerRulesReady;
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [ids.set, ids.allow] });
      publishedHeaders.delete(String(host).toLowerCase());
    }
    await setBadge(null);
  }
  const removed = await clearSessionCookies(origin);
  log('logged out', origin, 'apiOk', apiOk, 'removed', removed);
  return { ok: removed.length > 0 || apiOk, apiOk, status, removed };
}

// ---------------------------------------------------------------- credential capture

/**
 * Credentials typed into the sign-in form.
 *
 * These are recorded as *pending* and deliberately not verified with an extra API call: the user
 * has just spent one sign-in attempt, and Comm100 locks an account once failed attempts exceed the
 * site's password policy, so duplicating every attempt would halve the budget. The password is
 * promoted as soon as something proves it works — a live session, or a later successful login.
 *
 * The site is deliberately not recorded from the URL: which site an email uses on a dashboard is
 * the route service's answer, not the address bar's claim, and it is learned the moment the
 * sign-in these credentials produce succeeds.
 */
async function captureCredentials({ host, hostname, domain, email, password }) {
  const targetHost = String(hostname || host || '').toLowerCase();
  if (!targetHost || !email || !password) return { ok: false, reason: 'incomplete' };

  const targetDomain = resolveDomain(domain, null, targetHost);
  const accountId = await store.captureCredentials({ email, password, host: targetDomain, domain: targetDomain });
  return { ok: true, accountId, domain: targetDomain, pending: true };
}

/** Explicit verification, used by the popup's "Save & verify" button. */
async function verifyAccount(accountId, fallbackHost) {
  const state = await store.getState();
  const account = state.accounts.find((a) => a.id === accountId);
  if (!account || !account.pendingPassword) return null;

  // The account's own domain decides where to verify, not the tab the popup happens to be open on:
  // a credential can be added for a dashboard the user is not currently looking at.
  const targetDomain = store.normalizeDomain(account.domain) || store.normalizeDomain(fallbackHost);
  const routeBase = routeOriginFor(targetDomain);
  if (!routeBase) {
    await store.resolvePending({ accountId, ok: false });
    return null;
  }

  // The site is whatever the route service says this email uses here — the user is never asked to
  // type one. A site already learned from a previous sign-in is trusted outright; otherwise the
  // route service is asked, and its answer is cached for the next time.
  const wantedSite = store.normalizeSiteId(account.siteId);
  let site = wantedSite
    ? { siteId: wantedSite, portalUrl: account.portalUrl || dashboardOriginFor(targetDomain) }
    : store.getCachedRoute(state, targetDomain, account.email);
  if (!site) {
    const lookup = await getByEmail(routeBase, account.email, state.settings.partnerId);
    site = normalizeSite(pickSite(lookup, targetDomain));
  }
  if (!site) {
    await store.resolvePending({ accountId, ok: false });
    return null;
  }
  await store.putRoute(targetDomain, account.email, site);

  const login = await jwtLogin(site.portalUrl, {
    email: account.email,
    password: account.pendingPassword,
    siteId: site.siteId
  });
  const ok = Boolean(login.jwtToken) && !login.errorCode;
  await store.resolvePending({ accountId, ok });
  // Remember the site even when the password was rejected: "wrong password for site 10010" is a
  // more useful record than "wrong password".
  if (ok) await store.noteSite({ accountId, site, domain: targetDomain });
  log('verified credentials', account.email, targetDomain, ok ? 'verified' : `rejected (${login.errorCode})`);
  return { ok, siteId: site.siteId, errorCode: login.errorCode, errorMessage: login.errorMessage };
}

// ---------------------------------------------------------------- badge

async function setBadge(text) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: text === '!' ? '#c62828' : '#0077cc' });
    await chrome.action.setBadgeText({ text: text || '' });
  } catch {
    // action may be unavailable in some contexts
  }
}

// ---------------------------------------------------------------- pre-flight

/**
 * Cheap, local-only answer to "would ensureAuth actually sign in right now?".
 *
 * The content script asks this *before* starting a sign-in so it can cover the form while the
 * attempt is in flight. No network: storage plus at most two cookie reads.
 */
async function canAutoLogin({ host, hostname, domain = null, siteId = null, url = null }) {
  const targetHost = resolveDomain(domain, url, hostname || host);
  if (!targetHost || !isSupportedHost(targetHost) || !routeOriginFor(targetHost))
    return { eligible: false, reason: 'unsupported-host' };

  const state = await store.getState();

  const urlSiteId = siteId || siteIdFromUrl(url);

  // Matched by credential scope *and* site, exactly as ensureAuth does: an account recorded for
  // another site on this dashboard is not a candidate, so the form is never covered while the
  // answer is "sign in by hand".
  const account = store.pickAccount(state, targetHost, urlSiteId);
  if (!account) return { eligible: false, reason: 'no-account' };

  const hs = state.hostState[targetHost] || {};
  if (hs.paused) return { eligible: false, reason: 'paused' };
  if (store.isSuppressed(state, targetHost)) return { eligible: false, reason: 'logged-out' };

  const known = knownSiteFor(account, targetHost) || store.getCachedRoute(state, targetHost, account.email);
  // Mirrors resolveSite() without the network. The one asymmetry is deliberate — ensureAuth may
  // still confirm a claim with the route service, and covering the form for an attempt that then
  // refuses is the flicker worth avoiding.
  const mismatched = urlSiteId && known && String(known.siteId) !== String(urlSiteId);
  const site = mismatched
    ? null
    : urlSiteId
      ? { siteId: String(urlSiteId), portalUrl: dashboardOriginFor(targetHost) }
      : known;

  // Only claim eligibility when the site is known and every gate ensureAuth applies is open —
  // otherwise the content script would hide the form for an attempt that never happens, which is
  // a worse flicker than the one we are trying to remove.
  if (!site) return { eligible: false, reason: mismatched ? 'site-mismatch' : 'unresolved' };
  if (store.isCoolingDown(state, targetHost)) return { eligible: false, reason: 'cooldown' };

  const session = await hasSession(site.portalUrl, site.siteId);
  if (session.ok) return { eligible: false, reason: 'signed-in' };

  return { eligible: true, email: account.email, siteId: site.siteId };
}

// ---------------------------------------------------------------- keep-alive

const KEEP_ALIVE_ALARM = 'comm100-keep-alive';
const KEEP_ALIVE_PERIOD_MINUTES = 15;
/** Refresh once less than this is left, so a navigation never arrives without a live cookie. */
const REFRESH_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * Silently renews sessions before they lapse. This is what keeps the sign-in page from ever
 * appearing during normal browsing: the cookie is already valid when the page asks for it.
 */
async function keepSessionsFresh() {
  const state = await store.getState();

  // Route keys are credential scopes, so they carry the port where there is one.
  for (const host of Object.keys(state.routes || {})) {
    if (!isSupportedHost(host) || !routeOriginFor(host)) continue;
    if (store.isSuppressed(state, host)) continue;
    if ((state.hostState[host] || {}).paused) continue;

    const site = Object.values(state.routes[host] || {}).find((route) => route && route.siteId);
    if (!site) continue;
    if (await isSessionPruned(host, site.siteId)) continue;

    const account = store.pickAccount(state, host, site.siteId);
    if (!account) continue;

    const remaining = await sessionRemainingMs(site.portalUrl || dashboardOriginFor(host), site.siteId);
    if (remaining === null || remaining > REFRESH_THRESHOLD_MS) continue;

    log('refreshing session for', host, 'site', site.siteId, 'remaining(ms)', remaining);
    await ensureAuth({
      hostname: host,
      domain: host,
      siteId: site.siteId,
      minRemainingMs: REFRESH_THRESHOLD_MS
    }).catch((err) => log('refresh failed', err));
  }
}

function scheduleKeepAlive() {
  try {
    chrome.alarms.create(KEEP_ALIVE_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: KEEP_ALIVE_PERIOD_MINUTES
    });
  } catch (err) {
    log('could not schedule keep-alive', err);
  }
}

// ---------------------------------------------------------------- cookie watchdog

const REPLANT_DEBOUNCE_MS = 5000;
/** A deliberate sign-out navigates to /login first; do not fight it. */
const SIGN_OUT_GUARD_MS = 5000;

const lastReplantAt = new Map();
const recentLoginNav = new Map();

/**
 * Puts the session cookie back the moment it disappears.
 *
 * This is what makes the whole thing transparent: delete `token_10008` by hand and the worker has
 * it back a moment later, so a reload — or the control panel's own next request — still finds a
 * signed-in browser and never routes to /login in the first place.
 */
async function replantRemovedToken(cookie) {
  const siteId = cookie.name.slice('token_'.length);
  if (await isSessionPruned(cookie.domain, siteId)) return;
  const state = await store.getState();
  const domain = String(cookie.domain || '').replace(/^\./, '');
  const now = Date.now();

  for (const host of Object.keys(state.routes || {})) {
    if (registrableDomain(host) !== domain) continue;
    if (!routeMatchesSite(state.routes[host], siteId)) continue;
    if (store.isSuppressed(state, host)) continue;
    if ((state.hostState[host] || {}).paused) continue;
    // Only re-plant for a dashboard that actually holds a credential; otherwise the cookie for
    // site 10010 reappears on every branch that happens to share the cookie domain.
    if (!store.pickAccount(state, host, siteId)) continue;
    if (now - (lastReplantAt.get(host) || 0) < REPLANT_DEBOUNCE_MS) continue;
    if (now - (recentLoginNav.get(host) || 0) < SIGN_OUT_GUARD_MS) continue;

    lastReplantAt.set(host, now);
    note('cookie-removed', `site ${siteId} on ${host} — re-planting`);
    log('token cookie for site', siteId, 'was removed; re-planting for', host);
    ensureAuth({ hostname: host, domain: host, siteId }).catch((err) => log('re-plant failed', err));
  }
}

function routeMatchesSite(byEmail, siteId) {
  return Object.values(byEmail || {}).some((route) => route && String(route.siteId) === String(siteId));
}

function watchCookies() {
  if (!chrome.cookies || !chrome.cookies.onChanged) return;
  chrome.cookies.onChanged.addListener((change) => {
    if (!change || !change.removed || !change.cookie) return;
    if (!TOKEN_RE.test(change.cookie.name)) return;
    replantRemovedToken(change.cookie).catch((err) => log('cookie watchdog failed', err));
  });
}

// ---------------------------------------------------------------- auth-failure middleware

/**
 * The closest thing MV3 allows to "intercept the request, re-login and resend".
 *
 * A service worker cannot block, modify or replay a request the page made — blocking `webRequest`
 * is enterprise-only and `declarativeNetRequest` cannot set cookies. What it *can* do is watch for
 * the rejection: the moment any Comm100 API call comes back 401/403, the session is gone or was
 * invalidated server-side, so sign in again and put a fresh cookie in the jar. The SPA's next
 * request carries it, and it never reaches the point of routing to /login.
 *
 * This is the backstop, not the main defence: the keep-alive renews ~30 minutes before the JWT
 * lapses, so a 401 should be rare — it means the cookie was rejected while it still looked valid.
 */
const AUTH_FAILURE_STATUSES = new Set([401, 403]);
const AUTH_FAILURE_DEBOUNCE_MS = 2000;
/** A token this close to expiry is treated as gone. */
const JWT_SKEW_MS = 60000;
/** Bounds a reload loop if an endpoint rejects for a reason signing in cannot fix. */
const MAX_REAUTH_PER_WINDOW = 3;
const REAUTH_WINDOW_MS = 60000;

const lastAuthFailureAt = new Map();
const reauthHistory = new Map();

/** Every dashboard family the extension watches. Must stay in step with manifest host_permissions. */
const WATCHED_URLS = [
  'https://*.comm100dev.io/*',
  'https://*.comm100.io/*',
  'https://*.comm100staging.com/*',
  'http://localhost/*'
];

function watchApiResponses() {
  if (!chrome.webRequest || !chrome.webRequest.onCompleted) return;
  chrome.webRequest.onCompleted.addListener(
    (details) => {
      if (!AUTH_FAILURE_STATUSES.has(details.statusCode)) return;
      let parsed;
      try {
        parsed = new URL(details.url);
      } catch {
        return;
      }
      const host = parsed.host.toLowerCase();
      if (!isSupportedHost(host) || !routeOriginFor(host)) return;
      if (!parsed.pathname.startsWith('/api/')) return;
      if (parsed.pathname.toLowerCase().startsWith('/api/login/')) return;
      if (guardedFrames.has(frameKey(details))) return;
      handleAuthFailure(host, details.url).catch((err) => log('auth-failure handling failed', err));
    },
    { urls: WATCHED_URLS }
  );
}

/**
 * Deliberately empty of side effects.
 *
 * A failed request cannot be replayed, and the obvious next move — reloading the page — is exactly
 * the thing not to do: it throws away whatever the user was doing. With the CDP path the token is
 * attached before the request leaves, so a 401 should not happen in the first place; when it does
 * (the debugger is off, or absent) the fresh cookie is in the jar and the panel's *next* request
 * simply succeeds. The user retries when they are ready, not when we decide.
 */
function noteReauthComplete(host) {
  log('session restored for', host, '- leaving the page alone');
}

/**
 * Reads the session straight out of the request that is about to be sent.
 *
 * `onBeforeSendHeaders` is the last moment we see a request before it leaves, and unlike the
 * response it tells us the token *before* the server rejects it — so the sign-in starts a full
 * round trip earlier than the 401 would allow. Non-blocking access means the Cookie header cannot
 * be rewritten in place, which is exactly why this starts a sign-in instead of patching the call.
 */
function watchOutgoingRequests() {
  if (!chrome.webRequest || !chrome.webRequest.onBeforeSendHeaders) return;
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      let parsed;
      try {
        parsed = new URL(details.url);
      } catch {
        return;
      }
      const host = parsed.host.toLowerCase();
      if (!isSupportedHost(host) || !routeOriginFor(host)) return;
      if (!parsed.pathname.startsWith('/api/')) return;
      // The sign-in calls themselves carry no session, so they are not evidence of a bad one.
      if (parsed.pathname.startsWith('/api/login/')) return;
      if (guardedFrames.has(frameKey(details))) return;

      const cookieHeader = (details.requestHeaders || [])
        .filter((header) => header.name && header.name.toLowerCase() === 'cookie')
        .map((header) => header.value || '')
        .join('; ');
      const match = cookieHeader.match(/(?:^|;\s*)token_(\d+)=([^;]*)/);
      if (match && isJwtFresh(decodeURIComponent(match[2]), JWT_SKEW_MS)) return;

      handleAuthFailure(host, details.url, {
        siteId: match ? match[1] : null
      }).catch((err) => log('pre-flight re-auth failed', err));
    },
    { urls: WATCHED_URLS },
    ['requestHeaders']
  );
}

async function handleAuthFailure(host, url, { siteId = null } = {}) {
  const now = Date.now();
  const recent = (reauthHistory.get(host) || []).filter((at) => now - at < REAUTH_WINDOW_MS);
  reauthHistory.set(host, recent);
  if (recent.length >= MAX_REAUTH_PER_WINDOW) return;
  if (now - (lastAuthFailureAt.get(host) || 0) < AUTH_FAILURE_DEBOUNCE_MS) return;

  const state = await store.getState();
  if (store.isSuppressed(state, host)) return;
  const hs = state.hostState[host] || {};
  if (hs.paused) return;

  // A site this credential does not own will not start working because a 401 asked again. The
  // refusal is already on record; repeating it would only re-ask the route service every 2 s.
  const requested = siteId || siteIdFromUrl(url);
  const refusal = hs.lastRefusal;
  if (
    refusal &&
    refusal.reason === 'site-mismatch' &&
    requested &&
    String(refusal.siteId) === String(requested)
  ) {
    return;
  }
  if (!store.pickAccount(state, host, requested)) return;

  lastAuthFailureAt.set(host, now);
  recent.push(now);
  note('401', `${url} — signing in again, page untouched`);
  log('session rejected for', host, '-> signing in again, without touching the page');

  const result = await ensureAuth({
    hostname: host,
    domain: host,
    siteId: requested,
    url,
    force: true,
    forceRefresh: true
  });

  if (result && result.ok) {
    // The debounce is cleared — a 401 arriving after a *successful* sign-in is new information
    // (the fresh token was rejected too), and throttling it would only hide the problem.
    // The history deliberately is not: if successes kept clearing the budget, a dashboard that
    // rejects every token we hand it would re-sign-in forever, which is exactly the loop this cap
    // exists to stop. The window expires on its own.
    lastAuthFailureAt.delete(host);
    noteReauthComplete(host);
  } else {
    log('re-authentication failed:', result && result.reason);
  }
}

// ---------------------------------------------------------------- early start

// Static files fail before the application's fetch/XHR hooks can help. MV3 observers cannot
// replay a script or stylesheet into its original loader, so repair cookies and reload the tab.
// Persist the retry guard: a worker restart or a page full of failing assets must not loop.
const STATIC_RECOVERY_KEY = 'comm100StaticRecovery';
const STATIC_RECOVERY_WINDOW_MS = 60000;
let staticRecoveryQueue = Promise.resolve();

function watchStaticResponses() {
  if (!chrome.webRequest?.onCompleted) return;
  chrome.webRequest.onCompleted.addListener((details) => {
    if (details.tabId < 0 || details.frameId !== 0 || details.method !== 'GET' ||
        ![400, 431].includes(details.statusCode)) return;
    const htmlError = (details.responseHeaders || []).some((h) =>
      h.name.toLowerCase() === 'content-type' && /text\/html/i.test(h.value || ''));
    if (details.statusCode === 400 && !htmlError) return;
    staticRecoveryQueue = staticRecoveryQueue.then(() => recoverStaticRequest(details))
      .catch((err) => log('static-file cookie recovery failed', err));
  }, {
    urls: WATCHED_URLS,
    types: ['main_frame', 'script', 'stylesheet', 'image', 'font', 'media']
  }, ['responseHeaders']);
}

async function recoverStaticRequest(details) {
  const target = new URL(details.url);
  if (!isSupportedHost(target.host)) return;
  const tab = await chrome.tabs.get(details.tabId);
  const page = new URL(tab.url);
  if (details.type === 'main_frame' && page.href !== target.href) return;
  // The failed response may belong to a page the user has already left.
  if (registrableDomain(page.hostname) !== registrableDomain(target.hostname)) return;
  const saved = await chrome.storage.local.get(STATIC_RECOVERY_KEY);
  const recoveries = saved[STATIC_RECOVERY_KEY] || {};
  const key = `${details.tabId}|${page.host}`;
  if (Date.now() - (recoveries[key] || 0) < STATIC_RECOVERY_WINDOW_MS) return;
  const before = cookieHeaderBytes(await getAllCookies(target.href));
  // webRequest does not expose the response body. For a generic 400, require both an HTML
  // error response and cookie pressure. Never reload on ordinary small-cookie API errors.
  if (details.statusCode === 400 && before <= COOKIE_HEADER_BUDGET_BYTES) return;
  const state = await store.getState();
  const siteId = siteIdFromUrl(details.type === 'main_frame' ? target.href : page.href);
  const account = store.pickAccount(state, page.host, siteId);
  const keepSiteId = siteId || knownSiteFor(account, page.host)?.siteId;
  const result = await trimSessionCookies(target.href, keepSiteId, { force: details.statusCode === 431 });
  if (result.afterBytes >= result.beforeBytes) {
    note('cookie-budget', `${target.host}: ${result.beforeBytes} bytes; cannot reduce without removing the current session or unrelated cookies`);
    return;
  }
  // Discard expired retry records so this map remains bounded as tabs are opened and closed.
  const now = Date.now();
  const recent = Object.fromEntries(Object.entries(recoveries).filter(([, at]) => now - at < STATIC_RECOVERY_WINDOW_MS));
  recent[key] = now;
  await chrome.storage.local.set({ [STATIC_RECOVERY_KEY]: recent });
  note('cookie-budget', `${target.host}: ${result.beforeBytes} -> ${result.afterBytes} bytes; removed sites ${result.removedSiteIds.join(', ')}; retrying page once`);
  // Check again after async cookie work; never reload a different page opened in this tab.
  const current = await chrome.tabs.get(details.tabId);
  if (current.url === tab.url) await chrome.tabs.reload(details.tabId);
}

/**
 * Begin signing in as soon as the navigation is known, rather than waiting for the document.
 * Comm100's control panel is a SPA that only checks for its cookie after loading a large bundle,
 * so starting here usually wins the race and the page renders authenticated on the first paint.
 */
function watchNavigations() {
  if (!chrome.webNavigation || !chrome.webNavigation.onBeforeNavigate) return;
  chrome.webNavigation.onBeforeNavigate.addListener((details) => {
    if (details.frameId !== 0) return;
    let parsed;
    try {
      parsed = new URL(details.url);
    } catch {
      return;
    }
    const host = parsed.host.toLowerCase();
    if (!isSupportedHost(host) || !routeOriginFor(host)) return;

    // Remember deliberate trips to the sign-in page so the cookie watchdog does not undo a
    // sign-out the user just performed through the control panel.
    if (parsed.pathname === '/' || /^\/login(\/|$)/i.test(parsed.pathname)) {
      recentLoginNav.set(host, Date.now());
    }

    const siteId = siteIdFromUrl(details.url);
    if (!siteId) return;
    ensureAuth({ hostname: host, domain: host, siteId, tabId: details.tabId, url: details.url }).catch(() => {});
  });
}

// ---------------------------------------------------------------- request header rewriting

/**
 * Attaches the session to the panel's API calls.
 *
 * The control panel authenticates with `Authorization: Bearer <token>` (its repositories call
 * `sendHttpRequest({ auth: this.token })`), so re-planting the cookie alone is not enough — the
 * panel keeps sending whatever token it already had, and every call 401s no matter what is in the
 * cookie jar. `declarativeNetRequest` lets us substitute the header on the way out.
 *
 * This replaced a `chrome.debugger`/CDP implementation. That approach could not attach while
 * DevTools was open — which is exactly how a cookie gets cleared by hand — and when it failed it
 * said so only on a console nobody was reading. DNR needs no attach, shows no infobar, and works
 * whether or not DevTools is running.
 *
 * The panel's sign-in endpoints must not carry a stale bearer, so a higher-priority `allow` rule
 * exempts them.
 */
const DNR_RULE_BASE = 90000;
const ruleIds = new Map(); // host -> { set, allow }
const publishedHeaders = new Map();

function rulesFor(host) {
  let ids = ruleIds.get(host);
  if (!ids) {
    const base = DNR_RULE_BASE + ruleIds.size * 2;
    ids = { allow: base, set: base + 1 };
    ruleIds.set(host, ids);
  }
  return ids;
}

async function publishSessionHeader(host, jwt) {
  if (!chrome.declarativeNetRequest || !jwt) return;
  await headerRulesReady;
  if (publishedHeaders.get(host) === jwt) return;
  const { set, allow } = rulesFor(host);
  const rules = [
    {
      id: allow,
      priority: 2,
      action: { type: 'allow' },
      condition: { urlFilter: `||${host}/api/login/`, resourceTypes: ['xmlhttprequest'] }
    },
    {
      id: set,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'authorization', operation: 'set', value: `Bearer ${jwt}` }]
      },
      condition: { urlFilter: `||${host}/api/`, resourceTypes: ['xmlhttprequest'] }
    }
  ];
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [set, allow], addRules: rules });
    publishedHeaders.set(host, jwt);
    note('header-rule', `Authorization attached to ${host}/api/*`);
  } catch (err) {
    note('header-rule', `FAILED for ${host}: ${(err && err.message) || err}`);
    log('could not publish the header rule for', host, err);
  }
}

/** Dynamic rules survive a reload but our bookkeeping does not, so start from a clean slate. */
async function resetHeaderRules() {
  if (!chrome.declarativeNetRequest) return;
  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const ours = existing.filter((rule) => rule.id >= DNR_RULE_BASE).map((rule) => rule.id);
    if (ours.length) await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ours });
  } catch (err) {
    log('could not reset header rules', err);
  }
}

// ---------------------------------------------------------------- lifecycle

chrome.runtime.onInstalled.addListener(() => {
  store.getState().catch(() => {});
  setBadge(null);
  scheduleKeepAlive();
});

chrome.runtime.onStartup.addListener(() => {
  scheduleKeepAlive();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEP_ALIVE_ALARM) keepSessionsFresh().catch((err) => log('keep-alive failed', err));
});

const headerRulesReady = resetHeaderRules();
watchNavigations();
watchCookies();
watchOutgoingRequests();
watchApiResponses();
watchStaticResponses();
scheduleKeepAlive();
