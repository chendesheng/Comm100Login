import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatCurlTrace, formatHttpTrace } from '../src/cli/trace-format.mjs';

const exchange = (extra = {}) => ({
  id: 7,
  time: Date.parse('2026-10-19T12:00:00Z'),
  url: 'https://dash.test/api/thing?siteId=10010',
  method: 'POST',
  statusCode: 200,
  requestHeaders: [['accept', 'application/json'], ['content-type', 'application/json']],
  requestBody: '{"a":1}',
  responseHeaders: [['content-type', 'application/json']],
  responseBody: '{"ok":true}',
  ...extra
});

test('a trace prints as the request and then the response, separated by blank lines', () => {
  assert.equal(formatHttpTrace(exchange()), [
    'POST /api/thing?siteId=10010 HTTP/1.1',
    'Host: dash.test',
    'accept: application/json',
    'content-type: application/json',
    '',
    '{"a":1}',
    '',
    'HTTP/1.1 200 OK',
    'content-type: application/json',
    '',
    '{"ok":true}',
    ''
  ].join('\n'));
});

test('the request line keeps the origin form and Host comes from the URL', () => {
  const rendered = formatHttpTrace(exchange({
    method: 'GET',
    url: 'https://dash.test:8443/api/report?siteId=1&x=2',
    // A recorded Host would be duplicated by the rebuilt one, so it is dropped.
    requestHeaders: [['Host', 'spoofed.test'], ['x-test', 'yes']],
    requestBody: ''
  }));
  assert(rendered.startsWith('GET /api/report?siteId=1&x=2 HTTP/1.1\nHost: dash.test:8443\nx-test: yes\n'));
  assert(!rendered.includes('spoofed.test'));
});

test('a curl replay keeps the recorded headers and takes its cookies from the CLI', () => {
  assert.equal(formatCurlTrace(exchange()), [
    "curl -X POST \\",
    "  'https://dash.test/api/thing?siteId=10010' \\",
    "  -H 'accept: application/json' \\",
    "  -H 'content-type: application/json' \\",
    '  -b "$(comm100-accounts login <email> --siteId=10010 --cookie)" \\',
    `  --data-raw '{"a":1}'`,
    ''
  ].join('\n'));
});

test('a recorded bearer is replaced by a fresh login and transport headers are dropped', () => {
  const rendered = formatCurlTrace(exchange({
    method: 'GET',
    url: 'https://dash.test/api/plain',
    requestHeaders: [['Host', 'spoofed.test'], ['content-length', '8'], ['Authorization', 'Bearer stale'], ['x-test', 'yes']],
    requestBody: ''
  }));
  assert.equal(rendered, [
    "curl -X GET \\",
    "  'https://dash.test/api/plain' \\",
    "  -H 'x-test: yes' \\",
    '  -H "Authorization: Bearer $(comm100-accounts login <email>)" \\',
    '  -b "$(comm100-accounts login <email> --cookie)"',
    ''
  ].join('\n'));
  assert(!rendered.includes('spoofed.test'));
  assert(!rendered.includes('stale'));
  assert(!rendered.includes('content-length'));
});

test('a body is shell-quoted even when it contains single quotes', () => {
  const rendered = formatCurlTrace(exchange({ requestBody: `{"note":"it's raw"}` }));
  assert(rendered.includes(`--data-raw '{"note":"it'\\''s raw"}'`));
});

test('bodies are omitted when empty and a failed request names no status', () => {
  assert.equal(formatHttpTrace(exchange({
    statusCode: 0, requestBody: '', responseHeaders: [], responseBody: 'Failed to fetch'
  })), [
    'POST /api/thing?siteId=10010 HTTP/1.1',
    'Host: dash.test',
    'accept: application/json',
    'content-type: application/json',
    '',
    'HTTP/1.1 0 (no response)',
    '',
    'Failed to fetch',
    ''
  ].join('\n'));
  // An unknown status keeps the code alone instead of inventing a reason.
  assert(formatHttpTrace(exchange({ statusCode: 204, responseHeaders: [], responseBody: '' }))
    .endsWith('HTTP/1.1 204 No Content\n'));
  assert(formatHttpTrace(exchange({ statusCode: 599, responseHeaders: [], responseBody: '' }))
    .endsWith('HTTP/1.1 599\n'));
});
