// On-demand, table-scoped metadata for encoded-query validation.
//
// A bounded sys_db_object ancestry walk and one sys_dictionary request cover
// visible ancestors. Unresolved tables allow one bounded name-candidate lookup. Nothing here dumps a
// whole instance schema, and nothing here treats a hidden row as absence.

const FIELD_LIMIT = 1000;
const MAX_DEPTH = 8;

const raw = value => String(value && typeof value === 'object' ? value.value ?? '' : value ?? '');
const isName = value => typeof value === 'string' && /^[a-zA-Z0-9_]+$/.test(value);

function params(query, fields, limit) {
  return new URLSearchParams({
    sysparm_query: query,
    sysparm_fields: fields,
    sysparm_limit: String(limit),
    sysparm_display_value: 'false',
  });
}

function classifyFailure(error) {
  const status = Number(error?.status);
  if (status === 401 || status === 403 || error?.code === 'auth_error') return 'denied';
  return 'unavailable';
}

async function readList(sdk, table, searchParams) {
  try {
    const responseMetadata = {};
    const read = sdk.listStrict || sdk.list;
    const rows = await read.call(sdk, table, searchParams, { responseMetadata });
    if (!Array.isArray(rows)) return { state: 'unavailable', reason: 'Metadata response was not an array' };
    return { rows, total: responseMetadata.total };
  } catch (error) {
    return { state: classifyFailure(error), reason: 'Metadata read failed or returned an invalid envelope' };
  }
}

// One prefix-bounded, ACL-scoped candidate read, never a schema inventory.
// Suggestions are labels only and are never cached or substituted into queries.
async function tableSuggestions(sdk, table, requests) {
  if (!isName(table) || table.length < 3) return [];
  const prefix = table.slice(0, 3);
  const query = `nameSTARTSWITH${prefix}^ORDERBYname`;
  requests.push({ table: 'sys_db_object', query, fields: 'name', limit: 20 });
  const result = await readList(sdk, 'sys_db_object', params(query, 'name', 20));
  if (!result.rows || result.rows.length > 20) return [];
  const distance = (a, b) => {
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = next;
    }
    return previous[b.length];
  };
  return [...new Set(result.rows.map(row => raw(row?.name)))]
    .filter(name => isName(name) && name.length <= 160 && name !== table && name.startsWith(prefix))
    .map(name => ({ name, distance: distance(table.slice(0, 160), name) }))
    .filter(candidate => candidate.distance <= Math.max(2, Math.floor(table.length / 4)))
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, 3).map(candidate => candidate.name);
}

/**
 * Read table + ancestor field metadata as visible to the caller's own ACLs.
 * States: observed | denied | unavailable | incomplete.
 * `incomplete` is never absence: callers must not treat missing fields as
 * definitively unknown-to-the-platform.
 */
export async function readTableMetadata(sdk, table, { maxDepth = MAX_DEPTH, limit = FIELD_LIMIT } = {}) {
  if (!isName(table)) {
    return { state: 'unavailable', table, hierarchy: [], fields: {}, reason: 'Invalid table name', requests: [] };
  }
  const requests = [];
  const hierarchy = [];
  const visited = new Set();
  let next = { query: `name=${table}`, fields: 'sys_id,name,super_class', limit: 2 };
  let state = 'observed';
  let reason = '';

  for (let depth = 0; next && depth < maxDepth; depth++) {
    const search = params(next.query, next.fields, next.limit);
    requests.push({ table: 'sys_db_object', query: next.query, fields: next.fields, limit: next.limit });
    const result = await readList(sdk, 'sys_db_object', search);
    if (!result.rows) {
      return { state: result.state, table, hierarchy: hierarchy.map(item => item.name), fields: {}, reason: result.reason, requests,
        suggestions: depth === 0 ? await tableSuggestions(sdk, table, requests) : [] };
    }
    if (result.rows.length !== 1) {
      // First hop: the table is not visible (may not exist, may be ACL-hidden).
      // Deeper hop: an ancestor is hidden or the chain is malformed.
      state = depth === 0 ? 'denied' : 'incomplete';
      reason = depth === 0
        ? `Table ${table} is not visible to this identity; it may not exist or may be ACL-hidden`
        : `Ancestor metadata above ${hierarchy.at(-1)?.name || table} is not visible`;
      break;
    }
    const row = result.rows[0];
    const name = raw(row?.name);
    const id = raw(row?.sys_id);
    if (!row || typeof row !== 'object' || !isName(name) || visited.has(name)
      || (depth === 0 ? name !== table : id !== next.query.slice(7))) {
      state = 'incomplete';
      reason = 'Malformed or cyclic sys_db_object ancestry';
      break;
    }
    visited.add(name);
    hierarchy.push({ name, sys_id: id });
    if (!Object.hasOwn(row, 'super_class')) {
      state = 'incomplete';
      reason = 'Parent metadata is not visible; inheritance coverage is incomplete';
      break;
    }
    const parent = raw(row.super_class);
    if (!parent) { next = null; break; }
    if (!/^[a-f0-9]{32}$/i.test(parent)) {
      state = 'incomplete';
      reason = 'Malformed parent reference in sys_db_object';
      break;
    }
    next = { query: `sys_id=${parent}`, fields: 'sys_id,name,super_class', limit: 2 };
  }
  if (next && hierarchy.length >= maxDepth) {
    state = state === 'observed' ? 'incomplete' : state;
    reason ||= `Table inheritance depth limit ${maxDepth} reached`;
  }
  if (!hierarchy.length) {
    return { state, table, hierarchy: [], fields: {}, reason, requests, suggestions: await tableSuggestions(sdk, table, requests) };
  }

  const names = hierarchy.map(item => item.name);
  const query = `nameIN${names.join(',')}^elementISNOTEMPTY`;
  requests.push({ table: 'sys_dictionary', query, fields: 'sys_id,name,element,internal_type,reference', limit });
  const dictionary = await readList(sdk, 'sys_dictionary', params(query, 'sys_id,name,element,internal_type,reference', limit));
  if (!dictionary.rows) {
    return { state: dictionary.state, table, hierarchy: names, fields: {}, reason: dictionary.reason, requests };
  }
  const fields = {};
  for (const row of dictionary.rows) {
    const owner = raw(row?.name);
    const element = raw(row?.element);
    if (!isName(owner) || !isName(element) || !names.includes(owner)) {
      state = state === 'observed' ? 'incomplete' : state;
      reason ||= 'Ignored a malformed or out-of-scope sys_dictionary row';
      continue;
    }
    if (!Object.hasOwn(row, 'internal_type') || !raw(row.internal_type)
      || !Object.hasOwn(row, 'reference')
      || (raw(row.internal_type) === 'reference' && !isName(raw(row.reference)))) {
      state = state === 'observed' ? 'incomplete' : state;
      reason ||= 'Field type or reference metadata is not visible';
    }
    fields[owner] ||= {};
    fields[owner][element] = {
      type: raw(row.internal_type) || 'unknown',
      reference: isName(raw(row.reference)) ? raw(row.reference) : '',
    };
  }
  if (!dictionary.rows.length || !Number.isSafeInteger(dictionary.total)
    || dictionary.total !== dictionary.rows.length || dictionary.rows.length >= limit) {
    state = state === 'observed' ? 'incomplete' : state;
    reason ||= `sys_dictionary limit ${limit} reached; field coverage is incomplete`;
  }
  return { state, table, hierarchy: names, fields, reason, requests,
    complete: state === 'observed', source: 'table-api', total: dictionary.total };
}

/** Resolve one field through the dictionary, marking where it was inherited. */
export function resolveField(metadata, table, element) {
  const owners = metadata.hierarchy?.length ? metadata.hierarchy : [table];
  for (const owner of owners) {
    const definition = metadata.fields?.[owner]?.[element];
    if (definition) return { ...definition, owner, inherited: owner !== table };
  }
  return null;
}

export const QUERY_METADATA_LIMITS = Object.freeze({ maxDepth: MAX_DEPTH, fields: FIELD_LIMIT });
