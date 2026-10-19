/** Rendering of one stored exchange for the terminal. The rows keep raw headers and bodies. */

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

/** A stored `0` means the request never produced a response, so there is no status to name. */
function statusLine(statusCode) {
  if (!statusCode) return '0 (no response)';
  const reason = REASONS.get(statusCode);
  return reason ? `${statusCode} ${reason}` : String(statusCode);
}

function requestHeaders(trace) {
  // `Host` is not recorded (browsers forbid setting it), so it is rebuilt from the URL instead.
  return headers(trace.requestHeaders)
    .filter(([name]) => String(name).toLowerCase() !== 'host')
    .map(headerLine);
}

/**
 * One exchange as it would look on the wire: request line, request headers, request body, then the
 * response status line, response headers and response body. Sections are separated by a blank line.
 */
export function formatHttpTrace(trace) {
  const url = new URL(trace.url);
  const sections = [
    [`${trace.method} ${url.pathname}${url.search} HTTP/1.1`, `Host: ${url.host}`, ...requestHeaders(trace)].join('\n')
  ];
  if (trace.requestBody) sections.push(trace.requestBody);
  sections.push([`HTTP/1.1 ${statusLine(trace.statusCode)}`, ...headers(trace.responseHeaders).map(headerLine)].join('\n'));
  if (trace.responseBody) sections.push(trace.responseBody);
  return sections.join('\n\n') + '\n';
}
