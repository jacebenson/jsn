// `flows why <flow> --record <table> <number|sys_id>`
//
// Read-only answer to "why didn't this flow run for this record?". It combines
// the flow's own runnability checks with the trigger's table/condition
// evidence and existing sys_flow_context executions for that record.

import { getStringField } from './helpers.js';
import { errUsage } from './errors.js';
import { resolveRecord, unwrapSysId } from './resolve-record.js';
import { flowStatus, readFlowTrigger } from './flow-publish.js';
import {
  loadFieldCatalog, probeCondition, referenceComparisonFlags,
  resolveTargetRecord, recordLabel,
} from './why-checks.js';

const TRIGGER_OPERATIONS = new Map([
  ['record_create', ['insert']],
  ['record_update', ['update']],
  ['record_create_or_update', ['insert', 'update']],
  ['record_delete', ['delete']],
]);

const CONTEXT_FIELDS = ['sys_id', 'name', 'flow', 'state', 'source_table', 'source_record', 'sys_created_on', 'run_time', 'error_message'];

function triggerOperationEvidence(trigger) {
  if (!trigger) return { operations: [], reason: 'no trigger instance found' };
  const operations = TRIGGER_OPERATIONS.get(trigger.type);
  if (!operations) return { operations: [], reason: `${trigger.type} is not a record trigger` };
  return { operations, reason: undefined };
}

function coverageEvidence(trigger, recordTable, hierarchy) {
  if (!trigger?.table) {
    return { covered: null, reason: 'the trigger has no table input', trigger_table: trigger?.table ?? null, record_table: recordTable, ancestors: hierarchy.slice(1) };
  }
  const ancestors = hierarchy.map(node => node.name);
  if (trigger.table === recordTable) {
    return { covered: true, detail: 'exact_table', trigger_table: trigger.table, record_table: recordTable, ancestors };
  }
  if (ancestors.includes(trigger.table)) {
    const extended = String(trigger.run_on_extended || '').toLowerCase() === 'true';
    return {
      covered: extended,
      detail: extended ? 'ancestor_run_on_extended' : 'ancestor_run_on_extended_disabled',
      reason: extended ? undefined : `record table ${recordTable} extends trigger table ${trigger.table}, but the trigger has run_on_extended=false`,
      trigger_table: trigger.table, record_table: recordTable, ancestors,
    };
  }
  return {
    covered: false,
    detail: 'outside_hierarchy',
    reason: `record table ${recordTable} is not ${trigger.table} or one of its descendants`,
    trigger_table: trigger.table, record_table: recordTable, ancestors,
  };
}

export async function flowWhy(sdk, { flowIdentifier, recordTable, recordIdentifier, contextLimit = 10 }) {
  if (!flowIdentifier) throw errUsage('A flow name or sys_id is required.');
  const flowRecord = await resolveRecord(sdk, {
    table: 'sys_hub_flow', identifier: flowIdentifier, matchField: 'name', resource: 'Flow', fields: ['sys_id', 'name', 'type', 'active', 'status'],
  });
  const flowId = unwrapSysId(flowRecord);
  if (!flowId) throw errUsage('The flow has no readable sys_id.');

  const [status, trigger, catalog] = await Promise.all([
    flowStatus(sdk, flowId),
    readFlowTrigger(sdk, flowId),
    loadFieldCatalog(sdk, recordTable),
  ]);
  const target = await resolveTargetRecord(sdk, recordTable, recordIdentifier, { catalog });
  const hierarchy = catalog.names.map(name => ({ name }));

  const coverage = coverageEvidence(trigger, recordTable, hierarchy);
  const triggeredOperations = triggerOperationEvidence(trigger);
  const condition = trigger
    ? await probeCondition(sdk, { table: recordTable, sysId: target.sys_id, condition: trigger.condition })
    : { value: '', tested: false, matched: null, reason: 'no trigger instance found', groups: [], warnings: [] };
  const referenceComparisons = trigger ? referenceComparisonFlags(catalog, trigger.condition) : [];

  const contextQuery = `source_record=${target.sys_id}^flow=${flowId}^ORDERBYDESCsys_created_on`;
  const contexts = await sdk.listStrict('sys_flow_context', new URLSearchParams({
    sysparm_query: contextQuery,
    sysparm_fields: CONTEXT_FIELDS.join(','),
    sysparm_limit: String(contextLimit),
    sysparm_display_value: 'all',
  }));
  let contextCount = contexts.length;
  try {
    const counted = await sdk.aggregateCount('sys_flow_context', `source_record=${target.sys_id}^flow=${flowId}`);
    if (Number.isSafeInteger(counted)) contextCount = counted;
  } catch { /* count is optional supporting evidence */ }

  const reasons = [];
  const blockingChecks = status.checks.filter(check => !check.skipped && check.ok === false);
  for (const check of blockingChecks) reasons.push(`${check.name}: ${check.detail}`);
  const nonRecordTrigger = Boolean(trigger) && triggeredOperations.operations.length === 0;
  if (nonRecordTrigger) reasons.push(`trigger: ${triggeredOperations.reason}`);
  if (coverage.covered === false) reasons.push(`table coverage: ${coverage.reason}`);
  if (condition.matched === false) reasons.push(`trigger condition did not match ${target.label} (${target.sys_id})`);
  if (condition.matched === null) reasons.push(`trigger condition is not fully testable: ${condition.reason}`);

  let verdict;
  if (blockingChecks.length || coverage.covered === false || condition.matched === false) verdict = 'would_not_run';
  else if (condition.matched === null || coverage.covered === null || nonRecordTrigger) verdict = 'undetermined';
  else verdict = 'eligible_now';

  return {
    flow: {
      sys_id: flowId,
      name: getStringField(flowRecord, 'name') || status.flow?.name,
      type: getStringField(flowRecord, 'type') || status.flow?.type,
      active: getStringField(flowRecord, 'active') === 'true',
      status: getStringField(flowRecord, 'status') || undefined,
    },
    record: {
      table: recordTable,
      sys_id: target.sys_id,
      identifier: target.identifier,
      label: target.label || recordLabel(target.record, target.sys_id),
    },
    trigger: trigger ? {
      type: trigger.type,
      table: trigger.table,
      condition: trigger.condition,
      operations: triggeredOperations.operations,
      operation_note: triggeredOperations.reason,
      run_flow_in: trigger.run_flow_in,
      run_on_extended: trigger.run_on_extended,
      run_when_user_setting: trigger.run_when_user_setting,
      trigger_strategy: trigger.trigger_strategy,
    } : null,
    state: {
      ok: status.ok,
      checks: status.checks,
    },
    table_coverage: coverage,
    condition,
    reference_comparisons: referenceComparisons,
    executions: {
      count: contextCount,
      sampled: contexts.length,
      has_more: contexts.length >= contextLimit,
      latest: contexts.map(row => ({
        sys_id: getStringField(row, 'sys_id'),
        name: getStringField(row, 'name') || undefined,
        state: getStringField(row, 'state') || undefined,
        source_table: getStringField(row, 'source_table') || undefined,
        created_on: getStringField(row, 'sys_created_on') || undefined,
        run_time: getStringField(row, 'run_time') || undefined,
        error: getStringField(row, 'error_message') || undefined,
      })),
    },
    verdict,
    reasons,
    interpretation: 'Current-state evidence only. The condition is tested by the platform query engine; scripts and change operators are not evaluated, and a matching condition does not prove that an event occurred or that an earlier rule did not alter the record.',
  };
}

function mark(check) {
  return check.skipped ? '➖' : check.ok ? '✅' : '❌';
}

function conditionLine(condition) {
  if (condition.matched === true) return condition.tested ? '✅ matches now' : '✅ no condition / nothing to test';
  if (condition.matched === false) return '❌ does not match now';
  return `➖ untested (${condition.reason || 'unknown'})`;
}

export function formatFlowWhy(data) {
  const lines = [''];
  lines.push(`▶ FLOW WHY: ${data.flow.name || data.flow.sys_id}`);
  lines.push('─'.repeat(64));
  lines.push(`  Flow: ${data.flow.sys_id} (${data.flow.type || 'unknown'}${data.flow.active ? ', active' : ', inactive'})`);
  lines.push(`  Record: ${data.record.table} ${data.record.label} (${data.record.sys_id})`);
  lines.push('');
  lines.push('  FLOW STATE');
  for (const check of data.state.checks) lines.push(`    ${mark(check)} ${check.name}: ${check.detail}`);
  lines.push('');
  lines.push('  TRIGGER');
  if (!data.trigger) {
    lines.push('    ❌ no trigger instance found');
  } else {
    lines.push(`    ${data.trigger.type}${data.trigger.table ? ` on ${data.trigger.table}` : ''}`);
    lines.push(`    operations: ${data.trigger.operations.length ? data.trigger.operations.join('/') : (data.trigger.operation_note || 'unknown')}`);
    lines.push(`    condition: ${data.trigger.condition || '(none)'}`);
    if (data.trigger.run_flow_in) lines.push(`    run in: ${data.trigger.run_flow_in}; run on extended: ${data.trigger.run_on_extended || '(unset)'}`);
  }
  if (data.table_coverage) {
    const covered = data.table_coverage.covered;
    const detail = [data.table_coverage.detail, data.table_coverage.reason].filter(Boolean).join(' ');
    lines.push(`    table coverage: ${covered === true ? '✅' : covered === false ? '❌' : '➖'}${detail ? ` ${detail}` : ''}`);
  }
  lines.push('');
  lines.push('  CONDITION NOW');
  lines.push(`    ${conditionLine(data.condition)}`);
  for (const group of data.condition.groups || []) {
    lines.push(`      ${group.matched === true ? '✅' : group.matched === false ? '—' : '➖'} ${group.query}${group.error ? ` (${group.error})` : ''}${group.untested ? ` (${group.untested})` : ''}`);
  }
  if (data.reference_comparisons?.length) {
    lines.push('');
    lines.push('  REFERENCE-VALUE WARNINGS');
    for (const flag of data.reference_comparisons) lines.push(`    ! ${flag.message}`);
  }
  lines.push('');
  lines.push('  EXECUTIONS FOR THIS RECORD');
  if (!data.executions.count) {
    lines.push('    none found in sys_flow_context');
  } else {
    lines.push(`    ${data.executions.count} context(s)${data.executions.has_more ? ` (newest ${data.executions.sampled} shown)` : ''}`);
    for (const execution of data.executions.latest) {
      lines.push(`    ${execution.created_on || '?'} ${execution.state || '?'}${execution.run_time ? ` ${execution.run_time}s` : ''}${execution.error ? ` — ${execution.error}` : ''}`);
    }
  }
  lines.push('');
  lines.push(`  VERDICT: ${data.verdict.replaceAll('_', ' ')}`);
  for (const reason of data.reasons) lines.push(`    · ${reason}`);
  return lines.join('\n');
}
