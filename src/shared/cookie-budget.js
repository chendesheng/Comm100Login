/** Bound the Cookie header without deleting saved credentials or unrelated cookies. */
import { registrableDomain } from './api.js';
import { getAllCookies, jwtExpirySeconds, TOKEN_RE, TOKEN_EXPIRE_RE } from './cookies.js';

// This is a client-side safety margin, not a claim about the ingress configuration.
export const COOKIE_HEADER_BUDGET_BYTES = 4096;
const PRUNED_KEY = 'comm100PrunedSessions';
const encoder = new TextEncoder();
let queue = Promise.resolve();

function serialize(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

const scopeKey = (host, siteId) => `${registrableDomain(host)}|${siteId}`;
const prunedSites = async () => (await chrome.storage.local.get(PRUNED_KEY))[PRUNED_KEY] || {};

export async function isSessionPruned(host, siteId) {
  return Boolean((await prunedSites())[scopeKey(host, siteId)]);
}

/** A real visit may sign this site in again; background watchdogs must leave it evicted. */
export function restoreSessionTracking(host, siteId) {
  return serialize(async () => {
    const records = await prunedSites();
    const key = scopeKey(host, siteId);
    if (!(key in records)) return;
    delete records[key];
    await chrome.storage.local.set({ [PRUNED_KEY]: records });
  });
}

export function cookieHeaderBytes(cookies) {
  if (!cookies.length) return 0;
  return encoder.encode(`Cookie: ${cookies.map((c) => `${c.name}=${c.value}`).join('; ')}\r\n`).length;
}

function issuedAt(cookie, order) {
  try {
    const payload = cookie.value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const iat = JSON.parse(atob(payload)).iat;
    if (Number.isFinite(iat)) return iat * 1000;
  } catch { /* Older or opaque tokens still have a stable creation order in cookies.getAll(). */ }
  // getAll sorts by path length, then creation time. Sessions normally all use path '/'.
  return cookie.expirationDate ? cookie.expirationDate * 1000 : order;
}

function expired(cookie) {
  const jwtExp = jwtExpirySeconds(cookie.value);
  const until = Math.min(jwtExp ? jwtExp * 1000 : Infinity,
    cookie.expirationDate ? cookie.expirationDate * 1000 : Infinity);
  return until <= Date.now();
}

/**
 * Only evict token_<site> and its tokenExpire_<site> companions. Keep the requested site;
 * without a site hint, keep the newest token. A forced recovery evicts at least one older
 * session even below our budget, because the actual proxy limit may be smaller.
 */
export function trimSessionCookies(requestUrl, protectedSiteId = null, { force = false } = {}) {
  return serialize(async () => {
    const url = new URL(requestUrl);
    const cookies = await getAllCookies(url.href);
    const beforeBytes = cookieHeaderBytes(cookies);
    const groups = new Map();
    cookies.forEach((cookie, order) => {
      if (!TOKEN_RE.test(cookie.name) && !TOKEN_EXPIRE_RE.test(cookie.name)) return;
      const siteId = cookie.name.split('_')[1];
      const group = groups.get(siteId) || { siteId, cookies: [], tokens: [], oldest: Infinity };
      group.cookies.push(cookie);
      if (TOKEN_RE.test(cookie.name)) {
        group.tokens.push(cookie);
        group.oldest = Math.min(group.oldest, issuedAt(cookie, order));
      }
      groups.set(siteId, group);
    });
    const newest = [...groups.values()].filter((g) => g.tokens.length).sort((a, b) => b.oldest - a.oldest)[0];
    const keep = String(protectedSiteId || newest?.siteId || '');
    const candidates = [...groups.values()].filter((g) => g.siteId !== keep).sort((a, b) =>
      Number(b.tokens.every(expired)) - Number(a.tokens.every(expired)) || a.oldest - b.oldest);
    const targetBytes = force ? Math.min(COOKIE_HEADER_BUDGET_BYTES, Math.floor(beforeBytes * 0.6)) : COOKIE_HEADER_BUDGET_BYTES;
    const removedSiteIds = [];
    let afterBytes = beforeBytes;
    if (beforeBytes <= targetBytes) return { beforeBytes, afterBytes, removedSiteIds, protectedSiteId: keep };

    const records = await prunedSites();
    for (const group of candidates) {
      if (afterBytes <= targetBytes) break;
      // Persist before removing: cookies.onChanged can run immediately, and the worker can
      // restart at any time. Neither it nor the keep-alive should undo this eviction.
      records[scopeKey(url.hostname, group.siteId)] = Date.now();
      await chrome.storage.local.set({ [PRUNED_KEY]: records });
      for (const cookie of group.cookies) {
        const removalUrl = new URL(url.origin);
        removalUrl.hostname = cookie.domain.replace(/^\./, '');
        removalUrl.pathname = cookie.path || '/';
        if (cookie.secure) removalUrl.protocol = 'https:';
        try {
          await chrome.cookies.remove({
            url: removalUrl.href, name: cookie.name,
            ...(cookie.storeId ? { storeId: cookie.storeId } : {}),
            ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {})
          });
        } catch { /* Measure the remaining real header below; never assume removal succeeded. */ }
      }
      const remaining = await getAllCookies(url.href);
      if (!remaining.some((c) => TOKEN_RE.test(c.name) && c.name === `token_${group.siteId}`)) {
        removedSiteIds.push(group.siteId);
      }
      afterBytes = cookieHeaderBytes(remaining);
    }
    return { beforeBytes, afterBytes, removedSiteIds, protectedSiteId: keep };
  });
}
