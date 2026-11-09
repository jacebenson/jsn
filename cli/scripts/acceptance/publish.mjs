// Publish only the closed public projection produced by the acceptance runner.
// The token is read from the environment and is never accepted as an argument.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// The site owns the closed scenario allowlist. When it is present in this
// checkout, enforce it locally too; the server remains authoritative.
const SCENARIO_IDS = (() => {
  try {
    return new Set(fs.readFileSync(path.join(ROOT, 'site/config/acceptance_scenario_ids.txt'), 'utf8').split('\n').filter(Boolean));
  } catch {
    return null;
  }
})();

const STATUS = new Set(['passed', 'failed', 'failed-timeout', 'blocked-prerequisite', 'blocked-access', 'blocked-capability', 'excluded-mode', 'not-run']);
const COVERAGE = new Set(['not-run', 'failed', 'blocked', 'passed', 'complete', 'incomplete']);
const COLLECTORS = new Set(['platform_health', 'transactions', 'error_warning_summary', 'event_queue', 'ecc_queue', 'flow_executions', 'record_counts', 'scheduled_and_cleanup']);
const COLLECTOR_STATUS = new Set(['success', 'timeout', 'permission_denied', 'unsupported', 'unavailable', 'query_failure']);
const ID = /^(?:local|readonly|resources|workflows|auth)\.[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*){0,5}$/;
const FORBIDDEN_SEGMENTS = new Set(['com', 'net', 'org', 'io', 'dev', 'internal', 'service-now', 'test', 'invalid', 'example', 'localhost']);
const safeId = value => {
  if (typeof value !== 'string' || value.length > 100 || !ID.test(value)) return false;
  if (SCENARIO_IDS && !SCENARIO_IDS.has(value)) return false;
  return value.split('.').every(segment => !FORBIDDEN_SEGMENTS.has(segment) && !/^[a-f0-9]{32}$/i.test(segment) && !/^[a-f0-9]{64}$/i.test(segment));
};
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[a-z0-9]{1,20})?$/;
const NODE = /^v\d+\.\d+\.\d+$/;
const RUN_KEY = /^acceptance_[a-f0-9]{32}$/;
const MAX_BODY = 262144;

const fail = message => { throw new Error(message); };
const exactKeys = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`Unknown ${label} field`);
  for (const key of keys) if (!(key in value)) fail(`Missing ${label} field`);
};
const boundedInt = (value, max, label) => {
  if (!Number.isInteger(value) || value < 0 || value > max) fail(`Invalid ${label}`);
  return value;
};
const boundedNumber = (value, max, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) fail(`Invalid ${label}`);
  return value;
};

function capture(value) {
  if (value === null) return null;
  exactKeys(value, ['status', 'collectors'], 'performance capture');
  if (!['complete', 'incomplete'].includes(value.status)) fail('Invalid performance capture status');
  if (!Array.isArray(value.collectors) || value.collectors.length > COLLECTORS.size) fail('Invalid performance collectors');
  const seen = new Set();
  for (const collector of value.collectors) {
    exactKeys(collector, ['name', 'status'], 'performance collector');
    if (!COLLECTORS.has(collector.name) || seen.has(collector.name)) fail('Invalid performance collector name');
    if (!COLLECTOR_STATUS.has(collector.status)) fail('Invalid performance collector status');
    seen.add(collector.name);
  }
  return value;
}

function performance(value) {
  if (value === null) return null;
  exactKeys(value, ['observational', 'releaseGate', 'coverage', 'before', 'after', 'environment'], 'performance');
  if (value.observational !== true || value.releaseGate !== false) fail('Invalid performance flags');
  exactKeys(value.coverage, ['before', 'after', 'compare', 'list'], 'performance coverage');
  for (const key of ['before', 'after', 'compare', 'list']) if (!COVERAGE.has(value.coverage[key])) fail('Invalid performance coverage');
  capture(value.before); capture(value.after);
  exactKeys(value.environment, ['platform', 'domainSeparation', 'domainTable', 'domainSource', 'effectiveAuth', 'effectiveRoles', 'effectiveDomain'], 'performance environment');
  if (!['linux', 'untested'].includes(value.environment.platform)) fail('Invalid performance platform');
  if (!['not-installed', 'unknown'].includes(value.environment.domainSeparation)) fail('Invalid domain separation');
  if (!['readable', 'absent', 'unknown'].includes(value.environment.domainTable)) fail('Invalid domain table');
  if (value.environment.domainSource !== 'bounded Table API domain read via selected profile') fail('Invalid domain source');
  for (const key of ['effectiveAuth', 'effectiveRoles', 'effectiveDomain']) if (value.environment[key] !== 'unknown') fail('Invalid effective identity field');
  return value;
}

export function validateProjection(payload) {
  exactKeys(payload, ['schemaVersion', 'runKey', 'mode', 'provenance', 'platform', 'environment', 'selection', 'summary', 'performance', 'results'], 'projection');
  if (payload.schemaVersion !== 1) fail('Unsupported schema version');
  if (!RUN_KEY.test(payload.runKey || '')) fail('Invalid run key');
  if (!['readonly', 'pdi'].includes(payload.mode)) fail('Invalid mode');
  exactKeys(payload.provenance, ['sourceSHA', 'version', 'node', 'binarySHA256', 'sourceDirty'], 'provenance');
  if (!HEX40.test(payload.provenance.sourceSHA || '')) fail('Invalid source revision');
  if (!VERSION.test(payload.provenance.version || '')) fail('Invalid CLI version');
  if (!NODE.test(payload.provenance.node || '')) fail('Invalid node version');
  if (!HEX64.test(payload.provenance.binarySHA256 || '')) fail('Invalid binary digest');
  if (typeof payload.provenance.sourceDirty !== 'boolean') fail('Invalid dirty flag');
  if (payload.platform !== 'linux') fail('Invalid platform');
  exactKeys(payload.environment, ['domainSeparation'], 'environment');
  if (!['UNKNOWN', 'KNOWN', 'NOT-INSTALLED'].includes(payload.environment.domainSeparation)) fail('Invalid environment');
  exactKeys(payload.selection, ['full', 'selected'], 'selection');
  if (typeof payload.selection.full !== 'boolean' || !Array.isArray(payload.selection.selected) || payload.selection.selected.length > 5000) fail('Invalid selection');
  const selected = new Set();
  for (const id of payload.selection.selected) {
    if (!safeId(id) || selected.has(id)) fail('Invalid selected scenario');
    selected.add(id);
  }
  exactKeys(payload.summary, ['total', 'counts', 'complete', 'missingCount'], 'summary');
  boundedInt(payload.summary.total, 5000, 'total');
  boundedInt(payload.summary.missingCount, 1000000, 'missing count');
  if (typeof payload.summary.complete !== 'boolean') fail('Invalid complete flag');
  if (!payload.summary.counts || typeof payload.summary.counts !== 'object' || Array.isArray(payload.summary.counts)) fail('Invalid summary counts');
  for (const [status, count] of Object.entries(payload.summary.counts)) if (!STATUS.has(status) || !Number.isInteger(count) || count < 0) fail('Invalid summary count');
  performance(payload.performance);
  if (!Array.isArray(payload.results) || payload.results.length < 1 || payload.results.length > 5000) fail('Invalid results');
  const ids = new Set(), counts = {};
  for (const result of payload.results) {
    exactKeys(result, ['id', 'status', 'durationMs'], 'result');
    if (!safeId(result.id) || ids.has(result.id)) fail('Invalid result id');
    if (!STATUS.has(result.status)) fail('Invalid result status');
    boundedNumber(result.durationMs, 86400000, 'duration');
    ids.add(result.id);
    counts[result.status] = (counts[result.status] || 0) + 1;
  }
  if (payload.summary.total !== payload.results.length) fail('Total does not match results');
  for (const [status, count] of Object.entries(payload.summary.counts)) {
    if (!STATUS.has(status) || !Number.isInteger(count) || count < 0 || (counts[status] || 0) !== count) fail('Counts do not match results');
  }
  for (const [status, count] of Object.entries(counts)) if ((payload.summary.counts[status] || 0) !== count) fail('Counts omit observed results');
  const complete = payload.summary.missingCount === 0 && payload.results.every(result => result.status === 'passed');
  if (payload.summary.complete !== complete) fail('Complete flag does not match results');
  return payload;
}

function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { fail('Invalid publish URL'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash) fail('Publish URL must not carry credentials, query or fragment');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) fail('HTTPS required outside loopback');
  return url;
}

export async function publishResults({ file, url, token, fetchImpl = fetch }) {
  if (typeof token !== 'string' || token.length < 32) fail('Ingest token missing');
  const target = endpoint(url);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('Projection must be a regular file');
  if (stat.size > MAX_BODY) fail('Projection exceeds the payload bound');
  let payload;
  try { payload = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('Projection is not valid JSON'); }
  validateProjection(payload);
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > MAX_BODY) fail('Projection exceeds the payload bound');
  const response = await fetchImpl(target, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body,
  });
  let result = null;
  try { result = await response.json(); } catch { /* fixed labels only */ }
  if (response.status === 201 && result?.status === 'accepted') return { ok: true, httpStatus: 201, result: 'accepted' };
  if (response.status === 200 && result?.status === 'duplicate') return { ok: true, httpStatus: 200, result: 'duplicate' };
  if (response.status === 409) return { ok: false, httpStatus: 409, result: 'conflict' };
  return { ok: false, httpStatus: response.status, result: 'rejected' };
}

export async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!['--file', '--url'].includes(key)) throw new Error('Usage: publish.mjs --file PROJECTION [--url URL]');
    const value = argv[++i];
    if (!value) throw new Error(`Missing value: ${key}`);
    options[key.slice(2)] = value;
  }
  if (!options.file) throw new Error('Usage: publish.mjs --file PROJECTION [--url URL]');
  const url = options.url || process.env.JSN_ACCEPTANCE_INGEST_URL;
  const token = process.env.JSN_ACCEPTANCE_INGEST_TOKEN;
  if (!url) throw new Error('Publish URL required via --url or JSN_ACCEPTANCE_INGEST_URL');
  const outcome = await publishResults({ file: path.resolve(options.file), url, token });
  console.log(JSON.stringify(outcome));
  return outcome.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main().then(code => { process.exitCode = code; }).catch(() => { console.error('Publish refused; projection or endpoint invalid'); process.exitCode = 1; });
}
