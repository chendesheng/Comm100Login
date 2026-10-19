import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { test } from 'node:test';
import { startCliBridge } from '../src/background/cli-bridge.js';
import { encodeMessage, MAX_MESSAGE, messageReader, NATIVE_HOST, requestSocket, socketPath } from '../src/cli/bridge.mjs';
import { installBridge, windowsLauncher } from '../src/cli/setup.mjs';
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
  const options = { configDirectory: join(directory, 'config'), chromeDirectory: join(directory, 'chrome'), runCommand: async () => {} };
  const profile = join(directory, 'Default');
  const database = join(profile, 'Local Extension Settings', 'a'.repeat(32));
  const bridgeId = randomUUID();
  await installBridge(database, { cliBridgeId: bridgeId, accounts: [{ password: 'never-write-this' }] }, options);
  const config = await readFile(join(options.configDirectory, 'bridge.json'), 'utf8');
  assert.deepEqual(JSON.parse(config), { connections: [{ profilePath: profile, database, extensionId: 'a'.repeat(32), bridgeId }] });
  assert(!config.includes('never-write-this'));
  const manifestDirectory = platform() === 'win32' ? options.configDirectory : join(options.chromeDirectory, 'NativeMessagingHosts');
  const manifest = JSON.parse(await readFile(join(manifestDirectory, `${NATIVE_HOST}.json`), 'utf8'));
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${'a'.repeat(32)}/`]);
  assert.equal(manifest.type, 'stdio');
  const launcher = await readFile(manifest.path, 'utf8');
  assert(launcher.includes(process.execPath));
  if (platform() !== 'win32') {
    assert.equal((await stat(manifest.path)).mode & 0o777, 0o700);
    assert.equal((await stat(join(options.configDirectory, 'bridge.json'))).mode & 0o777, 0o600);
  }
});

test('Windows uses a profile-specific named pipe and quotes batch launcher paths', () => {
  const id = randomUUID();
  assert.equal(socketPath(id, 'win32'), `\\\\.\\pipe\\comm100-accounts-${id}`);
  assert.notEqual(socketPath(id, 'win32'), socketPath(randomUUID(), 'win32'));
  assert.throws(() => socketPath('../bad', 'win32'), /Reload/);
  const launcher = windowsLauncher('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\张三 & 100%!\\host.mjs');
  assert(launcher.startsWith('@echo off\r\nsetlocal DisableDelayedExpansion\r\nchcp 65001 >nul\r\n'));
  assert(launcher.includes('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\张三 & 100%%!\\host.mjs"'));
  assert.throws(() => windowsLauncher('bad"path', 'host.mjs'), /Invalid/);
  assert.throws(() => windowsLauncher('node.exe', 'bad\npath'), /Invalid/);
});

test('Windows setup registers the manifest in HKCU and preserves multiple profile origins', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'comm100-win-setup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const options = { os: 'win32', configDirectory: join(directory, 'config space & percent%'),
    runCommand: async (...args) => { calls.push(args); } };
  const firstId = 'a'.repeat(32), secondId = 'b'.repeat(32);
  const db = (profile, id) => join(directory, profile, 'Local Extension Settings', id);
  await installBridge(db('Default', firstId), { cliBridgeId: randomUUID() }, options);
  await installBridge(db('Profile 1', secondId), { cliBridgeId: randomUUID() }, options);
  // Re-running setup replaces the selected profile without duplicating it.
  await installBridge(db('Default', firstId), { cliBridgeId: randomUUID() }, options);
  const manifestPath = join(options.configDirectory, `${NATIVE_HOST}.json`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.path, join(options.configDirectory, 'native-host.bat'));
  assert.deepEqual(new Set(manifest.allowed_origins), new Set([firstId, secondId].map((id) => `chrome-extension://${id}/`)));
  assert((await readFile(manifest.path, 'utf8')).startsWith('@echo off\r\n'));
  assert.equal(calls.length, 3);
  for (const [command, args, settings] of calls) {
    assert.equal(command, join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'));
    assert.deepEqual(args, ['ADD', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST}`,
      '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f', '/reg:32']);
    assert.deepEqual(settings, { windowsHide: true });
  }
  const config = JSON.parse(await readFile(join(options.configDirectory, 'bridge.json'), 'utf8'));
  assert.equal(config.connections.length, 2);
});

test('Windows setup reports registry failure and does not save a successful connection', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'comm100-win-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(installBridge(join(directory, 'Local Extension Settings', 'a'.repeat(32)),
    { cliBridgeId: randomUUID() }, { os: 'win32', configDirectory: directory,
      runCommand: async () => { throw new Error('access denied'); } }), /Cannot register/);
  await assert.rejects(readFile(join(directory, 'bridge.json')), { code: 'ENOENT' });
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
  if (platform() !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
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
  assert((await invoke(['login', account.email, '--cookie'])).startsWith(`token_10001=${token};tokenExpire_10001=`));
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
