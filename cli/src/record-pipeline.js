// `records pipeline <table> <number|sys_id> --op insert|update|delete`
//
// Read-only execution-order view for one record. It reuses the table behavior
// inventory (business rules, data policies, flow record triggers and
// notifications, inherited rows included) and tests each encoded-query
// condition against the record through the Table API.

import { errUsage } from './errors.js';
import { discoverTableBehavior } from './table-behavior.js';
import { loadFieldCatalog, probeCondition, resolveTargetRecord, recordLabel } from './why-checks.js';

const OPERATIONS = new Map([['insert', 'insert'], ['update', 'update'], ['delete', 'delete']]);
const OPERATION_FLAG = { insert: 'action_insert', update: 'action_update', delete: 'action_delete' };
const MAX_CONDITION_PROBES = 120;

function operation(value) {
  const op = String(value || '').toLowerCase();
  if (!OPERATIONS.has(op)) throw errUsage('--op must be insert, update or delete.', 'Choose the record event whose pipeline you want to inspect.');
  return OPERATIONS.get(op);
}

export async function recordPipeline(sdk, { table, identifier, op: rawOp, maxConditionProbes = MAX_CONDITION_PROBES }) {
  const op = operation(rawOp);
  const catalog = await loadFieldCatalog(sdk, table);
  const target = await resolveTargetRecord(sdk, table, identifier, { catalog });

  const inventory = await discoverTableBehavior(sdk, table, {
    categories: ['business_rules', 'data_policies', 'flows', 'notifications'],
    includeInactive: false,
    limit: 500,
  });
  const category = id => inventory.categories.find(section => section.category === id)?.items || [];

  const cache = new Map();
  let probes = 0;
  const evaluate = async (condition, { script = false, applies = true, skipReason } = {}) => {
    const value = String(condition || '');
    if (!applies) return { value, tested: false, matched: null, reason: skipReason || `does not run on ${op}`, groups: [], warnings: [] };
    if (script) return { value, tested: false, matched: null, reason: 'script condition — not executed', groups: [], warnings: [] };
    const key = value;
    if (cache.has(key)) return cache.get(key);
    if (probes >= maxConditionProbes) {
      return { value, tested: false, matched: null, reason: 'condition probe budget reached', groups: [], warnings: [] };
    }
    probes += 1;
    const pending = probeCondition(sdk, { table, sysId: target.sys_id, condition: value });
    cache.set(key, pending);
    return pending;
  };

  const businessRule = async (item, stage) => {
    const applies = Array.isArray(item.operations) && item.operations.includes(op);
    const skipReason = item.operations?.length ? `operations: ${item.operations.join('/') || 'none'}` : 'no operation selected on the business rule';
    return {
      kind: 'business_rule',
      stage,
      sys_id: item.reference.sys_id,
      name: item.name,
      source_table: item.source_table,
      association: item.association,
      association_detail: item.association_detail,
      when: item.when,
      order: item.order,
      operations: item.operations || [],
      applies,
      condition_value: item.condition || '',
      advanced: item.advanced === true,
      has_script: item.has_script === true,
      condition: await evaluate(item.condition, { script: item.advanced === true, applies, skipReason }),
    };
  };

  const dataPolicy = async item => {
    const matchingActions = (item.field_actions || []).filter(action => action.field);
    const applies = op !== 'delete';
    return {
      kind: 'data_policy',
      stage: 'engines',
      sys_id: item.reference.sys_id,
      name: item.name,
      source_table: item.source_table,
      association: item.association,
      operations: [],
      applies,
      condition_value: item.conditions || '',
      fields: matchingActions.map(action => ({ field: action.field, mandatory: action.mandatory, disabled: action.disabled })),
      condition: await evaluate(item.conditions, { applies, skipReason: 'data policies are not evaluated on delete' }),
    };
  };

  const flowTrigger = async item => {
    const applies = item[`on_${op}`] === true;
    const operations = ['insert', 'update', 'delete'].filter(name => item[`on_${name}`] === true);
    return {
      kind: 'flow_record_trigger',
      stage: 'flow_triggers',
      sys_id: item.reference.sys_id,
      name: item.name,
      source_table: item.source_table,
      association: item.association,
      operations,
      applies,
      condition_value: item.condition || '',
      run_flow_in: item.run_flow_in,
      run_on_extended: item.run_on_extended,
      condition: await evaluate(item.condition, { applies, skipReason: `operations: ${operations.join('/') || 'none'}` }),
    };
  };

  const notification = async item => {
    const script = Boolean(item.advanced_condition);
    return {
      kind: 'notification',
      stage: 'notifications',
      sys_id: item.reference.sys_id,
      name: item.name,
      source_table: item.source_table,
      association: item.association,
      operations: [],
      applies: true,
      event_name: item.event_name,
      condition_value: item.condition || '',
      advanced_condition: item.advanced_condition || undefined,
      condition: await evaluate(item.condition, { script }),
    };
  };

  const rules = category('business_rules');
  const before = [];
  const after = [];
  const asyncRules = [];
  for (const item of rules) {
    if (item.when === 'before') before.push(await businessRule(item, 'before_rules'));
    else if (item.when === 'after') after.push(await businessRule(item, 'after_rules'));
    else if (item.when === 'async') asyncRules.push(await businessRule(item, 'async_rules'));
  }
  const dataPolicies = [];
  for (const item of category('data_policies')) dataPolicies.push(await dataPolicy(item));
  const flowTriggers = [];
  for (const item of category('flows')) flowTriggers.push(await flowTrigger(item));
  const notifications = [];
  for (const item of category('notifications')) notifications.push(await notification(item));

  const stages = [
    {
      id: 'before_rules', label: 'Before business rules', layer: 'server',
      note: 'Ordered by sys_script.order; inherited and global rules included.',
      items: before,
    },
    {
      id: 'engines', label: 'Platform engines', layer: 'server',
      note: 'Data policies are shown for condition evidence. The platform query/validation/audit/workflow engines are not inspectable through this read-only surface.',
      items: dataPolicies,
    },
    {
      id: 'after_rules', label: 'After business rules', layer: 'server',
      note: 'Ordered by sys_script.order; inherited and global rules included.',
      items: after,
    },
    {
      id: 'flow_triggers', label: 'Flow record triggers', layer: 'server',
      note: 'sys_flow_record_trigger rows have no flow column, so registration rows cannot be attributed to one flow. Use `jsn flows why` to test a specific flow.',
      items: flowTriggers,
    },
    {
      id: 'notifications', label: 'Email notifications', layer: 'server',
      note: 'Notification condition is current-state evidence; event delivery is not simulated.',
      items: notifications,
    },
    {
      id: 'async_rules', label: 'Async business rules', layer: 'server',
      note: 'Queued after the save completes; order here is configuration order, not queue position.',
      items: asyncRules,
    },
  ];

  const all = stages.flatMap(stage => stage.items);
  const applicable = all.filter(item => item.applies);
  const matched = applicable.filter(item => item.condition.matched === true);
  const notMatched = applicable.filter(item => item.condition.matched === false);
  const untested = applicable.filter(item => item.condition.matched === null);

  return {
    table,
    record: {
      table,
      sys_id: target.sys_id,
      identifier: target.identifier,
      label: target.label || recordLabel(target.record, target.sys_id),
      match_field: target.match_field,
    },
    op,
    operation_flag: OPERATION_FLAG[op],
    stages: stages.map(stage => ({ ...stage, count: stage.items.length, applicable: stage.items.filter(item => item.applies).length })),
    summary: {
      artifacts: all.length,
      applicable: applicable.length,
      matching_now: matched.length,
      not_matching_now: notMatched.length,
      untested: untested.length,
      condition_probes: probes,
    },
    interpretation: 'Configuration and current-state evidence only. Script conditions are never executed, change operators and a caller\'s setWorkflow(false) are not tested, and earlier artifacts can alter the record before later ones run.',
    warnings: [
      ...inventory.warnings,
      ...inventory.categories.flatMap(section => section.warnings.map(warning => ({ ...warning, category: section.category }))),
    ],
  };
}

function conditionMark(condition) {
  if (condition.matched === true) return condition.tested ? '✅' : '✅';
  if (condition.matched === false) return '❌';
  return '➖';
}

function conditionDetail(condition) {
  if (condition.matched === true) return condition.tested ? 'condition matches now' : condition.reason === 'no condition' ? 'no condition' : 'matches (not tested)';
  if (condition.matched === false) return 'condition does not match now';
  return condition.reason || 'untested';
}

export function formatRecordPipeline(data, { all = false } = {}) {
  const lines = [''];
  lines.push(`▶ RECORD PIPELINE: ${data.table} ${data.record.label}`);
  lines.push('─'.repeat(68));
  lines.push(`  Record: ${data.record.sys_id} | operation: ${data.op}`);
  lines.push('  Read-only; conditions are tested by the platform query engine and scripts are never executed.');
  lines.push('');
  for (const stage of data.stages) {
    const items = all ? stage.items : stage.items.filter(item => item.applies);
    const omitted = stage.items.length - items.length;
    lines.push(`▶ ${stage.label.toUpperCase()} — ${stage.applicable}/${stage.count} applicable`);
    lines.push('─'.repeat(68));
    lines.push(`  ${stage.note}`);
    if (!items.length) lines.push(all ? '  (none in accessible configuration)' : '  (none applicable to this operation)');
    for (const item of items) {
      const meta = [
        item.applies ? null : 'does not apply',
        item.order !== undefined ? `order ${item.order}` : null,
        item.when && stage.id.endsWith('_rules') ? item.when : null,
        item.operations?.length ? item.operations.join('/') : null,
        item.association && item.association !== 'direct' ? item.association : null,
      ].filter(Boolean);
      lines.push(`  ${conditionMark(item.condition)} ${item.name}${meta.length ? ` — ${meta.join(', ')}` : ''}`);
      if (item.condition_value) lines.push(`      condition: ${item.condition_value.length > 110 ? item.condition_value.slice(0, 107) + '...' : item.condition_value}`);
      lines.push(`      ${conditionDetail(item.condition)}${item.condition.tested && item.condition.groups?.length ? ` (${item.condition.groups.filter(group => group.matched === true).length}/${item.condition.groups.length} group(s) match)` : ''}`);
      if (item.event_name) lines.push(`      event: ${item.event_name}`);
      if (item.run_flow_in) lines.push(`      run in: ${item.run_flow_in}; run on extended: ${item.run_on_extended || '(unset)'}`);
      if (item.fields?.length) lines.push(`      fields: ${item.fields.map(field => `${field.field}${field.mandatory && field.mandatory !== 'ignore' ? ` mandatory=${field.mandatory}` : ''}${field.disabled && field.disabled !== 'ignore' ? ` disabled=${field.disabled}` : ''}`).join('; ')}`);
    }
    if (omitted) lines.push(`  (${omitted} artifact(s) do not run for ${data.op}; use --all to list them)`);
    lines.push('');
  }
  lines.push(`Applicable artifacts: ${data.summary.applicable}/${data.summary.artifacts}; ${data.summary.matching_now} condition(s) match now, ${data.summary.not_matching_now} do not, ${data.summary.untested} untested.`);
  for (const warning of data.warnings || []) lines.push(`  ! ${warning.category ? `${warning.category}: ` : ''}${warning.message}`);
  return lines.join('\n');
}
