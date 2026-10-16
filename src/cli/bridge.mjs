import { createConnection } from 'node:net';
import { endianness, homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

export const NATIVE_HOST = 'com.comm100.accounts';
export const MAX_MESSAGE = 1024 * 1024;
const littleEndian = endianness() === 'LE';

export function encodeMessage(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > MAX_MESSAGE) throw new Error('CLI bridge message exceeds 1 MiB.');
  const header = Buffer.alloc(4);
  if (littleEndian) header.writeUInt32LE(body.length); else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

export function messageReader(onMessage, onError) {
  let buffer = Buffer.alloc(0);
  let failed = false;
  return (chunk) => {
    if (failed) return;
    try {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = littleEndian ? buffer.readUInt32LE() : buffer.readUInt32BE();
        if (!size || size > MAX_MESSAGE) throw new Error('Invalid CLI bridge message size.');
        if (buffer.length < size + 4) break;
        const value = JSON.parse(buffer.subarray(4, size + 4).toString('utf8'));
        buffer = buffer.subarray(size + 4);
        onMessage(value);
      }
    } catch (error) { failed = true; onError(error); }
  };
}

export function socketDirectory() {
  if (platform() === 'win32') throw new Error('The native CLI bridge currently supports macOS and Linux.');
  return `/tmp/comm100-accounts-${process.getuid()}`;
}

export function socketPath(bridgeId) {
  if (!/^[a-f0-9-]{36}$/i.test(bridgeId || '')) throw new Error('Reload the updated extension, then run comm100-accounts setup.');
  return join(socketDirectory(), `${bridgeId}.sock`);
}

export function chromeDataDirectory() {
  if (platform() === 'darwin') return join(homedir(), 'Library/Application Support/Google/Chrome');
  if (platform() === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData/Local'), 'Google/Chrome/User Data');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'google-chrome');
}

export const bridgeConfigDirectory = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'comm100-accounts');
export const bridgeConfigFile = () => join(bridgeConfigDirectory(), 'bridge.json');

export async function readBridgeConfig(filename = bridgeConfigFile()) {
  try {
    const config = JSON.parse(await readFile(filename, 'utf8'));
    if (!Array.isArray(config.connections)) throw new Error('Invalid bridge configuration.');
    return config;
  } catch (error) {
    if (error.code === 'ENOENT') return { connections: [] };
    throw new Error('Cannot read CLI bridge configuration. Run comm100-accounts setup again.');
  }
}

export function requestSocket(path, request, timeoutMs = 10000) {
  return new Promise((accept, reject) => {
    const socket = createConnection(path);
    let settled = false;
    function finish(error, value) {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else accept(value);
    }
    socket.setTimeout(timeoutMs, () => finish(new Error('CLI bridge request timed out.')));
    socket.on('error', (error) => finish(error));
    socket.on('close', () => finish(new Error('CLI bridge disconnected before replying.')));
    socket.on('connect', () => {
      try { socket.write(encodeMessage({ request })); } catch (error) { finish(error); }
    });
    socket.on('data', messageReader((response) => {
      if (response?.ok) finish(null, response.result);
      else finish(new Error(response?.error || 'CLI bridge request failed.'));
    }, (error) => finish(error)));
  });
}

export async function requestBridge(options, request) {
  const config = await readBridgeConfig();
  const profilePath = resolve(chromeDataDirectory(), options.profile || 'Default');
  const connection = config.connections.find((entry) => options.db
    ? entry.database === resolve(options.db) : entry.profilePath === profilePath);
  if (!connection) throw new Error('CLI bridge is not configured for this Chrome profile. Run comm100-accounts setup, then reload the extension.');
  try { return await requestSocket(socketPath(connection.bridgeId), request); }
  catch (error) {
    if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) {
      throw new Error('CLI bridge is unavailable. Open Chrome and reload the Comm100 Auto Login extension after running comm100-accounts setup.');
    }
    throw error;
  }
}
