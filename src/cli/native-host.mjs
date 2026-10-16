import { createConnection, createServer } from 'node:net';
import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { encodeMessage, messageReader, socketDirectory, socketPath } from './bridge.mjs';

/** Chrome owns stdio; the local socket carries CLI requests to that same native port. */
export async function startNativeHost({ input = process.stdin, output = process.stdout } = {}) {
  const clients = new Set();
  const pending = new Map();
  let server, path, closed = false;
  const send = (value) => output.write(encodeMessage(value));
  async function close() {
    if (closed) return;
    closed = true;
    for (const socket of clients) socket.destroy();
    if (server?.listening) await new Promise((done) => server.close(done));
    if (path) await rm(path, { force: true });
  }
  async function listen(bridgeId) {
    const directory = socketDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const details = await lstat(directory);
    if (!details.isDirectory() || details.uid !== process.getuid()) throw new Error('Invalid CLI bridge socket directory.');
    await chmod(directory, 0o700);
    const target = socketPath(bridgeId);
    // Remove only an abandoned socket. Never displace a live Chrome/profile connection.
    try {
      await new Promise((accept, reject) => {
        const probe = createConnection(target);
        probe.on('connect', () => { probe.destroy(); reject(new Error('CLI bridge is already connected for this profile.')); });
        probe.on('error', (error) => ['ENOENT', 'ECONNREFUSED'].includes(error.code) ? accept() : reject(error));
      });
      await rm(target, { force: true });
    } catch (error) { throw error; }
    if (closed) return;
    server = createServer((socket) => {
      clients.add(socket);
      socket.setTimeout(15000, () => socket.destroy());
      socket.on('error', () => socket.destroy());
      let requestId;
      socket.on('close', () => { clients.delete(socket); if (requestId) pending.delete(requestId); });
      socket.on('data', messageReader((message) => {
        if (requestId) return socket.destroy();
        requestId = randomUUID();
        pending.set(requestId, socket);
        try { send({ id: requestId, request: message.request }); }
        catch { socket.destroy(); }
      }, () => socket.destroy()));
    });
    await new Promise((accept, reject) => {
      server.once('error', reject);
      server.listen(target, accept);
    });
    path = target;
    if (closed) { await rm(path, { force: true }); server.close(); return; }
    await chmod(path, 0o600);
    send({ type: 'listening' });
  }
  let initializing = false;
  input.on('data', messageReader((message) => {
    if (message?.type === 'ready' && !initializing) {
      initializing = true;
      void listen(message.bridgeId).catch((error) => { process.stderr.write(`${error.message}\n`); void close(); input.destroy(); });
    } else if (message?.id && pending.has(message.id)) {
      const socket = pending.get(message.id);
      pending.delete(message.id);
      try { socket.end(encodeMessage(message)); } catch { socket.destroy(); }
    }
  }, () => { void close(); input.destroy(); }));
  input.on('end', () => { void close(); });
  input.on('error', () => { void close(); });
  return { close };
}
