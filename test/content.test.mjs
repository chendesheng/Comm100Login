import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');
const origin = 'https://livechat3dash.testing.comm100dev.io';
const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup(path) {
  const location = new URL(path, origin);
  location.replace = () => assert.fail('content script must never redirect from login');
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
    callback({ ok: true, jwt: 'fresh', entryUrl: `${origin}/ui/10008/entry/` });
  } } };
  vm.runInNewContext(source, { window, document, location, history, chrome, URL, queueMicrotask,
    setInterval: (fn) => { polls.push(fn); } });
  return { window, document, location, history, messages, replies, polls, fields };
}

for (const path of ['/', '/login', '/login/', '/login?retUrl=%2Fui%2F10008%2Fentry%2F']) {
  test(`${path} stays manual, captures credentials, and supports dashboard SPA transitions`, async () => {
    const page = setup(path);
    await settle();
    page.polls.forEach((fn) => fn());
    assert.deepEqual(page.messages.map((message) => message.type), ['pageMode']);
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
  assert(patterns.every((pattern) => /^https:\/\/\*\.(comm100dev\.io|comm100staging\.com|comm100\.io)\/\*$/.test(pattern)));
});
