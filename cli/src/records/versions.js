import { SaxesParser } from 'saxes';
import { errUsage } from '../errors.js';
import { assertSafeExactMatch } from '../helpers.js';
import { resolveRecord, unwrapSysId } from '../resolve-record.js';

const VERSION = 'sys_update_version';
const UPDATE = 'sys_update_xml';
const VERSION_FIELDS = 'sys_id,name,record_name,state,action,source_table,source,application,instance_name,reverted_from,payload_hash,sys_recorded_at,sys_created_on,sys_created_by';
const UPDATE_FIELDS = 'sys_id,name,update_set,update_set.state,application,action,sys_updated_on,sys_updated_by';
// Same system noise `jsn diff record` ignores: every save changes them.
export const IGNORED_FIELDS = ['sys_created_by', 'sys_created_on', 'sys_mod_count', 'sys_updated_by', 'sys_updated_on'];
// shortcut: line diff is O(lines x lines) after trimming the common head and tail; past this it reports counts only.
const MAX_LINE_CELLS = 4_000_000;

// Display labels are presentation only. Joins and comparisons use raw values.
export const raw = value => value && typeof value === 'object' ? String(value.value ?? '') : String(value ?? '');
const text = value => value && typeof value === 'object' ? String(value.display_value ?? value.value ?? '') : String(value ?? '');
export const malformed = message => Object.assign(new Error(message), { code: 'malformed_response' });

export async function read(sdk, table, query, fields, limit, displayValue = 'all') {
  const rows = await sdk.listStrict(table, new URLSearchParams({ sysparm_query: query, sysparm_fields: fields, sysparm_limit: String(limit), sysparm_display_value: displayValue }));
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw malformed(`Malformed table response for ${table}`);
  return rows;
}

function assertName(rows, field, name, table) {
  if (rows.some(row => raw(row[field]) !== name)) throw malformed(`${table} returned a row for another record than ${name}.`);
}

// Every element carrying an `action` attribute is one record of the update; composite types
// (list layouts, dictionary entries) hold several. Fields are a record's leaf children.
export function parsePayload(xml) {
  if (typeof xml !== 'string' || !xml.trim()) throw malformed('Version payload is empty or not readable.');
  const records = [];
  const stack = [];
  const parser = new SaxesParser();
  parser.on('doctype', () => { throw malformed('Unexpected document type in version payload.'); });
  parser.on('opentag', node => {
    const record = Object.hasOwn(node.attributes, 'action') ? { table: node.name, action: node.attributes.action, fields: {} } : null;
    if (record) records.push(record);
    stack.push({ name: node.name, attributes: node.attributes, text: '', record });
  });
  const append = chunk => { if (stack.length) stack.at(-1).text += chunk; };
  parser.on('text', append);
  parser.on('cdata', append);
  parser.on('closetag', () => {
    const node = stack.pop();
    const parent = stack.at(-1);
    if (parent?.record && !node.record) {
      parent.record.fields[node.name] = Object.hasOwn(node.attributes, 'display_value') ? { value: node.text, display_value: node.attributes.display_value } : node.text;
    }
  });
  try { parser.write(xml).close(); } catch (error) { throw error.code ? error : malformed('Version payload is not readable update XML.'); }
  if (!records.length) throw malformed('Version payload holds no update record.');
  return records;
}

export function lineDiff(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let endX = x.length;
  let endY = y.length;
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) { endX--; endY--; }
  const xs = x.slice(start, endX);
  const ys = y.slice(start, endY);
  if (xs.length * ys.length > MAX_LINE_CELLS) return { truncated: true, first_line: start + 1, removed: xs.length, added: ys.length };
  const table = Array.from({ length: xs.length + 1 }, () => new Uint32Array(ys.length + 1));
  for (let i = xs.length - 1; i >= 0; i--) for (let j = ys.length - 1; j >= 0; j--) table[i][j] = xs[i] === ys[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const changes = [];
  let i = 0;
  let j = 0;
  while (i < xs.length || j < ys.length) {
    if (i < xs.length && j < ys.length && xs[i] === ys[j]) { i++; j++; }
    else if (j >= ys.length || (i < xs.length && table[i + 1][j] >= table[i][j + 1])) changes.push({ op: '-', line: start + ++i, text: xs[i - 1] });
    else changes.push({ op: '+', line: start + ++j, text: ys[j - 1] });
  }
  return { changes };
}

function keyed(records) {
  const map = new Map();
  for (const record of records) {
    const id = raw(record.fields.sys_id);
    let key = `${record.table}:${id || 0}`;
    for (let n = 1; !id && map.has(key); n++) key = `${record.table}:${n}`;
    map.set(key, record);
  }
  return map;
}

function fieldChange(field, a, b) {
  if (a === undefined) return { field, status: 'added', b };
  if (b === undefined) return { field, status: 'removed', a };
  if (raw(a) === raw(b)) return null;
  if (raw(a).includes('\n') || raw(b).includes('\n')) return { field, status: 'changed', lines: lineDiff(raw(a), raw(b)) };
  return { field, status: 'changed', a, b };
}

// Older version on the left, current on the right, as the platform's Compare to Current shows.
export function diffPayloads(older, current) {
  const left = keyed(older);
  const right = keyed(current);
  const records = [];
  for (const key of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const a = left.get(key);
    const b = right.get(key);
    const base = { table: (a || b).table, sys_id: raw((a || b).fields.sys_id) };
    if (!a || !b) { records.push({ ...base, status: a ? 'removed' : 'added', label: text((a || b).fields.sys_name ?? (a || b).fields.name ?? (a || b).fields.element) }); continue; }
    const fields = a.action === b.action ? [] : [{ field: '(action)', status: 'changed', a: a.action, b: b.action }];
    const names = [...new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])].filter(name => !IGNORED_FIELDS.includes(name)).sort();
    for (const name of names) {
      const change = fieldChange(name, a.fields[name], b.fields[name]);
      if (change) fields.push(change);
    }
    if (fields.length) records.push({ ...base, status: 'changed', fields });
  }
  return records;
}

function validate(limit, diff) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw errUsage('--limit must be an integer from 1 to 200.');
  if (diff !== undefined && (!Number.isSafeInteger(diff) || diff < 1 || diff > 200)) throw errUsage('--diff must be a version number from 1 to 200 (1 is the newest).');
}

async function payloadOf(sdk, query, name, expectOne) {
  const rows = await read(sdk, VERSION, query, 'sys_id,name,state,payload', 2, 'false');
  assertName(rows, 'name', name, VERSION);
  if (!rows.length) return null;
  if (rows.length > 1 && expectOne) throw malformed(`More than one current version exists for ${name}.`);
  return { sys_id: raw(rows[0].sys_id), records: parsePayload(raw(rows[0].payload)) };
}

export async function recordVersions(sdk, { table, identifier, identifierField, limit = 20, diff } = {}) {
  validate(limit, diff);
  const record = await resolveRecord(sdk, { table, identifier, identifierField, fields: ['sys_update_name', 'sys_class_name'], resource: 'Record' });
  const sysId = unwrapSysId(record);
  if (!/^[0-9a-f]{32}$/i.test(sysId)) throw malformed('The matched record has no readable sys_id; check field ACLs before retrying.');
  const updateName = raw(record.sys_update_name);
  const name = updateName || `${raw(record.sys_class_name) || table}_${sysId}`;
  assertSafeExactMatch(name);
  const notes = updateName ? [] : [`The record has no readable sys_update_name; versions were looked up as ${name}.`];

  const rows = await read(sdk, VERSION, `name=${name}^ORDERBYDESCsys_recorded_at^ORDERBYDESCsys_id`, VERSION_FIELDS, Math.max(limit, diff || 0) + 1);
  assertName(rows, 'name', name, VERSION);
  const shown = Math.max(limit, diff || 0);
  const versions = rows.slice(0, shown).map((row, index) => ({ number: index + 1, ...row }));
  const updates = await read(sdk, UPDATE, `name=${name}^update_setISNOTEMPTY^ORDERBYDESCsys_updated_on^ORDERBYDESCsys_id`, UPDATE_FIELDS, limit + 1);
  assertName(updates, 'name', name, UPDATE);
  // --get splits paths on dots, so the dot-walked state gets a plain key.
  const captures = updates.slice(0, limit).map(({ 'update_set.state': state, ...row }) => ({ ...row, update_set_state: state ?? null }));

  if (!versions.length) notes.push(`No versions found for ${name}. Versions exist only for records tracked by update sets that someone changed, or that an upgrade or app installed; tables in glide.update.suppress_update_version keep none, and ACLs can hide them. This does not mean the record is unchanged.`);
  if (!updates.length) notes.push(`No sys_update_xml row in an update set was readable for ${name}; ACLs can hide rows, and records an upgrade or app installed have none.`);
  if (updates.length > limit) notes.push(limit < 200 ? 'More captured updates exist; raise --limit (up to 200) to list them.' : 'More captured updates exist; only the newest 200 are listed.');
  if (rows.length > shown) notes.push(shown < 200 ? 'More versions exist; raise --limit (up to 200) to list them.' : 'More versions exist; only the newest 200 can be listed or compared.');
  const data = {
    table, record: { sys_id: sysId, table: raw(record.sys_class_name) || table, update_name: name },
    count: versions.length, versions, pagination: { limit: shown, has_more: rows.length > shown },
    latest_update: captures[0] || null, updates: captures, updates_pagination: { limit, has_more: updates.length > limit }, notes,
  };
  if (diff === undefined) return data;

  const version = versions[diff - 1];
  if (!version) throw errUsage(`Version ${diff} does not exist; ${name} has ${versions.length} version(s).`);
  if (raw(version.state) === 'current') throw errUsage(`Version ${diff} is the current version; there is nothing to compare. Pick an older one, for example --diff ${diff + 1}.`);
  const current = await payloadOf(sdk, `name=${name}^state=current`, name, true);
  if (!current) throw malformed(`No current version exists for ${name}, so there is nothing to compare against.`);
  const older = await payloadOf(sdk, `sys_id=${raw(version.sys_id)}`, name, false);
  if (!older || older.sys_id !== raw(version.sys_id)) throw malformed(`Version ${diff} (${raw(version.sys_id)}) was not returned; it may have been deleted or is not readable.`);
  const records = diffPayloads(older.records, current.records);
  data.diff = { version: diff, version_sys_id: older.sys_id, current_sys_id: current.sys_id, status: records.length ? 'different' : 'equal', ignored_fields: IGNORED_FIELDS, records };
  notes.push('Current means the version in state current, as the platform\'s Compare to Current uses; the live record is not read.');
  return data;
}

function versionLine(row) {
  const source = text(row.source) || text(row.source_table) || '(source unavailable)';
  return `${String(row.number).padStart(3)}  ${raw(row.state).padEnd(8)}  ${raw(row.action).padEnd(16)}  ${text(row.sys_created_on)}  ${text(row.sys_created_by)}  ${source}${raw(row.reverted_from) ? `  reverted from ${raw(row.reverted_from)}` : ''}  [${raw(row.sys_id)}]`;
}

function valueText(value) {
  return value === undefined ? '(none)' : JSON.stringify(text(value));
}

export function formatChanges(records) {
  const lines = [];
  for (const record of records) {
    lines.push(`  ${record.status.toUpperCase()} ${record.table} ${record.sys_id || '(no sys_id)'}${record.label ? ` ${record.label}` : ''}`);
    for (const field of record.fields || []) {
      if (!field.lines) { lines.push(`    ${field.status.toUpperCase()} ${field.field}: ${valueText(field.a)} -> ${valueText(field.b)}`); continue; }
      lines.push(`    CHANGED ${field.field}:`);
      if (field.lines.truncated) lines.push(`      too large to diff by line: ${field.lines.removed} line(s) replaced by ${field.lines.added} from line ${field.lines.first_line}`);
      else lines.push(...field.lines.changes.map(change => `      ${change.op}${change.line}: ${change.text}`));
    }
  }
  return lines;
}

export function formatVersions(data) {
  const lines = [`Versions of ${data.record.table} ${data.record.sys_id} (${data.record.update_name}), newest first (read-only)`];
  lines.push(...data.versions.map(versionLine));
  lines.push(...(data.updates.length
    ? ['', `${data.updates.length} captured update(s), latest first:`, ...data.updates.map((update, index) => `  ${index ? ' ' : '*'} "${text(update.update_set)}" [${raw(update.update_set_state) || '?'}] [${raw(update.update_set)}], ${text(update.sys_updated_on)} by ${text(update.sys_updated_by)} (${raw(update.action)}) [${raw(update.sys_id)}]`)]
    : ['', 'Captured updates: none readable in sys_update_xml for this record.']));
  if (data.diff) {
    const { diff } = data;
    lines.push('', `Version ${diff.version} [${diff.version_sys_id}] -> current [${diff.current_sys_id}]: ${diff.status === 'equal' ? 'no differences' : `${diff.records.length} record(s) differ`} (ignoring ${diff.ignored_fields.join(', ')})`);
    lines.push(...formatChanges(diff.records));
  }
  lines.push(...data.notes);
  return lines.join('\n');
}
