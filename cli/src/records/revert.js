import { errUsage } from '../errors.js';
import { resolveRecord, unwrapSysId } from '../resolve-record.js';
import { diffPayloads, formatChanges, malformed, parsePayload, raw, read } from './versions.js';

const VERSION = 'sys_update_version';
const FIELDS = 'sys_id,name,state,source_table,source,reverted_from,sys_recorded_at,payload';
const BASE_TABLES = ['sys_upgrade_history', 'sys_store_app'];
const ID = /^[0-9a-f]{32}$/;
// Update names and table names go into a background script; nothing outside this set does.
const NAME = /^[A-Za-z0-9_.$-]+$/;

async function currentVersion(sdk, name) {
  const rows = await read(sdk, VERSION, `name=${name}^state=current`, FIELDS, 2, 'false');
  if (rows.some(row => raw(row.name) !== name)) throw malformed(`${VERSION} returned a row for another record than ${name}.`);
  if (rows.length > 1) throw malformed(`More than one current version exists for ${name}; inspect it with jsn records versions before reverting.`);
  if (!rows.length) throw errUsage(`No current version exists for ${name}, so there is nothing to revert from.`);
  return rows[0];
}

const mainRecord = (records, sysId) => records.find(record => raw(record.fields.sys_id) === sysId);

export async function planRevert(sdk, { table, identifier, identifierField, version } = {}) {
  if (version !== undefined && !ID.test(String(version))) throw errUsage('--version must be the 32-character sys_id of a sys_update_version row; list them with jsn records versions.');
  const record = await resolveRecord(sdk, { table, identifier, identifierField, fields: ['sys_update_name', 'sys_class_name'], resource: 'Record' });
  const sysId = unwrapSysId(record);
  if (!ID.test(sysId)) throw malformed('The matched record has no readable sys_id; check field ACLs before retrying.');
  const name = raw(record.sys_update_name) || `${raw(record.sys_class_name) || table}_${sysId}`;
  if (!NAME.test(name)) throw errUsage(`The update name ${name} holds characters jsn will not put into a script.`);

  const current = await currentVersion(sdk, name);
  const query = version ? `sys_id=${version}` : `name=${name}^source_tableIN${BASE_TABLES.join(',')}^ORDERBYDESCsys_recorded_at^ORDERBYDESCsys_id`;
  const [target] = await read(sdk, VERSION, query, FIELDS, 1, 'false');
  if (version && (raw(target?.sys_id) !== version || raw(target.name) !== name)) throw errUsage(`${version} is not a version of ${name}; list them with jsn records versions ${table} ${sysId}.`);
  if (!target) throw errUsage(`${name} has no base system version: it was created on this instance, or its base version is not readable. Pass --version to revert to one of its own versions.`);
  const base = BASE_TABLES.includes(raw(target.source_table));
  if (raw(target.sys_id) === raw(current.sys_id)) throw errUsage(version ? `${version} is the current version of ${name}; there is nothing to revert.` : `${name} is already at its base system version.`);

  const targetRecords = parsePayload(raw(target.payload));
  const main = mainRecord(targetRecords, sysId);
  if (!main) throw errUsage(`Version ${raw(target.sys_id)} holds no row for ${table} ${sysId}; it cannot be checked after a revert.`);
  if (main.action === 'DELETE') throw errUsage(`Version ${raw(target.sys_id)} deletes ${name}; jsn records revert does not delete records.`);
  const changes = diffPayloads(parsePayload(raw(current.payload)), targetRecords);
  if (!changes.length) throw errUsage(`The current version of ${name} already matches version ${raw(target.sys_id)}; there is nothing to revert.`);
  const changed = changes.find(change => change.sys_id === sysId)?.fields?.map(field => field.field).filter(field => !field.startsWith('(')) || [];
  const expected = Object.fromEntries(changed.filter(field => !field.startsWith('sys_')).map(field => [field, raw(main.fields[field])]));
  return {
    table, sys_id: sysId, update_name: name, base, from_version: raw(current.sys_id), to_version: raw(target.sys_id),
    to_source: { source_table: raw(target.source_table), source: raw(target.source), recorded_at: raw(target.sys_recorded_at) },
    changes, changed_fields: changed, expected,
  };
}

export function revertQuestion(plan) {
  const to = plan.base ? `its base system version ${plan.to_version} (${plan.to_source.source_table})` : `version ${plan.to_version} (${plan.to_source.source_table}, recorded ${plan.to_source.recorded_at})`;
  const others = plan.changes.filter(change => change.sys_id !== plan.sys_id).length;
  return `Revert ${plan.table} ${plan.update_name} to ${to}; changes ${plan.changed_fields.join(', ') || 'no fields of the record itself'}${others ? ` and ${others} other record(s) in the update` : ''}`;
}

export async function applyRevert(sdk, plan) {
  const { table, sys_id: sysId, update_name: name, from_version: from, to_version: to } = plan;
  for (const [key, value, pattern] of [['table', table, NAME], ['sys_id', sysId, ID], ['update name', name, NAME], ['current version', from, ID], ['target version', to, ID]]) {
    if (!pattern.test(String(value ?? ''))) throw errUsage(`Invalid ${key} in the revert plan; jsn will not put it into a script.`);
  }
  const output = await sdk.executeScript(`(function() {
  if (!gs.hasRole('admin')) throw new Error('Admin role required');
  var target = new GlideRecord('sys_update_version');
  if (!target.get('${to}') || target.getValue('name') !== '${name}') throw new Error('Version ${to} is not a version of ${name}');
  var current = new GlideRecord('sys_update_version');
  current.addQuery('name', '${name}');
  current.addQuery('state', 'current');
  current.query();
  if (current.getRowCount() !== 1 || !current.next() || current.getUniqueValue() !== '${from}') throw new Error('The current version of ${name} changed since the preview');
  if (!GlideappUpdateVersion.canWriteRecordInVersion('${to}')) throw new Error('Not allowed to write the record in version ${to}');
  gs.print('JSN_REVERT:' + new GlideappUpdateVersion().revert('${to}'));
})();`, 'global');
  const said = String(output ?? '');
  if (said.includes('JSN_REVERT:false')) throw new Error(`The platform did not revert ${name} to version ${to}. Only the newest base system version can be reverted to, and the revert needs the upgrade_admin or delegated_developer role.`);
  if (!said.includes('JSN_REVERT:true')) throw new Error(`Revert outcome is unknown; inspect ${table} ${sysId} with jsn records versions before retrying. Script output: ${said || '(none)'}`);

  const now = await currentVersion(sdk, name);
  if (raw(now.reverted_from) !== to) throw new Error(`The current version of ${name} after the revert is ${raw(now.sys_id)}, not a revert of version ${to}; inspect it with jsn records versions before retrying.`);
  const fields = Object.keys(plan.expected || {});
  const [live] = await read(sdk, table, `sys_id=${sysId}`, ['sys_id', ...fields].join(','), 1, 'false');
  if (raw(live?.sys_id) !== sysId) throw new Error(`Version ${raw(now.sys_id)} reverts ${name} to ${to}, but ${table} ${sysId} could not be read after the revert; inspect it before retrying.`);
  const unread = fields.filter(field => !Object.hasOwn(live, field));
  if (unread.length) throw new Error(`Version ${raw(now.sys_id)} reverts ${name} to ${to}, but jsn could not read ${unread.join(', ')} on the live record to verify it; inspect it before retrying.`);
  const differs = fields.filter(field => raw(live[field]) !== plan.expected[field]);
  if (differs.length) throw new Error(`Version ${raw(now.sys_id)} reverts ${name} to ${to}, but the live record still differs from version ${to} in: ${differs.join(', ')}; inspect it before retrying.`);
  return { reverted: true, table, sys_id: sysId, update_name: name, base: plan.base, from_version: from, to_version: to, to_source: plan.to_source, new_version: raw(now.sys_id), changes: plan.changes };
}

export function formatRevert(data) {
  return [
    `Reverted ${data.table} ${data.sys_id} (${data.update_name}) to ${data.base ? 'its base system version' : 'version'} [${data.to_version}] from ${data.to_source.source_table}`,
    `New current version [${data.new_version}]; the version before the revert was [${data.from_version}]`,
    ...formatChanges(data.changes),
  ].join('\n');
}
