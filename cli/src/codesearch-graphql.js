import { AppError, errAuth, errForbidden, errUsage } from './errors.js';
import { CODESEARCH_CATALOG } from './codesearch-catalog.js';

const identifier = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const value = (v) => v && typeof v === 'object' ? v.value : v;
const isAccessFailure = (error) => ['auth_error', 'forbidden', 'mfa_required', 'mfa_code_rejected'].includes(error.code)
  || /\b401\b|\b403\b|access denied|not authorized|\bforbidden\b|\bunauthorized\b|\bunauthenticated\b/i.test(`${error.status || ''} ${error.message}`);
function literal(text, label) {
  // Glide encoded-query has no reliable literal escape for separators or eval.
  if (/[\^\r\n\0]/.test(text) || /javascript:/i.test(text)) {
    throw errUsage(`${label} cannot contain encoded-query separators or javascript:`);
  }
  return text;
}
function fail(message, code = 'api_error') {
  return new AppError(code, message);
}
export function matchingRows(record, table, fields, term) {
  if (!term) throw errUsage('A search term is required');
  const rows = [];
  const needle = term.toLowerCase();
  for (const field of fields) {
    const text = String(value(record[field]) ?? '');
    let matches = 0;
    const lines = [];
    let context = '';
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      const lower = line.toLowerCase();
      let position = 0;
      let count = 0;
      while ((position = lower.indexOf(needle, position)) !== -1) {
        count++;
        position += needle.length;
      }
      if (count) {
        matches += count;
        lines.push(index + 1);
        if (!context) context = line.trim().slice(0, 240);
      }
    }
    if (matches) rows.push({ table, name: String(value(record.name) ?? value(record.short_description) ?? value(record.sys_id)),
      field, lines: lines.join(','), matches, context, sys_id: value(record.sys_id) });
  }
  return rows;
}

export async function searchGraphQL(app, options) {
  const { term, table, scope, allScopes = true, searchGroup = 'sn_devstudio.Studio Search Group',
    limit = 100, pageSize = 250, maxPages = 20, maxRequests = 1000 } = options;
  if (!term?.trim()) throw errUsage('A search term is required');
  literal(term, 'Search term');
  if (scope) literal(scope, 'Scope');
  if (table && !identifier.test(table)) throw errUsage('Invalid table identifier');
  for (const [name, number, max] of [['limit', limit, 100000], ['page-size', pageSize, 1000],
    ['max-pages', maxPages, 1000], ['max-requests', maxRequests, 10000]]) {
    if (!Number.isInteger(number) || number < 1 || number > max) throw errUsage(`${name} must be an integer from 1 to ${max}`);
  }
  if (!allScopes && !scope) throw errUsage('--no-all-scopes requires an explicit --scope');
  const base = app.getEffectiveInstance();
  let requests = 0;
  const coverage = [];
  const records = [];
  const definitions = new Map(Object.entries(CODESEARCH_CATALOG).map(([name, fields]) => [name, { fields: [...fields], filters: [] }]));
  // Search-group configuration is additive; never silently omit configured fields.
  let configuration = { status: 'complete' };
  try {
    const params = new URLSearchParams({ sysparm_query: `search_group.name=${literal(searchGroup, 'Search group')}^ORDERBYsys_id`,
      sysparm_limit: '1001', sysparm_fields: 'table,search_fields,additional_filter', sysparm_display_value: 'false' });
    requests++;
    const payload = await app.sdk.request(`${base}/api/now/table/sn_codesearch_table?${params}`);
    if (!Array.isArray(payload?.result)) throw fail('Unreadable sn_codesearch_table response');
    if (payload.result.length > 1000) throw fail('Search configuration exceeds 1000 rows');
    for (const row of payload.result) {
      const name = value(row.table);
      const fields = String(value(row.search_fields) ?? '').split(/[,\s]+/).filter(Boolean);
      if (!identifier.test(name) || !fields.length || fields.some((f) => !identifier.test(f)) || !Object.hasOwn(row, 'additional_filter')) {
        throw fail('Invalid configured table or search fields');
      }
      const definition = definitions.get(name) || { fields: [], filters: [] };
      definition.fields = [...new Set([...definition.fields, ...fields])];
      const filter = String(value(row.additional_filter) ?? '').replace(/\^EQ$/, '');
      if (/javascript:|(?:^|\^)ORDERBY|(?:^|\^)GROUPBY|(?:^|\^)EQ(?:\^|$)|[\r\n\0]/i.test(filter)) {
        // Configuration is data, not permission to execute scripts or reorder.
        definition.invalidFilter = 'Configured additional_filter contains script or query control directives';
      }
      if (filter) definition.filters.push(filter);
      definitions.set(name, definition);
    }
  } catch (error) {
    if (isAccessFailure(error)) throw error;
    configuration = { status: 'partial', reason: error.message };
  }
  if (table && !definitions.has(table)) throw errUsage(`No curated or configured fields for ${table}`);
  const targets = table ? [[table, definitions.get(table)]] : [...definitions];
  let matchedRecords = 0;
  for (const [name, definition] of targets) {
    const status = { table: name, fields: definition.fields, status: 'partial', pages: 0, fetched: 0, reason: 'request budget' };
    coverage.push(status);
    if (definition.invalidFilter) { status.reason = definition.invalidFilter; continue; }
    if (matchedRecords >= limit) { status.reason = 'record limit'; continue; }
    const seen = new Set();
    let fields = [...definition.fields];
    let previous = '';
    for (let page = 0; page < maxPages; page++) {
      if (requests >= maxRequests) { status.reason = 'request budget'; break; }
      // Distribute restrictions into every OR/NQ branch so filters cannot escape scope.
      const branches = definition.filters.length ? definition.filters.flatMap((filter) => filter.split('^NQ')) : [''];
      const query = branches.map((filter) => [filter, scope ? `sys_scope.scope=${scope}` : '',
        fields.map((field) => `${field}LIKE${term}`).join('^OR')].filter(Boolean).join('^')).join('^NQ') + '^ORDERBYsys_id';
      const selection = [...new Set(['sys_id', ...(scope ? ['sys_scope'] : []), ...fields])].map((field) => `${field} { value }`).join(' ');
      const graphql = `query { GlideRecord_Query { ${name}(queryConditions: ${JSON.stringify(query)}, pagination: {limit: ${pageSize}, offset: ${page * pageSize}}) { _results { ${selection} } } } }`;
      requests++;
      let payload;
      try {
        payload = await app.sdk.request(`${base}/api/now/graphql`, { method: 'POST', body: JSON.stringify({ query: graphql }) });
        const envelope = payload?.result ?? payload;
        if (payload?.errors?.length || envelope?.errors?.length) {
          const errors = payload.errors || envelope.errors;
          if (errors.some((error) => /UNAUTHENTICATED/i.test(error.extensions?.code || ''))) {
            throw errAuth(`GraphQL authentication rejected: ${errors.map((error) => error.message).join('; ')}`);
          }
          if (errors.some((error) => /FORBIDDEN|ACCESS_DENIED/i.test(error.extensions?.code || ''))) {
            throw errForbidden(`GraphQL access denied: ${errors.map((error) => error.message).join('; ')}`);
          }
          throw fail(errors.map((e) => e.message || String(e)).join('; '), 'graphql_error');
        }
        if (payload?.ok === false || envelope?.error) throw fail(JSON.stringify(envelope.error || payload.error));
        const rows = envelope?.data?.GlideRecord_Query?.[name]?._results;
        if (!Array.isArray(rows)) throw fail('GraphQL response is missing _results');
        status.pages++;
        if (!rows.length) {
          status.status = status.unsupportedFields?.length ? 'partial' : 'complete';
          if (status.unsupportedFields?.length) status.reason = `Unsupported fields: ${status.unsupportedFields.join(', ')}`;
          else delete status.reason;
          break;
        }
        for (const row of rows) {
          const id = value(row.sys_id);
          if (!id || seen.has(id) || (previous && id <= previous)) throw fail('Unstable pagination: missing, duplicate or unordered sys_id');
          if ([...fields, ...(scope ? ['sys_scope'] : [])].some((field) => !Object.hasOwn(row, field) || row[field] == null)) throw fail('GraphQL omitted a requested field (schema or access restriction)');
          previous = id;
          seen.add(id);
          status.fetched++;
          const hits = matchingRows(row, name, fields, term);
          if (hits.length) { records.push(...hits); matchedRecords++; }
          if (matchedRecords >= limit) break;
        }
        if (matchedRecords >= limit) { status.reason = 'record limit'; break; }
        status.reason = 'page budget';
      } catch (error) {
        if (isAccessFailure(error)) {
          if (error.code === 'graphql_error') {
            throw /\b401\b|unauthorized|unauthenticated/i.test(error.message) ? errAuth(error.message) : errForbidden(error.message);
          }
          throw error;
        }
        // Only explicit schema-validation failures may narrow the selection.
        // Never reinterpret ACL errors or missing data as nonexistent fields.
        const missing = [...error.message.matchAll(/Cannot query field ["'](\w+)["']/g)]
          .map((match) => match[1]).filter((field) => fields.includes(field));
        if (missing.length && error.code === 'graphql_error') {
          status.unsupportedFields = [...new Set([...(status.unsupportedFields || []), ...missing])];
          fields = fields.filter((field) => !missing.includes(field));
          if (fields.length) { page--; continue; }
        }
        status.reason = error.message;
        status.status = /Cannot query field|Unknown field|Unknown type/i.test(error.message) ? 'unsupported' : 'partial';
        break;
      }
    }
  }
  const state = configuration.status === 'complete' && coverage.every((item) => item.status === 'complete') ? 'complete' :
    coverage.every((item) => item.status === 'unsupported') ? 'unsupported' : 'partial';
  return { term, count: records.length, records, recordCount: matchedRecords, fieldCount: records.length,
    matchCount: records.reduce((sum, row) => sum + row.matches, 0), status: state,
    coverage, configuration, requests, hint: 'Flow internals require separate jsn flows search; no flow downloads are performed.' };
}
