import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { encodeMessage, messageReader, socketPath } from '../src/cli/bridge.mjs';
import { installBridge } from '../src/cli/setup.mjs';
import { listTraces } from '../src/cli/traces.mjs';

if (process.platform !== 'win32') { console.log('skip: not Windows'); process.exit(0); }

const directory = await mkdtemp(join(tmpdir(), 'c100-win-launch-'));
const profile = join(directory, 'Default');
const database = join(profile, 'Local Extension Settings', 'a'.repeat(32));
await mkdir(database, { recursive: true });
const configDirectory = join(directory, 'config');
const tracesFile = join(directory, 'traces.sqlite');
process.env.COMM100_TRACES_DB = tracesFile;
const bridgeId = randomUUID();
await installBridge(database, { cliBridgeId: bridgeId }, {
  configDirectory, chromeDirectory: join(directory, 'chrome'), os: 'win32', runCommand: async () => {}
});
const manifest = JSON.parse(await readFile(join(configDirectory, 'com.comm100.accounts.json'), 'utf8'));
console.log('launcher:', manifest.path);
console.log('launcher text:', JSON.stringify(await readFile(manifest.path, 'utf8')));

// Chrome launches the manifest path through COMSPEC /c with pipe stdio.
const child = spawn(process.env.COMSPEC || 'cmd.exe', ['/c', manifest.path], {
  stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, COMM100_TRACES_DB: tracesFile }
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk; });
const frames = [];
child.stdout.on('data', messageReader((message) => frames.push(message), (error) => { stderr += `FRAME ${error.message}\n`; }));

child.stdin.write(encodeMessage({ type: 'ready', bridgeId }));
for (let attempt = 0; attempt < 200 && !frames.some((frame) => frame.type === 'listening'); attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 20));
  if (child.exitCode != null) break;
}
console.log('frames:', JSON.stringify(frames));
console.log('exit:', child.exitCode, 'stderr:', JSON.stringify(stderr));
assert(frames.some((frame) => frame.type === 'listening'), 'host reported listening through the batch launcher');

child.stdin.write(encodeMessage({ type: 'trace', trace: {
  url: 'https://example.test/api/through-bat', method: 'POST', statusCode: 201,
  requestHeaders: [['accept', 'application/json']], requestBody: '{"ok":true}',
  responseHeaders: [['content-type', 'application/json']], responseBody: '{"ok":true}', time: Date.now()
} }));

let rows = [];
for (let attempt = 0; attempt < 250 && !rows.length; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 20));
  rows = await listTraces();
}
console.log('rows:', JSON.stringify(rows));
assert.equal(rows.length, 1, `trace reached the DB through the batch launcher (stderr: ${stderr})`);
assert.equal(rows[0].url, 'https://example.test/api/through-bat');
child.kill();
await rm(directory, { recursive: true, force: true });
console.log('PASS');
