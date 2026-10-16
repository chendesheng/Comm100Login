import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { test } from 'node:test';
import { startCliBridge } from '../src/background/cli-bridge.js';
import { encodeMessage, MAX_MESSAGE, messageReader, NATIVE_HOST, requestSocket, socketPath } from '../src/cli/bridge.mjs';
import { installBridge } from '../src/cli/setup.mjs';
import { run } from '../src/cli/accounts.mjs';
import { cachedToken } from '../src/shared/tokens.js';
import * as storage from '../src/shared/storage.js';

test('native framing handles fragmented/coalesced UTF-8 messages and rejects oversized frames', () => {
  const messages = [];
  const errors = [];
  const read = messageReader((value) => messages.push(value), (error) => errors.push(error));
  const first = encodeMessage({ text: '测试' });
  const second = encodeMessage({ number: 2 });
  read(first.subarray(0, 2));
  read(first.subarray(2, 7));
  read(Buffer.concat([first.subarray(7), second]));
  assert.deepEqual(messages, [{ text: '测试' }, { number: 2 }]);
  assert.equal(errors.length, 0);
  assert.throws(() => encodeMessage({ text: 'x'.repeat(MAX_MESSAGE) }), /exceeds/);
  const oversized = encodeMessage({});
  // 0x7fffffff exceeds the limit in either native byte order.
  oversized.fill(0x7f, 0, 4);
  read(oversized);
  assert.match(errors[0].message, /message size/);
});

test('setup registers only selected extension IDs and stores connection metadata without credentials', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'comm100-setup-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { configDirectory: join(directory, 'config'), chromeDirectory: join(directory, 'chrome') };
  const profile = join(directory, 'Default');
  const database = join(profile, 'Local Extension Settings', 'a'.repeat(32));
  const bridgeId = randomUUID();
  await installBridge(database, { cliBridgeId: bridgeId, accounts: [{ password: 'never-write-this' }] }, options);
  const config = await readFile(join(options.configDirectory, 'bridge.json'), 'utf8');
  assert.deepEqual(JSON.parse(config), { connections: [{ profilePath: profile, database, extensionId: 'a'.repeat(32), bridgeId }] });
  assert(!config.includes('never-write-this'));
  const manifest = JSON.parse(await readFile(join(options.chromeDirectory, 'NativeMessagingHosts', `${NATIVE_HOST}.json`), 'utf8'));
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${'a'.repeat(32)}/`]);
  assert.equal(manifest.type, 'stdio');
  const launcher = await readFile(manifest.path, 'utf8');
  assert(launcher.includes(process.execPath));
  assert.equal((await stat(manifest.path)).mode & 0o777, 0o700);
  assert.equal((await stat(join(options.configDirectory, 'bridge.json'))).mode & 0o777, 0o600);
});

test('CLI reads/writes through a real native host process and the service worker shares the JWT', { timeout: 15000 }, async (t) => {
  const host = 'livechat6dash.testing.comm100dev.io';
  const account = { id: 'test-account', email: 'bridge@example.com', domain: host, siteId: '10001', password: 'saved-test-password' };
  let state = storage.normalizeState({ accounts: [account], cliBridgeId: randomUUID() });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/comm100-accounts-host.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
  const childClosed = once(child, 'close');
  const errors = [];
  child.stderr.on('data', (chunk) => errors.push(chunk.toString()));
  const portListeners = [], disconnectListeners = [];
  const port = {
    onMessage: { addListener: (listener) => portListeners.push(listener) },
    onDisconnect: { addListener: (listener) => disconnectListeners.push(listener) },
    postMessage: (message) => child.stdin.write(encodeMessage(message))
  };
  let ready;
  const listening = new Promise((accept, reject) => {
    ready = accept;
    child.on('error', reject);
    child.on('exit', () => reject(new Error(`Native host exited: ${errors.join('')}`)));
  });
  child.stdout.on('data', messageReader((message) => {
    if (message.type === 'listening') ready();
    for (const listener of portListeners) listener(message);
  }, (error) => { throw error; }));
  child.on('close', () => { for (const listener of disconnectListeners) listener(); });
  const previous = globalThis.chrome;
  globalThis.chrome = {
    runtime: { connectNative: (name) => { assert.equal(name, NATIVE_HOST); return port; }, lastError: null },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    storage: { local: {
      get: async (key) => ({ [key]: structuredClone(state) }),
      set: async (values) => { state = structuredClone(values.comm100AutoLogin); },
      remove: async () => { state = storage.normalizeState({}); }
    } }
  };
  t.after(async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 1000);
    try { await childClosed; }
    finally { clearTimeout(timer); globalThis.chrome = previous; }
  });
  startCliBridge();
  await listening;
  const path = socketPath(state.cliBridgeId);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const request = (_options, message) => requestSocket(path, message);
  const invoke = async (args) => {
    let output = '';
    await run(args, { request, stdout: { write: (text) => { output += text; } } });
    return output;
  };
  assert.equal(await invoke(['list', '--db=/does-not-exist']), `10001        bridge@example.com             ${host}\n`);
  const token = `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.s`;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ jwtToken: token, errorCode: 0 }); });
  assert.equal(await invoke(['login', account.email]), token + '\n');
  assert.equal(cachedToken(state, account, host, account.siteId).jwtToken, token);
  assert.equal((await request({}, { type: 'getState' })).state.tokens[0].jwtToken, token);
  assert((await invoke(['login', account.email, '--cookie'])).startsWith(`token_10001=${token}; tokenExpire_10001=`));
  assert.equal(calls, 1);
  const decoded = JSON.parse(await invoke(['tokens']));
  assert.equal(decoded[0].jwtToken, token);
  assert.equal(decoded[0].fresh, true);
  assert.equal(typeof decoded[0].payload.exp, 'number');
  await assert.rejects(request({}, { type: 'unknown' }), /Unknown CLI bridge request/);
  // Clearing account data must not break the profile's stable bridge configuration.
  const bridgeId = state.cliBridgeId;
  await storage.clearAll();
  assert.equal(state.cliBridgeId, bridgeId);
  assert.equal(await invoke(['tokens']), '[]\n');
  assert.equal(errors.join(''), '');
});
