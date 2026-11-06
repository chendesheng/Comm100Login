import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPartnerHost } from '../src/shared/platforms.js';
import { routeOriginFor } from '../src/shared/api.js';
import * as store from '../src/shared/storage.js';
import { login, run } from '../src/cli/accounts.mjs';
import { handleCliRequest } from '../src/background/cli-bridge.js';
import { capturePartnerLogin, ensurePartnerAuth, partnerSession, logoutPartner } from '../src/background/partner-session.js';
import { formatCurlTrace } from '../src/cli/trace-format.mjs';

const email = 'partner@example.com';
const token = (partnerId = 10000, exp = Math.floor(Date.now() / 1000) + 3600) =>
  `h.${Buffer.from(JSON.stringify({ partnerId, exp, userId: 'partner-user' })).toString('base64url')}.s`;

function fixture(t, host) {
  const oldChrome = globalThis.chrome, oldFetch = globalThis.fetch;
  let state = store.normalizeState({});
  const cookies = new Map();
  const calls = [];
  globalThis.chrome = {
    storage: { local: {
      get: async (key) => ({ [key]: structuredClone(state) }),
      set: async (value) => { state = structuredClone(value.comm100AutoLogin); }
    } },
    cookies: {
      get: async ({ url, name }) => cookies.get(`${new URL(url).host}|${name}`) || null,
      set: async (cookie) => {
        const value = { ...cookie, domain: cookie.domain || new URL(cookie.url).host };
        cookies.set(`${new URL(cookie.url).host}|${cookie.name}`, value); return value;
      },
      remove: async ({ url, name }) => cookies.delete(`${new URL(url).host}|${name}`)
    }
  };
  const response = { code: 0, partnerId: 10000, jwtToken: token(), expireTime: new Date(Date.now() + 3600000).toISOString() };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    assert.equal(url, `https://${host}/partnerloginapi/Login`);
    return Response.json(response);
  };
  t.after(() => { globalThis.chrome = oldChrome; globalThis.fetch = oldFetch; });
  return { state: () => state, calls, response, cookies };
}

for (const host of ['new-branchpartner.testing.comm100dev.io', 'new-branchpartner.comm100dev.io', 'partner.comm100staging.com']) {
  test(`${host}: captured credentials list, login via partner API, and reuse host-scoped token`, async (t) => {
    const f = fixture(t, host);
    assert(isPartnerHost(host));
    assert.equal(routeOriginFor(host), `https://${host}`);
    const id = await store.captureCredentials({ email, password: 'fixture-password', domain: host, host });
    let output = '';
    const request = (_options, message) => handleCliRequest(message);
    await run(['list'], { stdout: { write: (value) => { output += value; } }, request });
    assert(output.includes(email) && output.includes(host));
    assert.equal(await login(f.state(), email, {}, request), f.response.jwtToken);
    assert.deepEqual(f.calls, [{ url: `https://${host}/partnerloginapi/Login`, body: { email, password: 'fixture-password' } }]);
    assert.equal(f.state().accounts[0].partnerId, '10000');
    assert.equal(f.state().accounts[0].siteId, null);
    assert.equal(f.state().tokens[0].accountId, id);
    assert.equal(await login(f.state(), email, { cookie: true }, request), `partnerToken=${f.response.jwtToken}`);
    assert.equal(f.calls.length, 1);
    await assert.rejects(login(f.state(), email, { siteId: '10000' }, request), /does not accept --siteId/);
    await assert.rejects(login(f.state(), email, { domain: 'otherpartner.comm100dev.io' }, request), /No saved account/);
  });
}

test('partner detection rejects dashboard hosts and lookalikes', () => {
  for (const host of ['partner.comm100dev.io', 'livechat6dash.testing.comm100dev.io',
    'partner.comm100staging.com.evil.example', 'xpartner.comm100staging.com', 'partner11.comm100staging.com',
    'xpartner.comm100dev.io.evil.example', 'x.partner.comm100dev.io', 'xpartner.comm100.io']) assert(!isPartnerHost(host));
});

test('matching email on dashboard and partner requires an explicit domain', async (t) => {
  const host = 'livechat6partner.testing.comm100dev.io';
  const f = fixture(t, host);
  await store.captureCredentials({ email, password: 'partner-secret', domain: host, host });
  await store.captureCredentials({ email, password: 'dashboard-secret', domain: 'livechat6dash.testing.comm100dev.io' });
  await assert.rejects(login(f.state(), email, {}), /Select one with --domain/);
  assert.equal(f.calls.length, 0);
});

test('manual partner login stores verified credentials and JWT without another login', async (t) => {
  const host = 'livechat6partner.testing.comm100dev.io', origin = `https://${host}`;
  const f = fixture(t, host);
  await chrome.cookies.set({ url: origin, name: 'partnerToken', value: f.response.jwtToken, domain: `.${host}` });
  const message = { url: `${origin}/partnerloginapi/Login`, email, password: 'manual-password', response: f.response };
  assert.deepEqual(await capturePartnerLogin(message, { url: `${origin}/login`, tab: { id: 1 }, frameId: 0 }), { ok: true });
  assert.equal(f.state().accounts[0].password, 'manual-password');
  assert.equal(f.state().accounts[0].pendingPassword, null);
  assert.equal(f.state().accounts[0].partnerId, '10000');
  assert.equal(f.calls.length, 0);
  assert.equal((await capturePartnerLogin({ ...message, response: { ...f.response, jwtToken: token(10001) } },
    { url: `${origin}/login`, tab: { id: 1 } })).ok, false);
  assert.equal((await capturePartnerLogin(message, { url: 'https://otherpartner.comm100dev.io/login', tab: { id: 1 } })).ok, false);
});

test('partner session restoration, mismatched IDs, logout, and failure cooldown', async (t) => {
  const host = 'livechat6partner.comm100dev.io';
  const f = fixture(t, host);
  await store.captureCredentials({ email, password: 'fixture-password', domain: host, host });
  const result = await ensurePartnerAuth({ targetHost: host, urlSiteId: '10000' });
  assert(result.ok);
  assert.equal(result.entryUrl, `https://${host}/ui/10000/partner/dashboard/`);
  assert.equal((await partnerSession(`https://${host}`, '10000')).ok, true);
  assert.equal((await partnerSession(`https://${host}`, '10001')).ok, false);
  assert.equal(f.cookies.size, 1);
  assert.equal((await ensurePartnerAuth({ targetHost: host, urlSiteId: '10001', userInitiated: true })).ok, false);
  assert.equal(f.calls.length, 1, 'a known different partner never spends a password attempt');
  await logoutPartner(`https://${host}`);
  assert.equal((await ensurePartnerAuth({ targetHost: host, urlSiteId: '10000' })).reason, 'logged-out');
  await store.clearFailures(host);
  await store.invalidateToken(f.response.jwtToken);
  f.response.code = 101;
  assert.equal((await ensurePartnerAuth({ targetHost: host })).reason, 'api-error');
  assert.equal((await ensurePartnerAuth({ targetHost: host })).reason, 'cooldown');
  assert.equal(f.calls.length, 2);
});

test('partner failure and invalid identity never cache a token; expired tokens renew', async (t) => {
  const host = 'livechat6partner.testing.comm100dev.io';
  const f = fixture(t, host);
  await store.captureCredentials({ email, password: 'fixture-password', domain: host, host });
  const request = (_options, message) => handleCliRequest(message);
  f.response.code = 101;
  await assert.rejects(login(f.state(), email, {}, request), /Sign-in failed/);
  f.response.code = 0; f.response.partnerId = 99999;
  await assert.rejects(login(f.state(), email, {}, request), /invalid partner identity/);
  assert.equal(f.state().tokens.length, 0);
  f.response.partnerId = 10000;
  await login(f.state(), email, {}, request);
  f.state().tokens[0].jwtToken = token(10000, 1);
  await login(f.state(), email, {}, request);
  assert.equal(f.calls.length, 4);
  assert.equal(f.state().tokens.length, 1);
});

test('partner trace curl replay keeps partner domain and omits dashboard site selector', () => {
  const output = formatCurlTrace({ id: 1, method: 'GET', url: 'https://livechat6partner.comm100dev.io/api/sites?siteId=123',
    requestHeaders: [], requestBody: '' });
  assert(output.includes('comm100-accounts login <email> --domain=livechat6partner.comm100dev.io --cookie'));
  assert(!output.includes('--siteId='));
});

test('partner request traces are listed and read through comm100-accounts traces', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { openTraceWriter } = await import('../src/cli/traces.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'comm100-partner-traces-'));
  const previous = process.env.COMM100_TRACES_DB;
  process.env.COMM100_TRACES_DB = join(directory, 'traces.sqlite');
  t.after(async () => {
    if (previous === undefined) delete process.env.COMM100_TRACES_DB;
    else process.env.COMM100_TRACES_DB = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const host = 'livechat6partner.testing.comm100dev.io';
  const writer = await openTraceWriter();
  try {
    writer.insert({ url: `https://${host}/api/entity/configs`, method: 'POST', statusCode: 200,
      requestHeaders: [['content-type', 'application/json']], requestBody: '{"name":"partner"}',
      responseHeaders: [['content-type', 'application/json']], responseBody: '{"enabled":true}', time: Date.now() });
  } finally { writer.close(); }
  const read = async (args) => {
    let output = '';
    await run(args, { stdout: { write: (value) => { output += value; } } });
    return output;
  };
  assert((await read(['traces'])).includes(`${host}/api/entity/configs`));
  assert((await read(['traces', `--domain=${host}`])).includes(`${host}/api/entity/configs`));
  assert.equal(await read(['traces', '1', '--req-body']), '{"name":"partner"}\n');
  assert.equal(await read(['traces', '1', '--resp-body']), '{"enabled":true}\n');
  assert((await read(['traces', '1', '--curl'])).includes(`--domain=${host} --cookie`));
});
