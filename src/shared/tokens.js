import { jwtExpirySeconds } from './cookies.js';

/** Local expiry check shared by browser and CLI; this does not verify the signature. */
export function tokenIsFresh(record, now = Date.now(), minRemainingMs = 0) {
  if (typeof record?.jwtToken !== 'string' || record.jwtToken.split('.').length !== 3) return false;
  const exp = jwtExpirySeconds(record.jwtToken);
  const serverExpiry = Date.parse(record.expireTime);
  const until = Math.min(exp ? exp * 1000 : Infinity, Number.isFinite(serverExpiry) ? serverExpiry : Infinity);
  return Number.isFinite(until) && until > now + minRemainingMs;
}

export function cachedToken(state, account, domain, siteId, { minRemainingMs = 0, rejectedToken = null } = {}) {
  return (state.tokens || []).filter((entry) =>
    entry.accountId === account.id && entry.email?.toLowerCase() === account.email.toLowerCase() &&
    entry.domain === domain && (!siteId || String(entry.siteId) === String(siteId)) &&
    entry.jwtToken !== rejectedToken && tokenIsFresh(entry, Date.now(), minRemainingMs)
  ).sort((a, b) => b.savedAt - a.savedAt)[0] || null;
}
