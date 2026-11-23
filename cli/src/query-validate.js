// Glue between the parser, table-scoped metadata and the five-minute cache.
// A verdict reports what was actually established. "Could not tell" is never
// rendered as "invalid" or "absent"; reads may proceed, writes never do.

import { parseEncodedQuery } from './query-parse.js';
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
  const clauses = parsed.terms.filter(term => term.kind === 'clause');
  let state = parsed.unsupported ? 'unsupported' : 'valid';
  const diagnostics = [...parsed.diagnostics];
  const notes = [];
  const metadataByTable = new Map();

  const load = async name => {
    if (metadataByTable.has(name)) return metadataByTable.get(name);
    const cached = refresh ? null : metaCache.get(name);
    if (cached) {
      metadataByTable.set(name, cached.payload);
      return cached.payload;
    }
    const metadata = await readTableMetadata(sdk, name);
    metadataByTable.set(name, metadata);
    if (metadata.state === 'observed') metaCache.set(name, metadata);
    return metadata;
  };

  if (table && clauses.length) {
    if (!identity.principal) {
      diagnostics.push({ code: 'cache_identity_unknown', severity: 'info', term: '',
        message: 'The authenticated principal could not be established, so metadata is used in-process only and never reused from disk.',
        hint: 'Persisted metadata reuse requires a verified non-guest identity.' });
    }
    for (const term of clauses) {
      let currentTable = table;
      let metadata = await load(currentTable);
      if (metadata.state !== 'observed') {
        state = worse(state, metadata.state);
        if (!diagnostics.some(item => item.code === `metadata_${metadata.state}` && item.table === currentTable)) {
          diagnostics.push({ ...diagnostic(metadata.state, term, currentTable), table: currentTable, reason: metadata.reason });
        }
        continue;
      }
      for (let hop = 0; hop < term.path.length && hop < MAX_DOT_WALK; hop++) {
        const element = term.path[hop];
        const definition = resolveField(metadata, currentTable, element);
        if (!definition) {
          if (metadata.state !== 'observed') {
            state = worse(state, metadata.state);
            diagnostics.push(diagnostic(metadata.state, term, currentTable));
          } else {
            state = 'invalid';
            const suggestions = fieldSuggestions(metadata, currentTable, element);
            diagnostics.push({
              code: 'unknown_field', severity: 'error', term: term.raw, field: element, table: currentTable,
              message: `Field "${element}" is not defined on ${currentTable} or its visible ancestors.`,
              ...(suggestions.length ? { suggestions } : {}),
              hint: suggestions.length
                ? `Did you mean ${suggestions.join(', ')}? Run \`jsn columns --table ${currentTable}\`.`
                : `Run \`jsn columns --table ${currentTable}\` to list visible fields.`,
            });
          }
          break;
        }
        term.inherited = definition.inherited;
        if (hop === term.path.length - 1) break;
        if (!definition.reference) {
          state = 'invalid';
          diagnostics.push({ code: 'invalid_dot_walk', severity: 'error', term: term.raw, field: element, table: currentTable,
            message: `"${element}" on ${currentTable} is not a reference, so "${term.path.join('.')}" cannot be walked.`,
            hint: 'Dot-walks traverse reference fields only.' });
          break;
        }
        currentTable = definition.reference;
        metadata = await load(currentTable);
        if (metadata.state !== 'observed') {
          state = worse(state, metadata.state);
          diagnostics.push({ ...diagnostic(metadata.state, term, currentTable), table: currentTable, reason: metadata.reason });
          break;
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
  if (!query || !String(query).trim() || !table) return { state: 'valid', table, query: query || '', diagnostics: [], limits: LIMITS };
  const verdict = await validateEncodedQuery({ sdk: app.sdk, table, query, identity: metadataIdentity(app), refresh });
  if (verdict.state === 'invalid') throw errUsageHint(assertionMessage(verdict, 'Read'), verdict.diagnostics[0]?.hint);
  return verdict;
}

/** Validate the COMPLETE original filter before any instance-record write. */
export async function assertWriteQuery(app, { table, query, refresh = false } = {}) {
  const verdict = await validateEncodedQuery({ sdk: app.sdk, table, query, identity: metadataIdentity(app), refresh });
  if (verdict.state !== 'valid') {
    const error = errUsageHint(assertionMessage(verdict, 'Mutation'), verdict.diagnostics[0]?.hint
      || 'No records were written. Fix the filter, refresh metadata, or use an identity that can read table metadata.');
    error.diagnostics = verdict.diagnostics;
    error.query_validation = { state: verdict.state, query: verdict.query, limits: verdict.limits };
    throw error;
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

/**
 * The authenticated principal is only trusted when the selected profile's
 * username and the SDK's expected username agree. Otherwise identity is
 * unknown and persisted privileged metadata must not be reused.
 */
export function metadataIdentity(app) {
  const profile = app?.config?.activeProfile || app?.config?.defaultProfile || '';
  const sessionUser = app?.session?.username || '';
  const sdkUser = app?.sdk?.username || '';
  const principal = sessionUser && sdkUser && sessionUser === sdkUser && sessionUser !== 'guest' ? sessionUser : '';
  return { instance: app?.getEffectiveInstance?.() || '', profile, principal };
}

export { LIMITS as QUERY_VALIDATION_LIMITS };
