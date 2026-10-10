import { assertSafeExactMatch } from './helpers.js';

const FLOW_ENDPOINT = '/api/now/processflow/flow';

function valueOf(value) {
  if (value && typeof value === 'object') return String(value.value ?? value.sys_id ?? value.display_value ?? '');
  return value == null ? '' : String(value);
}

function findArray(value, key) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value[key])) return value[key];
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    const found = findArray(item, key);
    if (found.length) return found;
  }
  return [];
}

function flowData(response) {
  return response?.result?.data ?? response?.data?.result?.data ?? response?.data ?? response?.result ?? response;
}

function findTrigger(definition) {
  return findArray(definition, 'triggerInstances')[0] || findArray(definition, 'trigger_instances')[0] || null;
}

function inputValue(trigger, name) {
  const input = (trigger?.inputs || trigger?.triggerInputs || []).find(item => item?.name === name);
  return valueOf(input?.value ?? input?.displayValue);
}

function triggerType(trigger) {
  return valueOf(trigger?.triggerType || trigger?.trigger_type || trigger?.type);
}

export function deriveRecordTrigger(definition) {
  const trigger = findTrigger(definition);
  if (!trigger) throw new Error('Flow definition has no trigger instance');
  const type = triggerType(trigger);
  if (type !== 'record_create_or_update') throw new Error(`Flow test supports only record_create_or_update triggers; found ${type || 'unknown'}`);
  const table = inputValue(trigger, 'table');
  if (!table) throw new Error('Flow definition record trigger has no table');
  return { trigger, type, table };
}

function booleanFlag(value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

function classifyResponse(response) {
  const data = flowData(response);
  const contextId = data?.contextId || data?.context_id || data?.sys_id || data?.execution_id || '';
  const state = valueOf(data?.state ?? data?.status).toLowerCase();
  const succeeded = ['success', 'succeeded'].includes(state);
  const failed = ['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(state);
  const completed = booleanFlag(data?.completed) === true
    || booleanFlag(data?.finished) === true
    || succeeded
    || failed
    || ['complete', 'completed'].includes(state);
  const explicitSuccess = booleanFlag(data?.success ?? data?.successful);
  const success = failed || explicitSuccess === false
    ? false
    : completed && (succeeded || explicitSuccess === true) ? true : undefined;
  return {
    accepted: true,
    status: completed ? 'completed' : 'accepted',
    success,
    context_id: contextId || undefined,
    response: data,
  };
}

export async function testFlow(sdk, instance, identifier, recordId) {
  if (!recordId || !String(recordId).trim()) throw new Error('Flow test requires --record <sys_id>');
  if (!/^[0-9a-f]{32}$/i.test(String(recordId))) throw new Error(`--record must be a 32-character sys_id; flow was not dispatched`);
  const flowIdentifier = String(identifier);
  assertSafeExactMatch(flowIdentifier);
  const isId = /^[0-9a-f]{32}$/i.test(flowIdentifier);
  const flowRows = await sdk.list('sys_hub_flow', new URLSearchParams({
    sysparm_query: `${isId ? 'sys_id' : 'name'}=${flowIdentifier}`,
    sysparm_limit: '2',
    sysparm_display_value: 'all',
    sysparm_fields: 'sys_id,name,scope',
  }));
  if (!flowRows.length) throw new Error(`Flow not found: ${identifier}`);
  if (flowRows.length > 1) throw new Error(`Flow identifier is ambiguous: ${identifier}`);
  const flow = flowRows[0];
  const flowId = valueOf(flow.sys_id);
  const scope = valueOf(flow.scope);
  if (!scope) throw new Error(`Flow ${flowId} has no transaction scope; flow was not dispatched`);
  const response = await sdk.request(`${instance}${FLOW_ENDPOINT}/${encodeURIComponent(flowId)}?sysparm_transaction_scope=${encodeURIComponent(scope)}`, { method: 'GET' });
  const definition = flowData(response);
  const trigger = deriveRecordTrigger(definition);
  const records = await sdk.list(trigger.table, new URLSearchParams({
    sysparm_query: `sys_id=${recordId}`,
    sysparm_limit: '1',
    sysparm_fields: 'sys_id',
  }));
  if (!records.length) throw new Error(`Record ${recordId} was not found in trigger table ${trigger.table}; flow was not dispatched`);
  const definitionScope = valueOf(definition.scope);
  if (definitionScope && definitionScope !== scope) throw new Error(`Flow ${flowId} definition scope did not match the saved record; flow was not dispatched`);
  const body = {
    ...definition,
    outputMap: { current: recordId, table_name: trigger.table },
    runOnThread: true,
    tracingEnabled: false,
  };
  let dispatch;
  try {
    dispatch = await sdk.request(`${instance}${FLOW_ENDPOINT}/${encodeURIComponent(flowId)}/test?sysparm_transaction_scope=${encodeURIComponent(scope)}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`Flow test dispatch failed for ${flowId}: ${error.message}`, { cause: error });
  }
  return { flow: { id: flowId, name: valueOf(flow.name) }, trigger: { type: trigger.type, table: trigger.table }, record: recordId, ...classifyResponse(dispatch) };
}
