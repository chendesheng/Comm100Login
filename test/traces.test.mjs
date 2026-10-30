import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { TRACE_LIMIT, listTraces, openTraceWriter } from '../src/cli/traces.mjs';

const execute = promisify(execFile);
const binary = fileURLToPath(new URL('../bin/comm100-accounts.mjs', import.meta.url));

async function openDatabase(path) {
  const sqlite = await import('node:sqlite');
  const Database = sqlite.Database || sqlite.DatabaseSync;
  return new Database(path);
}

async function useTraceDatabase(t) {
  const directory = await mkdtemp(join(tmpdir(), 'comm100-traces-test-'));
  const previous = process.env.COMM100_TRACES_DB;
  const path = join(directory, 'traces.sqlite');
  process.env.COMM100_TRACES_DB = path;
  t.after(async () => {
    if (previous === undefined) delete process.env.COMM100_TRACES_DB;
    else process.env.COMM100_TRACES_DB = previous;
    await rm(directory, { recursive: true, force: true });
  });
  return path;
}

test('closing the output pipe early exits cleanly', async (t) => {
  await useTraceDatabase(t);
  const writer = await openTraceWriter();
  for (let index = 0; index < 1000; index++) {
    writer.insert({ url: `https://example.test/api/${index}/${'x'.repeat(200)}`, method: 'GET', statusCode: 200, time: index });
  }
  writer.close();

  const child = spawn(process.execPath, [binary, 'traces'], { env: process.env });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.once('data', () => child.stdout.destroy());
  const [code, signal] = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
  });
  assert.equal(signal, null);
  assert.equal(code, 0, stderr);
  assert.equal(stderr, '');
});

test('SQLite traces retain only the newest exchanges, by time, with exactly eight raw columns', async (t) => {
  const path = await useTraceDatabase(t);
  const writer = await openTraceWriter();
  const extra = 5;
  for (let index = 1; index <= TRACE_LIMIT + extra; index++) {
    writer.insert({
      url: `https://example.test/api/${index}`,
      method: 'GET',
      statusCode: 200,
      requestHeaders: [['X-Index', String(index)]],
      requestBody: `request-${index}`,
      responseHeaders: [['Content-Type', 'application/json']],
      responseBody: `response-${index}`,
      time: 1_700_000_000_000 + index
    });
  }
  const rows = await listTraces();
  assert.equal(rows.length, TRACE_LIMIT);
  assert.equal(rows[0].url, `https://example.test/api/${TRACE_LIMIT + extra}`);
  assert.equal(rows[0].time, 1_700_000_000_000 + TRACE_LIMIT + extra);
  assert.equal(rows[0].id, TRACE_LIMIT + extra);
  assert.equal(rows.at(-1).url, `https://example.test/api/${extra + 1}`);
  assert.equal(rows.at(-1).id, extra + 1);
  assert(rows.every((row, index) => row.url === `https://example.test/api/${TRACE_LIMIT + extra - index}`));

  const db = await openDatabase(path);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    assert.deepEqual(tables, ['traces', 'sqlite_sequence']);
    const columns = db.prepare('PRAGMA table_info(traces)').all().map((row) => row.name);
    assert.deepEqual(columns, [
      'id', 'url', 'method', 'status_code', 'request_headers', 'request_body', 'response_headers',
      'response_body', 'time'
    ]);
  } finally {
    db.close();
  }

  if (platform() !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  writer.close();
});

test('SQLite traces store headers and bodies verbatim without truncation', async (t) => {
  const path = await useTraceDatabase(t);
  const writer = await openTraceWriter();
  const requestHeaders = [['Authorization', 'Bearer raw-token'], ['Content-Type', 'application/json']];
  const responseHeaders = [['Set-Cookie', 'session=raw'], ['Content-Type', 'application/json']];
  const requestBody = JSON.stringify({ password: 'p@ss', nested: { keep: 'exactly' } });
  const responseBody = JSON.stringify({ token: 'secret-token', value: 42 });
  writer.insert({
    url: 'https://example.test/api/raw?x=1',
    method: 'POST',
    statusCode: 201,
    requestHeaders,
    requestBody,
    responseHeaders,
    responseBody,
    time: 1_700_000_000_001
  });
  const largeBody = 'trace-body-'.padEnd(2 * 1024 * 1024 + 17, 'abcdefghij');
  writer.insert({
    url: 'https://example.test/api/large',
    method: 'PUT',
    statusCode: 204,
    requestHeaders: [],
    requestBody: largeBody,
    responseHeaders: [],
    responseBody: '',
    time: 1_700_000_000_002
  });
  writer.close();

  const db = await openDatabase(path);
  try {
    const raw = db.prepare('SELECT * FROM traces ORDER BY rowid ASC LIMIT 1').get();
    assert.equal(raw.url, 'https://example.test/api/raw?x=1');
    assert.equal(raw.method, 'POST');
    assert.equal(raw.status_code, 201);
    assert.equal(raw.request_headers, JSON.stringify(requestHeaders));
    assert.equal(raw.request_body, requestBody);
    assert.equal(raw.response_headers, JSON.stringify(responseHeaders));
    assert.equal(raw.response_body, responseBody);
    assert.equal(raw.time, 1_700_000_000_001);
    const large = db.prepare('SELECT request_body FROM traces ORDER BY rowid DESC LIMIT 1').get();
    assert.equal(large.request_body.length, largeBody.length);
    assert.equal(large.request_body, largeBody);
  } finally {
    db.close();
  }
});

test('trace filters narrow by dashboard, site id and start time', async (t) => {
  await useTraceDatabase(t);
  const writer = await openTraceWriter();
  for (const [url, time] of [
    ['https://a.test/api/x?siteId=10001', 300],
    ['https://a.test/api/y?siteId=10002', 200],
    ['https://b.test/api/z?siteId=10001', 100],
    ['https://a.test/api/plain', 400]
  ]) {
    writer.insert({ url, time, method: 'GET', statusCode: 200,
      requestHeaders: [], requestBody: '', responseHeaders: [], responseBody: '' });
  }
  writer.close();

  // Newest first throughout; a dashboard filter ignores scheme and path, like the account filters.
  assert.deepEqual((await listTraces({ domain: 'a.test' })).map((row) => row.url), [
    'https://a.test/api/plain', 'https://a.test/api/x?siteId=10001', 'https://a.test/api/y?siteId=10002'
  ]);
  assert.deepEqual((await listTraces({ domain: 'https://A.TEST/ui/10001/' })).map((row) => row.time),
    [400, 300, 200]);
  assert.deepEqual((await listTraces({ siteId: '10001' })).map((row) => row.url), [
    'https://a.test/api/x?siteId=10001', 'https://b.test/api/z?siteId=10001'
  ]);
  assert.deepEqual((await listTraces({ siteId: 10002 })).map((row) => row.time), [200]);
  // --from is inclusive, so a row exactly at the bound stays.
  assert.deepEqual((await listTraces({ from: 300 })).map((row) => row.time), [400, 300]);
  assert.deepEqual((await listTraces({ domain: 'a.test', siteId: '10002' })).map((row) => row.time), [200]);
  assert.deepEqual(await listTraces({ domain: 'a.test', siteId: '10002', from: 201 }), []);
});

test('the traces command prints no experimental sqlite warning', async (t) => {
  const path = await useTraceDatabase(t);
  const writer = await openTraceWriter();
  writer.insert({
    url: 'https://example.test/api/quiet',
    method: 'GET',
    statusCode: 200,
    requestHeaders: [],
    requestBody: '',
    responseHeaders: [],
    responseBody: '',
    time: 1_700_000_000_000
  });
  writer.close();

  // A child process so the import happens fresh: the warning is emitted while node:sqlite loads.
  const { stdout, stderr } = await execute(process.execPath, [binary, 'traces'], {
    env: { ...process.env, COMM100_TRACES_DB: path }
  });
  assert.match(stdout, /^ID\s+TIME/);
  assert.equal(stderr, '');
});

test('trace filters narrow by HTTP method', async (t) => {
  await useTraceDatabase(t);
  const writer = await openTraceWriter();
  for (const [method, url, time] of [
    ['GET', 'https://a.test/api/get', 300],
    ['POST', 'https://a.test/api/post', 200],
    ['DELETE', 'https://a.test/api/delete?siteId=10010', 100]
  ]) {
    writer.insert({ method, url, time, statusCode: 200,
      requestHeaders: [], requestBody: '', responseHeaders: [], responseBody: '' });
  }
  writer.close();

  // The method compares case-insensitively against the stored uppercase value.
  assert.deepEqual((await listTraces({ method: 'post' })).map((row) => row.method), ['POST']);
  assert.deepEqual((await listTraces({ method: 'GET' })).map((row) => row.time), [300]);
  assert.deepEqual((await listTraces({ method: 'delete', siteId: 10010 })).map((row) => row.url),
    ['https://a.test/api/delete?siteId=10010']);
  assert.deepEqual(await listTraces({ method: 'PATCH' }), []);
  // A comma-separated list keeps any of the named methods, in the rows' own newest-first order.
  assert.deepEqual((await listTraces({ method: 'GET, DELETE' })).map((row) => row.method), ['GET', 'DELETE']);
  assert.deepEqual((await listTraces({ method: 'post,get' })).map((row) => row.method), ['GET', 'POST']);
  assert.deepEqual((await listTraces({ method: ['GET', 'POST', 'DELETE'] })).map((row) => row.time), [300, 200, 100]);
  assert.deepEqual(await listTraces({ method: 'PUT, PATCH' }), []);
});

test('missing trace databases list as empty', async (t) => {
  await useTraceDatabase(t);
  assert.deepEqual(await listTraces(), []);
});

test('trace databases written before the id and time columns gain them and keep their rows', async (t) => {
  const path = await useTraceDatabase(t);
  const legacy = await openDatabase(path);
  try {
    legacy.exec(`CREATE TABLE traces (
      url TEXT NOT NULL, method TEXT NOT NULL, status_code INTEGER NOT NULL,
      request_headers TEXT NOT NULL, request_body TEXT NOT NULL,
      response_headers TEXT NOT NULL, response_body TEXT NOT NULL
    ) STRICT;
    INSERT INTO traces VALUES ('https://example.test/api/legacy', 'GET', 200, '[]', '', '[]', '');`);
  } finally {
    legacy.close();
  }

  const beforeWriter = await listTraces();
  assert.deepEqual(beforeWriter.map((row) => ({ id: row.id, url: row.url, time: row.time })),
    [{ id: 1, url: 'https://example.test/api/legacy', time: 0 }]);

  const writer = await openTraceWriter();
  writer.insert({
    url: 'https://example.test/api/new',
    method: 'POST',
    statusCode: 201,
    requestHeaders: [],
    requestBody: '',
    responseHeaders: [],
    responseBody: '',
    time: 1_700_000_000_000
  });
  writer.close();

  const rows = await listTraces();
  assert.deepEqual(rows.map((row) => row.url), ['https://example.test/api/new', 'https://example.test/api/legacy']);
  assert.deepEqual(rows.map((row) => row.id), [2, 1]); // The stored row keeps an id of its own, below the new one.
  assert.equal(rows[0].time, 1_700_000_000_000);
  assert.equal(rows[1].time, 0); // Undated rows keep their data and sort last.

  const migrated = await openDatabase(path);
  try {
    const columns = migrated.prepare('PRAGMA table_info(traces)').all().map((row) => row.name);
    assert(columns.includes('id'));
    assert(columns.includes('time'));
    assert.equal(migrated.prepare('SELECT response_headers FROM traces WHERE url LIKE ?').get('%legacy').response_headers, '[]');
  } finally {
    migrated.close();
  }
});
