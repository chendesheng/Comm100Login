import assert from 'node:assert/strict';
import { cookieHeaderBytes, COOKIE_HEADER_BUDGET_BYTES, isSessionPruned, restoreSessionTracking, trimSessionCookies } from '../src/shared/cookie-budget.js';

const origin = 'https://livechat6dash.testing.comm100dev.io';
const jar = new Map();
const storage = new Map();
const key = (c) => `${c.domain}|${c.path}|${c.name}`;
const matches = (cookie, url) => {
  const domain = cookie.domain.replace(/^\./, '');
  return (url.hostname === domain || (!cookie.hostOnly && url.hostname.endsWith(`.${domain}`))) &&
    (url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`));
};
globalThis.chrome = {
  storage: { local: {
    get: async (name) => ({ [name]: structuredClone(storage.get(name)) }),
    set: async (values) => { for (const [name, value] of Object.entries(values)) storage.set(name, structuredClone(value)); }
  } },
  cookies: {
    getAll: async ({ url }) => [...jar.values()].filter((c) => matches(c, new URL(url))).map((c) => structuredClone(c)),
    remove: async ({ url, name }) => {
      const entry = [...jar.entries()].filter(([, c]) => c.name === name && matches(c, new URL(url)))
        .sort((a, b) => b[1].path.length - a[1].path.length)[0];
      if (entry) jar.delete(entry[0]);
    }
  }
};
const add = (name, value, options = {}) => {
  const cookie = { name, value, domain: '.comm100dev.io', path: '/', secure: true, ...options };
  jar.set(key(cookie), cookie);
  return cookie;
};
const jwt = (iat, expired = false) => `h.${Buffer.from(JSON.stringify({
  iat, exp: Math.floor(Date.now() / 1000) + (expired ? -30 : 7200), padding: 'x'.repeat(1300)
})).toString('base64url')}.s`;
const session = (site, iat, expired = false, options = {}) => {
  add(`token_${site}`, jwt(iat, expired), options);
  add(`tokenExpire_${site}`, 'expiry', options);
};
const exists = (name) => [...jar.values()].some((c) => c.name === name);
const reset = () => { jar.clear(); storage.clear(); };

reset();
session('1', 1); // Current session is the oldest, but it must be retained.
session('2', 2);
session('3', 3);
add('preferences', 'keep');
let result = await trimSessionCookies(`${origin}/ui/1/`, '1');
assert(result.beforeBytes > COOKIE_HEADER_BUDGET_BYTES);
assert(result.afterBytes <= COOKIE_HEADER_BUDGET_BYTES);
assert(exists('token_1'));
assert(!exists('token_2') && !exists('tokenExpire_2'));
assert(exists('token_3') && exists('preferences'));
assert(await isSessionPruned('anotherdash.testing.comm100dev.io', '2'));
assert(!await isSessionPruned('dash.comm100.io', '2'));
const freshModule = await import('../src/shared/cookie-budget.js?worker-restart');
assert(await freshModule.isSessionPruned(origin, '2'));
await restoreSessionTracking(origin, '2');
assert(!await isSessionPruned(origin, '2'));
console.log('PASS oldest JWTs are removed first, current session and unrelated cookies survive, and eviction persists across worker restarts');

reset();
session('1', 1);
session('2', 2);
session('3', 3, true);
result = await trimSessionCookies(`${origin}/assets/app.js`, '1');
assert(!exists('token_3') && !exists('tokenExpire_3'));
assert(exists('token_2'));
console.log('PASS expired JWTs are evicted before older tokens that still work');

reset();
session('1', 1);
session('2', 2);
session('3', 3, false, { domain: 'different.comm100dev.io', hostOnly: true });
result = await trimSessionCookies(`${origin}/assets/app.js`, '1');
assert.equal(result.beforeBytes, result.afterBytes);
assert.equal(result.removedSiteIds.length, 0);
result = await trimSessionCookies(`${origin}/assets/app.js`, '1', { force: true });
assert(exists('token_1') && !exists('token_2'));
assert(exists('token_3'));
assert(result.afterBytes < result.beforeBytes);
console.log('PASS only cookies sent to the failing endpoint count; confirmed 431 errors can recover below the default budget');

reset();
session('1', 1);
session('2', 2, false, { path: '/assets' });
session('3', 3, false, { path: '/assets' });
result = await trimSessionCookies(`${origin}/assets/app.js`, '1');
assert(!exists('token_2') && !exists('tokenExpire_2'));
assert(exists('token_1'));
assert(result.afterBytes <= COOKIE_HEADER_BUDGET_BYTES);
console.log('PASS cleanup removes path-scoped JWTs using their actual cookie path');

reset();
session('1', 1);
add('unrelated-large', 'x'.repeat(5000));
result = await trimSessionCookies(`${origin}/`, '1');
assert.equal(result.beforeBytes, result.afterBytes);
assert(exists('token_1') && exists('unrelated-large'));
assert.equal(cookieHeaderBytes([]), 0);
assert.equal(cookieHeaderBytes([{ name: 'a', value: 'é' }]), Buffer.byteLength('Cookie: a=é\r\n'));
console.log('PASS irreducible headers do not cause deletion of the current JWT or unrelated cookies; sizes count bytes');
