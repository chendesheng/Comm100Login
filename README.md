# Comm100 Auto Login

An unpacked Chrome (MV3) extension that signs in to Comm100 test dashboards **in the background**,
using the login HTTP API rather than the sign-in form. You get the dashboard, not a form.

It remembers multiple accounts — **one per dashboard** — and always uses the **most recently used**
one for the site you are on.

## Terminal account tool

Requires Node.js 22.13+ or 23.4+. Install the CLI and bundled Chrome extension from npm:

```bash
npm install --global --foreground-scripts @chendesheng/comm100-auto-login
```

The install message prints the absolute extension folder inside the installed package:
`node_modules/@chendesheng/comm100-auto-login/extension`. Open `chrome://extensions`, enable
**Developer mode**, click **Load unpacked**, and select that folder. You can print its path again:

```bash
comm100-accounts extension-path
```

`--foreground-scripts` makes npm show the install message. If install scripts are disabled or their
output is hidden, the extension files are still included and `extension-path` works normally.
After updating the npm package, click **Reload** for the extension in Chrome to load the new code.

For development from a source checkout, install dependencies and link the executable instead:

```bash
npm install
npm link
```

Reload the updated extension at `chrome://extensions`, then run the one-time bridge setup:

```bash
comm100-accounts setup
# Reload the Comm100 Auto Login extension once more to connect the installed native host.
```

Setup registers a [Chrome native messaging host](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
for this extension and profile. It uses one temporary LevelDB snapshot to discover the profile's
connection ID; it never opens Chrome's original database. The launcher uses this installation's
absolute Node.js path, so Chrome does not need Node on its PATH. Setup supports Chrome on Windows,
macOS, and Linux. Chrome must be running, with the extension enabled, for subsequent CLI commands.

On Windows, setup installs the launcher and configuration in `%LOCALAPPDATA%\comm100-accounts`
and registers the native host under
`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.comm100.accounts` for the current user;
administrator access is not required. Communication uses a Windows named pipe. The same install,
`extension-path`, and `setup` commands work in PowerShell and Command Prompt. If PowerShell blocks
npm's script launcher, use `npm.cmd` and `comm100-accounts.cmd`. After a Node.js installation moves,
run setup again so the launcher uses its new path.

All normal reads and writes go through the extension service worker over local IPC (a Windows
named pipe or a Unix socket).
Accounts and JWTs share the extension's `chrome.storage.local` state; no database snapshots are
made for `list`, `login`, or `tokens`, and there is no separate JWT cache file. Bridge configuration
contains only profile/connection metadata, not credentials or tokens.

```bash
comm100-accounts list
comm100-accounts list --domain=livechat6dash.testing.comm100dev.io --siteId=10010
comm100-accounts list --siteId=10010
comm100-accounts list --show-password

comm100-accounts login agent@example.com
comm100-accounts login agent@example.com --siteId=10010
comm100-accounts login agent@example.com --domain=livechat6dash.testing.comm100dev.io
comm100-accounts login agent@example.com --cookie

comm100-accounts tokens
comm100-accounts tokens --domain=livechat6dash.testing.comm100dev.io --siteId=10010

comm100-accounts traces
comm100-accounts traces --domain=livechat6dash.testing.comm100dev.io --siteId=10010
comm100-accounts traces --from=2026-10-19T12:00:00Z
comm100-accounts traces --from=24h
comm100-accounts traces --from=1h30m
comm100-accounts traces 42
```

`list` prints unique rows ordered by dashboard, then site id, then email, in `siteId`, email, domain
columns. Site IDs are padded to 12 characters and emails to 30 characters, separated by a space;
longer values are preserved. Site ids compare as numbers (site 9999 before site 10002). Unknown sites
or domains appear as `-` and sort last. Domain and site filters are optional. `login` prints only
the JWT, so it can be captured with `token="$(comm100-accounts login agent@example.com)"`. Errors go
to stderr with a nonzero exit status.

`login --cookie` prints a single cookie string that can be passed directly to curl's `-b` option:

```bash
curl -b $(comm100-accounts login agent@example.com --siteId=10010 --cookie) \
  'https://livechat6dash.testing.comm100dev.io/api/global/siteActivity:active'
```

The output is `token_<siteId>=<jwt>;tokenExpire_<siteId>=<encoded-expiry>;siteList=<siteId>`, with no spaces.
The two token cookies hold the JWT and its URL-encoded expiry; `siteList` identifies the selected
site, matching the extension's session cookies. The expiry comes from the login response, or the
JWT's `exp` claim when no server expiry was supplied. No `Cookie:` prefix or cookie attributes are
printed. This option reuses the same JWT cache and leaves browser cookies untouched.

`list --show-password` inserts the saved password as the third column, after email, padded to
20 characters. It uses the same password as `login`: verified password first, otherwise the pending
password. Missing passwords appear as `-`; longer passwords are printed in full.

An email or explicit site ID is usually enough to select an account. If the email matches multiple
site IDs across different dashboards, the default domain is `${NAMESPACE}dash.testing.comm100dev.io`.
For example, `NAMESPACE=livechat6 comm100-accounts login agent@example.com` selects the livechat6
dashboard. A unique match does not require `NAMESPACE`. Explicit `--domain` always takes precedence;
multiple sites remaining on the same dashboard require `--siteId`. Among records for the same site,
the most recently used account is preferred.

Setup discovers this extension in Chrome's `Default` profile. Use
`comm100-accounts setup --profile="/path/to/Profile 1"` to configure another profile, or
`--db="/path/to/Local Extension Settings/EXTENSION_ID"` to select its LevelDB directory for setup.
Use the same `--profile` or `--db` on subsequent commands to select that configured connection.
The service worker owns all storage writes and serializes them with account updates, avoiding
Chrome's LevelDB lock and stale in-memory data.

CLI login reuses a fresh JWT from the shared cache. Otherwise it attempts credential login once and
asks the service worker to save the result. Browser login can reuse that same JWT to restore session
cookies; successful browser sign-ins also update the shared cache. Both the JWT's `exp` and the
server's expiry time are checked, tokens too close to expiry are renewed, and a server-rejected JWT
is removed from the cache. Two-factor accounts require browser sign-in. CLI login does not change
browser cookies, and failed credentials are never automatically retried.

`tokens` prints all shared cached JWTs, including expired tokens, as a formatted JSON array ordered
by dashboard, site id, and email. Each entry includes the full JWT, account scope, cache save time,
server expiry, `fresh` status, decoded `header` and `payload`, and `claimTimes` with UTC dates for
numeric `iat`, `nbf`, and `exp` claims. Nested payload data is preserved. Decoding does not verify the
signature; `fresh` uses the same local expiry checks as `login`. A malformed JWT is listed with a
`decodeError` so other entries can still be inspected. Use `--domain` and/or `--siteId` to filter.
An empty cache prints `[]`. The command only reads from the worker and never signs in or renews tokens.

`traces` prints captured API exchanges as `ID`, `TIME`, `METHOD`, `STATUS`, and URL columns, newest
first. `ID` increases with every capture and is never reused; `TIME` is the capture time in UTC
ISO-8601 with milliseconds. Rows recorded before those columns existed print `-` for the time and
sort last. The extension records same-origin `/api/*` `fetch` and asynchronous XHR calls made by
`/ui/` dashboards (`/api/login/*` is excluded), and the native host stores the most recent 1,000
exchanges with verbatim request and response headers and bodies — no redaction or truncation,
ordered by capture time. The SQLite database is `traces.sqlite` in the CLI configuration directory
(file mode `0600`, directory `0700`), or `COMM100_TRACES_DB` when set. `traces` reads that file
directly, works while Chrome is closed, and prints nothing on stdout once the bridge is configured
but no rows have been captured, and fails with the setup instruction when the bridge has never been
configured. `--domain` keeps only rows whose request host matches (scheme and path are ignored, like
the account filters), `--siteId` keeps rows carrying that `siteId` query value, and `--from` sets an
inclusive lower bound on the capture time: an ISO-8601 timestamp, or a duration counted back from
now (`30m`, `24h`, `1h30m`, combining hours, minutes and seconds). `traces <id>` prints that one
exchange the way it looked on the wire: request line, `Host`, request headers and body, then the
response status line, response headers and body. Browser HTTP stacks hide `Cookie` and `Set-Cookie`
headers from page JavaScript, so those cannot be captured.

### Publishing npm releases

`npm pack` and `npm publish` build `extension/` from the current browser source files. The npm
package includes that ready-to-load extension, CLI runtime modules and the install message.
Tests, development tools, local account data and `node_modules` are excluded from the archive.

The first release is published with `npm login --auth-type=web` followed by `npm publish`.
Then configure **Trusted publishing** in the npm package settings with:

- Provider: GitHub Actions
- Repository owner: `chendesheng`
- Repository: `Comm100Login`
- Workflow filename: `publish-npm.yml`
- Allowed action: publish

The workflow uses GitHub's OIDC identity and requires no npm token secret. Future releases run
automatically when a version tag is pushed:

```bash
npm version patch
git push origin main --follow-tags
```

The tag must match the package version, such as `v0.0.2`. CI installs dependencies, runs the test
suite, builds the extension during packing, and publishes the package with public access.

## How it works

Sign-in happens in the service worker. Three requests, verified live against
`livechat6dash.testing.comm100dev.io`:

| # | Request | Purpose |
|---|---------|---------|
| 1 | `GET https://{branch}route.testing.comm100dev.io/api/v1/router/agents/getByEmail?email=…` | which `siteId` / `portalUrl` this email belongs to |
| 2 | `POST {portalUrl}/api/login/jwtToken/login` — `{ email, password, siteId }` | the JWT |
| 3 | `POST {portalUrl}/api/login/accounts/CrossPlatformLogin` — `{ token, siteId }` | turns the JWT into the session cookie |

Step 3 responds with `Set-Cookie`, and the extension **then re-reads the cookie and plants it
explicitly** (`chrome.cookies.set`) if it is missing — extension-initiated `fetch` is not guaranteed
to persist `Set-Cookie`, so the outcome is verified rather than assumed.

Once the cookie exists, the normal navigation you asked for simply renders authenticated. The sign-in
page is never opened, filled, or clicked.

### Intercepting API requests

At `document_start`, a script in the page's main JavaScript world wraps `fetch` and asynchronous
`XMLHttpRequest`. For same-origin `/api/*` requests, it waits for the service worker to obtain a
usable JWT before sending, then replaces (or adds) `Authorization: Bearer …`. This also covers a
page holding an expired token in memory, or a cookie deleted immediately after the last login.
Concurrent requests for the same dashboard and site share a login attempt.

If the server returns HTTP 401 despite a locally valid token, the hook renews it and retries once
before delivering the response to the app. It preserves the method, body and other request headers;
403 responses are passed through. Login endpoints, other origins and synchronous XHR are excluded.
Without a usable saved credential, the original request proceeds so the app can handle sign-in.
Explicit sign-out suppression, temporary retry cooldowns and renewal limits still apply.

The content script relays these requests to the worker; passwords are never sent to the page hook.
Background cookie monitoring and header rules remain as backstops, but cannot themselves pause a
page request while signing in. After changing the extension, reload it in `chrome://extensions`
and refresh existing dashboard tabs so they load the request hook.

Run `npm test` for the offline background and request-hook checks. These checks stub Chrome and
network boundaries; live dashboard behavior still needs verification after reloading the extension.

### Static files rejected because the Cookie header is too large

HTML pages, scripts, stylesheets, images, fonts and media load outside the app's API hooks. The
worker watches their GET responses. An HTML 400 response with a Cookie header over a conservative
4 KiB budget, or HTTP 431, triggers cleanup: expired JWT sessions first, then the oldest JWTs, along
with their `tokenExpire_*` cookies. The current page's site is kept; without a known site, the newest
token is kept. Saved accounts and unrelated cookies are preserved.

After successful cleanup, the extension reloads the affected tab so Chrome fetches the static files
again. A persistent guard allows at most one automatic reload per tab and dashboard per minute,
including when several assets fail together or the worker restarts. Watchdog and keep-alive tasks
do not restore evicted sessions; opening an evicted site can sign it in again normally.
SPA route and fragment changes within the same document do not prevent recovery. Navigating to
another document skips the reload without consuming the retry, and a rejected reload releases its
retry guard. The activity log distinguishes reload requests, skipped reloads and reload failures.

The worker cannot read response bodies, so it uses status, content type and measured cookie size
instead of matching Nginx's error text. The actual ingress limit is server-specific. If the current
JWT or unrelated cookies alone exceed that limit, removing older JWTs cannot solve it. Cleanup and
byte counts appear as `cookie-budget` entries in the popup's activity log. Reloading the page can
discard unsaved state.

### Credentials belong to a dashboard

Every Comm100 test branch shares the `comm100dev.io` cookie domain, but they are **separate
deployments with separate databases**. An account that exists on `livechat3dash` usually does not
exist on `livechat6dash` (and when the same address does exist, it is a different `siteId`). Firing
one dashboard's password at another therefore does nothing except spend attempts against the
**lockout threshold**.

So an account is identified by **email *and* dashboard**, and `pickAccount()` never crosses one:

- `src/shared/platforms.js` holds the dashboard list (`wanTestPlatformsPrefixes`,
  `lanTestPlatformsPrefixes`, `productionPlatformsPrefixes` — the same names the web client uses).
  The "domain" of an account is that entry's host, **including the port** where there is one, so
  `http://localhost:34500` and `https://localhost:3000` are different dashboards.
- The popup has no dashboard picker. A credential is recorded on the dashboard it was typed into (the
  capture path), and the account list's dashboard filter is built from the dashboards that actually
  have credentials — so `livechat3dash.testing.comm100dev.io` and `livechat3dash.comm100dev.io` list as
  separate entries there.
- `livechat3dash.testing.comm100dev.io` (WAN) and `livechat3dash.comm100dev.io` (LAN) are *different*
  entries on purpose: same name, different deployments.
- Signing in is a property of the account, not of the tab you are looking at, so a row's **Login
  now** works from any page — it signs in to *that account's* dashboard and opens it in a new tab.
- Accounts saved before this existed are pinned to the first host they were ever used on
  (`hosts[0]`) — that is where the credential was introduced, and anything appended later was a
  successful sign-in. An account with no host history stays deliberately unscoped (a wildcard), which
  is what an imported file expects; the picker asks for a dashboard on the next edit.

### Which site? (`getByEmail`, never the URL)

A dashboard can serve **several sites** — `livechat6dash.testing.comm100dev.io` serves site 10010 to
one agent and 10012 to another — and a URL can name any of them. The panel's URL is therefore a
*claim*, not a fact, and it is never trusted:

- Which site an email uses on a dashboard comes from the route service (`getByEmail`) — the same call
  that resolves `portalUrl`. Nobody types a site id anywhere; the popup has no field for it.
- A site learned from a successful sign-in is cached on the account and shown in the list as
  `site 10010`. That cache makes the common case free: no route call when the URL agrees with it.
- When the URL names a site the credential disagrees with, the route service is asked. Owns it → sign
  in for it. Does not own it → **nothing is attempted**; the dashboard shows its own sign-in page and
  you sign in by hand (that credential is remembered, and its site comes from the same call).
- A captured credential records **no** site. A claim from the address bar is not evidence, and a
  wrong site remembered as fact would skip exactly the check that keeps a rejected session from being
  planted.

That distinction is the whole fix for "it keeps jumping to login": the sign-in API will happily issue
a token for a site the account does not belong to, and the panel then rejects it on every call and
reloads itself. Refusing to guess is what makes it stop.

A dashboard that has no route service of its own — `dash11.comm100staging.com`, and the local
dashboard — is routed to itself (`getByEmail` on its own origin). That is a best-effort fallback,
not a verified convention like `{branch}dash` → `{branch}route`. **Neither has been verified live.**

### The session cookie

Discovered from the `Set-Cookie` headers of step 3:

```
siteList=10012;                 Domain=comm100dev.io; Path=/; Secure; SameSite=Strict; HttpOnly
token_10012=<jwt>;              Domain=comm100dev.io; Path=/; Secure; SameSite=Strict; HttpOnly
tokenExpire_10012=<url-encoded ISO>; Domain=comm100dev.io; Path=/; Secure; SameSite=Strict
```

`token_{siteId}` **is the JWT cookie**. `tokenExpire_{siteId}` is a session cookie and is not HttpOnly.

### Which site is this tab? (important)

Every Comm100 test branch shares the **`comm100dev.io`** cookie domain, so a `token_*` cookie for
one branch says *nothing* about another. A leftover `token_10012` from `livechat6dash` must never be
read as "livechat3dash is signed in".

So the extension takes the site from the URL instead:

```
/ui/10008/livechat/dashboard/   ->  site 10008, and only token_10008 counts
/login/?retUrl=…%2Fui%2F10008%2F…  ->  site 10008, read out of retUrl
```

With the site known, the route service is not consulted at all — one fewer round trip, and no chance
of confusing branches. The route lookup only runs when the URL does not name a site.

### Login pages stay manual

The extension does not monitor localhost or loopback addresses: no request interception, credential
capture, cookie restoration, or automatic sign-in. Existing local accounts remain available to the CLI.

Opening `/`, `/login`, or `/login/` leaves the login form available, including URLs with a
`retUrl` pointing to the dashboard. The extension does not sign in, cover the form, prefill it,
or redirect away. Requests from login pages bypass JWT renewal, retries, and automatic
Authorization header replacement. Manual form submissions still save entered credentials.

Automatic authentication starts on `/ui/...`, including SPA navigation from the login form.
The keep-alive and cookie watchdog also leave a host alone when its only open tabs are login
pages. Dashboard tabs on the same host can still renew their own sessions. An explicit popup
**Login now** action and CLI login remain available.

### Acting as middleware on a rejected request

The wanted behaviour is "catch the 401, sign in again, update the cookie and resend". In MV3 the
first three are possible and the fourth is not:

| Step | Possible? |
|---|---|
| Read the token out of the request **before it is sent** | ✅ `webRequest.onBeforeSendHeaders` |
| Decide whether that token is still valid | ✅ decode the JWT's own `exp` claim |
| Sign in again and plant a fresh cookie | ✅ |
| Rewrite the outgoing `Cookie` header, or resend the request | ❌ a worker cannot modify or replay a page's request — blocking `webRequest` is enterprise-force-install only, and `declarativeNetRequest` has no cookie action |

Two hooks cover the gap:

**Pre-flight (before the request).** `onBeforeSendHeaders` sees the actual outgoing `Cookie` header
for every `/api/` call. The token is decoded and checked against its own `exp` claim — the JWT is the
authority, not the cookie expiry, because the cookie's copy can outlive the token it carries.
`hasSession` applies the same rule, so a live cookie holding an expired JWT no longer counts as a
session. If the token is missing or within 60 s of expiry, the sign-in starts **there** — a full
round trip before the 401 could tell us. The sign-in endpoints (`/api/login/…`) are excluded, since
they carry no session and must not be read as evidence of a bad one.

**Response (after the request).** The offending request cannot be replayed, and the obvious next
move — reloading the page — is deliberately **not** taken: it throws away whatever the user was
doing. Instead the worker re-authenticates and then does nothing to the tab. The fresh cookie is in
the jar, so the panel's *next* request simply succeeds, and the user retries when they are ready
rather than when we decide.

Bounds on that re-authentication:

- a budget of 3 per host per minute, so an endpoint rejecting for a reason signing in cannot fix
  gives up rather than looping;
- 2 s coalescing, so a burst of failing calls causes one sign-in;
- nothing at all for a keep-alive renewal, where the page was never broken.

**Nothing in this extension reloads a working page.** The *only* remaining way anything moves a tab
is the content script leaving `/login` for `retUrl` — the recovery from a bounce, not a reload. An
earlier revision reloaded the tab that produced a 401; that was removed, because yanking the page
away throws out whatever the user was doing, and with the CDP path the token is attached before the
request leaves so a 401 should not arise in the first place.

This is a backstop, not the main defence — the keep-alive renews long before the JWT lapses, so a
401 should mean the server rejected a cookie that had not yet expired (revocation, a password
change, or the JWT's `thumbprint` binding) rather than plain expiry.

### Dead end: force-installing for webRequestBlocking

Tried, and closed by the platform. Force-installing was meant to grant `webRequestBlocking` so the
worker could hold a navigation while signing in. **Chrome refuses this on a Mac that is not
MDM-enrolled:**

```
ExtensionSettings   [BLOCKED]gpfpnldaoihmfpjcefhbfmkbdccngebd
Warning: This computer is not detected as enterprise managed so policy can only
         automatically install extensions hosted on the Chrome Webstore.
Warning: Schema validation error: Unknown property: [BLOCKED]<id>
```

That is a built-in Chromium string, not a misconfiguration — off-store automatic installs require a
genuinely managed device, because otherwise anything that can write that policy file could silently
install an extension with full network interception. The artifacts were correct (the derived
extension ID matched the key inside the CRX3 header and the policy passed `plutil -lint`); the
platform simply would not accept them. The packaging script and the `webRequestBlocking` code path
have since been deleted rather than left behind, since neither could ever run.

A `chrome.debugger` + CDP `Fetch` implementation was written next, on the reasoning that a paused
request can be resumed with rewritten headers without any policy. It was also removed: it cannot
attach while **DevTools is open** — which is exactly how a cookie gets cleared by hand — and when it
failed it said so only on a console nobody was reading. The `declarativeNetRequest` approach below
needs no attach, no permission prompt worth worrying about, and no policy.

### Attaching the session to the panel's API calls

The control panel authenticates with **`Authorization: Bearer <token>`** — its repositories call
`sendHttpRequest({ auth: this.token })`. That is why re-planting the cookie alone does nothing: the
panel goes on sending whatever token it already had, every call 401s, and *that* is what makes it
reload itself. Cookie state is irrelevant to those calls.

So a `declarativeNetRequest` rule substitutes the header on the way out:

```js
{ id, priority: 1, action: { type: 'modifyHeaders', requestHeaders: [
    { header: 'authorization', operation: 'set', value: `Bearer ${jwt}` } ] },
  condition: { urlFilter: `||${host}/api/`, resourceTypes: ['xmlhttprequest'] } }
```

Plus a higher-priority `allow` rule for `||{host}/api/login/`, so the sign-in calls are never handed
a stale bearer. The rule is republished whenever a session is established or renewed, and dropped on
install/startup (dynamic rules outlive the service worker, the bookkeeping that owns them does not).

Only `/api/` XHRs are touched. Navigations are never paused, held, or rewritten — that was tried and
removed, because it was the one change capable of making Chrome or the server respond unexpectedly.

**Two earlier attempts, both dead ends worth recording:**

- *Policy-installed extension for `webRequestBlocking`* — Chrome refuses off-store force-install on
  a machine that is not MDM-enrolled.
- *`chrome.debugger` + CDP `Fetch`* — cannot attach while **DevTools is open**, which is exactly how
  a cookie gets cleared by hand, and it failed silently. DNR needs no attach, shows no infobar, and
  works whether or not DevTools is running.

### Activity log

The worker keeps a rolling log of what it decided and why — `cookie-removed`, `sign-in ->
ok`/`-> bad-credentials`/`-> api-error`, `header-rule -> Authorization attached to …`, and `401`.

It exists because "it still reloads" was being diagnosed by guesswork across several rounds. That log
is what finally showed the truth: dozens of `/api/` calls returning 401 with **no interception
happening at all** — the panel reloading itself in reaction to them, not the extension reloading
anything. Capped at 40 entries in `chrome.storage.local`; it never influences behaviour.

The popup no longer renders the log — **Export activity** in the popup footer writes it to
`comm100-auto-login-activity.json` instead.

### Route host mapping

```
livechat6dash.testing.comm100dev.io  ->  livechat6route.testing.comm100dev.io
*.comm100.io                         ->  route.comm100.io
any other listed dashboard           ->  itself (staging; localhost routing is CLI-only)
anything else                        ->  not supported, nothing happens
```

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. **Load unpacked** → select this folder.
4. Reload any already-open Comm100 tab once so the content script is injected.
5. After pulling a change to `host_permissions` or `content_scripts`, hit **Reload** on the extension
   card there as well — the service worker keeps the old manifest until you do.

The extension itself has no build step and no runtime dependencies: load the folder unpacked and it
works. The one generated file is the popup's stylesheet — see **Styling** below.

### Styling

The popup is styled with Tailwind. Tailwind's browser build (the `cdn.jsdelivr.net` `<script>` from
the Tailwind docs) **cannot** be used here: an MV3 extension page is served with `script-src 'self'`
and Chrome rejects remote script origins, so the CDN script would be blocked and the popup would
render unstyled. The stylesheet is therefore compiled at development time and committed:

```
npm install
npm run build:css     # src/popup/tailwind.input.css -> src/popup/tailwind.css
npm run watch:css     # same, rebuilding on change
```

`tailwind.css` is a static file the popup links directly, so nothing about this is needed to *use* the
extension — only to change its styling. Class names are read out of `src/popup/popup.html` and
`src/popup/popup.js` (see the `@source` lines), so a class the script builds at runtime must appear
literally in one of those files, or Tailwind will never generate it.

### Icons

`src/icons/icon.png` is the source artwork; the three sizes the manifest references are rendered from
it and committed:

```
pip install pillow
python3 tools/make-icons.py                  # -> src/icons/icon16.png, icon48.png, icon128.png
python3 tools/make-icons.py --keep-background
```

The render is a single LANCZOS pass over the square source — no cropping, no staged downscale, because
LANCZOS already scales its kernel to the reduction ratio.

A toolbar icon needs a transparent surround, and exports sometimes come out flattened onto an opaque
near-white page instead. So when the source is fully opaque the script locates the rounded tile drawn
in the artwork and knocks out everything outside it; when the source already has alpha it is used
exactly as drawn and nothing is inferred. `--keep-background` opts out for artwork that is genuinely a
full square.

Two caveats on that knockout, since it is a reconstruction rather than something read from the file:

- it clips the tile's soft drop shadow along with the page, and assumes all four corners share one
  radius, inferred from where the outline stops curving;
- the edge threshold (`EDGE_THRESHOLD` in the script) is tuned to this artwork — the faintest run of
  the tile outline reads ~22 against the page while the shadow just outside reaches ~16, so there is
  not much room. If a future export has a softer edge, check the result on a dark background before
  trusting it.

At 16 px the three elements (C, figure, padlock) are near the limit of what that size can carry
regardless; a simplified small variant would be a change to the artwork, not to this script.

## Use

There is no "sign in automatically" switch. Signing in *is* the extension, so the off switch is
disabling the extension in `chrome://extensions`. A deliberate sign-out suppresses sign-in for
5 minutes and shows a **Re-enable auto-login** button. Failed sign-ins leave the login form available
and retry automatically after the cooldown; they never require manual re-enabling. Permanent pause
flags saved by older versions are ignored and removed by the next normal storage write.

- **Login now** (per account) — signs in with that credential and opens
  `https://{dashboard}/ui/{siteId}/entry/?fromlogin=1` — the panel's own post-sign-in path, which then
  hands off to the site's landing page — in a **new tab**. The current tab is left alone: it is
  usually the `/login` page (or another site's dashboard) that prompted the click, and taking it away
  loses that context. The site is the one the route service gives for that email, so the button is
  unaffected by which site the current URL happens to name. If the sign-in fails, no tab is opened
  and the reason is shown in the popup's status line instead.
- **Open a Comm100 dashboard** — you are signed in before the page needs the session.
- **Show / Edit / Delete** per account. The account list is ordered by dashboard, then site id, then
  email — the same order `comm100-accounts list` prints, so the newest sign-in no longer reshuffles
  it — and each row shows the dashboard it belongs to and the site id it resolved to.
- **Edit** turns the row into its address and password fields, and *Save & verify* calls the login API
  so a replacement password is only trusted once it is proven — a typo is caught immediately rather
  than at the next sign-in. There is no dashboard or site field: an account is identified by
  (address, dashboard), so signing in on another dashboard records that credential on its own, and the
  site is always the route service's answer.
- **Dashboard / site filters** above the account list. Once more than a handful of credentials are
  saved, the question is usually "which of these is the one for site 10010 on livechat6dash?", and
  the two selects answer it without reading every row. The site choices follow the dashboard choice
  (a site id only means something inside one dashboard), `any dashboard` / `any site` are filterable
  values for credentials that have not been scoped yet, and anything the filters hide is stated as
  `showing N of M` rather than left to look like an empty list. The filters live in the popup's
  memory only: reopening the popup always shows every account again.
- **Export / Import** — the whole saved state, or **Export activity** for just the worker's rolling
  log (`comm100-auto-login-activity.json`), which the popup itself no longer renders.

There is deliberately no **Add account** form. A credential is recorded by *using* it: sign in through
the panel's own form (for example when a second factor is required) and the typed credentials are
recorded **against the dashboard you are on**. They are stored as *pending* and promoted to a trusted
password as soon as something proves they work — a live session, or a later successful sign-in.
**Capture never calls the login API**, precisely so it cannot burn sign-in attempts (see *Lockout
safety*). *Edit* is the way back to a credential that was recorded wrong; *Import* is the way to
restore a saved set.

## How logout really works

Removing the cookies **is** the logout. The control panel decides whether it is signed in purely by
looking for `token_{siteId}`, so once the cookies are gone the next navigation lands on `/login`.

`POST /api/login/accounts/logout` exists, but it belongs to the login service and rejects a
JWT-cookie session with `401 AuthenticationFailed` — verified against a live session, with and
without `Origin`/`Referer` headers. The extension therefore attempts it best-effort and **never
depends on it**; cookie removal is what does the work.

One consequence worth knowing: the JWT itself stays valid until its `exp` claim (roughly 2 hours)
even after sign-out, so this is a client-side sign-out, not server-side revocation.

## Lockout safety

Comm100 locks an account once failed sign-ins exceed the site's password policy, and per
[Comm100's own troubleshooting article](https://help.comm100.com/why-am-i-receiving-account-locked-error-message-when-i-login)
the lock clears after **30 minutes** or when a site administrator unlocks it. The lockout arrives as
`errorCode 114`, not a wrong-password error.

Because of that the extension is deliberately conservative:

- a **60 s** cooldown after a failed attempt, including attempts triggered by outgoing requests;
- **form capture does not verify** — the user has just spent one sign-in attempt, and duplicating
  every attempt would halve the budget;
- `errorCode 114` is reported as-is rather than retried.

There is no failure threshold that disables auto-login. The cooldown expires automatically. An
explicit popup action can retry sooner; deliberate sign-out suppression remains independent.

## Testing

`test/harness.mjs` stubs the `chrome.*` APIs the extension uses and exercises the real modules.
Failure paths (bad password, MFA) are answered by a fetch stub so they can never lock a real
account; the happy path talks to the real API when credentials are supplied.

```bash
# offline: pure logic, no credentials, no network
node test/harness.mjs

# full run including a live background sign-in
C100_EMAIL='you@example.com' C100_PASSWORD='…' node test/harness.mjs
```

It asserts the planted cookie's exact shape (name, domain, `HttpOnly`, `Secure`, `SameSite`,
session-vs-persistent), the already-signed-in short-circuit, failure accounting, the MFA handoff,
cooldown/logout suppression, recency selection, the dashboard list itself (every entry parses to a
unique scope, WAN and LAN variants of one name stay distinct), that credentials never cross
dashboards, that a legacy record is pinned to the right one, that a site a credential does not own is
refused without spending a sign-in attempt, that a live session is recognised *before* any such
check, and that "nothing to do" outcomes stay out of the activity log. No credentials are stored in
the file.

## Behaviour details

- Auto-login backs off for 60 s after a failed attempt per host, then becomes eligible automatically.
  There is no permanent pause after repeated failures. An explicit popup action may retry sooner.
- A dashboard with no saved account, or an account that has none for the site the URL names, is
  reported as such — the popup says which dashboard and site it *does* have, and the sign-in page is
  left alone for you. Suspicious silences are shown in the popup, not just logged.
- Repeated 401s cannot re-sign-in without bound: at most 3 in a rolling minute per dashboard, and the
  cap is not reset by its own successes (a loop where every sign-in "works" is the one that needs
  bounding).
- Two-factor / forced-2FA accounts cannot be completed headlessly. The extension detects this,
  does **not** count it as a credential failure, and leaves manual sign-in available.
- Auto-login stays out of the way on `/login/forgotpassword`, `/login/sso`, and reset/2FA links.

## Security

Passwords are stored **unencrypted** in `chrome.storage.local` — local to this browser profile,
never synced, and erasable with **Clear all data**. This is the same trust model as Chrome's own
password manager storing them on disk. The only network requests the extension makes are the three
endpoints above plus the logout call, all over HTTPS to the Comm100 host you are already visiting.

## Troubleshooting

| Symptom | Check |
|---|---|
| Nothing happens | The host must map to a route host (see above). Check the service worker console. |
| "no-route" | The email is unknown to the route service for that branch. |
| "No saved account for &lt;dashboard&gt;" | The credential is saved under a different dashboard, or its picker entry was never set. Edit the account and pick the right dashboard. |
| "No saved credential for site N on …" | Something is saved for that dashboard, but for a different site. The route service says which site this address uses here; sign in by hand for the other one and it will be remembered. |
| "… has X on site N, not site M" | The URL asks for a site this credential does not belong to — typically a site id copied from another branch. Open the site's own URL, or sign in by hand with the account that owns it. |
| Account exists but is never used | It is scoped to another dashboard on purpose. A dashboard never borrows another's credential. |
| Session not stored | `chrome://settings/cookies` → the `comm100dev.io` cookies `token_*`, `tokenExpire_*`, `siteList`. |
| `errorCode 114` | Account locked by password policy — wait 30 minutes or ask a site admin. |
| Signed out unexpectedly | Another tab or the app itself called logout; auto-login is suppressed for 5 minutes. |
| Service worker logs | `chrome://extensions` → Details → *Inspect views: service worker*. Logs are prefixed `[Comm100 Auto Login]`. |

## Layout

```
manifest.json
package.json             dev-only: the Tailwind build script
src/shared/api.js        login API + host / route mapping
src/shared/platforms.js  the dashboard list credentials are scoped to
src/shared/cookies.js    session cookie read / plant / clear
src/shared/storage.js    chrome.storage.local schema + account lifecycle
src/background/service-worker.js
src/content/content.js   dashboard authentication bridge and manual credential capture
src/popup/popup.html     account manager UI
src/popup/popup.js
src/popup/tailwind.input.css  Tailwind source (not loaded by the extension)
src/popup/tailwind.css        built stylesheet (the one the popup links)
src/icons/icon.png            source artwork for the toolbar icons
src/icons/icon{16,48,128}.png rendered from it by tools/make-icons.py
tools/make-icons.py      renders the icon sizes (dev-only, needs Pillow)
test/harness.mjs         headless verification
```

## Verification status

Steps 1–3, every cookie flag, and the already-signed-in short-circuit were executed against the
live test environment, as were the `errorCode 100/101/114` failure shapes and the `logout` 401. The
harness additionally proved the planted cookies are genuinely accepted: an authenticated endpoint
(`/api/global/siteActivity:active`) returns `401` without them and gets past authentication with
them.

End-to-end in Chrome was confirmed too: with `voiceagenttest@comm100.com` saved for
`livechat3dash.testing.comm100dev.io`, deleting the session cookie and reloading a
`/login/?retUrl=…%2Fui%2F10008%2Fentry%2F` page landed on the Live Chat dashboard for site 10008
with no manual interaction, the popup reported `Signed in (token_10008, …)`, and the account's use
count incremented — a real background sign-in, not a lucky existing session.

The `*.comm100.io` production route host is inferred from the same login bundle and was checked for
reachability only, so if it behaves differently the extension falls back to doing nothing rather
than guessing.

Per-dashboard credential scoping was verified against the real browser, not just the harness: the two
accounts already saved in Chrome (`voiceagenttest@comm100.com`, `jackapi@livechat6.com`) were written
before accounts had a dashboard, and both were pinned to the right one by the `hosts[0]` rule and
picked up their site ids (`10008`, `10010`) from the route cache — visible in the popup with no
re-entry.

The loop itself was diagnosed from the activity log of a real occurrence, not from theory:
`/ui/10012/ai/dashboard/` on `livechat6dash` (site 10012 belongs to a different agent there) produced
`401` → `sign-in -> ok` → `header-rule` → `401` on repeat, because the extension was signing in for
the site *in the URL* and the panel rejected every call made with that token. `getByEmail` confirms
the account has exactly one site there (`10010`), which is what the fixed code checks before it
attempts anything. The staging dashboard's self-routing has **not** been exercised. Localhost entries
remain in the account metadata for CLI use; the extension does not monitor them.
