import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');
const origin = 'https://livechat3dash.testing.comm100dev.io';
const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup(path, response = { ok: true, jwt: 'fresh', entryUrl: `${origin}/ui/10008/entry/` }) {
  const location = new URL(path, origin);
  const redirects = [];
  location.replace = (url) => { redirects.push(url); location.href = url; };
  const window = new EventTarget();
  const document = new EventTarget();
  const fields = { email: { value: 'manual@example.com' }, password: { value: 'manual-password' } };
  document.querySelector = (selector) => selector.includes('password') ? fields.password : fields.email;
  const messages = [];
  const replies = [];
  const polls = [];
  window.postMessage = (data) => replies.push(data);
  const history = Object.fromEntries(['pushState', 'replaceState'].map((method) => [method,
    (_state, _title, url) => { location.href = new URL(url, location.href).href; }]));
  const chrome = { runtime: { sendMessage(message, callback) {
    messages.push(message);
    callback(typeof response === 'function' ? response(message) : response);
  } } };
  vm.runInNewContext(source, { window, document, location, history, chrome, URL, queueMicrotask,
    setInterval: (fn) => { polls.push(fn); } });
  return { window, document, location, history, messages, replies, polls, fields, redirects };
}

for (const path of ['/', '/login', '/login/', '/login?retUrl=%2Fui%2F10008%2Fentry%2F']) {
  test(`${path} stays manual, captures credentials, and supports dashboard SPA transitions`, async () => {
    const page = setup(path);
    await settle();
    page.polls.forEach((fn) => fn());
    assert.deepEqual(page.messages, []);
    assert.equal(page.fields.email.value, 'manual@example.com');
    assert.equal(page.fields.password.value, 'manual-password');
    const event = new Event('message');
    Object.assign(event, { source: page.window, origin, data: { source: 'comm100-request-hook',
      type: 'session-request', id: 'login-request', url: `${origin}/api/global` } });
    page.window.dispatchEvent(event);
    await settle();
    assert.equal(page.replies.at(-1).ok, false);
    assert(!page.messages.some((message) => message.type === 'requestSession'));
    page.document.dispatchEvent(new Event('submit'));
    assert.deepEqual({ ...page.messages.at(-1) }, { type: 'captureCredentials', hostname: new URL(origin).hostname,
      domain: new URL(origin).host, email: 'manual@example.com', password: 'manual-password' });
    page.history.pushState({}, '', '/ui/10008/entry/');
    await settle();
    assert.equal(page.messages.filter((message) => message.type === 'ensureAuth').length, 1);
    assert.equal(page.messages.at(-1).siteId, '10008');
    page.history.replaceState({}, '', '/login');
    await settle();
    page.polls.forEach((fn) => fn());
    assert.equal(page.messages.filter((message) => message.type === 'ensureAuth').length, 1);
    assert.deepEqual(page.redirects, []);
  });
}

for (const reason of ['no-account', 'site-mismatch', 'no-route']) {
  test(`${reason} opens manual login and preserves the requested site URL`, async () => {
    const path = '/ui/1/ai/dashboard/?view=all#details';
    const page = setup(path, { ok: false, reason });
    await settle();
    assert.equal(page.redirects.length, 1);
    const login = new URL(page.redirects[0]);
    assert.equal(login.origin, origin);
    assert.equal(login.pathname, '/login');
    assert.equal(login.searchParams.get('retUrl'), `${origin}${path}`);
    page.polls.forEach((fn) => fn());
    await settle();
    assert.equal(page.messages.filter((message) => message.type === 'ensureAuth').length, 1);
    assert.equal(page.redirects.length, 1);
  });
}

test('a refused request does not redirect a page the user has already left', async () => {
  let page;
  page = setup('/login', () => {
    page.location.href = `${origin}/ui/10008/entry/`;
    return { ok: false, reason: 'no-account' };
  });
  page.history.pushState({}, '', '/ui/1/ai/dashboard/');
  await settle();
  assert.deepEqual(page.redirects, []);
});

for (const response of [null, { ok: false, reason: 'cooldown' }, { ok: false, reason: 'exception' }]) {
  test(`a transient authentication result stays on the dashboard: ${response?.reason || 'no response'}`, async () => {
    const page = setup('/ui/10008/entry/', response);
    await settle();
    assert.deepEqual(page.redirects, []);
  });
}

for (const host of ['localhost:12050', 'localhost:34500', '127.0.0.1:12050', '[::1]:12050']) {
  test(`${host} does not start content monitoring or capture credentials`, async () => {
    const page = setup(`http://${host}/ui/10008/entry/`);
    await settle();
    page.document.dispatchEvent(new Event('submit'));
    page.history.pushState({}, '', '/login');
    await settle();
    assert.equal(page.messages.length, 0);
    assert.equal(page.polls.length, 0);
  });
}

test('manifest grants no access to localhost or loopback pages', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const patterns = [...manifest.host_permissions, ...manifest.content_scripts.flatMap((script) => script.matches)];
  assert(patterns.every((pattern) => pattern === 'https://app.livehelp100service.com/*' || /^https:\/\/\*\.(comm100dev\.io|comm100staging\.com|comm100\.io)\/\*$/.test(pattern)));
});
