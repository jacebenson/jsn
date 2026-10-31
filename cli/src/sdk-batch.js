// Optional, read-only ServiceNow Batch REST transport. No ordinary SDK call is
// routed here implicitly; writes are deliberately outside this initial contract.
import { randomUUID } from 'node:crypto';
import { AppError, errAPI, errUsage } from './errors.js';

const UNSUPPORTED = new Set([404, 405, 501]);
function malformed(message) { return new AppError('malformed_response', `Invalid Batch API response: ${message}`); }
function errorData(error) {
  return { code: error.code || 'network_error', message: error.message, ...(error.status ? { status: error.status } : {}) };
}
function normalizeRequests(sdk, requests) {
  if (!Array.isArray(requests)) throw errUsage('Batch requests must be an array.');
  const ids = new Set();
  return requests.map((item, index) => {
    if (!item || typeof item !== 'object') throw errUsage('Each batch request must be an object.');
    const id = item.id == null ? String(index + 1) : String(item.id);
    if (!id || ids.has(id)) throw errUsage('Batch request IDs must be nonempty and unique.');
    ids.add(id);
    if (String(item.method || 'GET').toUpperCase() !== 'GET' || item.body !== undefined) {
      throw errUsage('SDK batch supports GET reads only; send writes through ordinary SDK methods with their existing safety and history contracts.');
    }
    if (typeof item.url !== 'string' || !item.url.trim()) throw errUsage('Each batch request needs a same-instance API URL.');
    let url;
    try { url = new URL(item.url, `${sdk.baseURL}/`); } catch { throw errUsage('Invalid batch API URL.'); }
    if (url.origin !== new URL(sdk.baseURL).origin || url.username || url.password || url.hash
      || !url.pathname.startsWith('/api/') || /\/batch\/?$/.test(url.pathname)) {
      throw errUsage('Batch URLs must target a same-instance API endpoint; nested batches, credentials, and fragments are unsupported.');
    }
    const headers = new Headers(item.headers || {});
    for (const name of headers.keys()) {
      if (/^(authorization|cookie|x-usertoken|host|proxy-authorization)$/i.test(name)) throw errUsage('Batch subrequests cannot override authentication headers.');
    }
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');
    if (sdk.domain) headers.set('X-Now-Domain', sdk.domain);
    return { id, method: 'GET', url: url.pathname + url.search, headers: [...headers].map(([name, value]) => ({ name, value })), exclude_response_headers: true };
  });
}
function decodeBody(body) {
  if (body == null || body === '') return null;
  if (typeof body !== 'string') throw malformed('item body must be base64 text');
  const encoded = body.replace(/\s/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw malformed('item body is not valid base64');
  const text = Buffer.from(encoded, 'base64').toString('utf8');
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}
function parseBatch(response, requests, batchId) {
  // ServiceNow's endpoint returns these arrays directly, not in a Table API
  // result wrapper. Missing/duplicated correlations are never inferred by order.
  if (!response || response.batch_request_id !== batchId || !Array.isArray(response.serviced_requests) || !Array.isArray(response.unserviced_requests)) {
    throw malformed('expected matching batch_request_id and serviced/unserviced arrays');
  }
  const expected = new Set(requests.map(item => item.id));
  const mapped = new Map();
  for (const id of response.unserviced_requests) {
    if (typeof id !== 'string' || !expected.has(id) || mapped.has(id)) throw malformed('unknown or duplicate unserviced ID');
    mapped.set(id, { id, ok: false, serviced: false, status: null, data: null,
      error: { code: 'batch_unserviced', message: 'The batch processing limit left this request unserviced; it was not retried.' } });
  }
  for (const item of response.serviced_requests) {
    if (!item || !expected.has(item.id) || mapped.has(item.id)) throw malformed('unknown or duplicate serviced ID');
    const status = item.status_code;
    if (!Number.isInteger(status) || status < 100 || status > 599) throw malformed('invalid item HTTP status');
    const ok = status >= 200 && status < 300;
    let data;
    try { data = decodeBody(item.body); } catch (error) {
      mapped.set(item.id, { id: item.id, ok: false, serviced: true, status, data: null, error: errorData(error) });
      continue;
    }
    const error = ok ? null : errorData(errAPI(status, typeof data === 'string' ? data : JSON.stringify(data || { error: item.error_message || item.status_text || 'Request failed' })));
    mapped.set(item.id, { id: item.id, ok, serviced: true, status, data, error });
  }
  return requests.map(({ id }) => mapped.get(id) || { id, ok: false, serviced: null, status: null, data: null,
    error: { code: 'batch_missing_response', message: 'No correlated response was returned; execution is unknown and was not retried.' } });
}
async function individual(sdk, request, timeout) {
  try {
    return await sdk._withAuthenticatedRequest(`${sdk.baseURL}${request.url}`, {
      method: 'GET', headers: Object.fromEntries(request.headers.map(({ name, value }) => [name, value])),
    }, { timeout, normalizeErrors: true }, async response => {
      const text = await response.text();
      let data = text || null;
      if (text) { try { data = JSON.parse(text); } catch { /* Non-JSON REST reads remain text. */ } }
      return { id: request.id, ok: response.ok, serviced: true, status: response.status, data,
        error: response.ok ? null : errorData(errAPI(response.status, text)) };
    });
  } catch (error) {
    return { id: request.id, ok: false, serviced: null, status: error.status || null, data: null, error: errorData(error) };
  }
}

/**
 * @param {SDKClient} sdk authenticated SDK instance
 * @param {Array<{id?: string, method?: 'GET', url: string, headers?: object}>} requests
 * @param {{fallback?: boolean, chunkSize?: number, timeout?: number}} options
 */
export async function batchRead(sdk, requests, { fallback = true, chunkSize = 50, timeout = sdk.timeout } = {}) {
  if (typeof fallback !== 'boolean') throw errUsage('Batch fallback must be a boolean.');
  const normalized = normalizeRequests(sdk, requests);
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 1000) throw errUsage('Batch chunkSize must be an integer from 1 to 1000.');
  const results = [], transports = new Set();
  for (let offset = 0; offset < normalized.length; offset += chunkSize) {
    const chunk = normalized.slice(offset, offset + chunkSize);
    let useIndividual = fallback && sdk._batchUnsupported === true;
    if (!useIndividual) {
      const batchId = randomUUID();
      try {
        const response = await sdk.request(`${sdk.baseURL}/api/now/v1/batch`, {
          method: 'POST', timeout, touchLastSeen: false,
          body: JSON.stringify({ batch_request_id: batchId, rest_requests: chunk }),
        });
        results.push(...parseBatch(response, chunk, batchId));
        transports.add('batch');
      } catch (error) {
        // Only explicit endpoint absence permits fallback. ACL/auth, rate limits,
        // malformed responses and uncertain transport failures must not replay.
        if (!fallback || !UNSUPPORTED.has(error.status)) throw error;
        sdk._batchUnsupported = true;
        useIndividual = true;
      }
    }
    if (useIndividual) {
      transports.add('individual');
      for (const request of chunk) results.push(await individual(sdk, request, timeout));
    }
  }
  const successful = results.filter(item => item.ok).length;
  return { transport: transports.size > 1 ? 'mixed' : [...transports][0] || 'none',
    results, counts: { total: results.length, successful, failed: results.length - successful } };
}
