/**
 * Session cookie handling.
 *
 * After `/api/login/accounts/CrossPlatformLogin` the server sends exactly these cookies:
 *
 *   siteList=10012;              Domain=comm100dev.io; Path=/; Secure; SameSite=Strict; HttpOnly
 *   token_10012=<jwt>;           Domain=comm100dev.io; Path=/; Secure; SameSite=Strict; HttpOnly
 *   tokenExpire_10012=<iso>;     Domain=comm100dev.io; Path=/; Secure; SameSite=Strict   (session cookie)
 *
 * `token_{siteId}` is the JWT cookie. We never *assume* the browser persisted Set-Cookie from an
 * extension-initiated fetch: every login re-reads the cookie and plants it explicitly when missing.
 */

import { registrableDomain } from './api.js';

export const TOKEN_RE = /^token_\d+$/;
export const TOKEN_EXPIRE_RE = /^tokenExpire_\d+$/;

export const tokenCookieName = (siteId) => `token_${siteId}`;
export const tokenExpireCookieName = (siteId) => `tokenExpire_${siteId}`;

/** Reads the `exp` claim (seconds since epoch) out of a JWT, or null. */
export function jwtExpirySeconds(jwtToken) {
  try {
    const payload = String(jwtToken).split('.')[1];
    if (!payload) return null;
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const exp = JSON.parse(atob(padded)).exp;
    return Number.isFinite(exp) ? Number(exp) : null;
  } catch {
    return null;
  }
}

/** Seconds-since-epoch when the session ends, preferring the server's `expireTime`. */
export function expirySecondsFor(jwtToken, expireTime) {
  if (expireTime) {
    const parsed = Date.parse(String(expireTime));
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return jwtExpirySeconds(jwtToken);
}

export async function getCookie(origin, name) {
  try {
    return await chrome.cookies.get({ url: origin, name });
  } catch {
    return null;
  }
}

export async function getAllCookies(origin) {
  try {
    return (await chrome.cookies.getAll({ url: origin })) || [];
  } catch {
    return [];
  }
}

/**
 * Is this JWT still usable? The token's own `exp` claim is the authority — the cookie's expiry is
 * only a copy of it, and the copy can outlive (or predate) the token that is actually presented.
 */
export function isJwtFresh(jwtToken, skewMs = 0) {
  const exp = jwtExpirySeconds(jwtToken);
  if (!exp) return false;
  return exp * 1000 > Date.now() + skewMs;
}

/**
 * Reports whether a usable session exists for `siteId` on `portalUrl`.
 * Returns { ok, signedIn, expiresAt, expired, cookieName, siteId }.
 */
export async function hasSession(portalUrl, siteId) {
  let origin;
  try {
    origin = new URL(portalUrl).origin;
  } catch {
    return { ok: false, signedIn: false, siteId: String(siteId || ''), expiresAt: null };
  }

  const name = tokenCookieName(siteId);
  const token = await getCookie(origin, name);
  if (!token || !token.value) {
    return { ok: false, signedIn: false, cookieName: name, siteId: String(siteId), expiresAt: null };
  }

  const expireCookie = await getCookie(origin, tokenExpireCookieName(siteId));
  let expiresAt = token.expirationDate ? Math.round(token.expirationDate * 1000) : null;
  if (expireCookie && expireCookie.value) {
    const parsed = Date.parse(decodeURIComponent(expireCookie.value));
    if (!Number.isNaN(parsed)) expiresAt = parsed;
  }

  // The JWT itself is the last word: an expired token in a still-live cookie is not a session.
  const jwtExpiresAt = jwtExpirySeconds(token.value);
  if (jwtExpiresAt) {
    const jwtMs = jwtExpiresAt * 1000;
    expiresAt = expiresAt === null ? jwtMs : Math.min(expiresAt, jwtMs);
  }

  const expired = expiresAt !== null && expiresAt <= Date.now();
  return {
    ok: !expired,
    signedIn: !expired,
    expired,
    cookieName: name,
    siteId: String(siteId),
    expiresAt
  };
}

/**
 * Milliseconds until the session for `siteId` expires.
 *   0    -> no usable session (sign in now)
 *   null -> a session exists but its expiry is unknown (leave it alone)
 */
export async function sessionRemainingMs(portalUrl, siteId) {
  const session = await hasSession(portalUrl, siteId);
  if (!session.ok) return 0;
  if (!session.expiresAt) return null;
  return session.expiresAt - Date.now();
}

/** Finds any `token_<siteId>` cookie for the origin, so the popup can describe the session. */
export async function findSession(portalUrl) {
  const cookies = await getAllCookies(portalUrl);
  const token = cookies.find((c) => TOKEN_RE.test(c.name));
  if (!token) return { signedIn: false, siteId: null, cookieName: null, expiresAt: null, cookieNames: cookies.map((c) => c.name) };
  const siteId = token.name.slice('token_'.length);
  const session = await hasSession(portalUrl, siteId);
  return {
    signedIn: session.signedIn,
    expired: Boolean(session.expired),
    siteId,
    cookieName: token.name,
    expiresAt: session.expiresAt,
    cookieNames: cookies.map((c) => c.name)
  };
}

async function setIfChanged(details) {
  const existing = await getCookie(details.url, details.name);
  if (existing && existing.value === details.value) return false;
  await chrome.cookies.set(details);
  return true;
}

/**
 * Verifies the JWT cookie is present; plants `token_*`, `tokenExpire_*` and `siteList` when it is not.
 * Mirrors the server's flags exactly (domain = registrable domain, path /, Secure, SameSite=Strict).
 *
 * `force` overwrites an existing but lapsing session — needed when renewing before it expires.
 * Returns { ok, planted, session }.
 */
export async function ensureSessionCookies(portalUrl, siteId, jwtToken, expireTime, { force = false } = {}) {
  const url = new URL(portalUrl);
  const origin = url.origin;
  const domain = registrableDomain(url.hostname);
  const key = String(siteId);

  const before = await hasSession(origin, key);
  if (before.ok && !force) return { ok: true, planted: false, session: before };

  const expiresAt = expirySecondsFor(jwtToken, expireTime);
  // Secure only where it can be: the server sets it on https, and Chrome drops a Secure cookie on
  // the plain-http local dashboard.
  const common = { url: `${origin}/`, domain, path: '/', secure: url.protocol === 'https:', sameSite: 'strict' };

  await setIfChanged({
    ...common,
    name: tokenCookieName(key),
    value: String(jwtToken),
    httpOnly: true,
    ...(expiresAt ? { expirationDate: expiresAt } : {})
  });

  // Mirrors the server: session cookie, not HttpOnly.
  await setIfChanged({
    ...common,
    name: tokenExpireCookieName(key),
    value: encodeURIComponent(expireTime || (expiresAt ? new Date(expiresAt * 1000).toISOString() : '')),
    httpOnly: false
  });

  await setIfChanged({ ...common, name: 'siteList', value: key, httpOnly: true });

  const after = await hasSession(origin, key);
  return { ok: after.ok, planted: true, session: after };
}

/** Removes the session cookies (all sites) for an origin. */
export async function clearSessionCookies(portalUrl) {
  const url = new URL(portalUrl);
  const origin = url.origin;
  const cookies = await getAllCookies(origin);
  const removed = [];
  for (const cookie of cookies) {
    if (!TOKEN_RE.test(cookie.name) && !TOKEN_EXPIRE_RE.test(cookie.name) && cookie.name !== 'siteList') continue;
    try {
      await chrome.cookies.remove({ url: `${origin}/`, name: cookie.name });
      removed.push(cookie.name);
    } catch {
      // ignore individual removal failures
    }
  }
  return removed;
}
