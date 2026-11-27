// `columns why <table>.<field> --record <number|sys_id> [--user <user>]`
//
// Read-only answer to "what makes this field read-only, mandatory or hidden on
// this record?". Dictionary, overrides, UI policies, data policies and write
// ACLs are server-side evidence. Client scripts are candidates only and are
// never executed.

import { getStringField } from './helpers.js';
import { errUsage } from './errors.js';
import { resolveRecord, unwrapSysId } from './resolve-record.js';
import { discoverTableBehavior } from './table-behavior.js';
import {
  assertFieldName, assertTableName, loadFieldCatalog, probeCondition,
  resolveTargetRecord, recordLabel,
} from './why-checks.js';

function truthy(value) {
  return String(value ?? '').toLowerCase() === 'true';
}

function actionValue(value) {
  const normalized = String(value ?? '').toLowerCase();
  return normalized === '' || normalized === 'ignore' ? undefined : normalized;
}

function aclScope(name, table, ancestors, field) {
  if (name === `${table}.${field}`) return { level: 'field', table, inherited: false };
  if (name === `*.${field}`) return { level: 'field', table: 'global', inherited: true };
  if (name === table) return { level: 'table', table, inherited: false };
  if (name === `${table}.*`) return { level: 'table', table, inherited: false, wildcard: true };
  if (name === '*' || name === '*.*') return { level: 'global', table: 'global', inherited: true };
  for (const ancestor of ancestors) {
    if (name === `${ancestor}.${field}`) return { level: 'field', table: ancestor, inherited: true };
    if (name === ancestor) return { level: 'table', table: ancestor, inherited: true };
    if (name === `${ancestor}.*`) return { level: 'table', table: ancestor, inherited: true, wildcard: true };
  }
  return null;
}

function parseColumn(value, argv = {}) {
  if (argv.table && argv.field) return { table: assertTableName(argv.table), field: assertFieldName(argv.field) };
  const raw = String(value || '');
  const index = raw.indexOf('.');
  if (index <= 0 || index === raw.length - 1) {
    throw errUsage('Specify the column as <table>.<field>, e.g. incident.caller_id.',
      'Use the table name and the dictionary element, joined by a dot.');
  }
  return { table: assertTableName(raw.slice(0, index)), field: assertFieldName(raw.slice(index + 1)) };
}

async function readOverrides(sdk, { table, names, field }) {
  const rows = await sdk.listStrict('sys_dictionary_override', new URLSearchParams({
    sysparm_query: `nameIN${names.join(',')}^element=${field}`,
    sysparm_fields: 'sys_id,name,base_table,element,mandatory,mandatory_override,read_only,read_only_override,read_only_option,active',
    sysparm_limit: '100',
    sysparm_display_value: 'all',
  }));
  return rows.map(row => {
    const name = getStringField(row, 'name');
    return {
      sys_id: getStringField(row, 'sys_id'),
      name,
      base_table: getStringField(row, 'base_table') || undefined,
      element: getStringField(row, 'element') || undefined,
      active: getStringField(row, 'active') === 'true',
      mandatory: truthy(getStringField(row, 'mandatory')),
      mandatory_override: truthy(getStringField(row, 'mandatory_override')),
      read_only: truthy(getStringField(row, 'read_only')),
      read_only_override: truthy(getStringField(row, 'read_only_override')),
      read_only_option: getStringField(row, 'read_only_option') || undefined,
      applies: name === table,
    };
  });
}

async function readClientScripts(sdk, { table, ancestors, field }) {
  const names = [table, ...ancestors];
  const rows = await sdk.listStrict('sys_script_client', new URLSearchParams({
    sysparm_query: `tableIN${names.join(',')}^active=true`,
    sysparm_fields: 'sys_id,name,table,type,field,condition,applies_extended,global,script',
    sysparm_limit: '500',
    sysparm_display_value: 'all',
  }));
  if (rows.length >= 500) {
    return [{ warning: 'client-script read reached the 500-row bound; some candidates may be omitted.' }];
  }
  const word = new RegExp(`(^|[^A-Za-z0-9_])${field}(?![A-Za-z0-9_])`);
  const candidates = [];
  for (const row of rows) {
    const rowTable = getStringField(row, 'table');
    const appliesExtended = getStringField(row, 'applies_extended') === 'true';
    if (rowTable !== table && !appliesExtended) continue;
    const fieldName = getStringField(row, 'field');
    const script = getStringField(row, 'script');
    const matchedBy = fieldName === field ? 'field' : word.test(script) ? 'script text' : null;
    if (!matchedBy) continue;
    candidates.push({
      sys_id: getStringField(row, 'sys_id'),
      name: getStringField(row, 'name'),
      table: rowTable,
      type: getStringField(row, 'type') || undefined,
      field: fieldName || undefined,
      applies_extended: appliesExtended,
      global: getStringField(row, 'global') === 'true',
      matched_by: matchedBy,
      condition: getStringField(row, 'condition') || undefined,
      note: 'Client-side candidate; this command never executes the script.',
    });
  }
  return candidates;
}

export async function columnWhy(sdk, { column, table: tableOption, field: fieldOption, recordIdentifier, user }) {
  const { table, field } = parseColumn(column, { table: tableOption, field: fieldOption });
  const catalog = await loadFieldCatalog(sdk, table);
  const dictionary = catalog.fields.get(field);
  if (!dictionary) {
    throw errUsage(`Field ${field} was not found in the dictionary for ${table} or its ancestors.`,
      'Check the element name with `jsn columns list --table <table>` or `jsn tables behavior <table>`.');
  }
  const target = await resolveTargetRecord(sdk, table, recordIdentifier, { catalog });

  const [overrides, inventory, clientScripts] = await Promise.all([
    readOverrides(sdk, { table, names: catalog.names, field }),
    discoverTableBehavior(sdk, table, { categories: ['ui_policies', 'data_policies', 'access_controls'], includeInactive: false, limit: 500 }),
    readClientScripts(sdk, { table, ancestors: catalog.ancestors, field }),
  ]);
  const category = id => inventory.categories.find(section => section.category === id)?.items || [];

  const uiPolicies = [];
  for (const policy of category('ui_policies')) {
    const actions = (policy.field_actions || []).filter(action => action.field === field);
    if (!actions.length) continue;
    uiPolicies.push({
      sys_id: policy.reference.sys_id,
      name: policy.name,
      association: policy.association,
      inheritance: policy.association_detail,
      on_load: policy.on_load,
      run_scripts: policy.run_scripts,
      conditions: policy.conditions || '',
      condition: await probeCondition(sdk, { table, sysId: target.sys_id, condition: policy.conditions }),
      actions: actions.map(action => ({
        mandatory: actionValue(action.mandatory),
        disabled: actionValue(action.disabled),
        visible: actionValue(action.visible),
        cleared: actionValue(action.cleared),
        value_action: actionValue(action.value_action),
        value: action.value || undefined,
      })),
    });
  }

  const dataPolicies = [];
  for (const policy of category('data_policies')) {
    const actions = (policy.field_actions || []).filter(action => action.field === field);
    if (!actions.length) continue;
    dataPolicies.push({
      sys_id: policy.reference.sys_id,
      name: policy.name,
      association: policy.association,
      inheritance: policy.association_detail,
      conditions: policy.conditions || '',
      condition: await probeCondition(sdk, { table, sysId: target.sys_id, condition: policy.conditions }),
      actions: actions.map(action => ({ mandatory: actionValue(action.mandatory), disabled: actionValue(action.disabled) })),
    });
  }

  const acls = [];
  for (const acl of category('access_controls')) {
    const scope = aclScope(acl.name, table, catalog.ancestors, field);
    if (!scope) continue;
    if (!['write', '*'].includes(String(acl.operation || '').toLowerCase())) continue;
    acls.push({
      sys_id: acl.reference.sys_id,
      name: acl.name,
      operation: acl.operation,
      type: acl.type,
      scope,
      decision_type: acl.decision_type,
      admin_overrides: acl.admin_overrides,
      active: acl.active,
      condition_value: acl.condition || '',
      has_script: acl.has_script === true,
      condition: acl.has_script
        ? { value: acl.condition || '', tested: false, matched: null, reason: 'ACL script — not executed', groups: [], warnings: [] }
        : acl.condition
          ? await probeCondition(sdk, { table, sysId: target.sys_id, condition: acl.condition })
          : { value: '', tested: false, matched: true, reason: 'no condition', groups: [], warnings: [] },
    });
  }

  const reasons = { read_only: [], mandatory: [], hidden: [] };
  let readOnlySource = dictionary.read_only === true ? 'dictionary' : null;
  let mandatorySource = dictionary.mandatory === true ? 'dictionary' : null;
  for (const override of overrides.filter(row => row.applies && row.active)) {
    if (override.read_only_override) {
      readOnlySource = override.read_only ? 'dictionary_override' : null;
      if (override.read_only) {
        reasons.read_only.push({ source: 'dictionary_override', name: override.name, sys_id: override.sys_id, detail: 'read_only override=true' });
      }
    }
    if (override.mandatory_override) {
      mandatorySource = override.mandatory ? 'dictionary_override' : null;
      if (override.mandatory) {
        reasons.mandatory.push({ source: 'dictionary_override', name: override.name, sys_id: override.sys_id, detail: 'mandatory override=true' });
      }
    }
  }
  if (readOnlySource === 'dictionary') {
    reasons.read_only.push({ source: 'dictionary', name: `${dictionary.table}.${field}`, sys_id: dictionary.sys_id, detail: 'dictionary read_only=true' });
  }
  if (mandatorySource === 'dictionary') {
    reasons.mandatory.push({ source: 'dictionary', name: `${dictionary.table}.${field}`, sys_id: dictionary.sys_id, detail: 'dictionary mandatory=true' });
  }
  for (const policy of uiPolicies) {
    if (policy.condition.matched !== true) continue;
    for (const action of policy.actions) {
      if (action.disabled === 'true') reasons.read_only.push({ source: 'ui_policy', name: policy.name, sys_id: policy.sys_id, detail: 'UI policy disables the field (client-side)', condition_matched: policy.condition.matched });
      if (action.mandatory === 'true') reasons.mandatory.push({ source: 'ui_policy', name: policy.name, sys_id: policy.sys_id, detail: 'UI policy makes the field mandatory (client-side)', condition_matched: policy.condition.matched });
      if (action.visible === 'false') reasons.hidden.push({ source: 'ui_policy', name: policy.name, sys_id: policy.sys_id, detail: 'UI policy hides the field (client-side)', condition_matched: policy.condition.matched });
    }
  }
  for (const policy of dataPolicies) {
    if (policy.condition.matched !== true) continue;
    for (const action of policy.actions) {
      if (action.disabled === 'true') reasons.read_only.push({ source: 'data_policy', name: policy.name, sys_id: policy.sys_id, detail: 'Data policy disables the field (server-side)', condition_matched: policy.condition.matched });
      if (action.mandatory === 'true') reasons.mandatory.push({ source: 'data_policy', name: policy.name, sys_id: policy.sys_id, detail: 'Data policy makes the field mandatory (server-side)', condition_matched: policy.condition.matched });
    }
  }

  let userEvidence = null;
  if (user) {
    const userRecord = await resolveRecord(sdk, { table: 'sys_user', identifier: user, matchField: 'user_name', resource: 'User', fields: ['sys_id', 'user_name', 'name'] });
    userEvidence = {
      sys_id: unwrapSysId(userRecord),
      user_name: getStringField(userRecord, 'user_name') || undefined,
      name: getStringField(userRecord, 'name') || undefined,
      live_access: {
        evaluated: false,
        reason: 'access-analyzer check (#636) is not available in this build; ACL rows below are configuration evidence, not this user\'s effective access.',
      },
    };
  }

  const warnings = [
    ...inventory.warnings,
    ...inventory.categories.flatMap(section => section.warnings.map(warning => ({ ...warning, category: section.category }))),
  ];
  for (const entry of clientScripts) if (entry.warning) warnings.push({ code: 'truncated', message: entry.warning, source_table: 'sys_script_client' });
  const scripts = clientScripts.filter(entry => !entry.warning);

  return {
    table,
    field,
    record: {
      table,
      sys_id: target.sys_id,
      identifier: target.identifier,
      label: target.label || recordLabel(target.record, target.sys_id),
    },
    dictionary: {
      source_table: dictionary.table,
      inherited: dictionary.table !== table,
      internal_type: dictionary.internal_type,
      reference: dictionary.reference,
      active: dictionary.active,
      base: { mandatory: dictionary.mandatory, read_only: dictionary.read_only },
      overrides,
    },
    ui_policies: uiPolicies,
    data_policies: dataPolicies,
    acls,
    client_scripts: scripts,
    user: userEvidence,
    summary: {
      read_only: reasons.read_only.length > 0,
      mandatory: reasons.mandatory.length > 0,
      hidden: reasons.hidden.length > 0,
      reasons,
      counts: {
        ui_policies: uiPolicies.length,
        data_policies: dataPolicies.length,
        write_acls: acls.length,
        client_script_candidates: scripts.length,
      },
    },
    interpretation: 'Read-only evidence. Client-side requirements (client scripts, UI policies) are reported separately from server enforcement (dictionary, data policies, ACLs). ACL rows and conditions are configuration evidence, not proof of any user\'s effective access; client scripts are never executed.',
    warnings,
  };
}

function conditionMark(condition) {
  if (condition.matched === true) return condition.tested ? '✅' : '✅';
  if (condition.matched === false) return '❌';
  return '➖';
}

export function formatColumnWhy(data) {
  const lines = [''];
  lines.push(`▶ COLUMN WHY: ${data.table}.${data.field}`);
  lines.push('─'.repeat(66));
  lines.push(`  Record: ${data.record.table} ${data.record.label} (${data.record.sys_id})`);
  lines.push(`  Dictionary: ${data.dictionary.source_table}.${data.field}${data.dictionary.inherited ? ' (inherited)' : ''} — ${data.dictionary.internal_type || 'unknown type'}${data.dictionary.reference ? ` → ${data.dictionary.reference}` : ''}`);
  lines.push(`  Base: mandatory=${data.dictionary.base.mandatory ?? '(unset)'}, read_only=${data.dictionary.base.read_only ?? '(unset)'}, active=${data.dictionary.active ?? '(unset)'}`);
  lines.push('');
  if (data.dictionary.overrides.length) {
    lines.push('  DICTIONARY OVERRIDES');
    for (const override of data.dictionary.overrides) {
      lines.push(`    ${override.applies ? '→' : '·'} ${override.name || '?'}${override.base_table ? ` (base ${override.base_table})` : ''}: mandatory_override=${override.mandatory_override}, read_only_override=${override.read_only_override}${override.active ? '' : ' [inactive]'}`);
    }
    lines.push('');
  }
  lines.push('  UI POLICIES');
  if (!data.ui_policies.length) lines.push('    (no field actions for this field)');
  for (const policy of data.ui_policies) {
    lines.push(`    ${conditionMark(policy.condition)} ${policy.name} — ${policy.association}${policy.conditions ? ` | ${policy.conditions}` : ' | no condition'}`);
    for (const action of policy.actions) {
      const parts = [];
      if (action.disabled) parts.push(`disabled=${action.disabled}`);
      if (action.mandatory) parts.push(`mandatory=${action.mandatory}`);
      if (action.visible) parts.push(`visible=${action.visible}`);
      if (action.cleared) parts.push(`cleared=${action.cleared}`);
      if (action.value_action) parts.push(`value=${action.value_action}`);
      if (parts.length) lines.push(`        ${parts.join(', ')}`);
    }
  }
  lines.push('');
  lines.push('  SERVER DATA POLICIES');
  if (!data.data_policies.length) lines.push('    (no field actions for this field)');
  for (const policy of data.data_policies) {
    lines.push(`    ${conditionMark(policy.condition)} ${policy.name} — ${policy.association}${policy.conditions ? ` | ${policy.conditions}` : ' | no condition'}`);
    for (const action of policy.actions) {
      const parts = [];
      if (action.disabled) parts.push(`disabled=${action.disabled}`);
      if (action.mandatory) parts.push(`mandatory=${action.mandatory}`);
      if (parts.length) lines.push(`        ${parts.join(', ')}`);
    }
  }
  lines.push('');
  lines.push('  WRITE ACLs');
  if (!data.acls.length) lines.push('    (no write ACL rows matched this table/field from accessible configuration)');
  for (const acl of data.acls) {
    const conditionText = acl.condition_value ? `condition: ${acl.condition_value}` : 'no condition';
    lines.push(`    ${conditionMark(acl.condition)} ${acl.name} [${acl.operation}] ${acl.scope.level}${acl.scope.inherited ? ', inherited' : ''}${acl.has_script ? ', scripted (not executed)' : ''} — ${conditionText}${acl.condition.tested || acl.condition.reason === 'no condition' ? '' : ` (${acl.condition.reason})`}`);
  }
  lines.push('');
  lines.push('  CLIENT SCRIPT CANDIDATES (never executed)');
  if (!data.client_scripts.length) lines.push('    (none name this field)');
  for (const script of data.client_scripts) {
    lines.push(`    · ${script.name} — ${script.type || 'unknown type'}, matched by ${script.matched_by}${script.table !== data.table ? `, ${script.table}${script.applies_extended ? ' (applies_extended)' : ''}` : ''}`);
  }
  if (data.user) {
    lines.push('');
    lines.push(`  USER: ${data.user.name || data.user.user_name || data.user.sys_id} (${data.user.sys_id})`);
    lines.push(`    live access: not evaluated — ${data.user.live_access.reason}`);
  }
  lines.push('');
  lines.push('  SUMMARY');
  const summaryLine = key => data.summary[key] ? `${key.toUpperCase()}: ${data.summary.reasons[key].map(reason => `${reason.source}${reason.name ? `:${reason.name}` : ''} (${reason.detail})`).join('; ')}` : `${key.toUpperCase()}: no applicable evidence found`;
  lines.push(`    ${summaryLine('read_only')}`);
  lines.push(`    ${summaryLine('mandatory')}`);
  lines.push(`    ${summaryLine('hidden')}`);
  for (const warning of data.warnings || []) lines.push(`    ! ${warning.category ? `${warning.category}: ` : ''}${warning.message}`);
  return lines.join('\n');
}
