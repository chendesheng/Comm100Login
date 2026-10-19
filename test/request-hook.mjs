/** Exercise the real page hook with controlled network and extension-message boundaries. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/content/request-hook.js', import.meta.url), 'utf8');
const origin = 'https://livechat6dash.testing.comm100dev.io';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(path = '/ui/99999/entry/') {
  const network = [];
  const traces = [];
  const config = { jwt: 'fresh', delay: 10, checks: 0, renewals: 0 };
  const window = new EventTarget();
  class PageRequest extends Request {
    constructor(input, init) { super(typeof input === 'string' ? new URL(input, origin) : input, init); }
  }
  const statusFor = (url, auth) => url.includes('always401') ||
    (url.includes('reject') && auth !== 'Bearer renewed') ? 401 : url.includes('forbidden') ? 403 : 200;
  window.fetch = async (input, init) => {
    const request = new PageRequest(input, init);
    const record = { url: request.url, auth: request.headers.get('authorization'), body: await request.text(), method: request.method };
    network.push(record);
    return new Response(JSON.stringify(record), { status: statusFor(record.url, record.auth) });
  };
  class FakeXHR extends EventTarget {
    readyState = 0;
    status = 0;
    responseType = '';
    withCredentials = false;
    timeout = 0;
    open(method, url, async = true) {
      this.method = method;
      this.url = String(new URL(url, origin));
      this.async = async;
      this.headers = new Headers();
      this.status = 0;
      this.readyState = 1;
      this.responseType = '';
      this.withCredentials = false;
      this.dispatchEvent(new Event('readystatechange'));
    }
    setRequestHeader(name, value) { this.headers.append(name, value); }
    getAllResponseHeaders() { return 'Content-Type: application/json\r\nX-Test: yes\r\n'; }
    send(body) {
      const record = { url: this.url, auth: this.headers.get('authorization'), body, method: this.method,
        custom: this.headers.get('x-custom'), credentials: this.withCredentials };
      network.push(record);
      setTimeout(() => {
        this.status = statusFor(record.url, record.auth);
        this.readyState = 2;
        this.dispatchEvent(new Event('readystatechange'));
        this.response = this.responseType === 'json' ? record : JSON.stringify(record);
        this.readyState = 4;
        this.dispatchEvent(new Event('readystatechange'));
        this.dispatchEvent(new Event('load'));
        this.dispatchEvent(new Event('loadend'));
      }, 0);
    }
    abort() { this.readyState = 0; this.status = 0; }
  }
  window.XMLHttpRequest = FakeXHR;
  window.postMessage = (data) => queueMicrotask(() => {
    const event = new Event('message');
    Object.assign(event, { data, source: window, origin });
    window.dispatchEvent(event);
  });
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (data?.source !== 'comm100-request-hook') return;
    if (data.type === 'api-trace') { traces.push(data.trace); return; }
    if (data.type !== 'session-request') return;
    config.checks++;
    setTimeout(() => {
      if (data.rejectedToken) { config.renewals++; config.jwt = 'renewed'; }
      window.postMessage({ source: 'comm100-session-bridge', type: 'session-response', id: data.id,
        ok: Boolean(config.jwt), jwt: config.jwt });
    }, config.delay);
  });
  const location = new URL(path, origin);
  vm.runInNewContext(source, { window, location,
    Request: PageRequest, Headers, URL, Event, ProgressEvent: Event, DOMException, setTimeout, clearTimeout });
  return { window, network, traces, config, PageRequest, location };
}

function xhrCall(window, url, auth = 'Bearer expired') {
  return new Promise((resolve, reject) => {
    const request = new window.XMLHttpRequest();
    const statuses = [];
    request.open('POST', url);
    request.responseType = 'json';
    request.withCredentials = true;
    if (auth) request.setRequestHeader('Authorization', auth);
    request.setRequestHeader('X-Custom', 'preserved');
    request.addEventListener('readystatechange', () => { if (request.readyState >= 2) statuses.push(request.status); });
    request.addEventListener('load', () => resolve({ status: request.status, data: request.response, statuses }));
    request.addEventListener('error', reject);
    request.send('original body');
  });
}

{
  const { window, network } = setup();
  const requests = Promise.all([
    window.fetch('/api/echo', { method: 'POST', headers: { Authorization: 'Bearer expired' }, body: 'original body' }).then((r) => r.json()),
    xhrCall(window, '/api/echo'), xhrCall(window, '/api/echo', null)
  ]);
  assert.equal(network.length, 0, 'no request leaves before the session reply');
  const results = await requests;
  for (const result of results) {
    assert.equal((result.data || result).auth, 'Bearer fresh');
    assert.equal((result.data || result).body, 'original body');
  }
  assert.equal(network.length, 3);
  console.log('PASS fetch and XHR wait for authentication and replace expired or missing bearers');
}
{
  const { window, config, PageRequest, network } = setup();
  config.jwt = 'revoked';
  const response = await window.fetch(new PageRequest('/api/reject', { method: 'POST', body: 'retry body' }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).body, 'retry body');
  config.jwt = 'revoked';
  const xhr = await xhrCall(window, '/api/reject');
  assert.equal(xhr.status, 200);
  assert.equal(xhr.data.auth, 'Bearer renewed');
  assert.equal(xhr.data.custom, 'preserved');
  assert.equal(xhr.data.credentials, true);
  assert(xhr.statuses.every((status) => status === 200));
  assert.equal(network.length, 4);
  console.log('PASS a 401 retries once without delivering the rejected response to app handlers');
}
{
  const { window, network, config } = setup();
  config.jwt = 'revoked';
  assert.equal((await window.fetch('/api/always401')).status, 401);
  config.jwt = 'revoked';
  assert.equal((await xhrCall(window, '/api/always401')).status, 401);
  assert.equal(network.length, 4);
  const before = config.renewals;
  assert.equal((await window.fetch('/api/forbidden')).status, 403);
  assert.equal(config.renewals, before);
  console.log('PASS retry counts are bounded and 403 permission failures do not cause retries');
}
{
  const { window, traces } = setup();
  const response = await window.fetch('/api/fetch-trace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"hello":"world"}'
  });
  await response.json();
  await xhrCall(window, '/api/xhr-trace');
  await sleep(30);
  const fetchTrace = traces.find((trace) => trace.url.endsWith('/api/fetch-trace'));
  assert(fetchTrace, 'fetch trace captured');
  assert.equal(fetchTrace.method, 'POST');
  assert.equal(fetchTrace.statusCode, 200);
  assert.equal(fetchTrace.requestBody, '{"hello":"world"}');
  assert.deepEqual(fetchTrace.requestHeaders.find(([name]) => name.toLowerCase() === 'authorization'),
    ['authorization', 'Bearer fresh']);
  assert.equal(JSON.parse(fetchTrace.responseBody).body, '{"hello":"world"}');
  const xhrTrace = traces.find((trace) => trace.url.endsWith('/api/xhr-trace'));
  assert(xhrTrace, 'XHR trace captured');
  assert.equal(xhrTrace.method, 'POST');
  assert.equal(xhrTrace.statusCode, 200);
  assert.equal(xhrTrace.requestBody, 'original body');
  assert.equal(JSON.parse(xhrTrace.responseBody).auth, 'Bearer fresh');
  assert.equal(JSON.stringify(xhrTrace.responseHeaders),
    JSON.stringify([['Content-Type', 'application/json'], ['X-Test', 'yes']]));
  console.log('PASS fetch and XHR exchanges are traced with raw bodies and headers');
}
{
  const { window, config, traces } = setup();
  config.jwt = 'revoked';
  await (await window.fetch('/api/reject', { method: 'POST', body: 'retry body' })).json();
  config.jwt = 'revoked';
  await xhrCall(window, '/api/reject');
  assert.equal((await window.fetch('/api/forbidden')).status, 403);
  await sleep(50);
  const retried = traces.filter((trace) => trace.url.endsWith('/api/reject'));
  assert.deepEqual(retried.map((trace) => trace.statusCode).sort((a, b) => a - b), [200, 200, 401, 401]);
  const forbidden = traces.filter((trace) => trace.url.endsWith('/api/forbidden'));
  assert.deepEqual(forbidden.map((trace) => trace.statusCode), [403]);
  console.log('PASS rejected requests trace both the 401 and the retried outcome, and 403 is captured');
}
{
  const { window, network, config } = setup();
  config.delay = 30;
  const controller = new AbortController();
  const fetchResult = window.fetch('/api/abort', { signal: controller.signal });
  controller.abort();
  await assert.rejects(fetchResult, { name: 'AbortError' });
  const request = new window.XMLHttpRequest();
  request.open('GET', '/api/abort');
  let aborted = false;
  request.addEventListener('abort', () => { aborted = true; });
  request.send();
  request.abort();
  const timeout = new window.XMLHttpRequest();
  timeout.open('GET', '/api/timeout');
  timeout.timeout = 1;
  let timedOut = false;
  timeout.addEventListener('timeout', () => { timedOut = true; });
  timeout.send();
  await sleep(50);
  assert(aborted);
  assert(timedOut);
  assert.equal(network.length, 0);
  console.log('PASS abort and timeout during authentication prevent network transmission');
}
{
  const { window, config, network } = setup();
  await window.fetch('/api/login/test', { headers: { Authorization: 'Bearer manual' } });
  await window.fetch('/asset');
  await window.fetch('https://example.com/api/test');
  assert.equal(config.checks, 0);
  assert.equal(network[0].auth, 'Bearer manual');
  config.jwt = null;
  const fallback = await xhrCall(window, '/api/no-account', 'Bearer manual');
  assert.equal(fallback.data.auth, 'Bearer manual');
  console.log('PASS login endpoints and other origins bypass the hook; failed authentication preserves the original request');
}

for (const path of ['/', '/login', '/login/', '/login?retUrl=%2Fui%2F99999%2Fentry%2F']) {
  const { window, config, location } = setup(path);
  const response = await window.fetch('/api/always401', { headers: { Authorization: 'Bearer manual' } });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).auth, 'Bearer manual');
  assert.equal((await xhrCall(window, '/api/always401', 'Bearer manual')).data.auth, 'Bearer manual');
  assert.equal(config.checks, 0, 'login requests must not ask the extension for a session or retry');
  location.href = `${origin}/ui/99999/entry/`;
  assert.equal((await (await window.fetch('/api/echo')).json()).auth, 'Bearer fresh');
  const checks = config.checks;
  location.href = `${origin}/login`;
  assert.equal((await xhrCall(window, '/api/echo', null)).data.auth, null);
  assert.equal(config.checks, checks, 'SPA transition to login stops interception');
}
console.log('PASS login pages bypass authentication and retries, including SPA route transitions');
{
  const { window, location, config, network } = setup();
  config.delay = 30;
  const pending = window.fetch('/api/echo');
  location.href = `${origin}/login`;
  await pending;
  assert.equal(network[0].auth, null, 'a session reply arriving after navigation cannot inject a JWT');
}

for (const host of ['localhost:12050', 'localhost:34500', '127.0.0.1:12050', '[::1]:12050']) {
  const { window, config, network } = setup(`http://${host}/ui/99999/entry/`);
  await window.fetch('/api/echo', { headers: { Authorization: 'Bearer original' } });
  await xhrCall(window, '/api/echo', 'Bearer original');
  assert.equal(config.checks, 0);
  assert(network.every((request) => request.auth === 'Bearer original'));
}
console.log('PASS localhost and loopback requests are left untouched');
