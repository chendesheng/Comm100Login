import { isSupportedHost, routeOriginFor } from '../shared/api.js';
import * as store from '../shared/storage.js';

const el = (id) => document.getElementById(id);

/**
 * Tailwind classes for the DOM this script builds, and the tones the status/session lines switch
 * between.
 *
 * Every name is written out literally here (and in `popup.html`) because Tailwind scans this file as
 * plain text: a class assembled from parts at runtime would never make it into the built stylesheet.
 */
const CLASS = {
  card: 'card',
  email: 'font-semibold break-all',
  domain: 'break-all text-[11px] text-slate-500',
  meta: 'mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500',
  pill: 'pill',
  pillWarn: 'pill pill-warn',
  actions: 'mt-1.5 flex flex-wrap gap-1.5',
  button: 'btn',
  primary: 'btn btn-primary',
  link: 'btn btn-link',
  session: 'mt-1.5 text-xs',
  status: 'px-3.5 pt-2 text-xs text-slate-500',
  editor: 'mt-1.5 grid gap-1.5',
  field: 'field'
};
const SESSION_TONE = { ok: 'text-emerald-700', off: 'text-slate-500', warn: 'text-red-700' };
const STATUS_TONE = { ok: 'text-emerald-700', err: 'text-red-700' };

const context = { tabId: null, url: '', host: '', domain: '', origin: '', supported: false };
let editingAccountId = null;
let revealedAccountId = null;
let clearArmed = false;
/**
 * Account-list filters. Kept in memory only: they are a look at the list right now, not a setting, so
 * reopening the popup never silently hides credentials the user forgot they filtered out.
 */
let filterDomain = store.FILTER_ANY;
let filterSite = store.FILTER_ANY;
/** How long a refusal stays on screen; a successful sign-in clears it sooner. */
const REFUSAL_VISIBLE_MS = 10 * 60 * 1000;

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

// ---------------------------------------------------------------- domain help

/**
 * The dashboard to fall back on when an account does not have one: this tab's, when it is one.
 *
 * There is no dashboard *picker* any more — accounts are added by signing in through the panel (the
 * capture path) and edited in place — so this exists only for the legacy records that were imported
 * or saved before accounts were scoped at all.
 */
const defaultDomain = () => (context.supported ? context.domain : '');

/** The site this tab shows (`/ui/10010/…`) — the site a credential added from here is for. */
function siteIdFromTab() {
  const direct = /\/ui\/(\d+)(?:\/|$)/.exec(context.url || '');
  if (direct) return direct[1];
  try {
    const retUrl = new URL(context.url).searchParams.get('retUrl');
    const inner = retUrl && /\/ui\/(\d+)(?:\/|$)/.exec(retUrl);
    return inner ? inner[1] : '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- formatting

function relativeTime(timestamp) {
  if (!timestamp) return 'never used';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatExpiry(timestamp) {
  if (!timestamp) return 'unknown expiry';
  return `until ${new Date(timestamp).toLocaleTimeString()}`;
}

function setStatus(element, text, kind) {
  element.textContent = text || '';
  element.className = `${CLASS.status}${kind && STATUS_TONE[kind] ? ` ${STATUS_TONE[kind]}` : ''}`;
  // The status line reserves no space when there is nothing to say; the element is hidden rather
  // than left as an empty strip under the account list.
  element.hidden = !text;
}

// ---------------------------------------------------------------- account filters

/** What a dashboard filter compares against; an unscoped credential is a value of its own. */
const accountDomainKey = (account) => store.normalizeDomain(account.domain) || store.FILTER_UNSCOPED;
const accountSiteKey = (account) => store.normalizeSiteId(account.siteId) || store.FILTER_UNSCOPED;

/** Unscoped entries sort last: they are the fallback, not what the filter is usually after. */
const unscopedLast = (a, b) => (a === store.FILTER_UNSCOPED ? 1 : 0) - (b === store.FILTER_UNSCOPED ? 1 : 0);
const byDomain = (a, b) => unscopedLast(a, b) || a.localeCompare(b);
const bySite = (a, b) => unscopedLast(a, b) || Number(a) - Number(b) || a.localeCompare(b);

/**
 * Rebuilds a filter select, keeping "all" first, and returns the value that ended up selected.
 *
 * A selection with nothing behind it any more (its accounts were deleted, or the dashboard changed)
 * is dropped rather than left in place, where it would hide every row with no way to tell why.
 */
function setFilterOptions(select, allLabel, values, selected, labelFor) {
  select.textContent = '';
  const allOption = document.createElement('option');
  allOption.value = store.FILTER_ANY;
  allOption.textContent = allLabel;
  select.appendChild(allOption);

  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = labelFor(value);
    select.appendChild(option);
  }

  select.value = values.includes(selected) ? selected : store.FILTER_ANY;
  return select.value;
}

/**
 * Fills the two filters from what is actually saved.
 *
 * The site choices follow the dashboard choice: a site id only means something inside one dashboard,
 * so offering `10010` while a different dashboard is selected would be a filter that can only ever
 * return nothing.
 */
function renderAccountFilters(accounts) {
  filterDomain = setFilterOptions(
    el('filter-domain'),
    'All dashboards',
    [...new Set(accounts.map(accountDomainKey))].sort(byDomain),
    filterDomain,
    (value) => (value === store.FILTER_UNSCOPED ? 'any dashboard' : value)
  );

  const scoped =
    filterDomain === store.FILTER_ANY
      ? accounts
      : accounts.filter((account) => accountDomainKey(account) === filterDomain);
  filterSite = setFilterOptions(
    el('filter-site'),
    'All sites',
    [...new Set(scoped.map(accountSiteKey))].sort(bySite),
    filterSite,
    (value) => (value === store.FILTER_UNSCOPED ? 'any site' : `site ${value}`)
  );
}

// ---------------------------------------------------------------- rendering

async function render() {
  const state = await store.getState();

  // Session line
  const sessionEl = el('session');
  if (!context.supported) {
    sessionEl.textContent = 'Open a Comm100 page to sign in.';
    sessionEl.className = `${CLASS.session} ${SESSION_TONE.off}`;
  } else {
    const session = await send({ type: 'sessionStatus', origin: context.origin, siteId: siteIdFromTab() || null });
    if (session && session.signedIn) {
      sessionEl.textContent = `Signed in (${session.cookieName}, ${formatExpiry(session.expiresAt)})`;
      sessionEl.className = `${CLASS.session} ${SESSION_TONE.ok}`;
    } else if (session && session.expired) {
      sessionEl.textContent = `Session expired (${session.cookieName})`;
      sessionEl.className = `${CLASS.session} ${SESSION_TONE.warn}`;
    } else {
      sessionEl.textContent = 'No Comm100 session';
      sessionEl.className = `${CLASS.session} ${SESSION_TONE.off}`;
    }
  }

  // Paused banner (covers both a credential-failure pause and the post sign-out cooldown). The whole
  // strip is hidden the rest of the time, so a held-back host is the only thing that shows it.
  const hostState = state.hostState[context.host] || {};
  const paused = Boolean(hostState.paused);
  const suppressed = context.supported && store.isSuppressed(state, context.host);
  el('pause-notice').hidden = !((paused || suppressed) && context.supported);
  const reenable = el('reenable');
  if (paused) {
    reenable.textContent = `Re-enable auto-login (paused after ${hostState.consecutiveFailures || 0} failed attempts)`;
  } else if (suppressed) {
    reenable.textContent = 'Re-enable auto-login (paused after sign-out)';
  }

  // A refusal is the one outcome that looks identical to a broken extension, so it is shown here
  // rather than only in the activity log. Freshest first: a sign-in since then clears it.
  const refusal =
    hostState.lastRefusal && Date.now() - (hostState.lastRefusalAt || 0) < REFUSAL_VISIBLE_MS
      ? hostState.lastRefusal
      : null;
  const refusalEl = el('refusal');
  refusalEl.hidden = !(refusal && context.supported);
  if (refusal) refusalEl.textContent = refusal.message || `Not signing in (${refusal.reason}).`;

  // Account list, newest first
  const list = el('accounts');
  list.textContent = '';
  const sorted = state.accounts
    .slice()
    .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));

  renderAccountFilters(sorted);
  const visible = store.filterAccounts(sorted, { domain: filterDomain, siteId: filterSite });

  // The two empty states are different problems: nothing saved at all, versus everything saved is
  // hidden by a filter — the second must never look like the first.
  el('empty').hidden = sorted.length > 0;
  el('filter-empty').hidden = !(sorted.length > 0 && visible.length === 0);

  const orderHint = el('order-hint');
  orderHint.hidden = state.accounts.length < 2;
  orderHint.textContent =
    visible.length === sorted.length
      ? 'newest first'
      : `showing ${visible.length} of ${sorted.length}, newest first`;

  // "Nothing happens on this dashboard" is almost always this: a credential exists, but for another
  // dashboard. Say so instead of leaving the user to work it out from the rows below.
  const here = context.domain ? store.accountsForDomain(state, context.domain) : [];
  const hint = el('domain-hint');
  hint.hidden = !(context.supported && sorted.length > 0 && here.length === 0);
  if (!hint.hidden) {
    hint.textContent = `No credential saved for ${context.domain}. Accounts are per dashboard — nothing will sign in here until you add one.`;
  }

  for (const account of visible) {
    const item = document.createElement('li');
    item.className = CLASS.card;

    const row = document.createElement('div');

    const email = document.createElement('span');
    email.className = CLASS.email;
    email.textContent = account.email;
    row.appendChild(email);
    item.appendChild(row);

    // The dashboard the credential belongs to. Credentials are never shared between dashboards,
    // so this is the second most important thing about an account after the address.
    const domain = document.createElement('div');
    domain.className = CLASS.domain;
    domain.textContent = account.domain || 'any dashboard';
    item.appendChild(domain);

    const meta = document.createElement('div');
    meta.className = CLASS.meta;

    const used = document.createElement('span');
    used.textContent = relativeTime(account.lastUsedAt);
    meta.appendChild(used);

    const pill = document.createElement('span');
    pill.className = account.siteId ? CLASS.pill : CLASS.pillWarn;
    pill.textContent = account.siteId ? `site ${account.siteId}` : 'any site';
    meta.appendChild(pill);

    if (store.accountMatchesDomain(account, context.domain) && context.domain) {
      const pill = document.createElement('span');
      pill.className = CLASS.pill;
      pill.textContent = 'used here';
      meta.appendChild(pill);
    }

    if (!account.password) {
      const pill = document.createElement('span');
      pill.className = CLASS.pillWarn;
      pill.textContent = 'unverified';
      meta.appendChild(pill);
    } else if (account.needsReview) {
      const pill = document.createElement('span');
      pill.className = CLASS.pillWarn;
      pill.textContent = 'check password';
      meta.appendChild(pill);
    }

    if (account.useCount) {
      const pill = document.createElement('span');
      pill.className = CLASS.pill;
      pill.textContent = `${account.useCount}×`;
      meta.appendChild(pill);
    }

    if (revealedAccountId === account.id) {
      const value = document.createElement('span');
      value.className = 'font-mono break-all text-slate-700';
      value.textContent = account.password || account.pendingPassword || '(none)';
      meta.appendChild(value);
    }

    item.appendChild(meta);

    // Editing happens in the row itself: the Add account form is gone, and this is the only way left
    // to fix a password that the capture path recorded wrong.
    if (editingAccountId === account.id) {
      item.appendChild(buildAccountEditor(account));
      list.appendChild(item);
      continue;
    }

    const actions = document.createElement('div');
    actions.className = CLASS.actions;

    // Signing in needs the account's own dashboard on the other end, not the tab in front of it,
    // so the button stays live on any page for a credential that has one.
    const targetDomain = account.domain || context.domain;
    const signable = Boolean(account.password) && Boolean(routeOriginFor(targetDomain));
    const login = document.createElement('button');
    login.type = 'button';
    login.className = CLASS.primary;
    login.textContent = 'Login now';
    login.disabled = !signable;
    if (!account.password) login.title = 'No verified password saved yet';
    else if (!signable) login.title = 'Not a dashboard this extension can sign in to';
    else if (account.domain && account.domain !== context.domain) {
      login.title = `Signs in to ${account.domain} without touching this page`;
    }
    login.addEventListener('click', () => loginNow(account, login));
    actions.appendChild(login);

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = CLASS.button;
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => {
      editingAccountId = account.id;
      revealedAccountId = null;
      setStatus(el('status'), '');
      render();
    });
    actions.appendChild(edit);

    const reveal = document.createElement('button');
    reveal.type = 'button';
    reveal.className = CLASS.button;
    reveal.textContent = revealedAccountId === account.id ? 'Hide' : 'Show';
    reveal.addEventListener('click', () => {
      revealedAccountId = revealedAccountId === account.id ? null : account.id;
      render();
    });
    actions.appendChild(reveal);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = CLASS.button;
    remove.textContent = 'Delete';
    remove.addEventListener('click', async () => {
      await store.removeAccount(account.id);
      if (editingAccountId === account.id) editingAccountId = null;
      render();
    });
    actions.appendChild(remove);

    item.appendChild(actions);
    list.appendChild(item);
  }
}

// ---------------------------------------------------------------- actions

/**
 * The in-row editor. Built imperatively because the row it replaces is built the same way; the
 * inputs are the two things a saved credential is made of, the address and the password.
 *
 * The dashboard is deliberately *not* editable here. An account is identified by (address,
 * dashboard), so moving one to another dashboard is a different credential, and the capture path
 * records that for free when you sign in there. An account with no dashboard yet keeps none and is
 * verified against the tab it is being edited from.
 */
function buildAccountEditor(account) {
  const form = document.createElement('form');
  form.className = CLASS.editor;

  const email = document.createElement('input');
  email.type = 'email';
  email.className = CLASS.field;
  email.value = account.email;
  email.required = true;
  email.autocomplete = 'off';
  email.setAttribute('aria-label', 'Email');

  const password = document.createElement('input');
  password.type = 'password';
  password.className = CLASS.field;
  password.placeholder = 'New password';
  password.required = true;
  password.autocomplete = 'new-password';
  password.setAttribute('aria-label', 'New password');

  const actions = document.createElement('div');
  actions.className = CLASS.actions;

  const save = document.createElement('button');
  save.type = 'submit';
  save.className = CLASS.primary;
  save.textContent = 'Save & verify';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = CLASS.button;
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => {
    editingAccountId = null;
    setStatus(el('status'), '');
    render();
  });

  actions.append(save, cancel);
  form.append(email, password, actions);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await saveEdit(account, email.value.trim(), password.value, save);
  });

  password.focus();
  return form;
}

/**
 * Saves an in-row edit, then verifies the password the way the old form did — a replaced password is
 * only trusted once the login API accepts it, so "saved" and "works" are not confused.
 */
async function saveEdit(account, email, password, button) {
  if (!email || !password) {
    setStatus(el('status'), 'An address and a password are both required.', 'err');
    return;
  }

  button.disabled = true;
  setStatus(el('status'), 'Saving…');

  // `host` mirrors the domain so the account's history and the route cache agree with the scope the
  // worker will match it on. No site on purpose: which site an email uses comes from the route
  // service and is remembered once a sign-in proves it.
  const domain = store.normalizeDomain(account.domain) || defaultDomain();
  const previousId = account.id;
  const accountId = await store.upsertAccount({ email, password, host: domain, domain });
  // Changing the address creates the record for the new (address, dashboard) pair, because that pair
  // is the identity; the old record would otherwise linger as a duplicate.
  if (accountId !== previousId) await store.removeAccount(previousId);
  editingAccountId = null;

  if (!domain || !routeOriginFor(domain)) {
    setStatus(
      el('status'),
      `Saved${domain ? ` for ${domain}` : ''}. That dashboard has no route service, so it cannot be verified.`,
      'err'
    );
    render();
    return;
  }

  setStatus(el('status'), `Verifying against ${domain}…`);
  const result = await send({ type: 'verifyAccount', accountId, hostname: domain });
  if (result && result.ok) {
    setStatus(el('status'), `Verified — the password works.${result.siteId ? ` Site ${result.siteId}.` : ''}`, 'ok');
  } else {
    const detail = result && (result.errorMessage || result.reason);
    setStatus(el('status'), detail ? `Verification failed: ${detail}` : 'Verification failed.', 'err');
  }
  render();
}

async function loginNow(account, button) {
  if (!context.supported && !account.domain) return;
  button.disabled = true;
  button.textContent = 'Signing in…';
  // The account's own dashboard decides, not the tab: a credential belongs to one dashboard and
  // the worker will refuse to use it anywhere else.
  const domain = account.domain || context.domain;
  const result = await send({
    type: 'ensureAuth',
    hostname: context.host,
    domain,
    siteId: store.normalizeSiteId(account.siteId) || null,
    force: true,
    userInitiated: true
  });
  if (result && result.ok) {
    await openEntry(result);
  } else {
    button.disabled = false;
    button.textContent = 'Login now';
    setStatus(el('status'), (result && (result.message || result.reason)) || 'Sign-in failed', 'err');
  }
  render();
}

/**
 * Opens the dashboard the sign-in was for, in a **new tab**.
 *
 * Two deliberate choices:
 *   - The entry page with `fromlogin=1` is where the panel lands after a manual sign-in, and it is
 *     what "Login now" means: sign in *and go there*. Reloading whatever was on screen left the user
 *     staring at the sign-in page they had just been rescued from.
 *   - A new tab rather than replacing the current one: the page you were on is usually the reason you
 *     clicked (a `/login` page, another site's dashboard), and taking it away loses that context.
 *     `openerTabId` keeps the new tab beside the one it came from.
 *
 * The worker's `entryUrl` is the authority; the fallback only exists for an older worker. A failure
 * here is reported rather than swallowed: the sign-in did happen, so silently staying put would be
 * indistinguishable from the button doing nothing at all.
 */
async function openEntry(result) {
  const url =
    (result && result.entryUrl) ||
    (result && result.portalUrl && result.siteId ? `${result.portalUrl}/ui/${result.siteId}/entry/?fromlogin=1` : null);
  if (!url) {
    setStatus(el('status'), 'Signed in, but the worker did not say where to go.', 'err');
    return false;
  }
  try {
    await chrome.tabs.create({
      url,
      active: true,
      ...(typeof context.tabId === 'number' ? { openerTabId: context.tabId } : {})
    });
    return true;
  } catch (error) {
    const detail = (error && error.message) || error;
    setStatus(el('status'), `Signed in, but a new tab could not be opened at ${url} (${detail}).`, 'err');
    send({ type: 'notify', kind: 'open-tab-failed', detail: `${url} — ${detail}` });
    return false;
  }
}

// ---------------------------------------------------------------- wiring

el('filter-domain').addEventListener('change', (event) => {
  filterDomain = event.target.value;
  render();
});

el('filter-site').addEventListener('change', (event) => {
  filterSite = event.target.value;
  render();
});

el('reenable').addEventListener('click', async () => {
  await send({ type: 'resetFailures', hostname: context.host });
  setStatus(el('status'), 'Auto-login re-enabled.', 'ok');
  render();
});

/** Hands a JSON document to the browser as a download. */
function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

el('export').addEventListener('click', async () => {
  downloadJson('comm100-auto-login.json', await store.exportState());
});

/**
 * The activity log is what turns "it reloaded" into a specific cause, so it stays reachable even
 * though the popup no longer lists it: this is the way to read it now.
 */
el('export-activity').addEventListener('click', async () => {
  const events = (await store.getState()).events || [];
  if (!events.length) {
    setStatus(el('status'), 'No activity recorded yet.');
    return;
  }
  downloadJson('comm100-auto-login-activity.json', { exportedAt: new Date().toISOString(), events });
  setStatus(el('status'), `Exported ${events.length} activity event(s).`, 'ok');
});

el('import').addEventListener('click', () => el('import-file').click());

el('import-file').addEventListener('change', async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  try {
    const count = await store.importState(await file.text());
    setStatus(el('status'), `Imported ${count} account(s).`, 'ok');
  } catch (error) {
    setStatus(el('status'), `Import failed: ${(error && error.message) || error}`, 'err');
  }
  event.target.value = '';
  render();
});

el('clear-all').addEventListener('click', async () => {
  if (!clearArmed) {
    clearArmed = true;
    el('clear-all').textContent = 'Click again to erase everything';
    setTimeout(() => {
      clearArmed = false;
      el('clear-all').textContent = 'Clear all data';
    }, 4000);
    return;
  }
  await store.clearAll();
  clearArmed = false;
  el('clear-all').textContent = 'Clear all data';
  editingAccountId = null;
  setStatus(el('status'), '');
  render();
});

// ---------------------------------------------------------------- init

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  context.tabId = tab && typeof tab.id === 'number' ? tab.id : null;
  context.url = (tab && tab.url) || '';
  try {
    const parsed = new URL(context.url);
    context.host = parsed.hostname.toLowerCase();
    context.domain = parsed.host.toLowerCase();
    context.origin = parsed.origin;
  } catch {
    context.host = '';
    context.domain = '';
    context.origin = '';
  }
  context.supported = isSupportedHost(context.host) && Boolean(routeOriginFor(context.host));

  el('host').textContent = context.domain || 'Not on a Comm100 page';

  await render();
})();
