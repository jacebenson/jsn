import { errUsage } from './errors.js';

const TABLE = 'sys_flow_execution_setting';
// The table's choice values. An empty field leaves the instance-wide property in force.
const LEVELS = { reporting: ['OFF', 'BASIC', 'FULL', 'TRACE'], logging: ['DEBUG', 'INFO', 'WARN', 'ERROR'] };
const raw = value => value && typeof value === 'object' ? String(value.value ?? '') : String(value ?? '');
const shown = level => level || 'not set';
const describe = (changes, from) => Object.entries(changes).map(([field, level]) => from ? `${field} ${shown(from[field])} -> ${level}` : `${field} ${level}`).join(', ');

export function requestedLevels(argv) {
  const requested = {};
  for (const [field, levels] of Object.entries(LEVELS)) {
    if (argv[field] === undefined) continue;
    const level = typeof argv[field] === 'string' ? argv[field].trim().toUpperCase() : '';
    if (!levels.includes(level)) throw errUsage(`--${field} must be one of ${levels.join(', ')}.`);
    requested[field] = level;
  }
  return requested;
}

async function readSetting(sdk, source, sourceType) {
  const rows = await sdk.listStrict(TABLE, new URLSearchParams({ sysparm_query: `source=${source}^source_type=${sourceType}`, sysparm_fields: 'sys_id,source,source_type,reporting,logging', sysparm_limit: '2', sysparm_display_value: 'false' }));
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw Object.assign(new Error(`Malformed table response for ${TABLE}`), { code: 'malformed_response' });
  if (rows.some(row => raw(row.source) !== source || raw(row.source_type) !== sourceType)) throw new Error(`${TABLE} returned a row for a different source.`);
  if (rows.length > 1) throw errUsage(`More than one ${TABLE} row exists for ${source}; remove the extra one in Workflow Studio first. Nothing was written.`);
  return rows[0] ? { sys_id: raw(rows[0].sys_id), reporting: raw(rows[0].reporting), logging: raw(rows[0].logging) } : null;
}

// flow: { sys_id, name, type, table } where table is sys_hub_flow or sys_hub_action_type_definition.
export async function setFlowSettings(sdk, { flow, requested, write, rerunFlags = [] }) {
  const setting = await readSetting(sdk, flow.sys_id, flow.table);
  const changes = Object.fromEntries(Object.entries(requested).filter(([field, level]) => setting?.[field] !== level));
  const note = flow.type === 'subflow' || flow.type === 'action' ? `When this ${flow.type} runs from a flow, the parent flow's setting applies.` : null;
  const base = { flow, table: TABLE, setting, requested, changes, note };
  const pending = Object.keys(changes).length;
  if (!write || !pending) {
    const rerun = pending ? ['jsn', 'flows', 'settings', flow.sys_id, ...rerunFlags, ...Object.entries(changes).flatMap(([field, level]) => [`--${field}`, level]), '--yes'].join(' ') : null;
    return { ...base, written: false, verified: null, after: null, rerun };
  }
  if (setting) await sdk.update(TABLE, setting.sys_id, changes);
  else await sdk.create(TABLE, { source: flow.sys_id, source_type: flow.table, ...changes });
  // The write happened; a failed read-back is reported as unverified, never thrown away as an error.
  let after = null, verificationError;
  try { after = await readSetting(sdk, flow.sys_id, flow.table); } catch (error) { verificationError = error.message; }
  const verified = Boolean(after) && Object.entries(changes).every(([field, level]) => after[field] === level);
  return { ...base, written: true, verified, after, rerun: null, ...(verificationError ? { verification_error: verificationError } : {}) };
}

export function flowSettingsSummary(data) {
  const { flow, setting, requested, changes, written, verified, after } = data;
  const name = `${flow.type} "${flow.name}"`;
  if (written) return verified ? `Set ${describe(changes)} on ${name} in ${TABLE} ${after.sys_id}; read back and verified` : `Wrote ${describe(changes)} for ${name} but the read-back did not confirm it`;
  if (Object.keys(changes).length) return `Preview for ${name}: ${describe(changes, setting || {})}; nothing written`;
  if (Object.keys(requested).length) return `${name[0].toUpperCase()}${name.slice(1)} already has ${describe(requested)}; nothing written`;
  return setting ? `${name[0].toUpperCase()}${name.slice(1)}: reporting ${shown(setting.reporting)}, logging ${shown(setting.logging)} in ${TABLE} ${setting.sys_id}` : `${name[0].toUpperCase()}${name.slice(1)} has no readable ${TABLE} row, so the instance-wide levels apply`;
}

export function formatFlowSettings(data) {
  const { flow, setting, changes, written, verified, after, note, rerun } = data;
  // After a write the row as read back is the truth; before one, the change is what would be written.
  const current = written ? after : setting;
  const lines = [`${flow.name} (${flow.type} ${flow.sys_id}): ${current ? `${TABLE} ${current.sys_id}` : written ? `${TABLE} row not read back` : `no readable ${TABLE} row, so the instance-wide levels apply`}`];
  for (const field of Object.keys(LEVELS)) {
    const from = shown(setting?.[field]), to = written ? after && shown(after[field]) : changes[field];
    lines.push(`  ${field[0].toUpperCase()}${field.slice(1)}: ${from}${to && to !== from ? ` -> ${to}` : ''}`);
  }
  if (['FULL', 'TRACE'].includes(changes.reporting)) lines.push('Full and Trace keep every step input and output value. ServiceNow advises them for debugging on non-production instances only; lower the level again when done.');
  if (note) lines.push(note);
  if (rerun) lines.push('', `Preview only; nothing written. To write: ${rerun}`);
  else if (written) lines.push('', verified ? `Written and read back: ${TABLE} ${after.sys_id}.` : `Written, but the read-back does not show the requested levels${data.verification_error ? ` (${data.verification_error})` : ''}. Check ${TABLE} for source ${flow.sys_id}.`);
  else if (Object.keys(data.requested).length) lines.push('', 'Already at the requested levels; nothing written.');
  return lines.join('\n');
}
