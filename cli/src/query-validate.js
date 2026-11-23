// Glue between the parser, table-scoped metadata and the five-minute cache.
// A verdict reports what was actually established. "Could not tell" is never
// rendered as "invalid" or "absent"; reads may proceed, writes never do.

import { parseEncodedQuery, CANONICAL_OPERATORS, operatorSuggestions } from './query-parse.js';
import { readTableMetadata, resolveField, QUERY_METADATA_LIMITS } from './query-metadata.js';
import { createQueryMetadataCache, DEFAULT_TTL_MS } from './query-cache.js';
import { errUsageHint } from './errors.js';

const METADATA_TABLES = new Set(['sys_db_object', 'sys_dictionary', 'sys_dictionary_override']);
const MAX_DOT_WALK = 5;
const STATE_ORDER = { invalid: 6, denied: 5, unavailable: 4, incomplete: 3, unsupported: 2, valid: 1 };

const worse = (a, b) => (STATE_ORDER[b] || 0) > (STATE_ORDER[a] || 0) ? b : a;

const LIMITS = Object.freeze({
  ttl_seconds: DEFAULT_TTL_MS / 1000,
  dot_walk_depth: MAX_DOT_WALK,
  inheritance_depth: QUERY_METADATA_LIMITS.maxDepth,
  dictionary_rows: QUERY_METADATA_LIMITS.fields,
});

function fieldSuggestions(metadata, table, element) {
  const names = new Set();
  for (const owner of metadata.hierarchy?.length ? metadata.hierarchy : [table]) {
    for (const name of Object.keys(metadata.fields?.[owner] || {})) names.add(name);
  }
  const lower = String(element).toLowerCase();
  return [...names]
    .filter(name => name !== element)
    .filter(name => name.toLowerCase().includes(lower.slice(0, 3)) || lower.includes(name.toLowerCase().slice(0, 3)))
    .slice(0, 3);
}

function diagnostic(state, term, reason) {
  const base = { severity: 'warning', term: term?.raw || '', state };
  if (state === 'denied') {
    return { ...base, code: 'metadata_denied',
      message: `Table metadata for ${reason} is not visible to this identity. Hidden metadata is not proof the table or field is absent.`,
      hint: 'Re-authenticate with an identity that can read sys_db_object/sys_dictionary, or narrow the filter.' };
  }
  if (state === 'unavailable') {
    return { ...base, code: 'metadata_unavailable',
      message: `Table metadata for ${reason} could not be read (network or server failure).`,
      hint: 'Retry, then refresh the metadata cache; the query itself is unchanged.' };
  }
  return { ...base, code: 'metadata_incomplete',
    message: `Table metadata for ${reason} is incomplete or truncated.`,
    hint: 'Hidden or capped rows are not absence. Widen access or narrow the filter; refresh with --refresh-metadata.' };
}

/**
 * Validate a user-supplied encoded query.
 * @param {{sdk:object, table:string, query:string, identity?:object,
 *   refresh?:boolean, cache?:object}} options
 */
export async function validateEncodedQuery({ sdk, table, query, identity = {}, refresh = false, cache } = {}) {
  const parsed = parseEncodedQuery(query);
  const metaCache = cache || createQueryMetadataCache({ identity });
  if (!parsed.terms.length && !parsed.diagnostics.length) {
    return { state: 'valid', table, query: parsed.original, diagnostics: [], terms: [], limits: LIMITS };
  }
  if (parsed.invalid) {
    return { state: 'invalid', table, query: parsed.original, diagnostics: parsed.diagnostics, terms: parsed.terms, limits: LIMITS };
  }
  const clauses = parsed.terms.filter(term => ['clause', 'ambiguous', 'directive'].includes(term.kind));
  let state = parsed.terms.some(term => term.kind === 'unsupported') ? 'unsupported' : 'valid';
  const diagnostics = [...parsed.diagnostics];
  const metadataByTable = new Map();
  const load = async name => {
    if (metadataByTable.has(name)) return metadataByTable.get(name);
    if (refresh) metaCache.refresh(name);
    const cached = refresh ? null : metaCache.get(name);
    const metadata = cached?.payload || await readTableMetadata(sdk, name);
    metadataByTable.set(name, metadata);
    if (!cached && metadata.state === 'observed') metaCache.set(name, metadata);
    return metadata;
  };
  if (!table) {
    state = worse(state, 'incomplete');
    diagnostics.push(diagnostic('incomplete', parsed.terms[0], 'an unresolved table target'));
  } else {
    for (const term of clauses) {
      let currentTable = table;
      let metadata = await load(currentTable);
      if (metadata.state !== 'observed') {
        state = worse(state, metadata.state);
        diagnostics.push({ ...diagnostic(metadata.state, term, currentTable), table: currentTable });
        continue;
      }
      // Resolve operator boundaries against accessible dictionary names, longest
      // first. Uppercase fragments alone are never proof of a field boundary.
      if (term.clause && !term.field.includes('.')) {
        const names = metadata.hierarchy.flatMap(owner => Object.keys(metadata.fields[owner] || {}))
          .sort((a, b) => b.length - a.length);
        let resolved = false;
        for (const name of names) {
          if (!term.clause.startsWith(name)) continue;
          const suffix = term.clause.slice(name.length);
          const operator = CANONICAL_OPERATORS.find(op => suffix.startsWith(op));
          if (operator) {
            term.field = name; term.path = [name]; term.operator = operator;
            term.value = suffix.slice(operator.length); term.kind = 'clause'; resolved = true; break;
          }
          // Only a visible field plus a close misspelling of an operator is
          // demonstrably invalid. Other platform syntax stays unverified.
          const token = suffix.match(/^[A-Z ]+/)?.[0] || '';
          const suggestions = operatorSuggestions(token);
          if (suggestions.length && token) {
            state = 'invalid'; resolved = true;
            diagnostics.push({ code: 'invalid_operator', severity: 'error', state: 'invalid', term: term.raw,
              message: `Unrecognised operator after visible field "${name}".`, suggestions,
              hint: `Use ${suggestions.join(', ')} only if intended. See jsn records list --help.` });
            break;
          }
        }
        if (term.kind === 'ambiguous' && !resolved) {
          state = worse(state, 'unsupported'); continue;
        }
      }
      const path = term.path || term.field.split('.');
      if (path.length > MAX_DOT_WALK) {
        state = worse(state, 'unsupported');
        diagnostics.push({ code: 'dot_walk_limit', severity: 'warning', state: 'unsupported', term: term.raw,
          message: `Dot-walk exceeds ${MAX_DOT_WALK} field components; the tail was not validated.`,
          hint: 'Narrow the filter. See jsn records list --help.' });
        continue;
      }
      for (let hop = 0; hop < path.length; hop++) {
        const element = path[hop];
        const definition = resolveField(metadata, currentTable, element);
        if (!definition) {
          state = worse(state, 'incomplete');
          diagnostics.push({ code: 'unknown_field', severity: 'warning', state: 'incomplete', term: term.raw, field: element,
            message: `Field "${element}" is not visible on ${currentTable}; it may be ACL-hidden or unknown.`,
            suggestions: fieldSuggestions(metadata, currentTable, element),
            hint: `Run jsn columns list --table ${currentTable}; retry with --refresh-metadata. See jsn records list --help.` });
          break;
        }
        term.inherited = definition.inherited;
        if (hop === path.length - 1) break;
        if (!definition.reference) {
          const complete = definition.type && definition.type !== 'unknown' && definition.type !== 'reference';
          state = complete ? 'invalid' : worse(state, 'incomplete');
          diagnostics.push({ code: complete ? 'invalid_dot_walk' : 'metadata_incomplete',
            severity: complete ? 'error' : 'warning', state: complete ? 'invalid' : 'incomplete', term: term.raw, field: element,
            message: complete ? `"${element}" on ${currentTable} is not a reference.` : `Reference metadata for "${element}" is incomplete.`,
            hint: 'Dot-walks require visible reference type and target metadata. See jsn records list --help.' });
          break;
        }
        currentTable = definition.reference;
        metadata = await load(currentTable);
        if (metadata.state !== 'observed') {
          state = worse(state, metadata.state);
          diagnostics.push(diagnostic(metadata.state, term, currentTable)); break;
        }
      }
    }
  }
  return { state, table, query: parsed.original, diagnostics, terms: parsed.terms, limits: LIMITS,
    identity: { principal_verified: Boolean(identity.principal), cache: metaCache.persistent ? 'disk' : 'memory' },
    metadata: Object.fromEntries([...metadataByTable].map(([name, value]) => [name, { state: value.state, reason: value.reason || '' }])) };
}

function assertionMessage(verdict, action) {
  const first = verdict.diagnostics.find(item => item.severity === 'error') || verdict.diagnostics[0];
  return `${action} refused: encoded query validation state is ${verdict.state}${first ? ` (${first.code})` : ''}. ${first?.message || ''}`.trim();
}

/** Human-visible + JSON diagnostics attached to a successful read. */
export function queryDiagnostics(verdict) {
  if (!verdict || verdict.state === 'valid') return {};
  const diagnostics = verdict.diagnostics.map(item => ({
    code: item.code, severity: item.severity, term: item.term,
    ...(item.field ? { field: item.field } : {}), message: item.message,
    ...(item.hint ? { hint: item.hint } : {}),
    ...(item.suggestions?.length ? { suggestions: item.suggestions } : {}),
  }));
  return {
    query_validation: { state: verdict.state, diagnostics, limits: verdict.limits },
    warnings: diagnostics.filter(item => item.severity !== 'info')
      .map(item => `Query validation ${verdict.state}: ${item.message}${item.hint ? ` ${item.hint}` : ''}`),
  };
}

/**
 * Validate before a read. Demonstrably invalid syntax/schema throws; every
 * unverified state returns so the caller may proceed with diagnostics and the
 * original, byte-identical query.
 */
export async function validateReadQuery(app, { table, query, refresh = false } = {}) {
  if (!query || !String(query).trim()) return { state: 'valid', table, query: query || '', diagnostics: [], limits: LIMITS };
  if (app.queryValidation?.table === table && app.queryValidation.query === query) return app.queryValidation;
  const verdict = await validateEncodedQuery({ sdk: app.sdk, table, query, identity: await authenticatedIdentity(app), refresh });
  if (verdict.state === 'invalid') throw validationError(verdict, 'Read');
  return verdict;
}

/** Validate the COMPLETE original filter before any instance-record write. */
export async function assertWriteQuery(app, { table, query, refresh = false } = {}) {
  if (app.queryValidation?.state === 'valid' && app.queryValidation.table === table && app.queryValidation.query === query) return app.queryValidation;
  const verdict = await validateEncodedQuery({ sdk: app.sdk, table, query, identity: await authenticatedIdentity(app), refresh });
  if (verdict.state !== 'valid') {
    throw validationError(verdict, 'Mutation');
  }
  return verdict;
}

/** After a successful table/field mutation, drop affected cache entries. */
export function invalidateAfterMutation(app, table) {
  const identity = metadataIdentity(app);
  const cache = createQueryMetadataCache({ identity });
  if (METADATA_TABLES.has(table)) return cache.invalidate({ all: true });
  return cache.invalidate({ tables: [table] });
}

// Configuration usernames are expectations, never authenticated identity proof.
export function metadataIdentity(app) {
  return { instance: app?.getEffectiveInstance?.() || '',
    profile: app?.config?.activeProfile || app?.config?.defaultProfile || '', principal: '' };
}
async function authenticatedIdentity(app) {
  const identity = metadataIdentity(app);
  try {
    // Strict provider readback on every invocation; no principal cache can outlive
    // a session/account switch. Fixture SDKs without strict transport stay memory-only.
    const rows = await app.sdk.listStrict('sys_user', new URLSearchParams({
      sysparm_query: 'user_name=javascript:gs.getUserName()', sysparm_fields: 'sys_id,user_name',
      sysparm_limit: '2', sysparm_display_value: 'false',
    }));
    if (rows.length === 1) {
      const id = rows[0]?.sys_id?.value ?? rows[0]?.sys_id;
      const name = rows[0]?.user_name?.value ?? rows[0]?.user_name;
      if (/^[a-f0-9]{32}$/i.test(id) && typeof name === 'string' && name && name !== 'guest'
        && (!app.sdk.username || name === app.sdk.username)) identity.principal = id;
    }
  } catch { /* identity unknown: persisted entries must not be read */ }
  return identity;
}
function validationError(verdict, action) {
  const first = verdict.diagnostics.find(item => item.severity === 'error') || verdict.diagnostics[0];
  const error = errUsageHint(assertionMessage(verdict, action),
    `${first?.hint || 'No records were written. Refresh metadata or narrow the filter.'} See jsn records list --help.`);
  error.query_validation = { state: verdict.state, query: verdict.query, limits: verdict.limits, diagnostics: verdict.diagnostics };
  return error;
}

export { LIMITS as QUERY_VALIDATION_LIMITS };
