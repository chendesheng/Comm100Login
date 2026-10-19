/** Rendering of one stored exchange for the terminal. The rows keep raw headers and bodies. */

import { agentIdFromToken } from '../shared/cookies.js';

const REASONS = new Map([
  [200, 'OK'], [201, 'Created'], [202, 'Accepted'], [204, 'No Content'],
  [301, 'Moved Permanently'], [302, 'Found'], [303, 'See Other'], [304, 'Not Modified'],
  [307, 'Temporary Redirect'], [308, 'Permanent Redirect'],
  [400, 'Bad Request'], [401, 'Unauthorized'], [402, 'Payment Required'], [403, 'Forbidden'],
  [404, 'Not Found'], [405, 'Method Not Allowed'], [406, 'Not Acceptable'], [408, 'Request Timeout'],
  [409, 'Conflict'], [410, 'Gone'], [411, 'Length Required'], [413, 'Payload Too Large'],
  [414, 'URI Too Long'], [415, 'Unsupported Media Type'], [418, "I'm a teapot"],
  [422, 'Unprocessable Content'], [429, 'Too Many Requests'],
  [500, 'Internal Server Error'], [501, 'Not Implemented'], [502, 'Bad Gateway'],
  [503, 'Service Unavailable'], [504, 'Gateway Timeout']
]);

const headers = (value) => (Array.isArray(value) ? value : []);
const headerLine = ([name, text]) => `${name}: ${text}`;
const RESET = '\x1b[0m';

/** The protocol's skeleton is colored; header values and bodies stay exactly as recorded. */
const STYLE = {
  method: '\x1b[1;34m',
  version: '\x1b[2m',
  header: '\x1b[36m',
  ok: '\x1b[32m',
  redirect: '\x1b[36m',
  client: '\x1b[33m',
  server: '\x1b[31m',
  none: '\x1b[2m'
};

function statusStyle(statusCode) {
  if (!statusCode) return STYLE.none;
  if (statusCode < 300) return STYLE.ok;
  if (statusCode < 400) return STYLE.redirect;
  if (statusCode < 500) return STYLE.client;
  return STYLE.server;
}

/**
 * Color is for a terminal only: piped output, `NO_COLOR`, and dumb terminals stay plain, and
 * `FORCE_COLOR` overrides the terminal check for a file or a pager.
 */
export function wantsColor(stream, env = process.env) {
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0';
  if (env.NO_COLOR) return false;
  return Boolean(stream?.isTTY) && env.TERM !== 'dumb';
}

/** A stored `0` means the request never produced a response, so there is no status to name. */
function statusLine(statusCode) {
  if (!statusCode) return '0 (no response)';
  const reason = REASONS.get(statusCode);
  return reason ? `${statusCode} ${reason}` : String(statusCode);
}

/** Single-quoted shell word; an embedded quote is closed, escaped and reopened. */
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

// curl derives these from the URL and body, cookies are never recorded, and the session cookie
// already authenticates the call, so the recorded bearer would only duplicate it with a stale token.
const CURL_OMITS = new Set(['host', 'content-length', 'connection', 'cookie', 'authorization']);

/** The identifier the replay logs in with: the agent id stamped into the recorded token, else a placeholder. */
function loginIdentifier(trace) {
  const authorization = headers(trace.requestHeaders)
    .find(([name]) => String(name).toLowerCase() === 'authorization');
  const token = authorization ? String(authorization[1]).replace(/^Bearer\s+/i, '') : '';
  return agentIdFromToken(token) || '<email>';
}

/** One login invocation per trace: the site id narrows the account the CLI has to pick. */
function loginCommand(trace) {
  const siteId = new URL(trace.url).searchParams.get('siteId') || '';
  return `comm100-accounts login ${loginIdentifier(trace)}${/^[\w.-]+$/.test(siteId) ? ` --siteId=${siteId}` : ''}`;
}

/**
 * The same exchange as a curl command that replays it. `-sS` keeps the progress meter out of the
 * output while still reporting errors. Recorded credentials are stale by the time they are read, so
 * the cookies come from `comm100-accounts login` at replay time; that session is enough on its own,
 * so the recorded bearer is dropped rather than also refreshed.
 */
export function formatCurlTrace(trace) {
  const parts = [`curl -sS -X ${trace.method}`, shellQuote(trace.url)];
  for (const [name, value] of headers(trace.requestHeaders)) {
    if (CURL_OMITS.has(String(name).toLowerCase())) continue;
    parts.push(`-H ${shellQuote(headerLine([name, value]))}`);
  }
  parts.push(`-b "$(${loginCommand(trace)} --cookie)"`);
  if (trace.requestBody) parts.push(`--data-raw "$(comm100-accounts traces ${trace.id} --req-body)"`);
  return parts
    .map((part, index) => `${index ? '  ' : ''}${part}${index === parts.length - 1 ? '' : ' \\'}`)
    .join('\n') + '\n';
}

/**
 * One exchange as it would look on the wire: request line, request headers, request body, then the
 * response status line, response headers and response body. Sections are separated by a blank line.
 */
export function formatHttpTrace(trace, { color = false } = {}) {
  const paint = (style, text) => (color ? `${style}${text}${RESET}` : text);
  const lines = (list, drop) => headers(list)
    .filter(([name]) => !drop.includes(String(name).toLowerCase()))
    .map(([name, value]) => `${paint(STYLE.header, name)}: ${value}`);
  const url = new URL(trace.url);
  const requestLine = [
    paint(STYLE.method, trace.method),
    `${url.pathname}${url.search}`,
    paint(STYLE.version, 'HTTP/1.1')
  ].join(' ');
  // `Host` is not recorded (browsers forbid setting it), so it is rebuilt from the URL instead.
  const requestHead = [
    requestLine,
    `${paint(STYLE.header, 'Host')}: ${url.host}`,
    ...lines(trace.requestHeaders, ['host'])
  ].join('\n');
  const responseHead = [
    `${paint(STYLE.version, 'HTTP/1.1')} ${paint(statusStyle(trace.statusCode), statusLine(trace.statusCode))}`,
    ...lines(trace.responseHeaders, [])
  ].join('\n');
  const sections = [requestHead];
  if (trace.requestBody) sections.push(trace.requestBody);
  sections.push(responseHead);
  if (trace.responseBody) sections.push(trace.responseBody);
  return sections.join('\n\n') + '\n';
}
