/**
 * Headless verification harness for the Comm100 Auto Login extension.
 *
 *   node test/harness.mjs
 *
 * Stubs the chrome.* APIs the extension uses, then exercises the real modules against a real
 * Chrome API surface. The live happy path talks to the real Comm100 test API; failure paths
 * (bad password, MFA) are answered by a fetch stub, because Comm100 locks an account once failed
 * sign-ins exceed the site's password policy — never point those at the live endpoint.
 *
 * Live checks need credentials and are skipped without them:
 *
 *   C100_EMAIL=you@example.com C100_PASSWORD=... node test/harness.mjs
 *
 * No credentials are stored in this file.
 */

import { readFileSync } from 'node:fs';

const listeners = [];
const alarmListeners = [];const navListeners = [];
const webRequestListeners = [];
const staticResponseListeners = [];
const tabReloads = [];
const beforeSendHeaderListeners = [];
const beforeRequestListeners = [];
const dynamicRules = [];

const cookieChangeListeners = [];
const tabUpdates = [];
const tabCreates = [];
let currentTabUrl = '';
let currentDocumentId = 'test-document';
let pendingTabUrl;
const store = new Map();
const jar = new Map();

const cookieKey = (c) => `${c.domain}|${c.path}|${c.name}`;
const domainMatches = (host, domain) => {
  if (!domain) return false;
  const d = domain.startsWith('.') ? domain.slice(1) : domain;
  return host === d || host.endsWith(`.${d}`);
};

globalThis.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    lastError: null
  },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  alarms: {
    create: async () => {},
    onAlarm: { addListener: (fn) => alarmListeners.push(fn) }
  },
  webNavigation: {
    onBeforeNavigate: { addListener: (fn) => navListeners.push(fn) },
    getFrame: async () => currentDocumentId ? ({ url: currentTabUrl, documentId: currentDocumentId }) : undefined
  },
  webRequest: {
    onCompleted: { addListener: (fn, filter) => (filter.types ? staticResponseListeners : webRequestListeners).push(fn) },
    onBeforeSendHeaders: { addListener: (fn) => beforeSendHeaderListeners.push(fn) },
    onBeforeRequest: { addListener: (fn) => beforeRequestListeners.push(fn) }
  },
  tabs: {
    get: async (tabId) => ({ id: tabId, url: currentTabUrl, pendingUrl: pendingTabUrl }),
    reload: async (tabId) => { tabReloads.push(tabId); },
    update: async (tabId, props) => { tabUpdates.push({ tabId, ...props }); },
    create: async (props) => { tabCreates.push({ ...props }); }
  },
  declarativeNetRequest: {
    getDynamicRules: async () => dynamicRules.map((rule) => ({ id: rule.id })),
    updateDynamicRules: async ({ removeRuleIds = [], addRules = [] } = {}) => {
      for (const id of removeRuleIds) {
        const at = dynamicRules.findIndex((rule) => rule.id === id);
        if (at >= 0) dynamicRules.splice(at, 1);
      }
      dynamicRules.push(...addRules);
    }
  },
  storage: {
    local: {
      async get(key) {
        if (typeof key === 'string') return store.has(key) ? { [key]: structuredClone(store.get(key)) } : {};
        if (Array.isArray(key))
          return Object.fromEntries(key.filter((k) => store.has(k)).map((k) => [k, structuredClone(store.get(k))]));
        return Object.fromEntries([...store].map(([k, v]) => [k, structuredClone(v)]));
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) store.set(k, structuredClone(v));
      },
      async remove(key) {
        store.delete(key);
      }
    }
  },
  cookies: {
    onChanged: { addListener: (fn) => cookieChangeListeners.push(fn) },
    async get({ url, name }) {
      const host = new URL(url).hostname;
      for (const c of jar.values()) if (c.name === name && domainMatches(host, c.domain)) return structuredClone(c);
      return null;
    },
    async getAll({ url }) {
      const host = new URL(url).hostname;
      return [...jar.values()].filter((c) => domainMatches(host, c.domain)).map((c) => structuredClone(c));
    },
    async set(details) {
      const host = new URL(details.url).hostname;
      const domain = (details.domain || host).replace(/^\./, '');
      if (!domainMatches(host, domain)) throw new Error(`invalid domain ${domain} for ${host}`);
      const cookie = {
        name: details.name,
        value: details.value,
        domain,
        path: details.path || '/',
        secure: Boolean(details.secure),
        httpOnly: Boolean(details.httpOnly),
        sameSite: details.sameSite,
        expirationDate: details.expirationDate,
        session: !details.expirationDate
      };
      jar.set(cookieKey(cookie), cookie);
      return structuredClone(cookie);
    },
    async remove({ url, name }) {
      const host = new URL(url).hostname;
      for (const [k, c] of jar) {
        if (c.name === name && domainMatches(host, c.domain)) {
          jar.delete(k);
          return;
        }
      }
    }
  }
};

// ------------------------------------------------------------ fetch guard
const realFetch = globalThis.fetch;
const json = (body) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** The dashboard under test; also the portal the stubbed sites live on. */
const STUB_HOST = process.env.C100_HOST || 'livechat6dash.testing.comm100dev.io';
/**
 * Synthetic route answers, by email.
 *
 * Only these addresses are answered locally: a live run must still reach the real route service for
 * the real account, and answering *every* email here once made a live verification resolve the
 * offline placeholder site id instead of the account's own.
 */
const STUB_ROUTES = {
  'offline@example.com': [99999, 424242],
  'multisite@10012.com': [99999, 424242, 31337],
  'nowhere@10012.com': null
};

let loginCalls = 0;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : String(input && input.url);
  if (url.endsWith('/api/login/jwtToken/login')) loginCalls += 1;
  if (url.endsWith('/api/login/accounts/CrossPlatformLogin') && init && init.body) {
    const body = JSON.parse(init.body);
    if (String(body.token).startsWith('stub.')) return json({ errorCode: 0, errorMessage: '' });
  }
  // The route service: the authority on which sites an email belongs to. Only the synthetic
  // addresses are answered here; anything else goes to the real API so live runs stay live.
  if (url.includes('/api/v1/router/agents/getByEmail')) {
    const email = new URL(url).searchParams.get('email') || '';
    if (email in STUB_ROUTES) {
      const ids = STUB_ROUTES[email];
      if (!ids) return json({ errorCode: 100, errorMessage: 'Email or password is incorrect.' });
      return json({
        email,
        sites: ids.map((siteId) => ({
          siteId,
          portalUrl: `https://${STUB_HOST}`,
          apiUrl: `https://${STUB_HOST}`
        }))
      });
    }
  }
  if (url.endsWith('/api/login/jwtToken/login') && init && init.body) {
    const body = JSON.parse(init.body);
    if (body.password === 'DefinitelyWrong1') {
      return json({
        siteId: 10012,
        showVerificationCode: false,
        nextStep: 'noNeed',
        errorCode: 101,
        errorMessage: 'Incorrect email or password.'
      });
    }
    if (body.password === 'SlowLogin1') {
      await new Promise((r) => setTimeout(r, 250));
      return json({ siteId: 10008, jwtToken: 'stub.slow.token', expireTime: new Date(Date.now() + 7200000).toISOString(), showVerificationCode: false, nextStep: 'noNeed', errorCode: 0 });
    }
    if (body.password === 'RefreshToken1') {
      return json({ siteId: 10008, jwtToken: 'stub.refresh.token', expireTime: new Date(Date.now() + 7200000).toISOString(), showVerificationCode: false, nextStep: 'noNeed', errorCode: 0 });
    }
    if (body.password === 'offline-password') {
      return json({ siteId: 10008, showVerificationCode: false, nextStep: 'noNeed', errorCode: 100, errorMessage: 'Email or password is incorrect.' });
    }
    if (body.password === 'NeedsTwoFactor1') {
      return json({ siteId: 10012, showVerificationCode: true, nextStep: 'needVerificationCode', errorCode: 0 });
    }
  }
  return realFetch(input, init);
};

const ROOT = new URL('../src', import.meta.url).href;
const api = await import(`${ROOT}/shared/api.js`);
const platforms = await import(`${ROOT}/shared/platforms.js`);
const storage = await import(`${ROOT}/shared/storage.js`);
const cookies = await import(`${ROOT}/shared/cookies.js`);
await import(`${ROOT}/background/service-worker.js`);

const listen = listeners[0];
const call = (message, sender = {}) => new Promise((resolve) => listen(message, sender, resolve));

/** A JWT-shaped token with a chosen expiry, so the pre-flight decodes a real `exp`. */
const fakeJwt = (expSeconds) =>
  `h.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')}.s`;

const HOST = STUB_HOST;
const EMAIL = process.env.C100_EMAIL || '';
const PASSWORD = process.env.C100_PASSWORD || '';
const LIVE = Boolean(EMAIL && PASSWORD);
/** Offline runs still need a non-empty password to arm an account with. */
const TEST_PASSWORD = LIVE ? PASSWORD : 'offline-password';
const COOKIE_DOMAIN = 'comm100dev.io';
const LOCKED = 114;
let SITE_ID = null;
/** The address the offline checks use when no live credentials were supplied. */
let TARGET_EMAIL = '';
/** Set when the live account is locked, so the live checks are skipped rather than faked. */
let liveBlocked = false;

const waitFor = async (predicate, timeoutMs = 1500) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

let failed = 0;
let skipped = 0;
const check = (label, condition, detail) => {
  const ok = Boolean(condition);
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `  -> ${JSON.stringify(detail)}`}`);
};
const skip = (label, why) => {
  skipped += 1;
  console.log(`SKIP  ${label}  -> ${why}`);
};

const armAccount = async (password, domain = HOST) => {
  // Exactly one account at a time: pickAccount() orders by timestamp, and two accounts created in
  // the same millisecond would tie (real sign-ins never do, but a test run easily can).
  await storage.clearAll();
  // Keep the route cache warm so offline runs never hit the route API.
  await storage.putRoute(domain, TARGET_EMAIL, site);
  const id = await storage.upsertAccount({ email: TARGET_EMAIL, password, host: domain, domain });
  // Force the pending password to count as verified so pickAccount() will choose it.
  await storage.resolvePending({ accountId: id, ok: true });
  return id;
};

const dropSession = async () => {
  const names = ['siteList', ...(SITE_ID ? [`token_${SITE_ID}`, `tokenExpire_${SITE_ID}`] : [])];
  for (const name of names) await chrome.cookies.remove({ url: `https://${HOST}/`, name });
};

// ------------------------------------------------------------ pure helpers
console.log('\n-- host mapping --');
check('route host for livechat6dash', api.routeHostFor(HOST) === 'livechat6route.testing.comm100dev.io', api.routeHostFor(HOST));
check('route host for dash11.comm100.io', api.routeHostFor('dash11.comm100.io') === 'route.comm100.io');
check('unsupported host returns null', api.routeHostFor('example.com') === null);
check('registrable domain comm100dev.io', api.registrableDomain(HOST) === 'comm100dev.io');
check('registrable domain comm100.io', api.registrableDomain('dash11.comm100.io') === 'comm100.io');
check('isSupportedHost rejects lookalikes', api.isSupportedHost('evil-comm100.io.attacker.com') === false);
check('isSupportedHost accepts the local dashboard', api.isSupportedHost('localhost') === true);
check('isSupportedHost accepts staging', api.isSupportedHost('dash11.comm100staging.com') === true);

// ------------------------------------------------------------ the dashboard list
// Credentials are scoped per dashboard, so the list is load-bearing: a duplicate or unparseable
// entry would make two dashboards share a credential, which is the bug this all exists to prevent.
console.log('\n-- dashboard list --');
const knownPlatforms = platforms.allPlatforms();
check('the list parses to 29 dashboards', knownPlatforms.length === 29, knownPlatforms.length);
check(
  'every credential scope is unique',
  new Set(knownPlatforms.map((p) => p.domain)).size === knownPlatforms.length,
  knownPlatforms.map((p) => p.domain).filter((d, i, all) => all.indexOf(d) !== i)
);
check('every entry has an origin', knownPlatforms.every((p) => /^https?:\/\//.test(p.origin)));
check(
  'the testing and dev branches of one name stay distinct',
  platforms.platformDomainFor('livechat3dash.testing.comm100dev.io') !==
    platforms.platformDomainFor('livechat3dash.comm100dev.io')
);
check('the local dashboard keeps its port', platforms.platformDomainFor('localhost') === 'localhost:34500');
check(
  'staging maps to its own origin (no route convention exists)',
  api.routeOriginFor('dash11.comm100staging.com') === 'https://dash11.comm100staging.com',
  api.routeOriginFor('dash11.comm100staging.com')
);
check('the local dashboard keeps the http scheme', api.routeOriginFor('localhost') === 'http://localhost:34500');
check('a dashboard origin keeps its own scheme', api.dashboardOriginFor('localhost:34500') === 'http://localhost:34500');
check('a normal dashboard origin is https', api.dashboardOriginFor(HOST) === `https://${HOST}`);
check('a known branch still routes by convention', api.routeOriginFor(HOST) === `https://${api.routeHostFor(HOST)}`);
check(
  'the entry URL is the panel\'s own post-sign-in path',
  api.entryUrlFor(`https://${HOST}/`, SITE_ID || '99999') === `https://${HOST}/ui/${SITE_ID || '99999'}/entry/?fromlogin=1`
);
check('an unknown dashboard has no route at all', api.routeOriginFor('dash99.example.com') === null);

// ------------------------------------------------------------ step 1
console.log('\n-- step 1: getByEmail (live) --');
let site = { siteId: '99999', portalUrl: `https://${HOST}` };
if (LIVE) {
  const lookup = await api.getByEmail(api.routeHostFor(HOST), EMAIL);
  site = api.normalizeSite(api.pickSite(lookup, HOST));
  SITE_ID = site && site.siteId;
  check(`resolved a site id (${SITE_ID})`, Boolean(SITE_ID), site);
  check('portalUrl matches tab host', site && new URL(site.portalUrl).hostname === HOST, site && site.portalUrl);
} else {
  SITE_ID = site.siteId;
  skip('live route lookup', 'set C100_EMAIL and C100_PASSWORD');
}
TARGET_EMAIL = LIVE ? EMAIL : 'offline@example.com';
// Seed the route cache so every offline check runs without touching the network.
await storage.clearAll();
await storage.putRoute(HOST, TARGET_EMAIL, site);

// ------------------------------------------------------------ mfa detection
console.log('\n-- mfa detection --');
check('flags showVerificationCode', api.needsSecondFactor({ showVerificationCode: true }) === true);
check('flags nextStep beyond noNeed', api.needsSecondFactor({ nextStep: 'needVerificationCode' }) === true);
check('ignores the normal path', api.needsSecondFactor({ showVerificationCode: false, nextStep: 'noNeed' }) === false);

// ------------------------------------------------------------ add + verify (live)
console.log('\n-- add account + verify against the live API --');
if (!LIVE) skip('live credential verification', 'set C100_EMAIL and C100_PASSWORD');
else {
await storage.clearAll();
const accountId = await storage.upsertAccount({ email: TARGET_EMAIL, password: LIVE ? PASSWORD : 'offline', host: HOST, domain: HOST });
let account = (await storage.getState()).accounts.find((a) => a.id === accountId);
check('new account keeps the password pending', account.password === null && account.pendingPassword === PASSWORD);

const verify = await call({ type: 'verifyAccount', accountId, hostname: HOST });
check('verification reports the site id it proved', !verify || !verify.ok || verify.siteId === SITE_ID, verify);
liveBlocked = Boolean(verify && verify.errorCode === LOCKED);

if (liveBlocked) {
  skip('live login path', 'account locked (errorCode 114) — auto-unlocks ~30 min after repeated bad passwords');
} else {
  check('verification accepted', verify && verify.ok === true, verify);
  account = (await storage.getState()).accounts.find((a) => a.id === accountId);
  check('password promoted after verification', account.password === PASSWORD && account.pendingPassword === null);
  check('account is pickable for the host', storage.pickAccount(await storage.getState(), HOST)?.id === accountId);
}
}

if (!LIVE) await storage.putRoute(HOST, TARGET_EMAIL, site);

// ------------------------------------------------------------ background login (live)
console.log('\n-- ensureAuth: full background login --');
if (!LIVE) {
  skip('background login', 'set C100_EMAIL and C100_PASSWORD');
} else if (liveBlocked) {
  skip('background login', 'account locked');
} else {
  const result = await call({ type: 'ensureAuth', hostname: HOST });
  check('ensureAuth ok', result && result.ok === true, result);
  check('performed a login (not a cached session)', result && result.alreadySignedIn === false);

  const tokenCookie = jar.get(`${COOKIE_DOMAIN}|/|token_${SITE_ID}`);
  check(`token_${SITE_ID} planted`, Boolean(tokenCookie), [...jar.keys()]);
  check('token is a JWT', tokenCookie && tokenCookie.value.split('.').length === 3);
  check('token HttpOnly', tokenCookie && tokenCookie.httpOnly === true);
  check('token Secure', tokenCookie && tokenCookie.secure === true);
  check('token SameSite=Strict', tokenCookie && tokenCookie.sameSite === 'strict');
  check('token has an expiry', tokenCookie && typeof tokenCookie.expirationDate === 'number');
  check('cookie domain is the registrable domain', tokenCookie && tokenCookie.domain === COOKIE_DOMAIN);

  const expireCookie = jar.get(`${COOKIE_DOMAIN}|/|tokenExpire_${SITE_ID}`);
  check(`tokenExpire_${SITE_ID} planted`, Boolean(expireCookie));
  check('tokenExpire is a session cookie', expireCookie && expireCookie.session === true);
  check('tokenExpire is not HttpOnly', expireCookie && expireCookie.httpOnly === false);
  check('siteList planted', jar.get(`${COOKIE_DOMAIN}|/|siteList`)?.value === SITE_ID);

  const second = await call({ type: 'ensureAuth', hostname: HOST });
  check('second call short-circuits as already signed in', second && second.ok === true && second.alreadySignedIn === true, second);
  check(
    'the short-circuit still reports the entry URL',
    second && second.entryUrl === `https://${HOST}/ui/${SITE_ID}/entry/?fromlogin=1`,
    second && second.entryUrl
  );

  check(
    'a sign-in reports the entry URL to land on',
    result.entryUrl === `${result.portalUrl}/ui/${result.siteId}/entry/?fromlogin=1`,
    result.entryUrl
  );

  const status = await call({ type: 'sessionStatus', origin: `https://${HOST}` });
  check('sessionStatus sees the session', status && status.signedIn === true && status.cookieName === `token_${SITE_ID}`, status);
  check('sessionStatus reports a future expiry', status && status.expiresAt > Date.now(), status && status.expiresAt);
}

// ------------------------------------------------------------ capture is free (no API call)
console.log('\n-- form capture does not spend a sign-in attempt --');
await storage.clearAll();
loginCalls = 0;
const captured = await call({ type: 'captureCredentials', hostname: HOST, domain: HOST, email: 'captured@10012.com', password: 'Fresh1' });
check('capture accepted', captured && captured.ok === true, captured);
check('capture made no login API call', loginCalls === 0, { loginCalls });
const capturedState = await storage.getState();
const capturedAccount = capturedState.accounts.find((a) => a.email === 'captured@10012.com');
check('captured password is pending, not trusted', capturedAccount.password === null && capturedAccount.pendingPassword === 'Fresh1');
check('pending account is still selectable', storage.pickAccount(capturedState, HOST)?.email === 'captured@10012.com');
check('pending account yields an effective password', storage.effectivePassword(capturedAccount) === 'Fresh1');

// A live session proves the pending password works, so it gets promoted without a login call.
await chrome.cookies.set({ url: `https://${HOST}/`, domain: COOKIE_DOMAIN, path: '/', name: `token_${SITE_ID}`, value: 'a.b.c', httpOnly: true, secure: true, sameSite: 'strict' });
loginCalls = 0;
const promoteResult = await call({ type: 'ensureAuth', hostname: HOST, siteId: SITE_ID });
console.log('      ensureAuth ->', JSON.stringify(promoteResult));
const promoted = (await storage.getState()).accounts.find((a) => a.email === 'captured@10012.com');
check('pending password promoted from a live session', promoted.password === 'Fresh1' && promoted.pendingPassword === null, promoted);
check('promotion made no login API call', loginCalls === 0, { loginCalls });

// ------------------------------------------------------------ cross-branch cookie isolation
// Regression: all Comm100 test branches share the comm100dev.io cookie domain, so a leftover
// token_* for a different site must never be mistaken for this site's session.
console.log('\n-- a token for another site is not this session --');
// Deliberately unrelated to SITE_ID, which differs between offline and live runs.
const FOREIGN_SITE = '424242';
await storage.clearAll();
await armAccount(TEST_PASSWORD);
await dropSession();
await chrome.cookies.set({
  url: `https://${HOST}/`,
  domain: COOKIE_DOMAIN,
  path: '/',
  name: `token_${FOREIGN_SITE}`,
  value: 'not.our.session',
  secure: true,
  httpOnly: true,
  sameSite: 'strict'
});
const foreignSession = await cookies.hasSession(`https://${HOST}`, SITE_ID);
check('foreign token does not satisfy hasSession', foreignSession.ok === false, foreignSession);
const foreignStatus = await call({ type: 'sessionStatus', origin: `https://${HOST}`, siteId: SITE_ID });
check('sessionStatus does not report it as this page\'s session', foreignStatus.signedIn === false, foreignStatus);
const foreignOnly = await call({ type: 'sessionStatus', origin: `https://${HOST}`, siteId: FOREIGN_SITE });
check('sessionStatus does report it for the site it belongs to', foreignOnly.signedIn === true, foreignOnly);
const foreignAuth = await call({ type: 'ensureAuth', hostname: HOST, siteId: SITE_ID, force: true });
check('foreign token does not short-circuit ensureAuth', foreignAuth && foreignAuth.alreadySignedIn !== true, foreignAuth && foreignAuth.reason);
check('it still attempted this site', foreignAuth && foreignAuth.reason !== 'no-route', foreignAuth && foreignAuth.reason);

// ------------------------------------------------------------ failure accounting (stubbed)
console.log('\n-- wrong password: failure accounting (stubbed response) --');
await dropSession();
await armAccount('DefinitelyWrong1');

const bad1 = await call({ type: 'ensureAuth', hostname: HOST, force: true });
check('attempt 1 rejected as bad-credentials', bad1 && bad1.ok === false && bad1.reason === 'bad-credentials', bad1 && bad1.reason);
check('attempt 1 does not echo the password back', bad1 && bad1.password === undefined);
check('attempt 1 does not create a pause flag', bad1 && !('paused' in bad1));

const immediateRetry = await call({ type: 'ensureAuth', hostname: HOST, force: true });
check('failed sign-in requests still respect the temporary cooldown', immediateRetry && immediateRetry.reason === 'cooldown', immediateRetry);
await storage.setSettings({ cooldownMs: 0 });

const bad2 = await call({ type: 'ensureAuth', hostname: HOST, force: true });
check('attempt 2 rejected', bad2 && bad2.reason === 'bad-credentials', bad2 && bad2.reason);
check('two failures do not disable auto-login', bad2 && bad2.failures === 2 && !('paused' in bad2), bad2);

const thirdAttempt = await call({ type: 'ensureAuth', hostname: HOST });
check('auto-login tries again once the cooldown expires', thirdAttempt && thirdAttempt.reason === 'bad-credentials' && thirdAttempt.failures === 3, thirdAttempt);
await storage.setSettings({ cooldownMs: 60000 });

const blocked = await call({ type: 'ensureAuth', hostname: HOST });
check('repeated failures use a cooldown rather than a permanent pause', blocked && blocked.reason === 'cooldown', blocked && blocked.reason);

await call({ type: 'resetFailures', hostname: HOST });
check('resetFailures clears retry history', (await storage.getState()).hostState[HOST].consecutiveFailures === 0);

console.log('\n-- legacy pause flags cannot hold auto-login back --');
await armAccount('RefreshToken1');
await dropSession();
const legacyPaused = await storage.getState();
legacyPaused.settings.maxConsecutiveFailures = 2;
legacyPaused.hostState[HOST] = { paused: true, consecutiveFailures: 2, lastAttemptAt: Date.now() - 120000 };
await chrome.storage.local.set({ comm100AutoLogin: legacyPaused });
const migrated = await storage.getState();
check('stored pause flags and thresholds are ignored on read', !('paused' in migrated.hostState[HOST]) && !('maxConsecutiveFailures' in migrated.settings));
const legacyPeek = await call({ type: 'canAutoLogin', hostname: HOST, siteId: SITE_ID });
check('a legacy paused host is eligible again without a popup action', legacyPeek && legacyPeek.eligible === true, legacyPeek);
const legacyRetry = await call({ type: 'ensureAuth', hostname: HOST, siteId: SITE_ID });
check('a legacy paused host signs in automatically', legacyRetry && legacyRetry.ok === true, legacyRetry);
check('an ordinary write removes the legacy flag from disk', !('paused' in (await chrome.storage.local.get('comm100AutoLogin')).comm100AutoLogin.hostState[HOST]));

// ------------------------------------------------------------ mfa (stubbed)
console.log('\n-- two-factor handoff (stubbed response) --');
await armAccount('NeedsTwoFactor1');
await dropSession();
const mfa = await call({ type: 'ensureAuth', hostname: HOST, force: true });
check('reports mfa and needs manual entry', mfa && mfa.reason === 'mfa' && mfa.needsManual === true, mfa);
check('mfa pre-fills the email', mfa && mfa.email === TARGET_EMAIL);
check('mfa is not counted as a credential failure', (((await storage.getState()).hostState[HOST] || {}).consecutiveFailures || 0) === 0);

// ------------------------------------------------------------ cooldown + suppression
console.log('\n-- cooldown / logout suppression --');
await storage.clearFailures(HOST);
await armAccount(TEST_PASSWORD);
await dropSession();
await storage.noteAttempt(HOST);
await storage.clearEvents();
const cooling = await call({ type: 'ensureAuth', hostname: HOST });
check('cooldown blocks an immediate retry', cooling && cooling.reason === 'cooldown', cooling && cooling.reason);
// A sign-in page left open polls this, so logging it would append a line a second and evict the
// history the activity log exists for.
check(
  'a cooldown is not written to the activity log',
  ((await storage.getState()).events || []).length === 0,
  ((await storage.getState()).events || []).map((e) => e.detail)
);

await storage.clearFailures(HOST);
await dropSession();
// A session must exist for the logout to be observable.
await chrome.cookies.set({ url: `https://${HOST}/`, domain: COOKIE_DOMAIN, path: '/', name: `token_${SITE_ID}`, value: 'a.b.c', secure: true, httpOnly: true, sameSite: 'strict' });
const logout = await call({ type: 'logout', origin: `https://${HOST}`, host: HOST });
check('logout ok', logout && logout.ok === true, logout);
check('session cookies cleared', jar.size === 0, [...jar.keys()]);
check('auto-login suppressed after logout', await storage.isSuppressed(await storage.getState(), HOST));
const suppressed = await call({ type: 'ensureAuth', hostname: HOST });
check('suppressed host does not sign back in', suppressed && suppressed.reason === 'logged-out', suppressed && suppressed.reason);

// ------------------------------------------------------------ pre-flight + keep-alive
console.log('\n-- canAutoLogin (local-only pre-flight) --');
await storage.clearAll();
await armAccount(TEST_PASSWORD);

const eligible = await call({ type: 'canAutoLogin', hostname: HOST, siteId: SITE_ID });
check('eligible when there is no session', eligible && eligible.eligible === true, eligible);

await chrome.cookies.set({ url: `https://${HOST}/`, domain: COOKIE_DOMAIN, path: '/', name: `token_${SITE_ID}`, value: 'a.b.c', secure: true, httpOnly: true, sameSite: 'strict' });
const signedIn = await call({ type: 'canAutoLogin', hostname: HOST, siteId: SITE_ID });
check('not eligible once signed in', signedIn && signedIn.eligible === false && signedIn.reason === 'signed-in', signedIn);

await storage.clearFailures(HOST);
await dropSession();
await storage.markFailure(HOST);
await storage.markFailure(HOST);
const failedPeek = await call({ type: 'canAutoLogin', hostname: HOST, siteId: SITE_ID });
check('past failures do not require manual re-enabling', failedPeek && failedPeek.eligible === true, failedPeek);

await storage.clearFailures(HOST);
await storage.noteLogout(HOST);
const outPeek = await call({ type: 'canAutoLogin', hostname: HOST, siteId: SITE_ID });
check('not eligible right after logout', outPeek && outPeek.eligible === false && outPeek.reason === 'logged-out', outPeek);

await storage.clearAll();
const emptyPeek = await call({ type: 'canAutoLogin', hostname: HOST, siteId: SITE_ID });
check('not eligible with no saved account', emptyPeek && emptyPeek.eligible === false, emptyPeek);

// Regression: the pre-flight must mirror every gate ensureAuth applies, or the content script
// hides the form for an attempt that then refuses to run.
await storage.clearAll();
await armAccount(TEST_PASSWORD);
await storage.noteAttempt(HOST);
const coolingPeek = await call({ type: 'canAutoLogin', hostname: HOST, siteId: SITE_ID });
check('not eligible during the cooldown', coolingPeek && coolingPeek.eligible === false && coolingPeek.reason === 'cooldown', coolingPeek);

await storage.clearAll();
// Deliberately no cached route and no site id in the URL: cannot know where to sign in.
const unresolvedId = await storage.upsertAccount({ email: TARGET_EMAIL, password: TEST_PASSWORD, host: HOST, domain: HOST });
await storage.resolvePending({ accountId: unresolvedId, ok: true });
const unresolvedPeek = await call({ type: 'canAutoLogin', hostname: HOST });
check('not eligible when the site is unknown', unresolvedPeek && unresolvedPeek.eligible === false && unresolvedPeek.reason === 'unresolved', unresolvedPeek);

console.log('\n-- keep-alive renews a lapsing session --');
await storage.clearAll();
await armAccount('RefreshToken1');
await dropSession();
// A session with 60s left must be refreshed; one with 2h left must be left alone.
await chrome.cookies.set({
  url: `https://${HOST}/`,
  domain: COOKIE_DOMAIN,
  path: '/',
  name: `token_${SITE_ID}`,
  value: 'old.expiring.token',
  secure: true,
  httpOnly: true,
  sameSite: 'strict',
  expirationDate: Math.floor((Date.now() + 60000) / 1000)
});
check('sessionRemainingMs sees the short window', (await cookies.sessionRemainingMs(`https://${HOST}`, SITE_ID)) < 30 * 60 * 1000);
check('an alarm listener is registered', alarmListeners.length === 1, alarmListeners.length);
check('a navigation listener is registered', navListeners.length === 1, navListeners.length);
for (const fn of alarmListeners) fn({ name: 'comm100-keep-alive' });
await new Promise((r) => setTimeout(r, 300));
check('lapsing token was replaced', jar.get(`${COOKIE_DOMAIN}|/|token_${SITE_ID}`)?.value === 'stub.refresh.token', jar.get(`${COOKIE_DOMAIN}|/|token_${SITE_ID}`)?.value);
check('renewed session is healthy again', (await cookies.sessionRemainingMs(`https://${HOST}`, SITE_ID)) > 30 * 60 * 1000);

// ------------------------------------------------------------ pre-flight on the outgoing request
console.log('\n-- the token is checked before the request is sent --');
check('a before-send-headers listener is registered', beforeSendHeaderListeners.length === 1, beforeSendHeaderListeners.length);

const apiUrl = `https://${HOST}/api/global/siteActivity:active?siteId=${SITE_ID}`;
const sendWithCookie = (value, tabId) => {
  for (const fn of beforeSendHeaderListeners) {
    fn({ url: apiUrl, tabId, requestHeaders: [{ name: 'Cookie', value: `token_${SITE_ID}=${value}` }] });
  }
};

await storage.clearAll();
await armAccount('RefreshToken1');
await dropSession();
tabReloads.length = 0;

// Still-valid token: nothing should happen.
sendWithCookie(fakeJwt(Math.floor(Date.now() / 1000) + 3600), 9);
await new Promise((r) => setTimeout(r, 250));
check('a fresh token in the outgoing request triggers nothing', jar.get(`${COOKIE_DOMAIN}|/|token_${SITE_ID}`) === undefined);

// Expired token: sign in before the server gets the chance to 401.
sendWithCookie(fakeJwt(Math.floor(Date.now() / 1000) - 60), 9);
await new Promise((r) => setTimeout(r, 400));
check('an expired token starts the sign-in before the 401', jar.get(`${COOKIE_DOMAIN}|/|token_${SITE_ID}`)?.value === 'stub.refresh.token', jar.get(`${COOKIE_DOMAIN}|/|token_${SITE_ID}`)?.value);
check('the pre-flight itself does not reload the tab', tabReloads.length === 0, tabReloads);

// The sign-in endpoints carry no session, so they must not be read as evidence of a bad one.
await dropSession();
for (const fn of beforeSendHeaderListeners) {
  fn({ url: `https://${HOST}/api/login/jwtToken/login`, tabId: 9, requestHeaders: [{ name: 'Cookie', value: '' }] });
}
await new Promise((r) => setTimeout(r, 250));
check('sign-in endpoints are ignored by the pre-flight', jar.get(`${COOKIE_DOMAIN}|/|token_${SITE_ID}`) === undefined);

// hasSession must not trust a live cookie that holds an expired JWT.
await chrome.cookies.set({
  url: `https://${HOST}/`,
  domain: COOKIE_DOMAIN,
  path: '/',
  name: `token_${SITE_ID}`,
  value: fakeJwt(Math.floor(Date.now() / 1000) - 60),
  secure: true,
  httpOnly: true,
  sameSite: 'strict',
  expirationDate: Math.floor((Date.now() + 3600000) / 1000)
});
const staleJwt = await cookies.hasSession(`https://${HOST}`, SITE_ID);
check('an expired JWT inside a live cookie is not a session', staleJwt.ok === false && staleJwt.expired === true, staleJwt);
check('isJwtFresh agrees', cookies.isJwtFresh(fakeJwt(Math.floor(Date.now() / 1000) - 60)) === false);

// ------------------------------------------------------------ 401/403 middleware
console.log('\n-- a rejected API call triggers a fresh sign-in --');
await storage.clearAll();
await armAccount('RefreshToken1');
await dropSession();
// A cookie that looks valid locally but has been rejected server-side.
await chrome.cookies.set({
  url: `https://${HOST}/`,
  domain: COOKIE_DOMAIN,
  path: '/',
  name: `token_${SITE_ID}`,
  value: 'stale.but.unexpired.token',
  secure: true,
  httpOnly: true,
  sameSite: 'strict',
  expirationDate: Math.floor((Date.now() + 3600000) / 1000)
});
check('a stale-but-unexpired token reads as signed in', (await cookies.hasSession(`https://${HOST}`, SITE_ID)).ok === true);
check('an API-response listener is registered', webRequestListeners.length === 1, webRequestListeners.length);

currentTabUrl = `https://${HOST}/ui/${SITE_ID}/livechat/dashboard/`;
for (const fn of webRequestListeners) {
  fn({ statusCode: 401, url: `https://${HOST}/api/global/siteActivity:active?siteId=${SITE_ID}`, tabId: 7 });
}
await new Promise((r) => setTimeout(r, 400));
check('the rejected token was replaced', jar.get(`${COOKIE_DOMAIN}|/|token_${SITE_ID}`)?.value === 'stub.refresh.token', jar.get(`${COOKIE_DOMAIN}|/|token_${SITE_ID}`)?.value);
// The page must never be yanked out from under the user; the fresh cookie is simply in the jar for
// the panel's next request.
check('the page is left alone after a 401', tabReloads.length === 0 && tabUpdates.length === 0, { tabReloads, tabUpdates });

// 200s, non-API paths and unrelated hosts must not trigger anything.
await dropSession();
for (const fn of webRequestListeners) {
  fn({ statusCode: 200, url: `https://${HOST}/api/global/siteActivity:active?siteId=${SITE_ID}` });
  fn({ statusCode: 401, url: `https://${HOST}/assets/app.js` });
  fn({ statusCode: 401, url: 'https://example.com/api/thing' });
}
await new Promise((r) => setTimeout(r, 300));
check('ignores 200s, non-API paths and other hosts', jar.get(`${COOKIE_DOMAIN}|/|token_${SITE_ID}`) === undefined);

tabReloads.length = 0;
await storage.clearAll();
await armAccount('RefreshToken1');
await dropSession();
for (const fn of webRequestListeners) {
  fn({ statusCode: 401, url: `https://${HOST}/api/global/siteActivity:active?siteId=${SITE_ID}`, tabId: 8 });
}
await new Promise((r) => setTimeout(r, 400));
check('a page is never reloaded by the 401 path', tabReloads.length === 0 && tabUpdates.length === 0, { tabReloads, tabUpdates });

// ------------------------------------------------------------ session header rewriting
console.log('\n-- DNR header rewriting --');

await storage.clearAll();
await armAccount('RefreshToken1');
await dropSession();

// A successful sign-in must publish a rule attaching the bearer to the panel's API calls; without
// it the panel keeps sending its own stale token and every call 401s, which is what makes it reload.
const signIn = await call({ type: 'ensureAuth', hostname: HOST, siteId: SITE_ID, force: true });
check('a sign-in succeeds', signIn && signIn.ok === true, signIn);

const setRule = dynamicRules.find(
  (rule) => rule.action && rule.action.type === 'modifyHeaders' && rule.condition.urlFilter.endsWith('/api/')
);
check('a header rule is published', Boolean(setRule), dynamicRules);
check('  ... scoped to this host\'s API', setRule && setRule.condition.urlFilter === `||${HOST}/api/`, setRule && setRule.condition.urlFilter);
check('  ... only for XHR', setRule && setRule.condition.resourceTypes.join() === 'xmlhttprequest', setRule && setRule.condition.resourceTypes);
const header = setRule && setRule.action.requestHeaders[0];
check('  ... setting Authorization', header && header.header === 'authorization' && header.operation === 'set', header);
check('  ... to a bearer token', header && /^Bearer \S+\.\S+\.\S+$/.test(header.value), header && header.value);

const allowRule = dynamicRules.find((rule) => rule.action && rule.action.type === 'allow');
check('sign-in endpoints are exempted', allowRule && allowRule.condition.urlFilter === `||${HOST}/api/login/`, allowRule);
check('  ... with a higher priority', allowRule && setRule && allowRule.priority > setRule.priority);

check('nothing in the extension can reload a page', tabReloads.length === 0 && tabUpdates.length === 0, { tabReloads, tabUpdates });

// Auto-login is no longer a setting — the popup has no toggle and the worker has no gate — so a
// stale `autoLogin: false` (an older export, a hand-edited profile) must be completely inert.
await storage.setSettings({ autoLogin: false });
await storage.clearFailures(HOST);
await dropSession();
const staleToggle = await call({ type: 'canAutoLogin', hostname: HOST, siteId: SITE_ID });
check('a stale autoLogin:false no longer disables anything', staleToggle && staleToggle.reason !== 'disabled', staleToggle);
check('  ... and the header rule is left in place', dynamicRules.length > 0, dynamicRules);
const staleAuth = await call({ type: 'ensureAuth', hostname: HOST, siteId: SITE_ID, force: true });
check('  ... and a sign-in still runs', staleAuth && staleAuth.ok === true, staleAuth && staleAuth.reason);

const kinds = ((await storage.getState()).events || []).map((event) => event.kind);
check('the activity log records sign-ins', kinds.includes('sign-in'), kinds.slice(0, 6));
check('the header rule still uses the current session token', dynamicRules.some((rule) =>
  rule.action?.requestHeaders?.[0]?.value === `Bearer ${jar.get(`${COOKIE_DOMAIN}|/|token_${SITE_ID}`)?.value}`));

// ------------------------------------------------------------ account selection
console.log('\n-- recency selection --');
await storage.clearAll();
const older = await storage.upsertAccount({ email: 'older@10012.com', password: 'x', host: HOST, domain: HOST });
await storage.resolvePending({ accountId: older, ok: true });
await storage.markSuccess({ accountId: older, host: HOST, site });
await new Promise((r) => setTimeout(r, 5));
const newer = await storage.upsertAccount({ email: 'newer@10012.com', password: 'y', host: HOST, domain: HOST });
await storage.resolvePending({ accountId: newer, ok: true });
await storage.markSuccess({ accountId: newer, host: HOST, site });
check('newest account wins', storage.pickAccount(await storage.getState(), HOST)?.email === 'newer@10012.com');

// ------------------------------------------------------------ per-dashboard credentials
// The reported bug: a credential recorded on livechat3dash was also fired at livechat6dash, where
// the account does not exist. Every branch shares the comm100dev.io cookie domain, so nothing but
// an explicit scope can tell them apart — and a wrong attempt spends the lockout budget.
console.log('\n-- credentials do not cross dashboards --');
const OTHER_HOST = 'livechat3dash.testing.comm100dev.io';
check('the two dashboards really are different scopes', OTHER_HOST !== HOST);

await storage.clearAll();
await armAccount(TEST_PASSWORD, HOST);
let scopedState = await storage.getState();
check('the account is stored against its dashboard', scopedState.accounts[0].domain === HOST, scopedState.accounts[0].domain);
check('it is selectable on its own dashboard', storage.pickAccount(scopedState, HOST)?.email === TARGET_EMAIL);
check('it is not selectable on another dashboard', storage.pickAccount(scopedState, OTHER_HOST) === null);
check('accountsForDomain agrees', storage.accountsForDomain(scopedState, OTHER_HOST).length === 0);

await dropSession();
loginCalls = 0;
const otherAuth = await call({ type: 'ensureAuth', hostname: OTHER_HOST, domain: OTHER_HOST, force: true });
check('ensureAuth refuses instead of borrowing it', otherAuth && otherAuth.ok === false && otherAuth.reason === 'no-account', otherAuth);
check('  ... and says which dashboards do have one', /livechat6dash/.test((otherAuth && otherAuth.message) || ''), otherAuth && otherAuth.message);
check('  ... without spending a sign-in attempt', loginCalls === 0, { loginCalls });
const otherPeek = await call({ type: 'canAutoLogin', hostname: OTHER_HOST, domain: OTHER_HOST, siteId: SITE_ID });
check('the pre-flight refuses too, so the form is never covered', otherPeek && otherPeek.eligible === false && otherPeek.reason === 'no-account', otherPeek);

// ------------------------------------------------------------ account list filters
// The popup lists every saved credential at once; the filters are how "which of these is the one for
// site 10010 on livechat6dash?" gets answered without reading every row. Pure function, so the two
// edge cases that matter — compose, and "unscoped is a value, not a wildcard" — are checkable here.
console.log('\n-- account list filters --');
const filterIds = (list) => list.map((account) => account.id).join(',');
const filterRows = [
  { id: 'a', email: 'a@10012.com', domain: HOST, siteId: '10008' },
  { id: 'b', email: 'b@10012.com', domain: OTHER_HOST, siteId: '10010' },
  { id: 'c', email: 'c@10012.com', domain: HOST, siteId: null },
  { id: 'd', email: 'd@10012.com', domain: null, siteId: '10008' }
];
check('no filter keeps every account, in order', filterIds(storage.filterAccounts(filterRows)) === 'a,b,c,d', filterIds(storage.filterAccounts(filterRows)));
check('the dashboard filter narrows to one dashboard', filterIds(storage.filterAccounts(filterRows, { domain: HOST })) === 'a,c');
check('the site filter narrows to one site', filterIds(storage.filterAccounts(filterRows, { siteId: '10010' })) === 'b');
check('the two filters compose', filterIds(storage.filterAccounts(filterRows, { domain: HOST, siteId: '10008' })) === 'a');
check(
  'a site that belongs to another dashboard is not offered by it',
  storage.filterAccounts(filterRows, { domain: OTHER_HOST, siteId: '10008' }).length === 0
);
check(
  'an unscoped dashboard is a filter value, not a wildcard',
  filterIds(storage.filterAccounts(filterRows, { domain: storage.FILTER_UNSCOPED })) === 'd'
);
check(
  'a credential with no site yet is selectable too',
  filterIds(storage.filterAccounts(filterRows, { domain: HOST, siteId: storage.FILTER_UNSCOPED })) === 'c'
);
check('an unknown site filters everything out', storage.filterAccounts(filterRows, { siteId: '424242' }).length === 0);

// ------------------------------------------------------------ per-site credentials
// The reported loop: `/ui/10012/ai/dashboard/` on livechat6dash, where the only saved credential is
// for site 10010. `jwtToken/login` hands out a token for 10012 anyway, the panel rejects it on every
// call and reloads itself. The credential lookup is by domain *and* site, so the answer here is
// "nothing for that site" — and the user signs in by hand, once.
console.log('\n-- credentials do not cross sites either --');
await storage.clearAll();
await armAccount(TEST_PASSWORD, HOST); // site 99999
let siteState = await storage.getState();
check('the credential is recorded for its site', String(siteState.accounts[0].siteId) === String(SITE_ID), siteState.accounts[0].siteId);
check('it is picked for its own site', storage.pickAccount(siteState, HOST, SITE_ID)?.email === TARGET_EMAIL);
check('it is not picked for another site on the same dashboard', storage.pickAccount(siteState, HOST, FOREIGN_SITE) === null);
check('otherSitesOn explains what is saved here', storage.otherSitesOn(siteState, HOST, FOREIGN_SITE).length === 1);

await dropSession();
loginCalls = 0;
const wrongSite = await call({
  type: 'ensureAuth',
  hostname: HOST,
  domain: HOST,
  siteId: FOREIGN_SITE,
  url: `https://${HOST}/ui/${FOREIGN_SITE}/ai/dashboard/`,
  force: true
});
check('ensureAuth refuses a site it has no credential for', wrongSite && wrongSite.ok === false && wrongSite.reason === 'no-account', wrongSite);
check('  ... naming the site that is missing', String(wrongSite && wrongSite.requestedSiteId) === FOREIGN_SITE, wrongSite && wrongSite.requestedSiteId);
check('  ... pointing at what is saved instead', new RegExp(`site ${SITE_ID}\\b`).test((wrongSite && wrongSite.message) || ''), wrongSite && wrongSite.message);
check('  ... and never calls the login API', loginCalls === 0, { loginCalls });
// The popup explains the silence from this record, so a refusal that is not written is a refusal the
// user cannot see.
const refusalRecord = (await storage.getState()).hostState[HOST] || {};
check('  ... and the reason is recorded for the popup', refusalRecord.lastRefusal?.reason === 'no-account', refusalRecord.lastRefusal);
check('  ... naming the site that is missing', String(refusalRecord.lastRefusal?.siteId) === FOREIGN_SITE, refusalRecord.lastRefusal);

const wrongPeek = await call({ type: 'canAutoLogin', hostname: HOST, domain: HOST, siteId: FOREIGN_SITE });
check('the pre-flight refuses it too, so the form is not covered', wrongPeek && wrongPeek.eligible === false && wrongPeek.reason === 'no-account', wrongPeek);

// A credential with no site recorded is the one case worth trying: it has never signed in here, so
// the URL's claim is checked against the route service instead of being trusted outright.
await storage.clearAll();
const openId = await storage.upsertAccount({ email: 'multisite@10012.com', password: 'RefreshToken1', host: HOST, domain: HOST });
await storage.resolvePending({ accountId: openId, ok: true });
siteState = await storage.getState();
check('a credential with no site is picked for any site', storage.pickAccount(siteState, HOST, FOREIGN_SITE)?.id === openId);

await dropSession();
loginCalls = 0;
const ownedSite = await call({
  type: 'ensureAuth',
  hostname: HOST,
  domain: HOST,
  siteId: 31337,
  url: `https://${HOST}/ui/31337/ai/dashboard/`,
  force: true
});
check('a site the route service confirms is used as asked', ownedSite && ownedSite.ok === true && String(ownedSite.siteId) === '31337', ownedSite);
check('  ... by actually signing in', loginCalls > 0, { loginCalls });
check(
  '  ... and the site is remembered on the credential',
  String((await storage.getState()).accounts.find((a) => a.id === openId).siteId) === '31337'
);

// A session that already exists is proof, not a claim: it must be recognised even though the URL's
// claim has not been checked, and it is what teaches the credential which site it belongs to.
await storage.clearAll();
const recognisedId = await storage.upsertAccount({ email: 'multisite@10012.com', password: 'RefreshToken1', host: HOST, domain: HOST });
await storage.resolvePending({ accountId: recognisedId, ok: true });
await dropSession();
await chrome.cookies.set({
  url: `https://${HOST}/`,
  domain: COOKIE_DOMAIN,
  path: '/',
  name: 'token_31337',
  value: fakeJwt(Math.floor(Date.now() / 1000) + 3600),
  secure: true,
  httpOnly: true,
  sameSite: 'strict'
});
loginCalls = 0;
const recognised = await call({
  type: 'ensureAuth',
  hostname: HOST,
  domain: HOST,
  siteId: 31337,
  url: `https://${HOST}/ui/31337/ai/dashboard/`
});
check('an existing session is recognised before the claim is checked', recognised && recognised.ok === true && recognised.alreadySignedIn === true, recognised);
check('  ... without signing in again', loginCalls === 0, { loginCalls });
check(
  '  ... and it records which site the credential is for',
  String((await storage.getState()).accounts.find((a) => a.id === recognisedId).siteId) === '31337'
);

// The same account asked for a site it does not own is refused by the route service, not attempted.
await storage.clearAll();
const strayId = await storage.upsertAccount({ email: 'nowhere@10012.com', password: 'RefreshToken1', host: HOST, domain: HOST });
await storage.resolvePending({ accountId: strayId, ok: true });
await dropSession();
loginCalls = 0;
const stray = await call({
  type: 'ensureAuth',
  hostname: HOST,
  domain: HOST,
  siteId: FOREIGN_SITE,
  url: `https://${HOST}/ui/${FOREIGN_SITE}/ai/dashboard/`,
  force: true
});
check('a credential the route service does not place on a site is refused', stray && stray.ok === false && stray.reason === 'no-route', stray);
check('  ... without a login attempt', loginCalls === 0, { loginCalls });

// Identity is (address, dashboard). The site is not part of it and is never typed: it is the route
// service's answer, remembered on the record once a sign-in proves it.
await storage.clearAll();
const addOnce = await storage.upsertAccount({ email: TARGET_EMAIL, password: 'a', host: HOST, domain: HOST });
const addTwice = await storage.upsertAccount({ email: TARGET_EMAIL, password: 'a2', host: HOST, domain: HOST });
const perSiteState = await storage.getState();
check('re-adding an address on the same dashboard updates its record', addOnce === addTwice && perSiteState.accounts.length === 1, perSiteState.accounts.length);
check('a credential that has never signed in has no site yet', perSiteState.accounts[0].siteId === null, perSiteState.accounts[0].siteId);
// Nor does a captured credential claim one: the address bar names a site, but the panel is the only
// thing that decides whether this account belongs to it, so the claim is not recorded as fact.
await storage.clearAll();
const claimedCapture = await call({ type: 'captureCredentials', hostname: HOST, domain: HOST, email: 'fresh@10012.com', password: 'Fresh1', siteId: '424242' });
const capturedRow = (await storage.getState()).accounts.find((a) => a.id === claimedCapture.accountId);
check('a captured credential records no site', capturedRow.siteId === null, capturedRow.siteId);

// The same address on two dashboards is two records, not one record that keeps moving.
await storage.clearAll();
const homeId = await armAccount(TEST_PASSWORD, HOST);
const bothId = await storage.upsertAccount({ email: TARGET_EMAIL, password: 'other-branch-pw', host: OTHER_HOST, domain: OTHER_HOST });
scopedState = await storage.getState();
check('the same email on another dashboard is a separate record', bothId !== homeId && scopedState.accounts.length === 2, { count: scopedState.accounts.length, bothId, homeId });
check('the first record kept its dashboard', scopedState.accounts.find((a) => a.id !== bothId).domain === HOST);
check('each dashboard resolves to its own record', storage.pickAccount(scopedState, HOST)?.id !== storage.pickAccount(scopedState, OTHER_HOST)?.id);

// ------------------------------------------------------------ legacy records
console.log('\n-- records saved before accounts had a dashboard --');
await storage.clearAll();
await chrome.storage.local.set({
  comm100AutoLogin: {
    accounts: [
      { id: 'legacy-pinned', email: 'legacy@10012.com', password: 'p', hosts: [HOST, OTHER_HOST], lastHost: OTHER_HOST }
    ]
  }
});
let legacy = (await storage.getState()).accounts[0];
check('a legacy record is pinned to where it was introduced', legacy.domain === HOST, legacy.domain);
check('  ... so it no longer answers for the other branch', storage.pickAccount({ accounts: [legacy] }, OTHER_HOST) === null);

await chrome.storage.local.set({
  comm100AutoLogin: {
    accounts: [{ id: 'legacy-orphan', email: 'orphan@10012.com', password: 'p', hosts: [] }]
  }
});
legacy = (await storage.getState()).accounts[0];
check('a record with no history stays unscoped rather than guessed', legacy.domain === null, legacy.domain);
check('  ... and still answers anywhere, as the import format promises', Boolean(storage.pickAccount({ accounts: [legacy] }, OTHER_HOST)));

// ------------------------------------------------------------ site ids
console.log('\n-- the site id is remembered with the credential --');
await storage.clearAll();
const siteId = await storage.upsertAccount({ email: TARGET_EMAIL, password: TEST_PASSWORD, host: HOST, domain: HOST });
await storage.resolvePending({ accountId: siteId, ok: true });
await storage.markSuccess({ accountId: siteId, host: HOST, domain: HOST, site });
let recorded = (await storage.getState()).accounts[0];
check('a successful sign-in records the site id', recorded.siteId === String(site.siteId), recorded.siteId);
check('  ... and the portal it came from', recorded.portalUrl === site.portalUrl, recorded.portalUrl);

// Older records kept the site only in the route cache; the popup should still be able to show it.
await storage.clearAll();
await chrome.storage.local.set({
  comm100AutoLogin: {
    accounts: [{ id: 'old', email: TARGET_EMAIL, password: 'p', hosts: [HOST] }],
    routes: { [HOST]: { [TARGET_EMAIL]: { siteId: '777', portalUrl: `https://${HOST}` } } }
  }
});
recorded = (await storage.getState()).accounts[0];
check('a missing site id is backfilled from the route cache', recorded.siteId === '777', recorded.siteId);

// ------------------------------------------------------------ popup wiring
// The popup cannot be loaded here (it needs a DOM), but the one failure mode that is invisible in
// review — a script looking up an id the markup does not have — is a set comparison.
console.log('\n-- popup wiring --');
const popupHtml = readFileSync(new URL('../src/popup/popup.html', import.meta.url), 'utf8');
const popupJs = readFileSync(new URL('../src/popup/popup.js', import.meta.url), 'utf8');
const htmlIds = new Set([...popupHtml.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
const wantedIds = new Set([...popupJs.matchAll(/\bel\('([^']+)'\)/g)].map((match) => match[1]));
const missingIds = [...wantedIds].filter((id) => !htmlIds.has(id));
check('every element the popup script looks up exists', missingIds.length === 0, missingIds);
check('the popup can explain a missing credential', htmlIds.has('domain-hint'));
check('the popup offers a dashboard filter', htmlIds.has('filter-domain'));
check('the popup offers a site filter', htmlIds.has('filter-site'));
check('a filtered-out list says so instead of looking empty', htmlIds.has('filter-empty'));
check('the activity log can still be exported', htmlIds.has('export-activity'));
// The Add account form, the bottom action row, the filter's Clear button and the Activity list are
// all gone: neither rendered nor looked up.
const goneIds = [
  'add-form',
  'add-domain',
  'add-email',
  'add-password',
  'add-status',
  'login-now',
  'logout-now',
  'reload-tab',
  'filter-clear',
  'clear-events',
  'events',
  'events-empty',
  'autoLogin'
];
check(
  'no removed control is still rendered or referenced',
  goneIds.every((id) => !htmlIds.has(id) && !wantedIds.has(id)),
  goneIds.filter((id) => htmlIds.has(id) || wantedIds.has(id))
);
check('the popup edits an account in its own row', /buildAccountEditor/.test(popupJs) && htmlIds.has('accounts'));
check('there is one popup-level status line', htmlIds.has('status'));
check('the sign-out notice remains available', htmlIds.has('pause-notice') && htmlIds.has('reenable'));
// The Tailwind browser build is a remote script, and an MV3 extension page may only run scripts from
// its own package — linking the CDN would leave the popup unstyled in the real extension.
check(
  'the popup links the built stylesheet, never the Tailwind CDN',
  /href="tailwind\.css"/.test(popupHtml) && !/jsdelivr|@tailwindcss\/browser/.test(popupHtml)
);

console.log('\n-- requests wait for a usable JWT --');
await armAccount('SlowLogin1');
await dropSession();
const requestSender = { url: `https://${HOST}/ui/${SITE_ID}/entry/`, tab: { id: 91 }, frameId: 0 };
const requestMessage = { type: 'requestSession', url: `https://${HOST}/api/global/test?siteId=${SITE_ID}` };
let beforeRequests = loginCalls;
const sharedSessions = await Promise.all(Array.from({ length: 8 }, () => call(requestMessage, requestSender)));
check('concurrent requests wait for a single login', loginCalls === beforeRequests + 1, loginCalls - beforeRequests);
check('all waiting requests receive the new JWT', sharedSessions.every((r) => r.ok && r.jwt === 'stub.slow.token'), sharedSessions);
check('request messages never return saved passwords', sharedSessions.every((r) => !('password' in r) && !('email' in r)));

// Deleting a cookie immediately after signing in must not leave a real request stuck in cooldown.
await dropSession();
const recovered = await call(requestMessage, requestSender);
check('a missing token is replaced even during login cooldown', recovered.ok && recovered.jwt === 'stub.slow.token', recovered);
const replacementJwt = fakeJwt(Math.floor(Date.now() / 1000) + 3600);
await chrome.cookies.set({ url: `https://${HOST}`, domain: COOKIE_DOMAIN, path: '/', name: `token_${SITE_ID}`, value: replacementJwt });
const liveCookie = await call(requestMessage, requestSender);
check('the live cookie wins over an older cached token', liveCookie.jwt === replacementJwt, liveCookie);

beforeRequests = loginCalls;
const rejectedSessions = await Promise.all(Array.from({ length: 8 }, () => call({ ...requestMessage, rejectedToken: replacementJwt }, requestSender)));
check('concurrent 401 retries reuse a shared token different from the rejected cookie', loginCalls === beforeRequests, loginCalls - beforeRequests);
check('all rejected requests receive the replacement JWT', rejectedSessions.every((r) => r.ok && r.jwt === 'stub.slow.token'), rejectedSessions);
const invalidRequest = await call({ ...requestMessage, url: 'https://example.com/api/test' }, requestSender);
check('the bridge refuses to disclose a token to another origin', !invalidRequest.ok && !invalidRequest.jwt, invalidRequest);
const noSender = await call(requestMessage);
check('the bridge requires a browser-provided page sender', !noSender.ok, noSender);
await storage.noteLogout(HOST);
const signedOutRequest = await call(requestMessage, requestSender);
check('request interception respects an explicit sign-out', !signedOutRequest.ok && signedOutRequest.reason === 'logged-out', signedOutRequest);

console.log('\n-- static-file cookie overflow recovery --');
const sleepForCookieChecks = () => new Promise((resolve) => setTimeout(resolve, 150));
await armAccount('SlowLogin1');
await dropSession();
const cookieBudget = await import(`${ROOT}/shared/cookie-budget.js`);
const largeJwt = (iat) => `h.${Buffer.from(JSON.stringify({ iat, exp: Math.floor(Date.now() / 1000) + 7200, padding: 'x'.repeat(1800) })).toString('base64url')}.s`;
for (const [siteId, iat] of [[SITE_ID, 1], ['90001', 2], ['90002', 3]]) {
  await chrome.cookies.set({ url: `https://${HOST}`, domain: COOKIE_DOMAIN, path: '/', name: `token_${siteId}`, value: largeJwt(iat) });
  await chrome.cookies.set({ url: `https://${HOST}`, domain: COOKIE_DOMAIN, path: '/', name: `tokenExpire_${siteId}`, value: 'future' });
}
await chrome.cookies.set({ url: `https://${HOST}`, domain: COOKIE_DOMAIN, path: '/', name: 'unrelated', value: 'keep-me' });
const oldCookie = await chrome.cookies.get({ url: `https://${HOST}`, name: 'token_90001' });
const evictedSite = { siteId: '90001', portalUrl: `https://${HOST}` };
const evictedEmail = 'static-eviction@example.com';
const evictedAccount = await storage.upsertAccount({ email: evictedEmail, password: 'SlowLogin1', host: HOST, domain: HOST });
await storage.resolvePending({ accountId: evictedAccount, ok: true });
await storage.noteSite({ accountId: evictedAccount, site: evictedSite, domain: HOST });
await storage.putRoute(HOST, evictedEmail, evictedSite);
const staticFailure = { type: 'script', method: 'GET', statusCode: 400, tabId: 92, frameId: 0,
  url: `https://${HOST}/assets/app.js`, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }] };
currentTabUrl = `https://${HOST}/ui/${SITE_ID}/entry/`;
const reloadCount = tabReloads.length;
check('a static-response listener is registered', staticResponseListeners.length === 1);
for (const fn of staticResponseListeners) fn(staticFailure);
await waitFor(() => tabReloads.length > reloadCount);
check('static 400 with large cookies reloads the affected page once', tabReloads.length === reloadCount + 1);
check('the current site token is kept', Boolean(await chrome.cookies.get({ url: `https://${HOST}`, name: `token_${SITE_ID}` })));
check('older JWTs and companion expiry cookies are removed', !await chrome.cookies.get({ url: `https://${HOST}`, name: 'token_90001' }) && !await chrome.cookies.get({ url: `https://${HOST}`, name: 'tokenExpire_90001' }));
check('the resulting cookie header fits the budget', cookieBudget.cookieHeaderBytes(await cookies.getAllCookies(`https://${HOST}`)) <= cookieBudget.COOKIE_HEADER_BUDGET_BYTES);
check('unrelated cookies are kept', (await chrome.cookies.get({ url: `https://${HOST}`, name: 'unrelated' }))?.value === 'keep-me');
beforeRequests = loginCalls;
for (const fn of cookieChangeListeners) fn({ removed: true, cookie: oldCookie, cause: 'explicit' });
await sleepForCookieChecks();
check('the watchdog does not re-create deliberately evicted JWTs', loginCalls === beforeRequests && !await chrome.cookies.get({ url: `https://${HOST}`, name: 'token_90001' }));
for (const fn of staticResponseListeners) fn({ ...staticFailure, statusCode: 431 });
await sleepForCookieChecks();
check('failing assets cannot create a reload loop', tabReloads.length === reloadCount + 1);
for (const fn of staticResponseListeners) {
  fn({ ...staticFailure, tabId: 93 });
  fn({ ...staticFailure, tabId: 94, statusCode: 431, method: 'POST' });
  fn({ ...staticFailure, tabId: 95, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }] });
}
await sleepForCookieChecks();
check('small-cookie 400s, POSTs and normal validation responses do not reload', tabReloads.length === reloadCount + 1);

for (const siteId of ['90003', '90004']) {
  await chrome.cookies.set({ url: `https://${HOST}`, domain: COOKIE_DOMAIN, path: '/', name: `token_${siteId}`, value: largeJwt(Number(siteId)) });
}
for (const fn of staticResponseListeners) fn({ ...staticFailure, type: 'main_frame', tabId: 96, url: currentTabUrl });
await waitFor(() => tabReloads.length > reloadCount + 1);
check('the initial HTML page can recover before application JavaScript loads', tabReloads.length === reloadCount + 2);
for (const fn of staticResponseListeners) fn({ ...staticFailure, statusCode: 431, tabId: 96, url: 'https://assets.comm100dev.io/app.css', type: 'stylesheet' });
await sleepForCookieChecks();
check('the retry guard covers different static hosts in the same page', tabReloads.length === reloadCount + 2);

console.log('\n-- cookie recovery navigation and reload outcomes --');
const addOverflowCookies = async () => {
  jar.clear();
  for (const [siteId, iat] of [[SITE_ID, 1], ['90010', 2], ['90011', 3]]) {
    await chrome.cookies.set({ url: `https://${HOST}`, domain: COOKIE_DOMAIN, path: '/', name: `token_${siteId}`, value: largeJwt(iat) });
  }
};
const nativeRemoveCookie = chrome.cookies.remove;
const nativeReloadTab = chrome.tabs.reload;
for (const [index, scenario] of [
  { name: 'SPA URL changes still reload the same document', reload: true,
    change: () => { currentTabUrl = `https://${HOST}/ui/${SITE_ID}/livechat/dashboard/`; } },
  { name: 'fragment changes still reload the same document', reload: true,
    change: () => { currentTabUrl += '#loaded'; } },
  { name: 'another document at the same URL is left alone', reload: false,
    change: () => { currentDocumentId = 'replacement-document'; } },
  { name: 'a missing document after cleanup is left alone', reload: false,
    change: () => { currentDocumentId = undefined; } },
  { name: 'a pending navigation is left alone', reload: false,
    change: () => { pendingTabUrl = `https://${HOST}/ui/${SITE_ID}/other/`; } },
  { name: 'a rejected reload releases its retry guard', reload: false, rejectReload: true },
  { name: 'initial HTML requests ignore the tab fragment', reload: true, mainFrame: true },
  { name: 'late asset failures from a previous document are ignored', reload: false, stale: true }
].entries()) {
  const tabId = 200 + index;
  currentTabUrl = `https://${HOST}/ui/${SITE_ID}/entry/${scenario.mainFrame ? '#details' : ''}`;
  currentDocumentId = `recovery-document-${index}`;
  pendingTabUrl = undefined;
  await addOverflowCookies();
  const beforeReloads = tabReloads.length;
  const beforeBytes = cookieBudget.cookieHeaderBytes(await cookies.getAllCookies(`https://${HOST}`));
  chrome.cookies.remove = async (details) => {
    await nativeRemoveCookie(details);
    scenario.change?.();
  };
  chrome.tabs.reload = scenario.rejectReload ? async () => { throw new Error('test reload rejection'); } : nativeReloadTab;
  const failure = { ...staticFailure, tabId, documentId: scenario.stale ? 'old-document' : currentDocumentId,
    ...(scenario.mainFrame ? { type: 'main_frame', url: currentTabUrl.split('#')[0] } : {}) };
  for (const fn of staticResponseListeners) fn(failure);
  await sleepForCookieChecks();
  chrome.cookies.remove = nativeRemoveCookie;
  chrome.tabs.reload = nativeReloadTab;
  const guarded = Boolean(store.get('comm100StaticRecovery')?.[`${tabId}|${HOST}`]);
  check(scenario.name, tabReloads.length === beforeReloads + Number(scenario.reload) && guarded === scenario.reload);
  const recoveryEvent = (await storage.getState()).events.find((e) => e.kind === 'cookie-budget');
  if (scenario.reload) {
    check('successful reload is reported after Chrome accepts it', recoveryEvent?.detail.endsWith('page reload requested once'));
    for (const fn of staticResponseListeners) fn({ ...failure, statusCode: 431 });
    await sleepForCookieChecks();
    check('same-document recovery still permits only one reload', tabReloads.length === beforeReloads + 1);
  } else if (scenario.stale) {
    check('stale document failures do not remove any cookies', cookieBudget.cookieHeaderBytes(await cookies.getAllCookies(`https://${HOST}`)) === beforeBytes);
  } else {
    const outcome = scenario.rejectReload ? 'page reload failed: test reload rejection' : 'reload skipped: tab is navigating to another page';
    check('the activity log explains the unsuccessful reload', recoveryEvent?.detail.endsWith(outcome));
  }
  if (scenario.rejectReload) {
    await addOverflowCookies();
    for (const fn of staticResponseListeners) fn(failure);
    await waitFor(() => tabReloads.length > beforeReloads);
    check('a failed reload does not block a later recovery', tabReloads.length === beforeReloads + 1);
  }
}
pendingTabUrl = undefined;

// Make the evicted site the keep-alive's only target, so this checks suppression rather than
// merely relying on an unrelated current site's still-fresh cookie.
await storage.clearAll();
await storage.putRoute(HOST, evictedEmail, evictedSite);
const dormantAccount = await storage.upsertAccount({ email: evictedEmail, password: 'SlowLogin1', host: HOST, domain: HOST });
await storage.resolvePending({ accountId: dormantAccount, ok: true });
await storage.noteSite({ accountId: dormantAccount, site: evictedSite, domain: HOST });
beforeRequests = loginCalls;
for (const fn of alarmListeners) fn({ name: 'comm100-keep-alive' });
await sleepForCookieChecks();
check('keep-alive leaves evicted sites dormant', loginCalls === beforeRequests);
const revisit = await call({ type: 'ensureAuth', domain: HOST, siteId: evictedSite.siteId, force: true });
check('a real visit can sign an evicted site in again', revisit.ok && !await cookieBudget.isSessionPruned(HOST, evictedSite.siteId), revisit);

console.log('\n-- shared CLI/browser JWT cache --');
await armAccount('SlowLogin1');
await dropSession();
const sharedAccount = (await storage.getState()).accounts.find((a) => a.email === TARGET_EMAIL);
const sharedJwt = fakeJwt(Math.floor(Date.now() / 1000) + 7200);
await storage.saveToken({ accountId: sharedAccount.id, email: sharedAccount.email, domain: HOST,
  siteId: SITE_ID, jwtToken: sharedJwt });
beforeRequests = loginCalls;
const fromSharedCache = await call({ type: 'ensureAuth', domain: HOST, siteId: SITE_ID, force: true });
check('browser login restores a shared JWT without exchanging credentials', fromSharedCache.ok && loginCalls === beforeRequests, fromSharedCache);
check('the shared JWT becomes the real session cookie', (await chrome.cookies.get({ url: `https://${HOST}`, name: `token_${SITE_ID}` }))?.value === sharedJwt);
await storage.clearFailures(HOST);
const afterRejection = await call({ type: 'ensureAuth', domain: HOST, siteId: SITE_ID,
  force: true, forceRefresh: true, rejectedToken: sharedJwt });
check('a server-rejected JWT is not restored from the shared cache', afterRejection.ok && loginCalls === beforeRequests + 1, afterRejection);
check('browser credential login updates the shared cache', (await storage.getState()).tokens.some((token) => token.jwtToken === 'stub.slow.token'));

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`}${skipped ? ` (${skipped} skipped)` : ''}`);
process.exit(failed === 0 ? 0 : 1);
