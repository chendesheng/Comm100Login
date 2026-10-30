/**
 * The Comm100 dashboards this extension knows about.
 *
 * Credentials are scoped to a dashboard. Every test branch shares the `comm100dev.io` cookie
 * domain, but they are separate deployments with separate databases: an account that exists on
 * `livechat3dash` usually does not exist on `livechat6dash` (and when it does, it is a different
 * site id entirely). Handing one dashboard's password to another only burns sign-in attempts
 * against the lockout threshold, so `pickAccount()` never crosses a domain.
 *
 * The lists are the ones the web client keeps (`wanTestPlatformsPrefixes`,
 * `lanTestPlatformsPrefixes`, `productionPlatformsPrefixes`) — same names, so they stay greppable
 * and can be diffed against the source of truth.
 */

export const wanTestPlatformsPrefixes = [
  'https://canvasdash.testing.comm100dev.io',
  'https://customreportdash.testing.comm100dev.io',
  'https://global9dash.testing.comm100dev.io',
  'https://gptbotdash.testing.comm100dev.io',
  'https://internal7dash.testing.comm100dev.io',
  'https://livechat3dash.testing.comm100dev.io',
  'https://livechat6dash.testing.comm100dev.io',
  'https://livehelp100dash.testing.comm100dev.io',
  'https://ticketing2dash.testing.comm100dev.io',
  'https://ticketing3dash.testing.comm100dev.io',
  'https://van100dash.testing.comm100dev.io',
  'https://dash11.comm100staging.com'
];

export const lanTestPlatformsPrefixes = [
  'http://localhost:34500',
  'https://canvasdash.comm100dev.io',
  'https://customreportdash.comm100dev.io',
  'https://global9dash.comm100dev.io',
  'https://gptbotdash.comm100dev.io',
  'https://internal7dash.comm100dev.io',
  'https://livechat3dash.comm100dev.io',
  'https://livechat6dash.comm100dev.io',
  'https://livehelp100dash.comm100dev.io',
  'https://ticketing2dash.comm100dev.io',
  'https://ticketing3dash.comm100dev.io',
  'https://van100dash.comm100dev.io'
];

export const productionPlatformsPrefixes = [
  'https://app.livehelp100service.com',
  'https://dash11.comm100.io',
  'https://dash12.comm100.io',
  'https://dash13.comm100.io',
  'https://dash15.comm100.io',
  'https://dash17.comm100.io'
];

/** Groups, exactly as the popup's `<select>` renders them. */
export const PLATFORM_GROUPS = [
  { id: 'wan', label: 'WAN test platforms', prefixes: wanTestPlatformsPrefixes },
  { id: 'lan', label: 'LAN test platforms', prefixes: lanTestPlatformsPrefixes },
  { id: 'production', label: 'Production', prefixes: productionPlatformsPrefixes }
];

/** `https://livechat6dash.testing.comm100dev.io` -> `livechat6dash.testing.comm100dev.io` */
export function domainKeyForPrefix(prefix) {
  try {
    return new URL(prefix).host.toLowerCase();
  } catch {
    return '';
  }
}

/** Host part of a URL, a `host:port`, or a bare hostname — ports and paths removed. */
function hostnameOf(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .split('/')[0]
    .replace(/:\d+$/, '');
}

/**
 * Every known platform, flattened.
 *
 * `domain` is the credential scope key: the host, including a non-default port, so
 * `localhost:34500` and `localhost:3000` are different dashboards.
 */
export function allPlatforms() {
  return PLATFORM_GROUPS.flatMap((group) =>
    group.prefixes.map((prefix) => ({
      group: group.id,
      prefix,
      origin: prefix.replace(/\/+$/, ''),
      domain: domainKeyForPrefix(prefix),
      hostname: hostnameOf(prefix)
    }))
  ).filter((platform) => platform.domain);
}

/** Exact scope match: `livechat3dash.testing.comm100dev.io`. */
export function platformForDomain(domain) {
  const wanted = String(domain || '').trim().toLowerCase().replace(/\/+$/, '');
  if (!wanted) return null;
  return allPlatforms().find((platform) => platform.domain === wanted) || null;
}

/**
 * Match on the hostname alone. Needed wherever only a hostname survives — `webNavigation` gives a
 * URL, but the cookie watchdog and the route cache key on hosts — and it is what carries the
 * scheme, which matters for `http://localhost:34500`.
 */
export function platformForHostname(host) {
  const wanted = hostnameOf(host);
  if (!wanted) return null;
  return allPlatforms().find((platform) => platform.hostname === wanted) || null;
}

/** The credential scope for a hostname, or null when the dashboard is not in the list. */
export function platformDomainFor(host) {
  const platform = platformForHostname(host);
  return platform ? platform.domain : null;
}
