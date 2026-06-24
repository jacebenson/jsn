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
    oldValue: (r.oldvalue?.display_value ?? r.oldvalue?.value ?? '') || '',
    newValue: (r.newvalue?.display_value ?? r.newvalue?.value ?? '') || '',
    _oldRaw: r.oldvalue?.value ?? r.oldvalue ?? '',
    _newRaw: r.newvalue?.value ?? r.newvalue ?? '',
    changedOn: r.sys_created_on?.display_value || r.sys_created_on,
    changedBy: r.sys_created_by?.display_value || r.sys_created_by,
  }));
}

// Known choice fields and their display labels from sys_choice
const CHOICE_FIELDS = new Set(['state', 'incident_state', 'priority', 'impact', 'urgency', 'active', 'category', 'subcategory']);

// Known sys_user reference fields
const USER_REF_FIELDS = new Set(['closed_by', 'assigned_to', 'opened_by', 'resolved_by', 'called_by', 'caller_id']);

// Boolean fields stored as 0/1 in sys_audit
const BOOL_FIELDS = new Set(['active']);

async function resolveHistoryDisplayValues(app, table, history) {
  // Collect unique sys_ids for user reference resolution
  const userSysIds = new Set();
  for (const h of history) {
    if (USER_REF_FIELDS.has(h.field)) {
      if (isHexString(h.oldValue) && h.oldValue.length === 32) userSysIds.add(h.oldValue);
      if (isHexString(h.newValue) && h.newValue.length === 32) userSysIds.add(h.newValue);
    }
  }

  // Batch lookup user names
  const userNameMap = new Map();
  if (userSysIds.size > 0) {
    const idList = [...userSysIds].join(',');
    const params = new URLSearchParams();
    params.set('sysparm_query', `sys_idIN${idList}`);
    params.set('sysparm_limit', '100');
    params.set('sysparm_fields', 'sys_id,name');
    params.set('sysparm_display_value', 'all');
    try {
      const users = await app.sdk.list('sys_user', params);
      for (const u of users) {
        const uid = getStringField(u, 'sys_id');
        const name = u.name?.display_value || u.name;
        if (uid && name) userNameMap.set(uid, name);
      }
    } catch { /* non-fatal */ }
  }

  // Collect unique (field, value) pairs for choice resolution
  const choiceLookups = new Set();
  for (const h of history) {
    if (CHOICE_FIELDS.has(h.field)) {
      if (h.oldValue && h.oldValue !== '_raw_old_') choiceLookups.add(`${h.field}|${h.oldValue}`);
      if (h.newValue && h.newValue !== '_raw_new_') choiceLookups.add(`${h.field}|${h.newValue}`);
    }
  }

  // Batch lookup choice labels
  const choiceLabelMap = new Map();
  if (choiceLookups.size > 0) {
    for (const key of choiceLookups) {
      const [field, val] = key.split('|');
      const params = new URLSearchParams();
      params.set('sysparm_query', `name=${table}^element=${field}^value=${val}^language=en`);
      params.set('sysparm_limit', '1');
      params.set('sysparm_fields', 'value,label');
      params.set('sysparm_display_value', 'all');
      try {
        const choices = await app.sdk.list('sys_choice', params);
        if (choices.length > 0) {
          const label = choices[0].label?.display_value || choices[0].label;
          if (label) choiceLabelMap.set(key, label);
        }
      } catch { /* non-fatal */ }
    }
  }

  // Apply resolutions to history entries
  return history.map(h => {
    let oldDisplay = h.oldValue;
    let newDisplay = h.newValue;

    // Resolve user references
    if (USER_REF_FIELDS.has(h.field)) {
      if (isHexString(oldDisplay) && oldDisplay.length === 32) {
        oldDisplay = userNameMap.get(oldDisplay) || oldDisplay || '(empty)';
      }
      if (isHexString(newDisplay) && newDisplay.length === 32) {
        newDisplay = userNameMap.get(newDisplay) || newDisplay || '(empty)';
      }
    }

    // Resolve choice labels
    if (CHOICE_FIELDS.has(h.field)) {
      const oldLabel = choiceLabelMap.get(`${h.field}|${h.oldValue}`);
      const newLabel = choiceLabelMap.get(`${h.field}|${h.newValue}`);
      if (oldLabel) oldDisplay = oldLabel;
      if (newLabel) newDisplay = newLabel;
    }

    // Resolve boolean fields
    if (BOOL_FIELDS.has(h.field)) {
      if (oldDisplay === '1') oldDisplay = 'Yes';
      else if (oldDisplay === '0') oldDisplay = 'No';
      if (newDisplay === '1') newDisplay = 'Yes';
      else if (newDisplay === '0') newDisplay = 'No';
    }

    return { ...h, oldValue: oldDisplay || '(empty)', newValue: newDisplay || '(empty)' };
  });
}

async function fetchBusinessRules(app, table) {
  const params = new URLSearchParams();
  params.set('sysparm_query', `collection=${table}^active=true`);
  params.set('sysparm_limit', '50');
  params.set('sysparm_fields', 'name,collection,order,active,sys_scope,when,filter_condition');
  params.set('sysparm_display_value', 'all');
  params.set('sysparm_order_by', 'order');
  const records = await app.sdk.list('sys_script', params);
  return records
    .map(r => ({
      name: r.name?.display_value || r.name,
      order: r.order?.display_value || r.order,
      scope: r.sys_scope?.display_value || r.sys_scope || 'global',
      when: r.when?.display_value || r.when || '',
      condition: r.filter_condition?.display_value || r.filter_condition?.value || '',
    }))
    .sort((a, b) => {
      const aOrder = parseInt(String(a.order).replace(/,/g, ''), 10) || 0;
      const bOrder = parseInt(String(b.order).replace(/,/g, ''), 10) || 0;
      return aOrder - bOrder;
    });
}

async function fetchFlows(app, sysId) {
  const params = new URLSearchParams();
  params.set('sysparm_query', `source_record=${sysId}`);
  params.set('sysparm_limit', '20');
  params.set('sysparm_fields', 'flow_catalog_model,name,execution_id,state,engine_major_version,sys_created_on,origins,calling_source');
  params.set('sysparm_display_value', 'all');
  try {
    const records = await app.sdk.list('sys_flow_context', params);
    return records.map(r => ({
      flow: r.name?.display_value || r.name || r.flow_catalog_model?.display_value || r.flow_catalog_model?.value || '(deleted flow)',
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
    // Group by execution phase: before → display → after → async
    const phases = ['before', 'display', 'after', 'async'];
    const grouped = {};
    for (const br of data.businessRules) {
      const phase = br.when?.toLowerCase() || '';
      if (!grouped[phase]) grouped[phase] = [];
      grouped[phase].push(br);
    }
    for (const phase of phases) {
      const rules = grouped[phase]?.sort((a, b) => {
        const aOrder = parseInt(String(a.order).replace(/,/g, ''), 10) || 0;
        const bOrder = parseInt(String(b.order).replace(/,/g, ''), 10) || 0;
        return aOrder - bOrder;
      });
      if (!rules || rules.length === 0) continue;
      lines.push(`  ${phase.charAt(0).toUpperCase() + phase.slice(1)}:`);
      for (const br of rules) {
        lines.push(`    [${br.order}] ${br.name}${br.scope !== 'global' ? ` (${br.scope})` : ''}`);
        if (br.condition) {
          const cond = br.condition.length > 80 ? br.condition.substring(0, 77) + '...' : br.condition;
          lines.push(`       Condition: ${cond}`);
        }
      }
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
  const [rawHistory, businessRules, flows] = await Promise.all([
    fetchHistory(app, table, sysId),
    fetchBusinessRules(app, table),
    fetchFlows(app, sysId),
  ]);
  const history = await resolveHistoryDisplayValues(app, table, rawHistory);
  return { table, sys_id: sysId, history, businessRules, flows };
}
