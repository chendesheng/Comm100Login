import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { listTraces, openTraceWriter } from '../src/cli/traces.mjs';

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

test('SQLite traces retain the newest 1000 exchanges with exactly seven raw columns', async (t) => {
  const path = await useTraceDatabase(t);
  const writer = await openTraceWriter();
  for (let index = 1; index <= 1005; index++) {
    writer.insert({
      url: `https://example.test/api/${index}`,
      method: 'GET',
      statusCode: 200,
      requestHeaders: [['X-Index', String(index)]],
      requestBody: `request-${index}`,
      responseHeaders: [['Content-Type', 'application/json']],
      responseBody: `response-${index}`
    });
  }
  const rows = await listTraces();
  assert.equal(rows.length, 1000);
  assert.equal(rows[0].url, 'https://example.test/api/1005');
  assert.equal(rows.at(-1).url, 'https://example.test/api/6');
  assert(rows.every((row, index) => row.url === `https://example.test/api/${1005 - index}`));

  const db = await openDatabase(path);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    assert.deepEqual(tables, ['traces']);
    const columns = db.prepare('PRAGMA table_info(traces)').all().map((row) => row.name);
    assert.deepEqual(columns, [
      'url', 'method', 'status_code', 'request_headers', 'request_body', 'response_headers', 'response_body'
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
    responseBody
  });
  const largeBody = 'trace-body-'.padEnd(2 * 1024 * 1024 + 17, 'abcdefghij');
  writer.insert({
    url: 'https://example.test/api/large',
    method: 'PUT',
    statusCode: 204,
    requestHeaders: [],
    requestBody: largeBody,
    responseHeaders: [],
    responseBody: ''
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
    const large = db.prepare('SELECT request_body FROM traces ORDER BY rowid DESC LIMIT 1').get();
    assert.equal(large.request_body.length, largeBody.length);
    assert.equal(large.request_body, largeBody);
  } finally {
    db.close();
  }
});

test('missing trace databases list as empty', async (t) => {
  await useTraceDatabase(t);
  assert.deepEqual(await listTraces(), []);
});
