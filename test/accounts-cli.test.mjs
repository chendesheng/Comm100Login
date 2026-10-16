import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { ClassicLevel } from 'classic-level';
import { defaultDomain, findDatabase, login, readChromeState, readTokens, run, saveToken, tokenIsFresh } from '../src/cli/accounts.mjs';
import { normalizeState } from '../src/shared/storage.js';

const execute = promisify(execFile);
const binary = fileURLToPath(new URL('../bin/comm100-accounts.mjs', import.meta.url));
const host = 'livechat6dash.testing.comm100dev.io';
const other = 'livechat3dash.testing.comm100dev.io';
const account = (email, domain = host, siteId = '10001', extra = {}) => ({
  id: `${email}|${domain}|${siteId}`, email, domain, siteId, portalUrl: `https://${domain}`,
  password: 'saved-test-password', lastUsedAt: 1, ...extra
});
const state = (accounts) => normalizeState({ accounts });
const jwt = (exp = Math.floor(Date.now() / 1000) + 3600, serial = 1) =>
  `h.${Buffer.from(JSON.stringify({ exp, serial })).toString('base64url')}.s`;

async function fixture(t, accounts) {
  const directory = await mkdtemp(join(tmpdir(), 'comm100-cli-test-'));
  const location = join(directory, 'database');
  const db = new ClassicLevel(location, { valueEncoding: 'json' });
  await db.put('comm100AutoLogin', { accounts });
  t.after(async () => { await db.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, location, db, tokenFile: join(directory, 'cache/tokens.json') };
}

function capture() {
  let output = '';
  return { stdout: { write: (text) => { output += text; } }, text: () => output };
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

test('login saves a JWT privately and reuses it without another network request', async (t) => {
  const f = await fixture(t, [account('a@example.com')]);
  let calls = 0;
  const token = jwt();
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(url, `https://${host}/api/login/jwtToken/login`);
    assert.deepEqual(JSON.parse(options.body), { email: 'a@example.com', password: 'saved-test-password', siteId: 10001 });
    return Response.json({ errorCode: 0, jwtToken: token });
  });
  const args = ['login', 'a@example.com', '--db', f.location, '--token-file', f.tokenFile];
  const output = capture();
  await run(args, output);
  assert.equal(output.text(), token + '\n');
  assert.equal(calls, 1);
  const again = capture();
  await run(args, again);
  assert.equal(again.text(), token + '\n');
  assert.equal(calls, 1);
  assert.equal((await stat(f.tokenFile)).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.directory, 'cache'))).mode & 0o777, 0o700);
  const saved = await readFile(f.tokenFile, 'utf8');
  assert(!saved.includes('saved-test-password'));
  assert.equal((await readTokens(f.tokenFile)).length, 1);
  assert.deepEqual(await readdir(join(f.directory, 'cache')), ['tokens.json']);
});

test('expired tokens are replaced while other accounts retain their latest JWT', async (t) => {
  const f = await fixture(t, []);
  const a = account('a@example.com');
  const b = account('b@example.com');
  await saveToken(f.tokenFile, { ...a, accountId: a.id, jwtToken: jwt(1), savedAt: 1 });
  await saveToken(f.tokenFile, { ...b, password: undefined, accountId: b.id, jwtToken: jwt(undefined, 2), savedAt: 2 });
  const token = jwt(undefined, 3);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ errorCode: 0, jwtToken: token }); });
  assert.equal(await login(state([a]), a.email, { 'token-file': f.tokenFile }), token);
  const records = await readTokens(f.tokenFile);
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
  assert.equal(await login(state([a]), a.email, { 'token-file': f.tokenFile }), token);
  assert.equal(await login(state([b, c, unknown]), b.email, { siteId: '10003', 'token-file': f.tokenFile }), token);
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
  await login(state([a, b]), a.email, { 'token-file': f.tokenFile });
  assert.equal(urls[0], `https://${host}/api/login/jwtToken/login`);
  await login(state([a, b]), a.email, { domain: other, 'token-file': f.tokenFile });
  assert.equal(urls[1], `https://${other}/api/login/jwtToken/login`);
  await assert.rejects(login(state([b, account(b.email, host, '10004')]), b.email, { 'token-file': f.tokenFile }), /Select one with --domain and --siteId/);
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
  await login(state([a]), a.email, { 'token-file': f.tokenFile });
  assert.equal(calls.length, 2);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ sites: [{ siteId: 72, portalUrl: `https://${other}` }] }));
  await assert.rejects(login(state([a]), a.email, { siteId: '73', 'token-file': f.tokenFile }), /owned site/);
});

test('failed passwords and MFA do not retry or print server responses', async (t) => {
  const f = await fixture(t, [account('a@example.com')]);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ errorCode: 101, errorMessage: 'sensitive body' }); });
  const output = capture();
  await assert.rejects(run(['login', 'a@example.com', '--db', f.location, '--token-file', f.tokenFile], output), /code 101/);
  assert.equal(output.text(), '');
  assert.equal(calls, 1);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ showVerificationCode: true, nextStep: 'needVerificationCode' }));
  await assert.rejects(login(state([account('a@example.com')]), 'a@example.com', { 'token-file': f.tokenFile }), /Two-factor/);
  await assert.rejects(stat(f.tokenFile), { code: 'ENOENT' });
});

test('token freshness respects both JWT expiry and the earlier server expiry', () => {
  assert(tokenIsFresh({ jwtToken: jwt() }));
  assert(!tokenIsFresh({ jwtToken: jwt(1) }));
  assert(!tokenIsFresh({ jwtToken: jwt(), expireTime: '2000-01-01T00:00:00Z' }));
  assert(!tokenIsFresh({ jwtToken: 'opaque' }));
});

test('concurrent cache updates retain every account and replace only its matching token', async (t) => {
  const f = await fixture(t, []);
  const records = Array.from({ length: 6 }, (_, n) => ({ email: `${n}@example.com`, domain: host, siteId: '1', jwtToken: jwt(), savedAt: n }));
  await Promise.all(records.map((record) => saveToken(f.tokenFile, record)));
  assert.equal((await readTokens(f.tokenFile)).length, records.length);
  const latest = jwt(undefined, 9);
  await saveToken(f.tokenFile, { ...records[0], savedAt: 10, jwtToken: latest });
  await saveToken(f.tokenFile, records[0]); // A slower writer must not replace a newer result.
  assert.equal((await readTokens(f.tokenFile)).length, records.length);
  assert.equal((await readTokens(f.tokenFile)).find((entry) => entry.email === records[0].email).jwtToken, latest);
});

test('executable emits account rows and reports usage errors on stderr', async (t) => {
  const f = await fixture(t, [account('a@example.com')]);
  const result = await execute(process.execPath, [binary, 'list', '--db', f.location, `--domain=${host}`]);
  assert.equal(result.stdout, `10001        a@example.com                  ${host}\n`);
  assert.equal(result.stderr, '');
  await assert.rejects(execute(process.execPath, [binary, 'login']), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /comm100-accounts:/);
    return true;
  });
  const before = createHash('sha256').update(JSON.stringify(await f.db.get('comm100AutoLogin'))).digest('hex');
  await execute(process.execPath, [binary, 'list', '--db', f.location]);
  const after = createHash('sha256').update(JSON.stringify(await f.db.get('comm100AutoLogin'))).digest('hex');
  assert.equal(before, after);
});
