/**
 * Comm100 login API.
 *
 * All three calls were verified against livechat6dash.testing.comm100dev.io:
 *
 *   1. GET  https://{branch}route.testing.comm100dev.io/api/v1/router/agents/getByEmail?email=…
 *      -> { errorCode?: 100, sites: [{ siteId, portalUrl, apiUrl, partnerId, subDomain, customDomain, … }] }
 *
 *   2. POST {portalUrl}/api/login/jwtToken/login   { email, password, siteId }
 *      -> success: { jwtToken, siteId, expireTime, errorCode: 0, … }
 *      -> bad credentials: HTTP 200 + { errorCode: 101, errorMessage: "Incorrect email or password." }
 *      -> MFA required: showVerificationCode / nextStep indicate it (no jwtToken)
 *
 *   3. POST {portalUrl}/api/login/accounts/CrossPlatformLogin   { token, siteId }
 *      -> { errorCode: 0 } and Set-Cookie for token_{siteId}, tokenExpire_{siteId}, siteList
 *
 * Step 2 never fails at the HTTP level for wrong credentials, so callers must branch on
 * `errorCode` / the presence of `jwtToken`, never on the HTTP status.
 */

import { platformForDomain, platformForHostname } from './platforms.js';

const TEST_DOMAINS = ['testing.comm100dev.io', 'comm100dev.io'];
const PROD_ROUTE_HOST = 'route.comm100.io';

/** Hostname only: strips a scheme, a port and any path. */
function bareHost(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .split('/')[0]
    .replace(/:\d+$/, '');
}

/** Maps a dashboard host to its route-service host, or null when unsupported. */
export function routeHostFor(host) {
  const h = bareHost(host);
  if (!h) return null;
  for (const domain of TEST_DOMAINS) {
    const suffix = `dash.${domain}`;
    if (h.endsWith(suffix)) {
      // Preserve the namespace and domain for both WAN and LAN dashboards.
      return h.slice(0, h.length - suffix.length) + `route.${domain}`;
    }
  }
  if (h === PROD_ROUTE_HOST) return h;
  if (h === 'comm100.io' || h.endsWith('.comm100.io')) return PROD_ROUTE_HOST;
  return null;
}

/**
 * Cookie domain the server uses: the registrable domain.
 * livechat6dash.testing.comm100dev.io -> comm100dev.io ; dash11.comm100.io -> comm100.io
 */
export function registrableDomain(host) {
  const parts = bareHost(host).split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  return parts.slice(-2).join('.');
}

/** True when the extension should monitor the dashboard host. */
export function isSupportedHost(host) {
  const h = bareHost(host);
  if (!h) return false;
  if (h === 'app.livehelp100service.com') return true;
  if (h === 'comm100dev.io' || h.endsWith('.comm100dev.io')) return true;
  if (h === 'comm100.io' || h.endsWith('.comm100.io')) return true;
  if (h === 'comm100staging.com' || h.endsWith('.comm100staging.com')) return true;
  return false;
}

/**
 * The origin of the route service for a dashboard.
 *
 * `routeHostFor` covers the naming convention (`livechat6dash` -> `livechat6route`). Everything
 * else in the platform list — staging, and the local dashboard — has no such convention, so the
 * dashboard itself is used as the route base: the login app is served from the same origin, and
 * `getByEmail` is the only call that needs a route host, so a same-origin attempt is strictly
 * better than refusing to try. A dashboard that is not in the list at all still returns null.
 */
export function routeOriginFor(host) {
  const mapped = routeHostFor(host);
  if (mapped) return `https://${mapped}`;
  const platform = platformForHostname(host);
  return platform ? platform.origin : null;
}

/** The credential-scope key for a URL: its host, port included. */
export function domainKeyForUrl(url) {
  try {
    return new URL(String(url)).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The dashboard's own origin, scheme included.
 *
 * `https://` is right for everything Comm100 serves over TLS, but not for the local dashboard,
 * whose prefix is `http://localhost:34500` — and once the platform list is asked, it also restores
 * the port that a bare hostname would have dropped.
 */
export function dashboardOriginFor(host) {
  const key = String(host || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .split('/')[0];
  const platform = platformForDomain(key) || platformForHostname(key);
  return platform ? platform.origin : `https://${bareHost(key)}`;
}

/**
 * Does the route service say this email owns `siteId` on `host`?
 *
 * This is the authority on which sites an account belongs to, and it is the only safe answer to
 * "may I sign in for the site this URL names?" — a dashboard URL can name *any* site id, including
 * one that lives on another branch, and `jwtToken/login` will hand out a token for it without
 * complaining. The panel then rejects that token for every API call, which is a reload loop.
 */
export function ownsSiteOnHost(routeResponse, host, siteId) {
  const sites = Array.isArray(routeResponse && routeResponse.sites) ? routeResponse.sites : [];
  const wantedHost = String(host || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .split('/')[0];
  return sites.some((site) => {
    if (String(site && site.siteId) !== String(siteId)) return false;
    try {
      return new URL(site.portalUrl).host.toLowerCase() === wantedHost;
    } catch {
      return false;
    }
  });
}

function describeError(err) {
  if (err && err.name === 'AbortError') return 'Request timed out';
  return String((err && err.message) || err);
}

/** fetch + JSON parse that always resolves to an object carrying `errorCode`. */
export async function jsonFetch(url, { method = 'GET', body, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...parsed, httpStatus: res.status };
    }
    return {
      errorCode: -1,
      errorMessage: `Unexpected response from ${url} (HTTP ${res.status})`,
      httpStatus: res.status
    };
  } catch (err) {
    return { errorCode: -1, errorMessage: describeError(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Step 1: resolve which site an email belongs to. `routeBase` is an origin or a bare host. */
export async function getByEmail(routeBase, email, partnerId) {
  const qs = new URLSearchParams({ email: String(email) });
  if (partnerId) qs.set('partnerId', String(partnerId));
  const origin = /^https?:\/\//i.test(String(routeBase || '')) ? String(routeBase) : `https://${routeBase}`;
  const url = `${origin.replace(/\/+$/, '')}/api/v1/router/agents/getByEmail?${qs.toString()}`;
  return jsonFetch(url);
}

/** Chooses the site entry that matches the tab's host, falling back to the first. */
export function pickSite(routeResponse, dashHost) {
  const sites = Array.isArray(routeResponse && routeResponse.sites) ? routeResponse.sites.filter(Boolean) : [];
  if (!sites.length) return null;
  // Compare `host`, not `hostname`: the local dashboard is `localhost:34500`, and the port is the
  // only thing that tells it apart from another local dashboard.
  const wanted = String(dashHost || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .split('/')[0];
  const match = sites.find((site) => {
    try {
      return new URL(site.portalUrl).host.toLowerCase() === wanted;
    } catch {
      return false;
    }
  });
  return match || sites[0];
}

/** Normalises a route response into the shape the rest of the extension uses. */
export function normalizeSite(site) {
  if (!site || !site.siteId) return null;
  return {
    siteId: String(site.siteId),
    portalUrl: String(site.portalUrl || '').replace(/\/+$/, ''),
    apiUrl: site.apiUrl || '',
    partnerId: site.partnerId ?? null
  };
}

/** Step 2: exchange credentials for a JWT. */
export async function jwtLogin(portalUrl, { email, password, siteId }) {
  return jsonFetch(`${portalUrl}/api/login/jwtToken/login`, {
    method: 'POST',
    body: { email: String(email), password: String(password), siteId: Number(siteId) || siteId }
  });
}

/** Step 3: exchange the JWT for the session cookies. */
export async function crossPlatformLogin(portalUrl, token, siteId) {
  return jsonFetch(`${portalUrl}/api/login/accounts/CrossPlatformLogin`, {
    method: 'POST',
    body: { token: String(token), siteId: String(siteId) }
  });
}

/** True when the login response is asking for a second factor we cannot supply headlessly. */
export function needsSecondFactor(loginResponse) {
  if (!loginResponse) return false;
  if (loginResponse.showVerificationCode) return true;
  const next = loginResponse.nextStep;
  return Boolean(next) && next !== 'noNeed';
}

export const dashboardUrlFor = (portalUrl, siteId) => `${portalUrl}/ui/${siteId}/`;

/**
 * Where the panel sends you after a *manual* sign-in: the entry page, flagged as a fresh login.
 *
 * `fromlogin=1` is the dashboard's own post-sign-in marker, and it is what "Login now" should land
 * on — the button means "sign me in and take me in", not "reload whatever page I am looking at".
 */
export const entryUrlFor = (portalUrl, siteId) =>
  `${String(portalUrl || '').replace(/\/+$/, '')}/ui/${siteId}/entry/?fromlogin=1`;
