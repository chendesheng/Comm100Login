import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatHttpTrace } from '../src/cli/trace-format.mjs';

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
