import { dashboardOriginFor, partnerLogin, needsSecondFactor } from '../shared/api.js';
import { getCookie, jwtPayload, jwtExpirySeconds } from '../shared/cookies.js';
import { cachedToken, tokenIsFresh } from '../shared/tokens.js';
import * as store from '../shared/storage.js';

const cookieName = 'partnerToken';
const entryUrl = (origin, partnerId) => `${origin}/ui/${partnerId}/partner/dashboard/`;
const validPartnerId = (value) => /^\d+$/.test(String(value || ''));

export async function partnerSession(origin, partnerId = null) {
  const cookie = await getCookie(origin, cookieName);
  const payload = jwtPayload(cookie?.value);
  const ok = Boolean(cookie && cookie.domain.replace(/^\./, '') === new URL(origin).hostname &&
    validPartnerId(payload?.partnerId) && (!partnerId || String(payload.partnerId) === String(partnerId)) &&
    tokenIsFresh({ jwtToken: cookie.value }));
  return { ok, signedIn: ok, partnerId: ok ? String(payload.partnerId) : null,
    expiresAt: ok ? jwtExpirySeconds(cookie.value) * 1000 : null,
    jwtToken: ok ? cookie.value : null, cookieNames: ok ? [cookieName] : [] };
}

function loginRecord(account, domain, response) {
  if (needsSecondFactor(response) && !response.jwtToken) throw new Error('Complete verification in the partner login page.');
  if (response.errorCode || response.code || response.httpStatus && response.httpStatus !== 200 ||
      !validPartnerId(response.partnerId) ||
      String(jwtPayload(response.jwtToken)?.partnerId) !== String(response.partnerId) || !tokenIsFresh(response)) {
    throw new Error('Partner sign-in failed. Check the saved credentials or sign in manually.');
  }
  return { accountId: account.id, email: account.email, domain, siteId: null,
    partnerId: String(response.partnerId), jwtToken: response.jwtToken, expireTime: response.expireTime || null };
}

export async function verifyPartnerAccount(account, domain) {
  const response = await partnerLogin(dashboardOriginFor(domain), {
    email: account.email, password: account.pendingPassword
  });
  try {
    const record = loginRecord(account, domain, response);
    await store.saveToken(record);
    await store.resolvePending({ accountId: account.id, ok: true });
    return { ok: true, partnerId: record.partnerId };
  } catch (error) {
    await store.resolvePending({ accountId: account.id, ok: false });
    return { ok: false, errorMessage: error.message };
  }
}

/** A successful manual request is observed without spending another password attempt. */
export async function capturePartnerLogin(message, sender) {
  const page = new URL(sender.url);
  const target = new URL(message.url);
  if (sender.tab?.id == null || sender.frameId != null && sender.frameId !== 0 ||
      target.origin !== page.origin || target.pathname.toLowerCase() !== '/partnerloginapi/login' ||
      !message.email || !message.password) return { ok: false };
  const current = await partnerSession(page.origin, message.response?.partnerId);
  if (!current.ok || current.jwtToken !== message.response?.jwtToken) return { ok: false };
  // Validate the response before recording any credential from the page bridge.
  loginRecord({ id: '', email: message.email }, page.host, message.response);
  const accountId = await store.captureCredentials({ email: message.email, password: message.password,
    domain: page.host, host: page.host });
  await store.saveToken(loginRecord({ id: accountId, email: message.email }, page.host, message.response));
  await store.markSuccess({ accountId, host: page.host, domain: page.host });
  return { ok: true };
}

export async function ensurePartnerAuth({ targetHost, urlSiteId: partnerId, userInitiated,
  forceRefresh, rejectedToken, minRemainingMs = 0, force = false, ignoreCooldown = false, accountId = null }) {
  const origin = dashboardOriginFor(targetHost);
  const state = await store.getState();
  if (!userInitiated && store.isSuppressed(state, targetHost)) return { ok: false, reason: 'logged-out' };
  const current = await partnerSession(origin, partnerId);
  if (current.ok && !forceRefresh && !userInitiated && current.expiresAt > Date.now() + minRemainingMs) {
    return { ok: true, partnerId: current.partnerId, domain: targetHost,
      entryUrl: entryUrl(origin, current.partnerId) };
  }
  const accounts = store.usableAccounts(state).filter((account) => account.domain === targetHost &&
    (!accountId || account.id === accountId));
  const account = accounts.find((account) => !partnerId || String(account.partnerId) === String(partnerId)) ||
    accounts.find((account) => !account.partnerId);
  if (!account) return { ok: false, reason: 'no-account', message: 'No saved account for this partner portal.' };
  if (!userInitiated && !ignoreCooldown && (!force || state.hostState[targetHost]?.consecutiveFailures > 0) &&
      store.isCoolingDown(state, targetHost)) return { ok: false, reason: 'cooldown' };
  await store.noteAttempt(targetHost);
  try {
    const rejected = rejectedToken || (forceRefresh ? current.jwtToken : null);
    if (rejected) await store.invalidateToken(rejected);
    let record = cachedToken(state, account, targetHost, null, { minRemainingMs, rejectedToken: rejected });
    if (!record) {
      record = loginRecord(account, targetHost, await partnerLogin(origin, {
        email: account.email, password: store.effectivePassword(account)
      }));
    }
    if (partnerId && String(record.partnerId) !== String(partnerId)) {
      return { ok: false, reason: 'site-mismatch', message: 'This account belongs to a different partner.' };
    }
    await store.saveToken(record);
    await chrome.cookies.set({ url: origin, name: cookieName, value: record.jwtToken,
      domain: targetHost, path: '/', secure: true, httpOnly: true, sameSite: 'strict' });
    const planted = await partnerSession(origin, record.partnerId);
    if (!planted.ok || planted.jwtToken !== record.jwtToken) throw new Error('Could not establish the partner session.');
    await store.markSuccess({ accountId: account.id, host: targetHost, domain: targetHost });
    if (userInitiated) await store.clearFailures(targetHost);
    return { ok: true, domain: targetHost, partnerId: record.partnerId,
      entryUrl: entryUrl(origin, record.partnerId), dashboardUrl: entryUrl(origin, record.partnerId) };
  } catch (error) {
    await store.markFailure(targetHost);
    return { ok: false, reason: 'api-error', message: error.message };
  }
}

export async function logoutPartner(origin) {
  await store.noteLogout(new URL(origin).host);
  await chrome.cookies.remove({ url: origin, name: cookieName });
  return { ok: true, removed: [cookieName] };
}
