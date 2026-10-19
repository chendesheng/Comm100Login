import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { ClassicLevel } from 'classic-level';
import { defaultDomain, findDatabase, login as cliLogin, readChromeState, resolveFrom, run, tokenIsFresh } from '../src/cli/accounts.mjs';
import * as storage from '../src/shared/storage.js';
import { normalizeState } from '../src/shared/storage.js';
import { handleCliRequest } from '../src/background/cli-bridge.js';
import { extensionPath } from '../src/cli/extension-path.mjs';
import { openTraceWriter } from '../src/cli/traces.mjs';

const execute = promisify(execFile);
let currentStore;
const request = (_options, message) => handleCliRequest(message);
const login = (snapshot, email, options) => {
  currentStore.value = normalizeState({ ...snapshot, tokens: currentStore.value.tokens });
  return cliLogin(currentStore.value, email, options, request);
};
const seedToken = (record) => {
  const tokens = currentStore.value.tokens.filter((entry) => entry.email !== record.email || entry.domain !== record.domain || entry.siteId !== record.siteId);
  currentStore.value.tokens = [...tokens, record];
};
const binary = fileURLToPath(new URL('../bin/comm100-accounts.mjs', import.meta.url));
const host = 'livechat6dash.testing.comm100dev.io';
const other = 'livechat3dash.testing.comm100dev.io';
const account = (email, domain = host, siteId = '10001', extra = {}) => ({
  id: `${email}|${domain}|${siteId}`, email, domain, siteId, portalUrl: `https://${domain}`,
  password: 'saved-test-password', lastUsedAt: 1, ...extra
});
const state = (accounts) => normalizeState({ accounts });
const jwt = (exp = Math.floor(Date.now() / 1000) + 3600, serial = 1, extra = {}) =>
  `h.${Buffer.from(JSON.stringify({ exp, serial, ...extra })).toString('base64url')}.s`;

async function fixture(t, accounts) {
  const previousChrome = globalThis.chrome;
  currentStore = { value: normalizeState({ accounts }) };
  const browserStore = currentStore;
  globalThis.chrome = { storage: { local: {
    get: async (key) => ({ [key]: structuredClone(browserStore.value) }),
    set: async (value) => { browserStore.value = structuredClone(value.comm100AutoLogin); }
  } } };
  t.after(() => { globalThis.chrome = previousChrome; });
  const directory = await mkdtemp(join(tmpdir(), 'comm100-cli-test-'));
  const location = join(directory, 'database');
  const db = new ClassicLevel(location, { valueEncoding: 'json' });
  await db.put('comm100AutoLogin', { accounts });
  t.after(async () => { await db.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, location, db };
}

function capture() {
  let output = '';
  return { stdout: { write: (text) => { output += text; } }, request, text: () => output };
}

function namespace(t, value) {
  const previous = process.env.NAMESPACE;
  if (value === undefined) delete process.env.NAMESPACE;
  else process.env.NAMESPACE = value;
  t.after(() => {
    if (previous === undefined) delete process.env.NAMESPACE;
    else process.env.NAMESPACE = previous;
  });
}

test('list aligns site/email/domain rows while the source LevelDB remains locked', async (t) => {
  const accounts = [account('b@example.com'), account('a@example.com'), account('a@example.com'), account('a@example.com', host, '10002'), account('c@example.com', other, '10003')];
  const f = await fixture(t, accounts);
  const original = await f.db.get('comm100AutoLogin');
  let output = capture();
  await run(['list', '--db', f.location, `--domain=${host}`, '--siteId=10001'], output);
  assert.equal(output.text(), `10001        a@example.com                  ${host}\n10001        b@example.com                  ${host}\n`);
  output = capture();
  await run(['list', '--db', f.location, '--siteId=10003'], output);
  assert.equal(output.text(), `10003        c@example.com                  ${other}\n`);
  output = capture();
  await run(['list', '--db', f.location], output);
  // Dashboards order first, so livechat3 (site 10003) precedes every livechat6 row.
  assert.equal(output.text(), `10003        c@example.com                  ${other}\n10001        a@example.com                  ${host}\n10001        b@example.com                  ${host}\n10002        a@example.com                  ${host}\n`);
  assert.deepEqual(await f.db.get('comm100AutoLogin'), original);
});

test('list orders rows by dashboard, then site id, then email', async (t) => {
  const alpha = 'alphadash.testing.comm100dev.io';
  const beta = 'betadash.testing.comm100dev.io';
  // The same rendering the CLI uses, so a padding change cannot silently move a column.
  const row = (siteId, email, domain) => `${siteId.padEnd(12)} ${email.padEnd(30)} ${domain}`;
  const f = await fixture(t, [
    account('zeta@example.com', beta, '10002'),
    account('Beta@example.com', alpha, '10002'),
    account('alpha@example.com', alpha, '10002'),
    account('a@example.com', alpha, '9999'),
    account('unscoped@example.com', null, null)
  ]);
  const output = capture();
  await run(['list', '--db', f.location], output);
  assert.equal(
    output.text(),
    [
      row('9999', 'a@example.com', alpha), // Site ids are numbers: 9999 before 10002.
      row('10002', 'alpha@example.com', alpha), // Email is the last key, so a capital B waits its turn.
      row('10002', 'Beta@example.com', alpha),
      row('10002', 'zeta@example.com', beta),
      row('-', 'unscoped@example.com', '-') // Nothing recorded is the fallback: last, not first.
    ].join('\n') + '\n'
  );
});

test('passwords appear only with --show-password, in a 20-character third column', async (t) => {
  const f = await fixture(t, [
    account('a@example.com', host, '10001', { password: 'Verified1', pendingPassword: 'Rejected1' }),
    account('b@example.com', host, '10001', { password: null, pendingPassword: 'Pending1' }),
    account('c@example.com', host, '10001', { password: null, pendingPassword: null })
  ]);
  const hidden = capture();
  await run(['list', '--db', f.location], hidden);
  assert(!/Verified1|Rejected1|Pending1/.test(hidden.text()));
  const shown = capture();
  await run(['list', '--db', f.location, '--siteId=10001', '--show-password'], shown);
  const rows = shown.text().trimEnd().split('\n');
  assert.equal(rows[0].slice(44, 64), 'Verified1           ');
  assert.equal(rows[1].slice(44, 64), 'Pending1            ');
  assert.equal(rows[2].slice(44, 64), '-                   ');
  assert(rows.every((row) => row.slice(65) === host));
  assert(!shown.text().includes('Rejected1'));
});

test('CLI discovers extension storage from a Chrome profile and honors --db', async (t) => {
  const f = await fixture(t, [account('a@example.com')]);
  const profile = join(f.directory, 'Default');
  const id = 'a'.repeat(32);
  const extensionDB = join(profile, 'Local Extension Settings', id);
  await mkdir(extensionDB, { recursive: true });
  const preferences = { extensions: { settings: { [id]: { manifest: { name: 'Comm100 Auto Login' } } } } };
  await writeFile(join(profile, 'Preferences'), JSON.stringify(preferences));
  await writeFile(join(profile, 'Secure Preferences'), JSON.stringify(preferences));
  assert.equal(await findDatabase({ profile }), extensionDB);
  assert.equal(await findDatabase({ profile: '/missing', db: f.location }), f.location);
  await assert.rejects(findDatabase({ profile: join(f.directory, 'Missing') }), /storage not found/);
});

test('legacy account scope and site are normalized identically to the extension', async (t) => {
  const f = await fixture(t, []);
  await f.db.put('comm100AutoLogin', { accounts: [{ email: 'legacy@example.com', hosts: [host], password: 'test' }],
    routes: { [host]: { 'legacy@example.com': { siteId: '123', portalUrl: `https://${host}` } } } });
  const read = await readChromeState(f.location);
  assert.equal(read.accounts[0].domain, host);
  assert.equal(read.accounts[0].siteId, '123');
});

test('setup snapshot ignores the source LOCK entry and leaves it untouched', async (t) => {
  const f = await fixture(t, [account('snapshot@example.com')]);
  await f.db.close();
  const lock = join(f.location, 'LOCK');
  await rm(lock, { force: true });
  // A directory in place of LOCK makes the copied database unusable unless omitted.
  await mkdir(lock);
  await writeFile(join(lock, 'untouched'), 'source lock');
  const snapshot = await readChromeState(f.location);
  assert.equal(snapshot.accounts[0].email, 'snapshot@example.com');
  assert.equal(await readFile(join(lock, 'untouched'), 'utf8'), 'source lock');
});

test('login saves a JWT through the worker and reuses it without another network request', async (t) => {
  const f = await fixture(t, [account('a@example.com')]);
  let calls = 0;
  const token = jwt();
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(url, `https://${host}/api/login/jwtToken/login`);
    assert.deepEqual(JSON.parse(options.body), { email: 'a@example.com', password: 'saved-test-password', siteId: 10001 });
    return Response.json({ errorCode: 0, jwtToken: token });
  });
  const args = ['login', 'a@example.com', '--db', f.location];
  const output = capture();
  await run(args, output);
  assert.equal(output.text(), token + '\n');
  assert.equal(calls, 1);
  const again = capture();
  await run(args, again);
  assert.equal(again.text(), token + '\n');
  assert.equal(calls, 1);
  const saved = (await storage.getState()).tokens;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].jwtToken, token);
  assert(!JSON.stringify(saved).includes('saved-test-password'));
  assert.deepEqual(await readdir(f.directory), ['database']);

});

test('login accepts the agent id from a token and stores it next to the email', async (t) => {
  const agentId = '08edd2e8-350a-43a8-a531-b2252044cbe0';
  const f = await fixture(t, [account('id@example.com')]);
  const token = jwt(undefined, 1, { agentId });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ errorCode: 0, jwtToken: token }));

  const first = capture();
  await run(['login', 'id@example.com', '--db', f.location], first);
  assert.equal(first.text(), token + '\n');
  const saved = await storage.getState();
  assert.equal(saved.accounts[0].agentId, agentId);
  assert.equal(saved.tokens[0].agentId, agentId);

  // The same account, named by its id: the cache answers and no second sign-in is attempted.
  const calls = globalThis.fetch.mock.callCount();
  const byId = capture();
  await run(['login', agentId, '--db', f.location], byId);
  assert.equal(byId.text(), token + '\n');
  assert.equal(globalThis.fetch.mock.callCount(), calls);

  const listed = capture();
  await run(['tokens', '--db', f.location], listed);
  assert.equal(JSON.parse(listed.text())[0].agentId, agentId);
});

test('an agent id in the token cache selects its account before a login has saved the id', async (t) => {
  const agentId = '08edd2e8-350a-43a8-a531-b2252044cbe0';
  const accounts = [account('cache@example.com')];
  const f = await fixture(t, accounts);
  // A cache written by an older version: the token names the agent, the account record does not.
  currentStore.value = normalizeState({
    accounts,
    tokens: [{ accountId: accounts[0].id, email: accounts[0].email, domain: host, siteId: '10001',
      jwtToken: jwt(undefined, 1, { agentId }), savedAt: Date.now() }]
  });
  const output = capture();
  await run(['login', agentId, '--db', f.location], output);
  assert.equal(output.text(), jwt(undefined, 1, { agentId }) + '\n');
});

test('login --cookie prints curl -b cookies with the server expiry, including from cache', async (t) => {
  const f = await fixture(t, [account('a@example.com')]);
  const token = jwt();
  const expireTime = new Date(Date.now() + 1800000).toISOString();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ errorCode: 0, jwtToken: token, expireTime });
  });
  const args = ['login', 'a@example.com', '--db', f.location];
  const expected = `token_10001=${token};tokenExpire_10001=${encodeURIComponent(expireTime)};siteList=10001\n`;
  const fresh = capture();
  await run([...args, '--cookie'], fresh);
  assert.equal(fresh.text(), expected);
  const cached = capture();
  await run([...args, '--cookie'], cached);
  assert.equal(cached.text(), expected);
  const plain = capture();
  await run(args, plain);
  assert.equal(plain.text(), token + '\n');
  assert.equal(calls, 1);
});

test('cookie output uses the resolved site and JWT expiry when server expiry is absent', async (t) => {
  const f = await fixture(t, [account('a@example.com', host, null)]);
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = jwt(exp);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls++;
    if (url.includes('/getByEmail?')) return Response.json({ sites: [{ siteId: 72, portalUrl: `https://${host}` }] });
    return Response.json({ errorCode: 0, jwtToken: token });
  });
  const args = ['login', 'a@example.com', '--db', f.location, '--cookie'];
  const fresh = capture();
  await run(args, fresh);
  assert.equal(fresh.text(), `token_72=${token};tokenExpire_72=${encodeURIComponent(new Date(exp * 1000).toISOString())};siteList=72\n`);
  const cached = capture();
  await run(args, cached);
  assert.equal(cached.text(), fresh.text());
  assert.equal(calls, 2);
});

test('list rejects --cookie before reading accounts', async () => {
  const output = capture();
  await assert.rejects(run(['list', '--cookie', '--db', '/missing'], output), /--cookie is only supported by login/);
  assert.equal(output.text(), '');
});

test('expired tokens are replaced while other accounts retain their latest JWT', async (t) => {
  const f = await fixture(t, []);
  const a = account('a@example.com');
  const b = account('b@example.com');
  seedToken({ ...a, accountId: a.id, jwtToken: jwt(1), savedAt: 1 });
  seedToken({ ...b, password: undefined, accountId: b.id, jwtToken: jwt(undefined, 2), savedAt: 2 });
  const token = jwt(undefined, 3);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ errorCode: 0, jwtToken: token }); });
  assert.equal(await login(state([a]), a.email, {}), token);
  const records = (await storage.getState()).tokens;
  assert.equal(calls, 1);
  assert.equal(records.length, 2);
  assert.equal(records.find((r) => r.email === a.email).jwtToken, token);
  assert.equal(records.find((r) => r.email === b.email).savedAt, 2);
});

test('unique email or explicit site ID does not require a namespace or domain', async (t) => {
  const f = await fixture(t, []);
  namespace(t, undefined);
  const a = account('unique@example.com', other, '10002');
  const b = account('shared@example.com', other, '10003');
  const c = account('shared@example.com', host, '10004');
  const unknown = account('shared@example.com', host, null, { lastUsedAt: 999 });
  const token = jwt();
  const destinations = [];
  t.mock.method(globalThis, 'fetch', async (url) => { destinations.push(url); return Response.json({ errorCode: 0, jwtToken: token }); });
  assert.equal(await login(state([a]), a.email, {}), token);
  assert.equal(await login(state([b, c, unknown]), b.email, { siteId: '10003' }), token);
  assert(destinations.every((url) => url.startsWith(`https://${other}/`)));
});

test('namespace default disambiguates an email across different sites and dashboards', async (t) => {
  const f = await fixture(t, []);
  namespace(t, 'livechat6');
  assert.equal(defaultDomain(), host);
  const a = account('same@example.com', other, '10002');
  const b = account('same@example.com', host, '10003');
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => { urls.push(url); return Response.json({ errorCode: 0, jwtToken: jwt() }); });
  await login(state([a, b]), a.email, {});
  assert.equal(urls[0], `https://${host}/api/login/jwtToken/login`);
  await login(state([a, b]), a.email, { domain: other });
  assert.equal(urls[1], `https://${other}/api/login/jwtToken/login`);
  await assert.rejects(login(state([b, account(b.email, host, '10004')]), b.email, {}), /Select one with --domain and --siteId/);
});

test('unknown sites are resolved from an owned route before sending a password', async (t) => {
  const f = await fixture(t, []);
  const a = account('new@example.com', host, null);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(url);
    if (url.includes('/getByEmail?')) return Response.json({ sites: [{ siteId: 72, portalUrl: `https://${host}` }] });
    assert.equal(JSON.parse(options.body).siteId, 72);
    return Response.json({ errorCode: 0, jwtToken: jwt() });
  });
  await login(state([a]), a.email, {});
  assert.equal(calls.length, 2);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ sites: [{ siteId: 72, portalUrl: `https://${other}` }] }));
  await assert.rejects(login(state([a]), a.email, { siteId: '73' }), /owned site/);
});

test('failed passwords and MFA do not retry or print server responses', async (t) => {
  const f = await fixture(t, [account('a@example.com')]);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ errorCode: 101, errorMessage: 'sensitive body' }); });
  const output = capture();
  await assert.rejects(run(['login', 'a@example.com', '--db', f.location], output), /code 101/);
  assert.equal(output.text(), '');
  assert.equal(calls, 1);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ showVerificationCode: true, nextStep: 'needVerificationCode' }));
  await assert.rejects(login(state([account('a@example.com')]), 'a@example.com', {}), /Two-factor/);
  assert.deepEqual((await storage.getState()).tokens, []);
});

test('token freshness respects both JWT expiry and the earlier server expiry', () => {
  assert(tokenIsFresh({ jwtToken: jwt() }));
  assert(!tokenIsFresh({ jwtToken: jwt(1) }));
  assert(!tokenIsFresh({ jwtToken: jwt(), expireTime: '2000-01-01T00:00:00Z' }));
  assert(!tokenIsFresh({ jwtToken: 'opaque' }));
});

test('tokens prints full JWTs, decoded nested claims and UTC dates, including expired entries', async (t) => {
  await fixture(t, [account('a@example.com')]);
  const header = { alg: 'HS256', typ: 'JWT', kid: 'test-key' };
  const payload = { sub: 'agent-123', email: 'a@example.com', iat: 1700000000, nbf: 1700000001,
    exp: 4102444800, data: { name: '测试 Agent', roles: ['admin', 'agent'] } };
  const token = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
  const record = { ...account('a@example.com'), accountId: account('a@example.com').id,
    jwtToken: token, savedAt: 1700000000000 };
  seedToken(record);
  seedToken({ ...record, email: 'expired@example.com', domain: other, jwtToken: jwt(1) });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () => { calls++; throw new Error('tokens must not use the network'); });
  const output = capture();
  await run(['tokens', '--db=/missing'], output);
  const results = JSON.parse(output.text());
  assert.equal(results.length, 2);
  assert.equal(results[0].domain, other);
  assert.equal(results[0].fresh, false);
  assert.equal(results[1].jwtToken, token);
  assert.equal(results[1].fresh, true);
  assert.deepEqual(results[1].header, header);
  assert.deepEqual(results[1].payload, payload);
  assert.deepEqual(results[1].claimTimes, { iat: '2023-11-14T22:13:20.000Z', nbf: '2023-11-14T22:13:21.000Z', exp: '2100-01-01T00:00:00.000Z' });
  assert.equal(results[1].savedAt, '2023-11-14T22:13:20.000Z');
  assert.equal(calls, 0);
  assert(!output.text().includes('saved-test-password'));
});

test('tokens handles empty state, filters and malformed JWTs without changing shared storage', async (t) => {
  await fixture(t, []);
  const empty = capture();
  await run(['tokens'], empty);
  assert.equal(empty.text(), '[]\n');
  seedToken({ email: 'bad@example.com', domain: host, siteId: '1', jwtToken: 'broken', savedAt: 1 });
  seedToken({ email: 'bad-payload@example.com', domain: host, siteId: '2', jwtToken: 'e30.bm90LWpzb24.s', savedAt: 1 });
  seedToken({ email: 'good@example.com', domain: other, siteId: '1', jwtToken: jwt(), savedAt: 1 });
  const before = await storage.getState();
  const output = capture();
  await run(['tokens', `--domain=${host}`], output);
  const records = JSON.parse(output.text());
  assert.equal(records.length, 2);
  assert.match(records[0].decodeError, /three dot-separated parts/);
  assert.match(records[1].decodeError, /payload/);
  assert.deepEqual(records[1].header, {});
  const filtered = capture();
  await run(['tokens', `--domain=${host}`, '--siteId=2'], filtered);
  assert.equal(JSON.parse(filtered.text())[0].siteId, '2');
  assert.deepEqual(await storage.getState(), before);
});

test('tokens rejects login/list-only flags and extra arguments before contacting the worker', async () => {
  for (const args of [['tokens', '--cookie'], ['tokens', '--show-password'], ['tokens', 'extra']]) {
    let calls = 0;
    await assert.rejects(run(args, { request: async () => { calls++; }, stdout: capture().stdout }));
    assert.equal(calls, 0);
  }
});

test('concurrent worker cache writes retain every account and preserve account updates', async (t) => {
  const accounts = Array.from({ length: 6 }, (_, n) => account(`${n}@example.com`));
  await fixture(t, accounts);
  await Promise.all(accounts.flatMap((a) => [
    storage.saveToken({ ...a, accountId: a.id, jwtToken: jwt() }),
    storage.setSettings({ cooldownMs: 12345 })
  ]));
  assert.equal((await storage.getState()).tokens.length, accounts.length);
  assert.equal((await storage.getState()).settings.cooldownMs, 12345);
  const latest = jwt(undefined, 9);
  await storage.saveToken({ ...accounts[0], accountId: accounts[0].id, jwtToken: latest });
  assert.equal((await storage.getState()).tokens.length, accounts.length);
  assert.equal((await storage.getState()).tokens.find((entry) => entry.email === accounts[0].email).jwtToken, latest);
  await assert.rejects(handleCliRequest({ type: 'saveToken', token: { ...accounts[0], accountId: accounts[0].id,
    domain: other, jwtToken: jwt() } }), /does not match/);
  await assert.rejects(handleCliRequest({ type: 'saveToken', token: { ...accounts[0], accountId: accounts[0].id,
    jwtToken: jwt(1) } }), /expired or invalid/);
});

test('executable reports usage and bridge setup errors without exposing account data', async () => {
  await assert.rejects(execute(process.execPath, [binary, 'login']), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /comm100-accounts:/);
    return true;
  });
  await assert.rejects(execute(process.execPath, [binary, 'tokens', '--profile=/nonexistent-profile']), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /setup/);
    return true;
  });
});

test('traces reports an unconfigured bridge and stays silent once configured', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'comm100-traces-config-'));
  const previous = {
    xdg: process.env.XDG_CONFIG_HOME,
    localAppData: process.env.LOCALAPPDATA,
    tracesDb: process.env.COMM100_TRACES_DB
  };
  if (process.platform === 'win32') process.env.LOCALAPPDATA = directory;
  else process.env.XDG_CONFIG_HOME = directory;
  delete process.env.COMM100_TRACES_DB;
  t.after(async () => {
    if (previous.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous.xdg;
    if (previous.localAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous.localAppData;
    if (previous.tracesDb === undefined) delete process.env.COMM100_TRACES_DB;
    else process.env.COMM100_TRACES_DB = previous.tracesDb;
    await rm(directory, { recursive: true, force: true });
  });

  const unconfigured = capture();
  await assert.rejects(run(['traces'], unconfigured), /Run comm100-accounts setup/);
  assert.equal(unconfigured.text(), '');

  const configDirectory = join(directory, 'comm100-accounts');
  await mkdir(configDirectory, { recursive: true });
  await writeFile(join(configDirectory, 'bridge.json'), JSON.stringify({ connections: [{
    profilePath: '/profile',
    database: join(directory, 'Local Extension Settings', 'a'.repeat(32)),
    extensionId: 'a'.repeat(32),
    bridgeId: '00000000-0000-4000-8000-000000000000'
  }] }));
  const configured = capture();
  await run(['traces'], configured);
  assert.equal(configured.text(), '');
});

test('traces prints the capture time first and dates unknown rows with a dash', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'comm100-traces-time-'));
  const previous = process.env.COMM100_TRACES_DB;
  process.env.COMM100_TRACES_DB = join(directory, 'traces.sqlite');
  t.after(async () => {
    if (previous === undefined) delete process.env.COMM100_TRACES_DB;
    else process.env.COMM100_TRACES_DB = previous;
    await rm(directory, { recursive: true, force: true });
  });

  const writer = await openTraceWriter();
  writer.insert({ url: 'https://example.test/api/old', method: 'GET', statusCode: 200, time: 0,
    requestHeaders: [], requestBody: '', responseHeaders: [], responseBody: '' });
  writer.insert({ url: 'https://example.test/api/new', method: 'POST', statusCode: 201,
    time: Date.parse('2026-10-19T20:15:12.481Z'),
    requestHeaders: [], requestBody: '', responseHeaders: [], responseBody: '' });
  writer.close();

  const output = capture();
  await run(['traces'], output);
  // Times sort newest first, and a row stored before the column existed keeps a dash.
  assert.equal(output.text(), [
    `${'ID'.padEnd(4)} ${'TIME'.padEnd(24)} ${'METHOD'.padEnd(7)} ${'STATUS'.padEnd(7)} URL`,
    `${'2'.padEnd(4)} 2026-10-19T20:15:12.481Z ${'POST'.padEnd(7)} ${'201'.padEnd(7)} https://example.test/api/new`,
    `${'1'.padEnd(4)} ${'-'.padEnd(24)} ${'GET'.padEnd(7)} ${'200'.padEnd(7)} https://example.test/api/old`
  ].join('\n') + '\n');
});

test('traces filters rows by --domain, --siteId and --from', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'comm100-traces-filter-'));
  const previous = process.env.COMM100_TRACES_DB;
  process.env.COMM100_TRACES_DB = join(directory, 'traces.sqlite');
  t.after(async () => {
    if (previous === undefined) delete process.env.COMM100_TRACES_DB;
    else process.env.COMM100_TRACES_DB = previous;
    await rm(directory, { recursive: true, force: true });
  });

  const writer = await openTraceWriter();
  const insert = (url, time) => writer.insert({ url, time, method: 'GET', statusCode: 200,
    requestHeaders: [], requestBody: '', responseHeaders: [], responseBody: '' });
  insert('https://a.test/api/x?siteId=10001', Date.parse('2026-10-19T12:00:00Z'));
  insert('https://a.test/api/y?siteId=10002', Date.parse('2026-10-19T13:00:00Z'));
  insert('https://b.test/api/z?siteId=10001', Date.parse('2026-10-19T14:00:00Z'));
  writer.close();

  const header = `${'ID'.padEnd(4)} ${'TIME'.padEnd(24)} ${'METHOD'.padEnd(7)} ${'STATUS'.padEnd(7)} URL`;
  const row = (id, time, url) => `${String(id).padEnd(4)} ${time.padEnd(24)} ${'GET'.padEnd(7)} ${'200'.padEnd(7)} ${url}`;
  const output = capture();
  await run(['traces', '--domain=a.test', '--siteId=10001', '--from=2026-10-19T11:00:00Z'], output);
  assert.equal(output.text(), [header, row(1, '2026-10-19T12:00:00.000Z', 'https://a.test/api/x?siteId=10001')].join('\n') + '\n');

  // A filter that matches nothing stays silent: the bridge is configured, so there is nothing to report.
  const empty = capture();
  await run(['traces', '--from=2027-01-01T00:00:00Z'], empty);
  assert.equal(empty.text(), '');

  for (const args of [['list', '--from=2026-10-19T12:00:00Z'], ['tokens', '--from=2026-10-19T12:00:00Z'],
    ['login', 'a@example.com', '--from=2026-10-19T12:00:00Z']]) {
    await assert.rejects(run(args, capture()), /--from is only supported by traces/);
  }
  await assert.rejects(run(['traces', '--from=yesterday'], capture()), /ISO-8601/);
  await assert.rejects(run(['traces', '--from='], capture()), /--from requires a non-empty value/);

  // Durations count back from now; everything else goes through Date.parse unchanged.
  const now = Date.parse('2026-10-19T12:00:00Z');
  assert.equal(resolveFrom('30m', now), now - 30 * 60_000);
  assert.equal(resolveFrom('24h', now), now - 24 * 3_600_000);
  assert.equal(resolveFrom('1h30m10s', now), now - (3_600 + 1_800 + 10) * 1_000);
  assert.equal(resolveFrom('30m1h', now), now - (1_800 + 3_600) * 1_000);
  assert.equal(resolveFrom('2026-10-19T11:00:00Z', now), Date.parse('2026-10-19T11:00:00Z'));
  for (const value of ['30', 'h', '24x', '1h 30m']) {
    assert.throws(() => resolveFrom(value, now), /ISO-8601 timestamp or a duration/);
  }
});

test('traces --from accepts durations counted back from now', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'comm100-traces-since-'));
  const previous = process.env.COMM100_TRACES_DB;
  process.env.COMM100_TRACES_DB = join(directory, 'traces.sqlite');
  t.after(async () => {
    if (previous === undefined) delete process.env.COMM100_TRACES_DB;
    else process.env.COMM100_TRACES_DB = previous;
    await rm(directory, { recursive: true, force: true });
  });

  const recent = Date.now() - 30 * 60_000;
  const stale = Date.now() - 3 * 3_600_000;
  const writer = await openTraceWriter();
  for (const [url, time] of [['https://a.test/api/recent', recent], ['https://a.test/api/stale', stale]]) {
    writer.insert({ url, time, method: 'GET', statusCode: 200,
      requestHeaders: [], requestBody: '', responseHeaders: [], responseBody: '' });
  }
  writer.close();

  const urls = async (from) => {
    const output = capture();
    await run(['traces', `--from=${from}`], output);
    return output.text().split('\n').slice(1).filter(Boolean).map((line) => line.split(/\s+/).at(-1));
  };
  assert.deepEqual(await urls('1h'), ['https://a.test/api/recent']);
  assert.deepEqual(await urls('1h30m'), ['https://a.test/api/recent']);
  assert.deepEqual(await urls('24h'), ['https://a.test/api/recent', 'https://a.test/api/stale']);
  assert.deepEqual(await urls('0m'), []);
  await assert.rejects(urls('30'), /ISO-8601 timestamp or a duration/);
});

test('traces <id> prints one exchange as raw HTTP and rejects filters', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'comm100-traces-raw-'));
  const previous = process.env.COMM100_TRACES_DB;
  process.env.COMM100_TRACES_DB = join(directory, 'traces.sqlite');
  t.after(async () => {
    if (previous === undefined) delete process.env.COMM100_TRACES_DB;
    else process.env.COMM100_TRACES_DB = previous;
    await rm(directory, { recursive: true, force: true });
  });

  const writer = await openTraceWriter();
  writer.insert({
    url: 'https://a.test/api/thing?siteId=10010',
    time: Date.parse('2026-10-19T12:00:00Z'),
    method: 'POST',
    statusCode: 201,
    requestHeaders: [['content-type', 'application/json']],
    requestBody: '{"a":1}',
    responseHeaders: [['content-type', 'application/json']],
    responseBody: '{"ok":true}'
  });
  writer.insert({
    url: 'https://a.test/api/none?siteId=10010',
    time: Date.parse('2026-10-19T12:00:01Z'),
    method: 'GET',
    statusCode: 204,
    requestHeaders: [],
    requestBody: '',
    responseHeaders: [],
    responseBody: ''
  });
  writer.close();

  const output = capture();
  await run(['traces', '1'], output);
  assert.equal(output.text(), [
    'POST /api/thing?siteId=10010 HTTP/1.1',
    'Host: a.test',
    'content-type: application/json',
    '',
    '{"a":1}',
    '',
    'HTTP/1.1 201 Created',
    'content-type: application/json',
    '',
    '{"ok":true}',
    ''
  ].join('\n'));

  await assert.rejects(run(['traces', '9'], capture()), /No trace with id 9/);

  // The same view is colored on a terminal and plain when piped or told not to. This machine's
  // shell exports NO_COLOR and TERM=dumb, so the deciding environment is set here, not inherited.
  const savedEnv = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR, TERM: process.env.TERM };
  delete process.env.NO_COLOR;
  delete process.env.FORCE_COLOR;
  process.env.TERM = 'xterm-256color';
  t.after(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const terminal = (store) => ({ isTTY: true, write: (text) => { store.text += text; } });
  const tinted = { text: '' };
  await run(['traces', '1'], { stdout: terminal(tinted) });
  assert(tinted.text.includes('\x1b[1;34mPOST\x1b[0m'));
  assert(tinted.text.includes('\n\n{"a":1}\n\n'));
  process.env.NO_COLOR = '1';
  const plainTerminal = { text: '' };
  await run(['traces', '1'], { stdout: terminal(plainTerminal) });
  assert(!plainTerminal.text.includes('\x1b['));

  const replay = capture();
  await run(['traces', '1', '--curl'], replay);
  assert.equal(replay.text(), [
    'curl -sS -X POST \\',
    "  'https://a.test/api/thing?siteId=10010' \\",
    "  -H 'content-type: application/json' \\",
    '  -b "$(comm100-accounts login <email> --siteId=10010 --cookie)" \\',
    '  --data-raw "$(comm100-accounts traces 1 --req-body)"',
    ''
  ].join('\n'));

  const body = capture();
  await run(['traces', '1', '--req-body'], body);
  assert.equal(body.text(), '{"a":1}\n');
  // A bodyless exchange prints nothing at all, so the substitution stays empty.
  const noBody = capture();
  await run(['traces', '2', '--req-body'], noBody);
  assert.equal(noBody.text(), '');
  await assert.rejects(run(['traces', '--req-body'], capture()), /--req-body needs a trace id/);
  await assert.rejects(run(['traces', '1', '--req-body', '--curl'], capture()), /choose one/);
  await assert.rejects(run(['list', '--req-body'], capture()), /--req-body is only supported by traces/);

  await assert.rejects(run(['traces', '--curl'], capture()), /--curl needs a trace id/);
  await assert.rejects(run(['list', '--curl'], capture()), /--curl is only supported by traces/);

  // An id selects exactly one row, so filters and extra arguments are refused rather than ignored.
  for (const args of [['traces', '0'], ['traces', 'abc'], ['traces', '1', '2'],
    ['traces', '1', '--siteId=10010'], ['traces', '1', '--from=1h']]) {
    await assert.rejects(run(args, capture()), /positive integer|does not accept|Use "list"/);
  }
});

test('extension-path works without a browser bridge and rejects irrelevant options', async () => {
  const { stdout } = await execute(process.execPath, [binary, 'extension-path']);
  assert.equal(stdout.trim(), extensionPath());
  const forbiddenRequest = () => { throw new Error('This command must not contact Chrome'); };
  for (const option of ['--domain=example.com', '--profile=/missing', '--cookie']) {
    await assert.rejects(run(['extension-path', option], { request: forbiddenRequest }), /only supported|does not accept/);
  }
});
