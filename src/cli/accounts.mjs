import { cp, chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, platform, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { ClassicLevel } from 'classic-level';
import { dashboardOriginFor, getByEmail, jwtLogin, needsSecondFactor, normalizeSite, routeOriginFor } from '../shared/api.js';
import { jwtExpirySeconds } from '../shared/cookies.js';
import { compareAccountOrder, effectivePassword, filterAccounts, normalizeDomain, normalizeState } from '../shared/storage.js';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const help = `Usage:
  comm100-accounts list [--domain=HOST] [--siteId=ID] [--show-password]
  comm100-accounts login <email> [--domain=HOST] [--siteId=ID]

list   Print siteId (12 columns), email (30 columns), and domain, ordered by domain, site id,
       then email, with optional filters.
login  Print a valid cached JWT, or sign in once and save the new JWT.

Options:
  --domain=HOST          Filter by dashboard; login defaults to $NAMESPACE + dash.testing.comm100dev.io
                        only when multiple site IDs match
  --siteId=ID            Restrict to a site
  --show-password       Include a 20-character password column after email (list only)
  --profile=PATH_OR_NAME  Chrome profile directory (default: Chrome's Default profile)
  --db=PATH              Extension LevelDB directory; overrides profile discovery
  --token-file=PATH      JWT cache file (default: ~/.config/comm100-accounts/tokens.json)
  --help                 Show this help

Chrome's database is copied to a temporary directory and never opened in place.
Only account rows or the JWT go to stdout. Errors go to stderr. No browser cookies are changed.
`;

export function defaultDomain(namespace = process.env.NAMESPACE) {
  if (!namespace) throw new Error('Set NAMESPACE or pass --domain.');
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(namespace) || namespace.length > 59) {
    throw new Error('NAMESPACE must be a valid dashboard name prefix.');
  }
  return `${namespace.toLowerCase()}dash.testing.comm100dev.io`;
}

function chromeDataDirectory() {
  if (platform() === 'darwin') return join(homedir(), 'Library/Application Support/Google/Chrome');
  if (platform() === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData/Local'), 'Google/Chrome/User Data');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'google-chrome');
}

export async function findDatabase({ db, profile } = {}) {
  if (db) {
    const path = resolve(db);
    if (!(await stat(path)).isDirectory()) throw new Error('--db must name a LevelDB directory.');
    return path;
  }
  const directory = profile && isAbsolute(profile) ? profile : join(chromeDataDirectory(), profile || 'Default');
  const found = new Set();
  for (const filename of ['Preferences', 'Secure Preferences']) {
    let preferences;
    try { preferences = JSON.parse(await readFile(join(directory, filename), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error(`Cannot read Chrome profile ${filename}; specify --db or check --profile.`);
    }
    for (const [id, settings] of Object.entries(preferences.extensions?.settings || {})) {
      if (!/^[a-p]{32}$/.test(id)) continue;
      if (settings.manifest?.name !== 'Comm100 Auto Login' &&
          (!settings.path || (resolve(settings.path) !== resolve(projectRoot) && basename(settings.path) !== 'Comm100Login'))) continue;
      const path = join(directory, 'Local Extension Settings', id);
      try { if ((await stat(path)).isDirectory()) found.add(path); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  if (found.size !== 1) throw new Error(found.size
    ? 'Multiple Comm100 extensions found. Select one with --db.'
    : 'Comm100 extension storage not found. Use --profile with Chrome\'s Profile Path, or --db with its LevelDB directory.');
  return [...found][0];
}

export async function readChromeState(source) {
  // Copying live LevelDB files can race Chrome's compaction. Retry a fresh copy, never
  // repair or open the original database. All copies, including on failure, are removed.
  for (let attempt = 0; attempt < 3; attempt++) {
    const temporary = await mkdtemp(join(tmpdir(), 'comm100-accounts-'));
    let db;
    try {
      const snapshot = join(temporary, 'db');
      await cp(source, snapshot, { recursive: true });
      db = new ClassicLevel(snapshot, { keyEncoding: 'utf8', valueEncoding: 'json', createIfMissing: false });
      const raw = await db.get('comm100AutoLogin');
      if (!raw || !Array.isArray(raw.accounts)) throw new Error('The database has no Comm100 account list.');
      return normalizeState(raw);
    } catch (error) {
      if (attempt === 2) throw new Error('Cannot read Comm100 accounts. Check --db/--profile; if Chrome is changing its database, quit Chrome and retry.');
    } finally {
      try { await db?.close(); } finally { await rm(temporary, { recursive: true, force: true }); }
    }
  }
}

function defaultTokenFile() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'comm100-accounts/tokens.json');
}

export async function readTokens(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (value.version !== 1 || !Array.isArray(value.tokens)) throw new Error('invalid cache');
    return value.tokens;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error('Cannot read JWT cache. Check --token-file (expected a tokens.json file created by this CLI).');
  }
}

export function tokenIsFresh(record, now = Date.now()) {
  if (typeof record.jwtToken !== 'string' || record.jwtToken.split('.').length !== 3) return false;
  const exp = jwtExpirySeconds(record.jwtToken);
  const serverExpiry = Date.parse(record.expireTime);
  const until = Math.min(exp ? exp * 1000 : Infinity, Number.isFinite(serverExpiry) ? serverExpiry : Infinity);
  return Boolean(record.jwtToken) && Number.isFinite(until) && until > now;
}

const tokenKey = (record) => JSON.stringify([record.email.toLowerCase(), record.domain, String(record.siteId)]);

export async function saveToken(path, record) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  // Multiple CLI processes may sign different accounts in concurrently. Serialize the
  // read/merge/rename so one account's token does not overwrite another account's update.
  let locked = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await mkdir(lock, { mode: 0o700 }); locked = true; break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await delay(25);
    }
  }
  if (!locked) throw new Error(`JWT cache is busy. If no other CLI is running, remove ${lock} and retry.`);
  let temporary;
  try {
    const records = await readTokens(path);
    if (records.some((entry) => tokenKey(entry) === tokenKey(record) && entry.savedAt > record.savedAt)) return;
    const tokens = records.filter((entry) => tokenKey(entry) !== tokenKey(record));
    tokens.push(record);
    temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, tokens }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    try { if (temporary) await rm(temporary, { force: true }); }
    finally { await rm(lock, { recursive: true, force: true }); }
  }
}

function selectAccount(state, email, options) {
  let matches = state.accounts.filter((account) => account.email?.toLowerCase() === email.toLowerCase());
  if (options.domain) {
    const exact = matches.filter((account) => normalizeDomain(account.domain) === normalizeDomain(options.domain));
    matches = exact.length ? exact : matches.filter((account) => !account.domain);
  }
  if (options.siteId) {
    const exact = matches.filter((account) => String(account.siteId) === options.siteId);
    matches = exact.length ? exact : matches.filter((account) => !account.siteId);
  }
  if (!matches.length) throw new Error(`No saved account matches ${email} and the selected domain/site.`);
  let domain = options.domain;
  const sites = () => new Set(matches.map((account) => account.siteId ? String(account.siteId) : null));
  const domains = new Set(matches.map((account) => normalizeDomain(account.domain)));
  if (sites().size > 1 && domains.size > 1 && !domain) {
    domain = defaultDomain();
    const exact = matches.filter((account) => normalizeDomain(account.domain) === domain);
    matches = exact.length ? exact : matches.filter((account) => !account.domain);
    if (!matches.length) throw new Error(`No saved account matches ${email} on ${domain}. Pass --domain to select another dashboard.`);
  }
  if (sites().size > 1) {
    const scopes = matches.map((a) => `${a.domain || 'unscoped'} / site ${a.siteId || 'unknown'}`).join(', ');
    throw new Error(`Multiple accounts match ${email}: ${scopes}. Select one with --domain and --siteId.`);
  }
  matches.sort((a, b) => (b.lastUsedAt || b.createdAt || 0) - (a.lastUsedAt || a.createdAt || 0));
  return { account: matches[0], domain };
}

async function resolveLoginSite(state, account, domain, siteId) {
  const cached = state.routes[domain]?.[account.email.trim().toLowerCase()];
  const known = account.siteId ? { siteId: account.siteId, portalUrl: account.portalUrl || dashboardOriginFor(domain) } : cached;
  if (known && (!siteId || String(known.siteId) === siteId)) {
    const site = normalizeSite(known);
    if (site && new URL(site.portalUrl).host.toLowerCase() === domain) return site;
  }
  const route = routeOriginFor(domain);
  if (!route) throw new Error(`Cannot resolve a Comm100 route for ${domain}.`);
  const answer = await getByEmail(route, account.email, state.settings.partnerId);
  const sites = (answer.sites || []).filter((site) => {
    try { return new URL(site.portalUrl).host.toLowerCase() === domain && (!siteId || String(site.siteId) === siteId); }
    catch { return false; }
  });
  if (sites.length !== 1) throw new Error(sites.length
    ? `This account owns multiple sites on ${domain}. Select one with --siteId.`
    : `Could not resolve an owned site on ${domain} for ${account.email}.`);
  return normalizeSite(sites[0]);
}

export async function login(state, email, options) {
  const selected = selectAccount(state, email, options);
  const account = selected.account;
  const domain = normalizeDomain(account.domain || selected.domain);
  if (!domain) throw new Error('This account has no dashboard recorded. Specify --domain.');
  const siteId = options.siteId || (account.siteId ? String(account.siteId) : null);
  const tokenFile = options['token-file'] || defaultTokenFile();
  const records = await readTokens(tokenFile);
  const cached = records.filter((entry) => entry.email?.toLowerCase() === account.email.toLowerCase() &&
    entry.domain === domain && (!siteId || String(entry.siteId) === siteId) &&
    (!entry.accountId || entry.accountId === account.id))
    .sort((a, b) => b.savedAt - a.savedAt)[0];
  if (cached && tokenIsFresh(cached)) {
    await chmod(tokenFile, 0o600);
    return cached.jwtToken;
  }
  const password = effectivePassword(account);
  if (!password) throw new Error('This account has no saved password. Sign in through the extension first.');
  const site = await resolveLoginSite(state, account, domain, siteId);
  const response = await jwtLogin(site.portalUrl, { email: account.email, password, siteId: site.siteId });
  if (needsSecondFactor(response) && !response.jwtToken) throw new Error('Two-factor verification is required. Sign in through the browser.');
  if (!response.jwtToken || response.errorCode || (response.httpStatus && response.httpStatus !== 200)) {
    // Do not echo a server body: it can contain sensitive material. Never retry a credential.
    throw new Error(`Sign-in failed${response.errorCode ? ` (code ${response.errorCode})` : ''}. Check the saved credentials in the extension.`);
  }
  const record = { accountId: account.id, email: account.email, domain, siteId: String(site.siteId),
    jwtToken: response.jwtToken, expireTime: response.expireTime || null, savedAt: Date.now() };
  if (!tokenIsFresh(record)) throw new Error('The login service returned an expired token or no usable token expiry.');
  await saveToken(tokenFile, record);
  return response.jwtToken;
}

export async function run(args, { stdout = process.stdout } = {}) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    domain: { type: 'string' }, siteId: { type: 'string' }, db: { type: 'string' },
    profile: { type: 'string' }, 'token-file': { type: 'string' },
    'show-password': { type: 'boolean' }, help: { type: 'boolean', short: 'h' }
  } });
  if (values.help || !positionals.length) { stdout.write(help); return; }
  const [command, email] = positionals;
  if (!['list', 'login'].includes(command) || positionals.length !== (command === 'list' ? 1 : 2)) {
    throw new Error('Use "list" or "login <email>". See --help.');
  }
  if (values['show-password'] && command !== 'list') throw new Error('--show-password is only supported by list.');
  for (const [name, value] of Object.entries(values)) if (typeof value === 'string' && !value.trim()) throw new Error(`--${name} requires a non-empty value.`);
  const state = await readChromeState(await findDatabase(values));
  if (command === 'list') {
    // One order for every account list: the popup's Accounts section sorts the same way.
    const rows = [...new Set(filterAccounts(state.accounts, { domain: values.domain, siteId: values.siteId })
      .filter((account) => account.email)
      .sort(compareAccountOrder)
      .map((account) => {
        const password = values['show-password'] ? `${String(effectivePassword(account) || '-').padEnd(20)} ` : '';
        return `${String(account.siteId || '-').padEnd(12)} ${account.email.padEnd(30)} ${password}${account.domain || '-'}`;
      }))];
    if (rows.length) stdout.write(rows.join('\n') + '\n');
  } else {
    stdout.write(await login(state, email, values) + '\n');
  }
}
