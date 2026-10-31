// Public documentation service. Deliberately independent of instance credentials.
import { AppError } from '../../errors.js';

export const DEFAULT_DOCS_URL = 'https://jsn.jace.pro';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export function docsServiceUrl(value = process.env.JSN_DOCS_URL || DEFAULT_DOCS_URL) {
  let url;
  try { url = new URL(value); } catch { throw new AppError('usage_error', 'Invalid documentation service URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new AppError('usage_error', 'Documentation service URL must be HTTP(S), without credentials, a query, or a fragment.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') + '/';
  return url.toString();
}
export function configuredDocsService(config = {}) {
  return docsServiceUrl(process.env.JSN_DOCS_URL || config.docs?.url || DEFAULT_DOCS_URL);
}
async function request(endpoint, params, options = {}) {
  const service = docsServiceUrl(options.serviceUrl);
  const url = new URL(endpoint, service);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  let response, data;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    let bytes = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BYTES) throw new AppError('api_error', 'Documentation service response is too large.');
      chunks.push(chunk);
    }
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new AppError('api_error', 'Documentation service did not return JSON.', 'Check JSN_DOCS_URL points to a JSN documentation service.'); }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('network_error', 'Could not reach the documentation service.', `Check your connection and JSN_DOCS_URL (${service}).`, 0, error);
  }
  if (!response.ok) {
    const code = response.status === 404 ? 'not_found' : response.status === 429 ? 'rate_limited' : response.status === 400 ? 'usage_error' : 'api_error';
    const message = typeof data?.error === 'string' ? data.error.slice(0, 300) : `Documentation service returned HTTP ${response.status}.`;
    const hint = response.status === 409 ? 'Search again for the current revision, or retrieve the document by its exact path.'
      : response.status === 429 ? 'Wait before retrying.' : response.status >= 500 ? 'Try again later; the documentation service may be updating or unavailable.' : '';
    throw new AppError(code, message, hint, response.status);
  }
  return { data, service };
}
function invalidResponse() {
  return new AppError('api_error', 'Unexpected documentation service response.', 'Check JSN_DOCS_URL and the documentation service version.');
}
export async function searchHostedDocs(options = {}) {
  const query = String(options.query || '').trim();
  const limit = options.limit ?? 20, offset = options.offset ?? 0;
  if (!query || query.length > 200) throw new AppError('usage_error', 'Search query must contain 1–200 characters.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0 || offset > 10000) {
    throw new AppError('usage_error', 'Use --limit 1–50 and --offset 0–10000.');
  }
  const { data, service } = await request('api/docs/search', { q: query, limit, offset, bundle: options.bundle }, options);
  if (!data || !Array.isArray(data.results) || data.results.length > limit || data.count !== data.results.length ||
      !Number.isInteger(data.total) || data.total < data.count || typeof data.revision !== 'string' ||
      !data.results.every(row => row && Number.isInteger(row.id) && typeof row.path === 'string')) throw invalidResponse();
  return { ...data, query, limit, offset, service };
}
export async function getHostedDoc(idOrPath, options = {}) {
  const identifier = String(idOrPath || '');
  if (!identifier) throw new AppError('usage_error', 'Provide a document ID or exact path.');
  const numeric = /^\d+$/.test(identifier);
  const { data, service } = await request(numeric ? `api/docs/${identifier}` : 'api/docs/document', {
    ...(numeric ? {} : { path: identifier }), revision: options.revision,
  }, options);
  if (!data || !data.document || typeof data.document.body !== 'string' || typeof data.document.path !== 'string' || typeof data.revision !== 'string') throw invalidResponse();
  return { ...data.document, revision: data.revision, service };
}
export async function getHostedDocsStatus(options = {}) {
  const { data, service } = await request('api/docs/status', {}, options);
  if (!data || typeof data.state !== 'string') throw invalidResponse();
  return { ...data, service };
}
