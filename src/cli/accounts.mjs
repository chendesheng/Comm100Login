import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ClassicLevel } from 'classic-level';
import { dashboardOriginFor, getByEmail, jwtLogin, needsSecondFactor, normalizeSite, routeOriginFor } from '../shared/api.js';
import { agentIdFromToken, expirySecondsFor, tokenCookieName, tokenExpireCookieName } from '../shared/cookies.js';
import { compareAccountOrder, effectivePassword, filterAccounts, normalizeDomain, normalizeState } from '../shared/storage.js';

import { cachedToken, tokenIsFresh } from '../shared/tokens.js';
import { chromeDataDirectory, readBridgeConfig, requestBridge } from './bridge.mjs';
import { installBridge } from './setup.mjs';
import { extensionPath } from './extension-path.mjs';
import { listTraces, readTrace } from './traces.mjs';
import { formatCurlTrace, formatHttpTrace, wantsColor } from './trace-format.mjs';
export { tokenIsFresh } from '../shared/tokens.js';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const help = `Usage:
  comm100-accounts list [--domain=HOST] [--siteId=ID] [--show-password]
  comm100-accounts login <email_or_agent_id> [--domain=HOST] [--siteId=ID] [--cookie]
  comm100-accounts tokens [--domain=HOST] [--siteId=ID]
  comm100-accounts traces [--domain=HOST] [--siteId=ID] [--method=METHOD[,METHOD]] [--from=TIMESTAMP_OR_DURATION]
  comm100-accounts traces <id> [--curl | --req-body]
  comm100-accounts setup [--profile=PATH_OR_NAME]
  comm100-accounts extension-path

list   Print siteId (12 columns), email (30 columns), and domain, ordered by domain, site id,
       then email, with optional filters.
login  Print a valid cached JWT, or sign in once and save the new JWT. The account is selected by
       email or by the agent id its dashboard tokens carry.
tokens Print shared JWTs and decoded headers/payloads as formatted JSON, including expired tokens.
traces Print captured API traces as ID, TIME, METHOD, STATUS, URL, newest first; --domain, --siteId,
       --method (one or more, comma separated) and --from (ISO-8601, or a duration back from now such
       as 30m or 24h) narrow the rows.
       "traces <id>" prints that exchange's request and response as raw HTTP; --req-body prints only
       the request body, and --curl prints a curl command that replays it with fresh credentials
       from comm100-accounts login and the body from --req-body.
setup  Register the native messaging bridge for the selected Chrome profile (one-time snapshot).
extension-path Print the installed Chrome extension folder for "Load unpacked".

Options:
  --domain=HOST          Filter by dashboard; login defaults to $NAMESPACE + dash.testing.comm100dev.io
                        only when multiple site IDs match
  --siteId=ID            Restrict to a site
  --cookie              Print session cookies for curl -b instead of the JWT (login only)
  --show-password       Include a 20-character password column after email (list only)
  --profile=PATH_OR_NAME  Chrome profile directory (default: Chrome's Default profile)
  --db=PATH              Extension LevelDB directory; overrides profile discovery
  --help                 Show this help

Normal commands read/write through the extension service worker; Chrome must be running.
Only setup reads a temporary database snapshot. JWTs are stored with accounts in Chrome storage.
Only command results go to stdout. Errors go to stderr. No browser cookies are changed.
`;

export function defaultDomain(namespace = process.env.NAMESPACE) {
  if (!namespace) throw new Error('Set NAMESPACE or pass --domain.');
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(namespace) || namespace.length > 59) {
    throw new Error('NAMESPACE must be a valid dashboard name prefix.');
  }
  return `${namespace.toLowerCase()}dash.testing.comm100dev.io`;
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
          (!settings.path || (resolve(settings.path) !== resolve(projectRoot) &&
            resolve(settings.path) !== resolve(extensionPath()) && basename(settings.path) !== 'Comm100Login'))) continue;
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
      // Chrome holds LOCK exclusively on Windows. The snapshot creates its own lock.
      await cp(source, snapshot, { recursive: true, filter: (path) => basename(path) !== 'LOCK' });
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

function isoTime(milliseconds) {
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function tokenDetails(record, now) {
  const details = {
    email: record.email, domain: record.domain, siteId: record.siteId,
    jwtToken: record.jwtToken, fresh: tokenIsFresh(record, now),
    expireTime: record.expireTime || null, savedAt: isoTime(record.savedAt),
    header: null, payload: null
  };
  const parts = typeof record.jwtToken === 'string' ? record.jwtToken.split('.') : [];
  if (parts.length !== 3) {
    return { ...details, decodeError: 'Expected a JWT with three dot-separated parts.' };
  }
  for (const [index, name] of ['header', 'payload'].entries()) {
    try {
      if (!/^[A-Za-z0-9_-]+={0,2}$/.test(parts[index])) throw new Error();
      const value = JSON.parse(Buffer.from(parts[index], 'base64url').toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      details[name] = value;
    } catch {
      details.decodeError = [details.decodeError, `Cannot decode JWT ${name} as a JSON object.`].filter(Boolean).join(' ');
    }
  }
  details.agentId = record.agentId || (typeof details.payload?.agentId === 'string' ? details.payload.agentId : null);
  details.claimTimes = Object.fromEntries(['iat', 'nbf', 'exp']
    .filter((name) => typeof details.payload?.[name] === 'number')
    .map((name) => [name, isoTime(details.payload[name] * 1000)]));
  return details;
}

function selectAccount(state, identifier, options) {
  const wanted = String(identifier || '').trim().toLowerCase();
  let matches = state.accounts.filter((account) => account.email?.toLowerCase() === wanted);
  if (!matches.length) {
    /** Login accepts the agent id a dashboard token carries, not only the address that was typed. */
    matches = state.accounts.filter((account) => account.agentId && String(account.agentId).toLowerCase() === wanted);
    if (!matches.length) {
      // A token names its agent before a login has had the chance to store the id on the account.
      const accountIds = new Set(state.tokens
        .filter((token) => agentIdFromToken(token.jwtToken)?.toLowerCase() === wanted)
        .map((token) => token.accountId));
      matches = state.accounts.filter((account) => accountIds.has(account.id));
    }
  }
  if (!matches.length) throw new Error(`No saved account matches ${identifier} as an email or agent id for the selected domain/site.`);
  if (options.domain) {
    const exact = matches.filter((account) => normalizeDomain(account.domain) === normalizeDomain(options.domain));
    matches = exact.length ? exact : matches.filter((account) => !account.domain);
  }
  if (options.siteId) {
    const exact = matches.filter((account) => String(account.siteId) === options.siteId);
    matches = exact.length ? exact : matches.filter((account) => !account.siteId);
  }
  if (!matches.length) throw new Error(`No saved account matches ${identifier} with the selected domain/site.`);
  let domain = options.domain;
  const sites = () => new Set(matches.map((account) => account.siteId ? String(account.siteId) : null));
  const domains = new Set(matches.map((account) => normalizeDomain(account.domain)));
  if (sites().size > 1 && domains.size > 1 && !domain) {
    domain = defaultDomain();
    const exact = matches.filter((account) => normalizeDomain(account.domain) === domain);
    matches = exact.length ? exact : matches.filter((account) => !account.domain);
    if (!matches.length) throw new Error(`No saved account matches ${identifier} on ${domain}. Pass --domain to select another dashboard.`);
  }
  if (sites().size > 1) {
    const scopes = matches.map((a) => `${a.domain || 'unscoped'} / site ${a.siteId || 'unknown'}`).join(', ');
    throw new Error(`Multiple accounts match ${identifier}: ${scopes}. Select one with --domain and --siteId.`);
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

function loginOutput(record, options) {
  if (!options.cookie) return record.jwtToken;
  const expiresAt = expirySecondsFor(record.jwtToken, record.expireTime);
  const expireTime = record.expireTime || new Date(expiresAt * 1000).toISOString();
  return `${tokenCookieName(record.siteId)}=${record.jwtToken};${tokenExpireCookieName(record.siteId)}=${encodeURIComponent(expireTime)};siteList=${record.siteId}`;
}

export async function login(state, identifier, options, request = requestBridge) {
  const selected = selectAccount(state, identifier, options);
  const account = selected.account;
  const domain = normalizeDomain(account.domain || selected.domain);
  if (!domain) throw new Error('This account has no dashboard recorded. Specify --domain.');
  const siteId = options.siteId || (account.siteId ? String(account.siteId) : null);
  const cached = cachedToken(state, account, domain, siteId);
  if (cached) return loginOutput(cached, options);
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
  await request(options, { type: 'saveToken', token: record });
  return loginOutput(record, options);
}

// UTC ISO-8601 keeps the newest-first trace rows comparable; rows stored before the column show "-".
const traceTime = (time) => (time ? new Date(time).toISOString() : '-');

const DURATION_UNITS = { h: 3_600_000, m: 60_000, s: 1_000 };
const DURATION = /^(?:\d+[hms])+$/i;

/**
 * `--from` is either an absolute ISO-8601 timestamp or a duration counted back from now, so
 * `--from 30m` reads as "the last 30 minutes" and `--from 1h30m` as "the last 90 minutes".
 */
export function resolveFrom(value, now = Date.now()) {
  if (DURATION.test(value)) {
    let elapsed = 0;
    for (const [, amount, unit] of value.matchAll(/(\d+)([hms])/gi)) elapsed += Number(amount) * DURATION_UNITS[unit.toLowerCase()];
    return now - elapsed;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error('--from requires an ISO-8601 timestamp or a duration such as 30m or 24h.');
  return parsed;
}

export async function run(args, { stdout = process.stdout, request = requestBridge } = {}) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    domain: { type: 'string' }, siteId: { type: 'string' }, db: { type: 'string' },
    from: { type: 'string' }, method: { type: 'string' },
    profile: { type: 'string' },
    cookie: { type: 'boolean' }, 'show-password': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    curl: { type: 'boolean' }, 'req-body': { type: 'boolean' }
  } });
  if (values.help || !positionals.length) { stdout.write(help); return; }
  const [command, argument] = positionals;
  const limits = { login: 2, traces: 2 }[command] || 1;
  if (!['list', 'login', 'tokens', 'traces', 'setup', 'extension-path'].includes(command) ||
      positionals.length > limits || positionals.length < (command === 'login' ? 2 : 1)) {
    throw new Error('Use "list", "login <email_or_agent_id>", "tokens", "traces [id]", "setup", or "extension-path". See --help.');
  }
  if (values['show-password'] && command !== 'list') throw new Error('--show-password is only supported by list.');
  if (values.cookie && command !== 'login') throw new Error('--cookie is only supported by login.');
  if (values.from !== undefined && command !== 'traces') throw new Error('--from is only supported by traces.');
  if (values.curl && command !== 'traces') throw new Error('--curl is only supported by traces.');
  if (values['req-body'] && command !== 'traces') throw new Error('--req-body is only supported by traces.');
  for (const [name, value] of Object.entries(values)) if (typeof value === 'string' && !value.trim()) throw new Error(`--${name} requires a non-empty value.`);
  if (values.method !== undefined && command !== 'traces') throw new Error('--method is only supported by traces.');
  if (values.method !== undefined && !/^[A-Za-z]+(?:\s*,\s*[A-Za-z]+)*$/.test(values.method)) {
    throw new Error('--method requires HTTP methods such as GET or POST, separated by commas.');
  }
  if (command === 'extension-path') {
    if (Object.keys(values).length) throw new Error('extension-path does not accept account or profile options.');
    stdout.write(extensionPath() + '\n');
    return;
  }
  if (command === 'setup') {
    const database = await findDatabase(values);
    await installBridge(database, await readChromeState(database));
    stdout.write('CLI bridge installed. Reload the Comm100 Auto Login extension in Chrome, then run list/login/tokens.\n');
    return;
  }
  if (command === 'traces') {
    if (values.curl && argument === undefined) throw new Error('--curl needs a trace id: comm100-accounts traces <id> --curl.');
    if (values['req-body'] && argument === undefined) throw new Error('--req-body needs a trace id: comm100-accounts traces <id> --req-body.');
    if (values.curl && values['req-body']) throw new Error('--curl and --req-body print different things; choose one.');
    if (argument !== undefined) {
      if (!/^[1-9]\d*$/.test(argument)) throw new Error('Trace id must be a positive integer.');
      if (values.domain !== undefined || values.siteId !== undefined || values.from !== undefined ||
          values.method !== undefined) {
        throw new Error('traces <id> prints one exchange and does not accept --domain, --siteId, --method or --from.');
      }
      const trace = await readTrace(Number(argument));
      if (!trace) throw new Error(`No trace with id ${argument}.`);
      if (values['req-body']) {
        // Uncolored and byte-exact: this feeds `$(… --req-body)` in the curl command.
        if (trace.requestBody) stdout.write(trace.requestBody.endsWith('\n') ? trace.requestBody : `${trace.requestBody}\n`);
        return;
      }
      stdout.write(values.curl ? formatCurlTrace(trace) : formatHttpTrace(trace, { color: wantsColor(stdout) }));
      return;
    }
    const from = values.from === undefined ? undefined : resolveFrom(values.from);
    const rows = await listTraces({ domain: values.domain, siteId: values.siteId, method: values.method, from });
    if (rows.length) {
      const header = `${'ID'.padEnd(4)} ${'TIME'.padEnd(24)} ${'METHOD'.padEnd(7)} ${'STATUS'.padEnd(7)} URL`;
      const lines = rows.map((row) =>
        `${String(row.id).padEnd(4)} ${traceTime(row.time).padEnd(24)} ${row.method.padEnd(7)} ${String(row.statusCode).padEnd(7)} ${row.url}`);
      stdout.write([header, ...lines].join('\n') + '\n');
    } else if (!process.env.COMM100_TRACES_DB && (await readBridgeConfig()).connections.length === 0) {
      throw new Error(
        'No traces have been captured because the CLI bridge is not configured. ' +
        'Run comm100-accounts setup, then reload the extension.');
    }
    return;
  }
  const state = normalizeState((await request(values, { type: 'getState' })).state);
  if (command === 'tokens') {
    const now = Date.now();
    const details = filterAccounts(state.tokens, { domain: values.domain, siteId: values.siteId })
      .sort(compareAccountOrder).map((record) => tokenDetails(record, now));
    stdout.write(JSON.stringify(details, null, 2) + '\n');
    return;
  }
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
    stdout.write(await login(state, argument, values, request) + '\n');
  }
}
