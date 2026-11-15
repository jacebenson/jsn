import { decodeGzipJson } from './sdk.js';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const field = value => String(value && typeof value === 'object' ? value.value ?? '' : value ?? '');
const TABLE = 'sys_hub_flow';

async function secureDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe flow cache directory');
  await fs.chmod(directory, 0o700);
}

async function readCache(file) {
  try {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe flow cache file permissions');
      const cache = JSON.parse(await handle.readFile('utf8'));
      return cache.schema === 1 && Array.isArray(cache.flows) ? cache : null;
    } finally { await handle.close(); }
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeCache(file, data) {
  const temporary = `${file}.${randomUUID()}`;
  try {
    await fs.writeFile(temporary, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

export function formatFlowSearch(report) {
  const { coverage: c, cache } = report;
  return [
    `${report.match_count} matching line(s) in ${report.matching_flows} flow(s)`,
    ...(cache.disabled_reason ? [cache.disabled_reason] : []),
    `Cache ${cache.state}; prior age ${cache.previous_age_seconds === null ? 'n/a' : `${Math.floor(cache.previous_age_seconds)}s`}; ${cache.reused_definitions} decoded definitions reused. Live source access revalidated.`,
    `Visible inventory: provider ${c.provider_count ?? 'unknown'}, inventoried ${c.inventoried}, downloaded ${c.downloaded}, decoded ${c.decoded}. ${c.complete_visible_inventory ? 'Visible inventory accounted for.' : 'PARTIAL/UNKNOWN coverage.'}`,
    c.scope,
    ...report.matches.map(match => `${match.name} [${match.sys_id}] ${match.source} ${match.path}:${match.line}\n  ${match.text}`),
    ...report.failures.map(failure => `FAILED ${failure.stage}: ${failure.name || ''} ${failure.sys_id || ''} ${failure.message}`),
  ].join('\n');
}

export async function searchFlows({ sdk, term, context = {}, refresh = false, cacheRoot, platform = process.platform, pageSize = 100, maxPages = 10000, progress = () => {} }) {
  if (!String(term || '').trim()) throw new Error('A nonempty literal search term is required');
  if (!Number.isInteger(pageSize) || pageSize < 1 || !Number.isInteger(maxPages) || maxPages < 1) throw new Error('Invalid flow pagination bounds');
  const instance = new URL(sdk.baseURL).origin;
  const directory = path.join(cacheRoot || process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'jsn', 'flow-search');
  // Node's Windows mode bits cannot establish a private DACL. Do not touch
  // cache paths (including existing files or reparse points) on that platform.
  const diskCache = platform !== 'win32';
  if (diskCache) await secureDirectory(directory);
  const key = digest({ instance, profile: context.profile || '', username: context.username || '', authMethod: context.authMethod || '', domain: context.domain || '' });
  const file = diskCache ? path.join(directory, `${key}.json`) : null;
  const previous = !diskCache || refresh ? null : await readCache(file);
  const previousById = new Map((previous?.flows || []).map(flow => [flow.sys_id, flow]));
  if (!diskCache) progress('Disk cache disabled on Windows: private ACLs are not verified. Searching freshly downloaded definitions in memory only.');
  if (diskCache) progress(previous ? 'Revalidating flow visibility and source permissions before reusing decoded cache.' : 'Downloading visible flow definitions and decoding a private local cache. First use can be slow; no instance records are changed.');
  const failures = [];
  const get = route => sdk.request(`${instance}${route}`, { method: 'GET' });
  let expected;
  try {
    const response = await get(`/api/now/stats/${TABLE}?sysparm_count=true`);
    const count = response?.result?.stats?.count;
    if (!/^\d+$/.test(String(count))) throw new Error('Missing provider count');
    expected = Number(count);
    if (!Number.isSafeInteger(expected)) throw new Error('Invalid provider count');
  } catch { expected = null; failures.push({ stage: 'inventory_count', message: 'Provider count unavailable; inventory completeness is unknown.' }); }
  const rows = new Map();
  let exhausted = false;
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    try {
      const params = new URLSearchParams({ sysparm_query: 'ORDERBYsys_id', sysparm_fields: 'sys_id,name,type,sys_updated_on', sysparm_display_value: 'false', sysparm_limit: String(pageSize), sysparm_offset: String(offset) });
      const response = await get(`/api/now/table/${TABLE}?${params}`);
      if (!Array.isArray(response?.result)) throw new Error('Missing result array; source is unreadable');
      const batch = response.result;
      if (!batch.length) { exhausted = true; break; }
      for (const row of batch) {
        const id = field(row.sys_id);
        if (!/^[0-9a-f]{32}$/i.test(id) || rows.has(id)) throw new Error('Missing/duplicate flow identity; unstable or ACL-filtered pagination');
        rows.set(id, { sys_id: id, name: field(row.name), type: field(row.type), updated: field(row.sys_updated_on) });
      }
      offset += batch.length;
    } catch (error) {
      failures.push({ stage: 'inventory', message: error.message });
      break;
    }
  }
  if (expected !== null && exhausted && rows.size !== expected) failures.push({ stage: 'inventory', message: `Provider count ${expected} differs from ${rows.size} unique visible flow records; ACL filtering or concurrent changes may hide flows.` });
  if (expected !== null) {
    try {
      const after = await get(`/api/now/stats/${TABLE}?sysparm_count=true`);
      if (String(after?.result?.stats?.count) !== String(expected)) throw new Error('Provider count changed during inventory');
    } catch { failures.push({ stage: 'inventory_count', message: 'Provider count changed or became unreadable during inventory; completeness is unknown.' }); }
  }
  if (!exhausted && !failures.some(f => f.stage === 'inventory')) failures.push({ stage: 'inventory', message: 'Pagination safety limit reached; inventory is partial.' });
  const flows = [];
  let downloaded = 0;
  let reused = 0;
  for (const row of rows.values()) {
    let data;
    try {
      // A fresh source read is deliberately mandatory even on a cache hit. A
      // profile/role fingerprint cannot detect field ACLs, impersonation or a
      // revoked permission. Never release old source on a failed live read.
      const response = await get(`/api/now/processflow/flow/${row.sys_id}`);
      const code = response?.result?.errorCode;
      if (response?.result?.errorMessage || (code != null && code !== '' && String(code) !== '0')) throw new Error('Provider refused the flow definition');
      data = response?.result?.data;
      if (data?.security?.can_read === false || data?.security?.can_read === 'false') throw new Error('403 Flow definition read denied');
      if (!data || typeof data !== 'object') throw new Error('No readable ProcessFlow definition');
      downloaded++;
    } catch (error) {
      failures.push({ ...row, stage: 'download', message: error.status === 403 || /403|forbidden/i.test(error.message) ? 'Access denied reading definition' : 'Definition download failed or unavailable', status: error.status || null });
      continue;
    }
    try {
      const sourceDigest = digest(data);
      const cached = previousById.get(row.sys_id);
      const entries = cached?.source_digest === sourceDigest && Array.isArray(cached.entries) ? cached.entries : decodeFlowSearchDefinition(data);
      const unchanged = entries === cached?.entries;
      if (unchanged) reused++;
      flows.push({ ...row, source: `/api/now/processflow/flow/${row.sys_id}`, source_digest: sourceDigest, decoded_at: unchanged ? cached.decoded_at : new Date().toISOString(), entries });
    } catch (error) { failures.push({ ...row, stage: 'decode', message: error.message }); }
  }
  const captured = new Date().toISOString();
  if (diskCache) await writeCache(file, { schema: 1, captured_at: captured, flows });
  const matches = [];
  const needle = String(term).toLowerCase();
  for (const flow of flows) for (const entry of flow.entries) {
    entry.text.split(/\r?\n/).forEach((text, index) => {
      if (text.toLowerCase().includes(needle)) matches.push({ sys_id: flow.sys_id, name: flow.name, source: flow.source, path: entry.path, line: index + 1, text });
    });
  }
  const complete = exhausted && expected !== null && expected === rows.size && !failures.length;
  return {
    term, match_count: matches.length, matching_flows: new Set(matches.map(match => match.sys_id)).size, matches, failures,
    cache: { state: !diskCache ? 'disabled' : refresh ? 'refreshed' : previous ? 'reused' : 'built', disabled_reason: diskCache ? null : 'Windows private cache ACLs are not verified; live in-memory search only', file, captured_at: captured, previous_age_seconds: previous ? Math.max(0, (Date.now() - Date.parse(previous.captured_at)) / 1000) : null, reused_definitions: reused, live_source_revalidation: true },
    coverage: { provider_count: expected, inventoried: rows.size, downloaded, decoded: flows.length, complete_visible_inventory: complete, scope: 'ACL-visible sys_hub_flow ProcessFlow definitions only. Referenced custom action implementation scripts, inaccessible flows, and fields omitted by provider ACLs are not included. No instance-wide completeness claim.' },
  };
}


// ProcessFlow returns the same definition graph used by flows show. Its values
// fields can contain the platform's base64-gzip JSON, not plain script text.
export function decodeFlowSearchDefinition(data) {
  if (!data || typeof data !== 'object' || !['actionInstances', 'triggerInstances', 'flowLogicInstances', 'subFlowInstances'].some(key => Array.isArray(data[key]))) {
    throw new Error('Unsupported definition: no ProcessFlow structure arrays');
  }
  const entries = [];
  function walk(value, path, depth = 0) {
    if (depth > 100) throw new Error(`Definition nesting exceeds decoder limit at ${path}`);
    if (typeof value === 'string') {
      if (value.trim().startsWith('H4sI')) {
        const decoded = decodeGzipJson(value);
        if (decoded === null) throw new Error(`Cannot decode gzip JSON at ${path}`);
        walk(decoded, path, depth + 1);
      } else if (value) entries.push({ path, text: value });
    } else if (Array.isArray(value)) {
      value.forEach((child, index) => walk(child, `${path}[${index}]`, depth + 1));
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`, depth + 1);
    }
  }
  walk(data, '$');
  return entries;
}
