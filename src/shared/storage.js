/**
 * Persistent state, kept in a single `chrome.storage.local` key so every update is one
 * read-modify-write. Never uses `storage.sync`: credentials stay on this machine.
 *
 * Account lifecycle
 * -----------------
 * A saved password is only trusted once the login API has accepted it (`verifiedAt` is set).
 * Credentials captured from the login form land in `pendingPassword` first and are promoted
 * on a successful verification, so a typo can never destroy a working password.
 *
 * Accounts are scoped to a dashboard (`domain`, the host with any port — see platforms.js).
 * Comm100's test branches share one cookie domain but are separate deployments, so a password that
 * works on one is not evidence for another, and guessing across them just spends attempts against
 * the account lockout threshold.
 */

const KEY = 'comm100AutoLogin';

export const STORAGE_DEFAULTS = Object.freeze({
  /** Minimum gap between automatic attempts for the same host. */
  cooldownMs: 60000,
  /**
   * Auto-login pauses for a host after this many consecutive credential failures.
   * Comm100 locks an account once failed logins exceed the site's password policy, and the
   * lock only clears after ~30 minutes, so this is deliberately low.
   */
  maxConsecutiveFailures: 2,
  /** After an explicit "Log out now" we stay out of the way for this long. */
  logoutSuppressionMs: 300000,
  /** How long a getByEmail result may be reused. */
  routeCacheTtlMs: 86400000,
  /** Follow the app's own redirect when landing on /login. */
  redirectFromLogin: true,
  /** Optional partnerId for the route lookup; the API works without it. */
  partnerId: null
});

let queue = Promise.resolve();

/** Serialises writes so concurrent ensureAuth calls cannot clobber each other. */
function serialize(task) {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * The credential-scope key: a host, optionally with its port. Accepts a full URL too, so callers
 * can hand over whatever they have (`location.host`, `new URL(url).host`, a saved `hosts` entry).
 */
export const normalizeDomain = (domain) =>
  String(domain || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/\/.*$/, '');

/**
 * Pins a legacy record (saved before accounts had a domain) to a dashboard.
 *
 * `hosts` is the only evidence available, and its *first* entry is where the credential was
 * introduced: everything appended later was a successful sign-in, which by definition was not the
 * cross-branch mistake. Unpinnable records keep a null domain — a deliberate wildcard, so an
 * imported or hand-edited file still works — and the popup asks for a domain on edit.
 */
function withDomain(account) {
  if (!account || typeof account !== 'object') return account;
  if (normalizeDomain(account.domain)) return account;
  const hosts = Array.isArray(account.hosts) ? account.hosts.filter(Boolean) : [];
  const inherited = normalizeDomain(hosts[0] || account.lastHost || '');
  return { ...account, domain: inherited || null };
}

/**
 * Backfills the site id from the route cache for records saved before it lived on the account.
 * The cache is keyed by host, so every host the account has been used on is worth a look.
 */
function withSite(account, routes) {
  if (!account || account.siteId) return account;
  const email = String(account.email || '').trim().toLowerCase();
  const hosts = new Set(
    [normalizeDomain(account.domain), account.lastHost, ...(Array.isArray(account.hosts) ? account.hosts : [])]
      .filter(Boolean)
      .map(normalizeDomain)
  );
  for (const host of hosts) {
    const entry = routes?.[host]?.[email];
    if (entry && entry.siteId) {
      return { ...account, siteId: String(entry.siteId), portalUrl: entry.portalUrl || account.portalUrl || null };
    }
  }
  return account;
}

export async function getState() {
  const raw = await chrome.storage.local.get(KEY);
  const state = raw && typeof raw[KEY] === 'object' && raw[KEY] !== null ? raw[KEY] : {};
  const routes = state.routes && typeof state.routes === 'object' ? state.routes : {};
  return {
    version: 1,
    settings: { ...STORAGE_DEFAULTS, ...(state.settings || {}) },
    accounts: (Array.isArray(state.accounts) ? state.accounts : [])
      .map(withDomain)
      .map((account) => withSite(account, routes)),
    routes,
    hostState: state.hostState && typeof state.hostState === 'object' ? state.hostState : {},
    events: Array.isArray(state.events) ? state.events : []
  };
}

/**
 * A small rolling log of what the worker actually did and why.
 *
 * Without this, "it reloaded" is guesswork: there are half a dozen paths that could plausibly be
 * responsible and no way to tell them apart after the fact. Capped, newest first, and shown in the
 * popup.
 */
export const recordEvent = (kind, detail) =>
  mutate((state) => {
    const events = Array.isArray(state.events) ? state.events : [];
    events.unshift({
      at: Date.now(),
      kind: String(kind || '?'),
      detail: detail == null ? '' : String(detail).slice(0, 220)
    });
    state.events = events.slice(0, 40);
  });

export const clearEvents = () =>
  mutate((state) => {
    state.events = [];
  });

async function mutate(task) {
  return serialize(async () => {
    const state = await getState();
    const result = await task(state);
    await chrome.storage.local.set({ [KEY]: state });
    return result;
  });
}

// ---------------------------------------------------------------- settings

export const setSettings = (patch) =>
  mutate((state) => {
    state.settings = { ...state.settings, ...patch };
    return state.settings;
  });

// ---------------------------------------------------------------- accounts

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

/**
 * Finds an account by address and dashboard.
 *
 * Both are part of the identity: the same person usually has the same address on several
 * dashboards, with a different password (or none at all) on each, so matching on the address alone
 * would have one branch's edit silently retarget another branch's credential.
 *
 * The *site* deliberately is not. Which site an email uses on a dashboard is not something a human
 * types or should have to know — the route service answers it (`getByEmail`), and the answer is
 * remembered on the account once a sign-in proves it. Two records for one address here would mean
 * asking the user to disambiguate something the API already knows.
 */
export function findAccount(state, email, domain) {
  const wanted = normalizeEmail(email);
  const wantedDomain = normalizeDomain(domain) || null;
  return (
    state.accounts.find(
      (account) =>
        normalizeEmail(account.email) === wanted && (normalizeDomain(account.domain) || null) === wantedDomain
    ) || null
  );
}

/** Site ids are compared as strings; null/'' mean "no particular site". */
export const normalizeSiteId = (siteId) => {
  const value = siteId == null ? '' : String(siteId).trim();
  return value === '' ? null : value;
};

/** Accounts that actually have a usable password, newest first. */
export function usableAccounts(state) {
  return state.accounts
    .filter((account) => account.password || account.pendingPassword)
    .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
}

/**
 * The credential to try for an account: the verified password when there is one, otherwise the
 * one most recently typed into the sign-in form.
 */
export const effectivePassword = (account) => (account && (account.password || account.pendingPassword)) || null;

/** True when an account may be used on `domain` — a null domain is the unscoped legacy wildcard. */
export const accountMatchesDomain = (account, domain) =>
  !normalizeDomain(account && account.domain) || normalizeDomain(account.domain) === normalizeDomain(domain);

/**
 * Picks the credential to sign in with, for this dashboard and this site.
 *
 * Scoped by domain first, because Comm100 test branches share a cookie domain but not a database.
 * Then by site, because one dashboard can serve several sites and a credential belongs to one of
 * them:
 *
 *   - `siteId` known (a URL usually names one): an account recorded for that exact site, else an
 *     account that has no site recorded yet — it has never signed in here, so it may well be the
 *     right one. **If neither exists the answer is nothing**, and the caller leaves the dashboard to
 *     show its sign-in page: guessing between sites is what hands the panel a session it rejects, and
 *     a rejected session is a reload loop.
 *   - `siteId` unknown: the most recently used account for the dashboard.
 *
 * The site is never typed by a human — it is the route service's answer, cached on the account once a
 * sign-in proves it (see `noteSite` / `markSuccess`).
 *
 * Records with no domain at all stay a wildcard and are the last resort, as before.
 */
export function pickAccount(state, domain, siteId = null) {
  const usable = usableAccounts(state);
  if (!usable.length) return null;

  const wantedDomain = normalizeDomain(domain);
  const forDomain = wantedDomain ? usable.filter((a) => normalizeDomain(a.domain) === wantedDomain) : [];
  const pool = forDomain.length ? forDomain : usable.filter((a) => !normalizeDomain(a.domain));
  if (!pool.length) return null;

  const wantedSite = normalizeSiteId(siteId);
  if (!wantedSite) return pool[0];

  return (
    pool.find((account) => normalizeSiteId(account.siteId) === wantedSite) ||
    pool.find((account) => !normalizeSiteId(account.siteId)) ||
    null
  );
}

/** Every account that could sign in on this dashboard, newest first (before site scoping). */
export function accountsForDomain(state, domain) {
  return usableAccounts(state).filter((account) => accountMatchesDomain(account, domain));
}

// ---------------------------------------------------------------- account filters

/**
 * Filter values for the popup's Accounts list.
 *
 * `FILTER_ANY` means "do not narrow by this". `FILTER_UNSCOPED` is a *value*, not a wildcard: it
 * selects the credentials with no dashboard (or no site) recorded yet, which the list shows as
 * `any dashboard` / `any site`. They are deliberately different values — the list has to be able to
 * show either everything or only the unscoped rows, and an empty value cannot mean both.
 */
export const FILTER_ANY = '';
export const FILTER_UNSCOPED = '~unscoped';

/**
 * Narrows accounts to a dashboard and/or a site, preserving the caller's order (newest first).
 *
 * The Accounts list is the only place every saved credential is visible at once, and the question it
 * gets asked is almost always "which of these is the one for site 10010 on livechat6dash?" — a
 * domain/site pair. Both filters are independent and optional.
 */
export function filterAccounts(accounts, { domain = FILTER_ANY, siteId = FILTER_ANY } = {}) {
  // `FILTER_UNSCOPED` resolves to null, which is exactly how an unscoped account reads.
  const wantedDomain = domain === FILTER_UNSCOPED ? null : normalizeDomain(domain);
  const wantedSite = siteId === FILTER_UNSCOPED ? null : normalizeSiteId(siteId);
  return (Array.isArray(accounts) ? accounts : []).filter((account) => {
    if (domain !== FILTER_ANY && (normalizeDomain(account.domain) || null) !== wantedDomain) return false;
    if (siteId !== FILTER_ANY && normalizeSiteId(account.siteId) !== wantedSite) return false;
    return true;
  });
}

/** Every account already tied to a *different* site on this dashboard, for explaining a refusal. */
export function otherSitesOn(state, domain, siteId) {
  const wanted = normalizeSiteId(siteId);
  return accountsForDomain(state, domain)
    .filter((account) => normalizeSiteId(account.siteId) && normalizeSiteId(account.siteId) !== wanted)
    .map((account) => `${account.email} → site ${account.siteId}`);
}

export const upsertAccount = ({ email, password, host, domain }) =>
  mutate((state) => {
    const now = Date.now();
    let account = findAccount(state, email, domain);
    if (!account) {
      account = {
        id: crypto.randomUUID(),
        email: String(email).trim(),
        password: null,
        pendingPassword: null,
        verifiedAt: null,
        needsReview: false,
        domain: normalizeDomain(domain) || null,
        siteId: null,
        createdAt: now,
        lastUsedAt: 0,
        useCount: 0,
        lastHost: host || null,
        hosts: host ? [host] : []
      };
      state.accounts.push(account);
    }
    account.pendingPassword = password;
    if (domain) account.domain = normalizeDomain(domain);
    if (host) account.hosts = Array.from(new Set([...(account.hosts || []), host]));
    // Adding or updating a credential *is* the answer to "nothing to sign in with", so whatever was
    // refused here no longer applies.
    if (host && state.hostState[host]) {
      delete state.hostState[host].lastRefusal;
      delete state.hostState[host].lastRefusalAt;
    }
    return account.id;
  });

/**
 * Records credentials typed into the login form; trusted only after verification.
 *
 * The site from the URL is *not* recorded: it is a claim, not a fact — the panel will not even sign
 * the account in if the claim is wrong — and a wrong site remembered here would skip the route
 * check that keeps a rejected session from being planted. A successful sign-in records the site.
 */
export const captureCredentials = ({ email, password, host, domain }) =>
  upsertAccount({ email, password, host, domain });

/** Applies the outcome of a verification attempt against the login API. */
export const resolvePending = ({ accountId, ok }) =>
  mutate((state) => {
    const account = state.accounts.find((a) => a.id === accountId);
    if (!account) return null;
    if (ok) {
      if (account.pendingPassword) {
        account.password = account.pendingPassword;
        account.pendingPassword = null;
      }
      account.verifiedAt = Date.now();
      account.needsReview = false;
      account.lastUsedAt = Date.now();
      return account;
    }
    account.pendingPassword = null;
    if (!account.password) {
      // Nothing was ever verified for this address: drop the empty shell.
      state.accounts = state.accounts.filter((a) => a.id !== accountId);
      return null;
    }
    account.needsReview = true;
    return account;
  });

export const markSuccess = ({ accountId, host, site, domain }) =>
  mutate((state) => {
    const hs = (state.hostState[host] ||= {});
    hs.consecutiveFailures = 0;
    hs.paused = false;
    hs.lastSuccessAt = Date.now();

    const account = state.accounts.find((a) => a.id === accountId);
    if (account) {
      account.lastUsedAt = Date.now();
      account.useCount = (account.useCount || 0) + 1;
      account.lastHost = host;
      account.hosts = Array.from(new Set([...(account.hosts || []), host]));
      if (domain) account.domain = normalizeDomain(domain);
      delete hs.lastRefusal;
      delete hs.lastRefusalAt;
      if (account.pendingPassword) {
        account.password = account.pendingPassword;
        account.pendingPassword = null;
      }
      account.verifiedAt = Date.now();
      account.needsReview = false;
      if (site) {
        account.siteId = String(site.siteId);
        if (site.portalUrl) account.portalUrl = String(site.portalUrl);
        state.routes[host] ||= {};
        state.routes[host][normalizeEmail(account.email)] = { ...site, at: Date.now() };
      }
    }
    return account || null;
  });

export const removeAccount = (accountId) =>
  mutate((state) => {
    state.accounts = state.accounts.filter((a) => a.id !== accountId);
  });

/**
 * Records which site an account resolves to on a dashboard.
 *
 * Purely informational — the login path re-derives the site every time — but it is the difference
 * between "an account for livechat6dash" and "site 10010 on livechat6dash", and it is the first
 * thing worth knowing when a sign-in is rejected.
 */
export const noteSite = ({ accountId, site, domain }) =>
  mutate((state) => {
    const account = state.accounts.find((a) => a.id === accountId);
    if (!account || !site || !site.siteId) return false;
    // Only fills a gap. This is called when a session is merely *observed*, and a session can belong
    // to a site this credential is not for (every branch shares one cookie domain), so it must never
    // overwrite the site a real sign-in established.
    if (!normalizeSiteId(account.siteId)) account.siteId = String(site.siteId);
    if (site.portalUrl) account.portalUrl = String(site.portalUrl);
    if (domain) account.domain = normalizeDomain(domain);
    return true;
  });

// ---------------------------------------------------------------- host state

export const markFailure = (host) =>
  mutate((state) => {
    const hs = (state.hostState[host] ||= {});
    hs.consecutiveFailures = (hs.consecutiveFailures || 0) + 1;
    if (hs.consecutiveFailures >= state.settings.maxConsecutiveFailures) hs.paused = true;
    return { failures: hs.consecutiveFailures, paused: Boolean(hs.paused) };
  });

/**
 * Why the last attempt on this host was refused before it could even try.
 *
 * A refusal is not a failure — no credential was presented — but it is exactly the thing that looks
 * like "the extension does nothing", so it is kept for the popup to explain.
 */
export const noteRefusal = (host, refusal) =>
  mutate((state) => {
    const hs = (state.hostState[host] ||= {});
    hs.lastRefusalAt = Date.now();
    hs.lastRefusal = {
      reason: String((refusal && refusal.reason) || 'refused'),
      // The requested site is kept so a repeat of the *same* doomed attempt can be recognised and
      // skipped, instead of re-asking the route service on every 401.
      siteId: refusal && refusal.siteId != null ? String(refusal.siteId) : null,
      message: String((refusal && refusal.message) || '').slice(0, 300)
    };
  });

export const noteAttempt = (host) =>
  mutate((state) => {
    (state.hostState[host] ||= {}).lastAttemptAt = Date.now();
  });

/** Clears the failure pause *and* the post-logout suppression, i.e. "start signing in again". */
export const clearFailures = (host) =>
  mutate((state) => {
    state.hostState[host] = {
      ...(state.hostState[host] || {}),
      consecutiveFailures: 0,
      paused: false,
      lastAttemptAt: 0
    };
    delete state.hostState[host].justLoggedOutAt;
    delete state.hostState[host].lastRefusal;
    delete state.hostState[host].lastRefusalAt;
  });

export const noteLogout = (host) =>
  mutate((state) => {
    (state.hostState[host] ||= {}).justLoggedOutAt = Date.now();
  });

export function isSuppressed(state, host) {
  const hs = state.hostState[host] || {};
  if (!hs.justLoggedOutAt) return false;
  return Date.now() - hs.justLoggedOutAt < state.settings.logoutSuppressionMs;
}

export function isCoolingDown(state, host) {
  const hs = state.hostState[host] || {};
  if (!hs.lastAttemptAt) return false;
  return Date.now() - hs.lastAttemptAt < state.settings.cooldownMs;
}

// ---------------------------------------------------------------- route cache

export function getCachedRoute(state, host, email) {
  const entry = state.routes?.[host]?.[normalizeEmail(email)];
  if (!entry) return null;
  if (Date.now() - (entry.at || 0) > state.settings.routeCacheTtlMs) return null;
  return entry;
}

export const putRoute = (host, email, site) =>
  mutate((state) => {
    state.routes[host] ||= {};
    state.routes[host][normalizeEmail(email)] = { ...site, at: Date.now() };
  });

// ---------------------------------------------------------------- maintenance

/**
 * Erases everything.
 *
 * Through the same queue as every other write, not straight to `storage.local.remove`. Each mutate
 * is a read-modify-write of the whole state, so an unqueued remove can land *between* a write's read
 * and its write — and the write then puts back everything the user just erased (a recorded event, a
 * use counter, a re-planted session). Serialised, a clear can only fall between writes.
 */
export const clearAll = () => serialize(() => chrome.storage.local.remove(KEY));

export const exportState = () => getState();

export const importState = (text) =>
  mutate((state) => {
    const incoming = JSON.parse(text);
    if (incoming && Array.isArray(incoming.accounts)) {
      // Same legacy sweep as getState(): a file exported before domains existed still lands pinned
      // to whatever dashboard it was last used on.
      state.accounts = incoming.accounts.map(withDomain);
    } else {
      throw new Error('Imported JSON has no "accounts" array');
    }
    if (incoming.settings && typeof incoming.settings === 'object') {
      state.settings = { ...state.settings, ...incoming.settings };
    }
    if (incoming.routes && typeof incoming.routes === 'object') state.routes = incoming.routes;
    if (incoming.hostState && typeof incoming.hostState === 'object') state.hostState = incoming.hostState;
    return state.accounts.length;
  });
