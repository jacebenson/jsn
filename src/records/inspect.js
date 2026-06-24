import { isHexString, getStringField } from '../helpers.js';

export async function resolveIdentifier(app, table, identifier) {
  // If it looks like a sys_id (32 hex chars), use it directly
  if (isHexString(identifier) && identifier.length === 32) {
    return identifier;
  }

  // Otherwise, assume it's a record number — query the table
  const params = new URLSearchParams();
  params.set('sysparm_query', `number=${identifier}`);
  params.set('sysparm_limit', '1');
  params.set('sysparm_fields', 'sys_id');
  const records = await app.sdk.list(table, params);
  if (records.length === 0) {
    throw new Error(`Record not found in ${table}: ${identifier}`);
  }
  return getStringField(records[0], 'sys_id');
}

export async function inspectRecord(app, table, identifier) {
  const sysId = await resolveIdentifier(app, table, identifier);
  return { table, sys_id: sysId, history: [], businessRules: [], flows: [] };
}
