// Opt-in related-list counts. Counts never fetch supplementary records; hints
// leave opening the list to an explicit subsequent command.
import { assertSafeExactMatch, quoteShellArg } from './helpers.js';
import { errUsage } from './errors.js';
const namePattern = /^[A-Za-z0-9_]+$/;
const raw = value => String(value && typeof value === 'object' ? value.value ?? '' : value ?? '');

/** Only a conservative, AND-only literal encoded-query subset can be combined
 * with a record reference. Unknown platform/dynamic logic stays unavailable. */
export function safeRelatedFilter(value = '') {
  if (typeof value !== 'string' || /javascript\s*:|\r|\n/i.test(value)) return null;
  if (!value) return '';
  const clauses = value.split('^');
  if (clauses.at(-1) === 'EQ') clauses.pop();
  if (!clauses.length) return '';
  for (const clause of clauses) {
    if (!clause || /^(?:OR|NQ|ORDERBY)/i.test(clause)) return null;
    if (!/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*(?:(?:!=|>=|<=|=|>|<|NOT LIKE|STARTSWITH|ENDSWITH|LIKE|NOT IN|IN)[^^]*|ISEMPTY|ISNOTEMPTY)$/.test(clause)) return null;
  }
  return clauses.join('^');
}
function parseCount(body) {
  const result = body?.result;
  const entry = Array.isArray(result) && result.length === 1 && !result[0]?.groupby_fields?.length
    ? result[0] : result;
  let stats = entry?.stats;
  if (typeof stats === 'string') { try { stats = JSON.parse(stats); } catch { return null; } }
  const count = stats?.count;
  if (typeof count !== 'number' && (typeof count !== 'string' || !/^\d+$/.test(count))) return null;
  const number = Number(count);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}
function hint(table, query, { profile, instance }) {
  const tokens = ['jsn', 'records', 'list', '--table', table, '--query', query];
  if (profile) tokens.push('--profile', profile);
  if (instance) tokens.push('--instance', instance);
  return tokens.map(quoteShellArg).join(' ');
}

/** Invocation-bound reader. Metadata/aggregate failures are coverage gaps, not
 * zero counts. Optional batch owns endpoint fallback; items never replay. */
export function createRelatedListReader(sdk, { metadataReader, maxLists = 100 } = {}) {
  if (!Number.isInteger(maxLists) || maxLists < 1 || maxLists > 1000) throw errUsage('Related-list limit must be an integer from 1 to 1000.');
  const cache = new Map();
  let reader = metadataReader;
  async function read({ table, recordId, view = 'Default view', profile = '', instance = '' }) {
    if (!namePattern.test(table)) throw errUsage('Related-list table must be a valid table name.');
    const id = raw(recordId);
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) throw errUsage('Related-list counts require a safe, resolved record sys_id.');
    assertSafeExactMatch(id);
    if (!reader) {
      const { createRecordMetadataReader } = await import('./metadata/records.js');
      reader = createRecordMetadataReader(sdk);
    }
    const metadata = await reader.read({ table, view });
    const warnings = [...(metadata.coverage?.warnings || [])];
    const descriptors = metadata.related_lists || [];
    const prepared = descriptors.map((list, index) => {
      const result = { id: list.id, label: list.label || list.id, table: list.table || null,
        reference_field: list.reference_field || null, configured: !!list.configured,
        status: 'unavailable', count: null };
      let reason;
      const filter = safeRelatedFilter(list.filter || '');
      if (index >= maxLists) reason = `Related-list limit ${maxLists} reached; count was not requested.`;
      else if (list.query_status !== 'reference' || !namePattern.test(list.table) || !namePattern.test(list.reference_field)) reason = list.reason || 'Related list requires platform relationship logic or unavailable metadata.';
      else if (filter === null) reason = 'Related-list filter uses unsupported dynamic or disjunctive query logic; count was not requested.';
      if (reason) {
        result.reason = reason; warnings.push({ source: list.id, reason }); return { result };
      }
      const query = `${list.reference_field}=${id}${filter ? `^${filter}` : ''}`;
      const params = new URLSearchParams({ sysparm_count: 'true', sysparm_query: query });
      const url = `/api/now/stats/${list.table}?${params}`;
      return { result, query, url };
    });
    const unique = [...new Set(prepared.filter(item => item.url && !cache.has(item.url)).map(item => item.url))];
    if (unique.length) {
      const pending = (async () => {
        if (typeof sdk.batch === 'function' && unique.length > 1) {
          try {
            const batch = await sdk.batch(unique.map((url, index) => ({ id: `related-${index}`, method: 'GET', url })), { fallback: true });
            return unique.map((_, index) => {
              const item = batch.results?.find(value => value.id === `related-${index}`);
              if (!item?.ok) return { count: null, status: item?.status || null,
                reason: item?.error?.message || 'Aggregate subrequest was unavailable or unserviced.' };
              const count = parseCount(item.data);
              return { count, status: item.status, ...(count === null ? { reason: 'Aggregate response did not contain a valid count.' } : {}) };
            });
          } catch (error) {
            return unique.map(() => ({ count: null, status: error.status || null, reason: error.message || 'Aggregate batch failed.' }));
          }
        }
        return Promise.all(unique.map(async url => {
          try {
            const body = await sdk.request(`${sdk.baseURL}${url}`, { method: 'GET', readOnly: true });
            const count = parseCount(body);
            return { count, ...(count === null ? { reason: 'Aggregate response did not contain a valid count.' } : {}) };
          } catch (error) { return { count: null, status: error.status || null, reason: error.message || 'Aggregate request failed.' }; }
        }));
      })();
      unique.forEach((url, index) => cache.set(url, pending.then(items => items[index])));
    }
    const lists = await Promise.all(prepared.map(async item => {
      if (!item.url) return item.result;
      const observed = await cache.get(item.url);
      if (observed.count === null) {
        warnings.push({ source: item.result.id, reason: observed.reason, ...(observed.status ? { status: observed.status } : {}) });
        return { ...item.result, reason: observed.reason, ...(observed.status ? { http_status: observed.status } : {}) };
      }
      return { ...item.result, status: 'available', count: observed.count, query: item.query,
        ...(observed.count > 0 ? { command: hint(item.result.table, item.query, { profile, instance }) } : {}) };
    }));
    return { table, record_id: id, view, lists, nonempty: lists.filter(list => list.count > 0),
      coverage: { state: metadata.coverage?.state === 'partial' || warnings.length ? 'partial' : 'observed',
        scope: 'aggregate_api_access', warnings } };
  }
  return { read, clear() { cache.clear(); reader?.clear?.(); } };
}

/** Specialized show hook; ordinary shows and generic records get do no work. */
export async function enrichRelatedLists(record, { table, argv = {}, app }) {
  if (!argv.related) return record;
  if (!app.relatedListReader || app._relatedListReaderSDK !== app.sdk) {
    app.relatedListReader = createRelatedListReader(app.sdk);
    app._relatedListReaderSDK = app.sdk;
  }
  record._related = await app.relatedListReader.read({ table, recordId: record.sys_id,
    view: argv.view || 'Default view', profile: app.session?.profileName || argv.profile || '',
    instance: app.getEffectiveInstance?.() || '' });
  return record;
}
