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
    oldValue: (r.oldvalue?.display_value ?? r.oldvalue?.value ?? r.oldvalue) || '',
    newValue: (r.newvalue?.display_value ?? r.newvalue?.value ?? r.newvalue) || '',
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

async function fetchFlows(app, sysId) {
  const params = new URLSearchParams();
  params.set('sysparm_query', `source_record=${sysId}`);
  params.set('sysparm_limit', '20');
  params.set('sysparm_fields', 'flow_catalog_model,execution_id,state,engine_major_version,sys_created_on,origins');
  params.set('sysparm_display_value', 'all');
  try {
    const records = await app.sdk.list('sys_flow_context', params);
    return records.map(r => ({
      flow: r.flow_catalog_model?.display_value || r.flow_catalog_model,
      executionId: r.execution_id?.display_value || r.execution_id,
      state: r.state?.display_value || r.state,
      version: r.engine_major_version?.display_value || r.engine_major_version,
      started: r.sys_created_on?.display_value || r.sys_created_on,
    }));
  } catch {
    return []; // Flow Designer might not be installed
  }
}

export function formatInspectOutput(data) {
  const lines = [];
  lines.push('');
  lines.push(`\u{1F4CB} ${data.table}  ${data.sys_id}`);
  lines.push('');

  // History section
  lines.push('\u25B6 HISTORY');
  lines.push('\u2500'.repeat(50));
  if (data.history.length === 0) {
    lines.push('  (no audit history found)');
  } else {
    for (const h of data.history.slice(0, 10)) {
      lines.push(`  ${h.changedOn}  ${h.changedBy}  ${h.field}: ${h.oldValue || '(empty)'} \u2192 ${h.newValue}`);
    }
    if (data.history.length > 10) {
      lines.push(`  ... and ${data.history.length - 10} more`);
    }
  }
  lines.push('');

  // Business rules section
  lines.push('\u25B6 BUSINESS RULES');
  lines.push('\u2500'.repeat(50));
  if (data.businessRules.length === 0) {
    lines.push('  (no active business rules on this table)');
  } else {
    for (const br of data.businessRules) {
      lines.push(`  [${br.order}] ${br.name}${br.scope !== 'global' ? ` (${br.scope})` : ''}`);
    }
  }
  lines.push('');

  // Flows section
  lines.push('\u25B6 RUNNING FLOWS');
  lines.push('\u2500'.repeat(50));
  if (data.flows.length === 0) {
    lines.push('  (no running flows for this record)');
  } else {
    for (const f of data.flows) {
      lines.push(`  Flow: ${f.flow}`);
      lines.push(`  Status: ${f.state} | Version: ${f.version}`);
      if (f.started) lines.push(`  Started: ${f.started}`);
      lines.push('');
    }
  }
  lines.push('');

  return lines.join('\n');
}

export async function inspectRecord(app, table, identifier) {
  const sysId = await resolveIdentifier(app, table, identifier);
  const [history, businessRules, flows] = await Promise.all([
    fetchHistory(app, table, sysId),
    fetchBusinessRules(app, table),
    fetchFlows(app, sysId),
  ]);
  return { table, sys_id: sysId, history, businessRules, flows };
}
