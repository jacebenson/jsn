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

async function fetchHistory(app, table, sysId, limit = 20) {
  const params = new URLSearchParams();
  params.set('sysparm_query', `documentkey=${sysId}^tablename=${table}`);
  params.set('sysparm_limit', String(limit));
  params.set('sysparm_fields', 'fieldname,newvalue,oldvalue,sys_created_on,sys_created_by');
  params.set('sysparm_display_value', 'all');
  params.set('sysparm_order_by', 'sys_created_on');
  const records = await app.sdk.list('sys_audit', params);
  return records.map(r => ({
    field: r.fieldname?.display_value || r.fieldname,
    oldValue: r.oldvalue?.display_value || r.oldvalue,
    newValue: r.newvalue?.display_value || r.newvalue,
    changedOn: r.sys_created_on?.display_value || r.sys_created_on,
    changedBy: r.sys_created_by?.display_value || r.sys_created_by,
  }));
}

async function fetchBusinessRules(app, table) {
  const params = new URLSearchParams();
  params.set('sysparm_query', `collection=${table}^active=true`);
  params.set('sysparm_limit', '50');
  params.set('sysparm_fields', 'name,collection,order,active,sys_scope');
  params.set('sysparm_display_value', 'all');
  params.set('sysparm_order_by', 'order');
  const records = await app.sdk.list('sys_script', params);
  return records.map(r => ({
    name: r.name?.display_value || r.name,
    order: r.order?.display_value || r.order,
    scope: r.sys_scope?.display_value || r.sys_scope || 'global',
  }));
}

export async function inspectRecord(app, table, identifier) {
  const sysId = await resolveIdentifier(app, table, identifier);
  const [history, businessRules] = await Promise.all([
    fetchHistory(app, table, sysId),
    fetchBusinessRules(app, table),
  ]);
  return { table, sys_id: sysId, history, businessRules, flows: [] };
}
