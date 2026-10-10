import { randomUUID } from 'node:crypto';
import { assertSafeExactMatch } from './helpers.js';
import { createVerifiedFlowVersion } from './flow-versioning.js';

const FLOW_ENDPOINT = '/api/now/processflow/flow';
const GRAPHQL_ENDPOINT = '/api/now/graphql';
const TABLE_DESCRIPTOR_ENDPOINT = '/api/now/processflow/trigger/record/table';
const PROTECTED_FLOW_ID = 'c215135293bf03d087b0f14fdd03d652';
const PROTECTED_FLOW_NAME = 'jace-test-flow';

function isSysId(value) {
  return typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value);
}

function stringValue(value) {
  if (value && typeof value === 'object') return String(value.value ?? value.sys_id ?? value.name ?? value.display_value ?? '');
  return value == null ? '' : String(value);
}

function idValue(value) {
  return stringValue(value);
}

function gqlString(value) {
  return JSON.stringify(String(value));
}

function gqlValue(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return gqlString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (Array.isArray(value)) return `[${value.map(gqlValue).join(', ')}]`;
  if (typeof value === 'object') return `{${Object.entries(value).map(([key, item]) => `${key}: ${gqlValue(item)}`).join(', ')}}`;
  return gqlString(value);
}

function gqlInputObject(value) {
  return `{${Object.entries(value).map(([key, item]) => `${key}: ${gqlValue(item)}`).join(', ')}}`;
}

function parseMaybeJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function walk(value, visitor, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  visitor(value);
  if (Array.isArray(value)) value.forEach(item => walk(item, visitor, seen));
  else Object.values(value).forEach(item => walk(item, visitor, seen));
}

function findArray(value, key) {
  let found;
  walk(value, object => {
    if (!found && !Array.isArray(object) && Array.isArray(object[key])) found = object[key];
  });
  return found || [];
}

function findFlowData(response) {
  return response?.result?.data ?? response?.data?.result?.data ?? response?.data ?? response?.result ?? response;
}

function findId(value, keys = ['sysId', 'sys_id', 'flowId', 'id']) {
  let found = '';
  walk(value, object => {
    if (found || Array.isArray(object)) return;
    for (const key of keys) {
      const candidate = idValue(object[key]);
      if (candidate) {
        found = candidate;
        break;
      }
    }
  });
  return found;
}

function graphQLErrors(response) {
  const errors = response?.errors || response?.data?.errors || response?.result?.errors;
  return Array.isArray(errors) ? errors : [];
}

function assertGraphQLSuccess(response, operation) {
  const errors = graphQLErrors(response);
  if (errors.length) throw new Error(`${operation} failed: ${errors.map(error => String(error.message || error.code || 'GraphQL error')).join('; ')}`);
  if (response?.result?.errorMessage) throw new Error(`${operation} failed: ${response.result.errorMessage}`);
}

function schemaEntries(definition) {
  const entries = [];
  const seen = new Set();
  walk(definition, object => {
    for (const key of ['inputs', 'inputSchema', 'parameters', 'fields']) {
      if (!Array.isArray(object[key])) continue;
      for (const field of object[key]) {
        if (!field || typeof field !== 'object') continue;
        const name = stringValue(field.name || field.key || field.element || field.parameter);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        entries.push({
          ...field,
          name,
          type: stringValue(field.type || field.inputType || field.valueType || 'string') || 'string',
          default: field.default ?? field.defaultValue,
        });
      }
    }
  });
  return entries;
}

function actionTypeId(record) {
  return idValue(record?.sys_id || record?.sysId || record?.id || record?.actionTypeId);
}

function exactActionName(record) {
  return stringValue(record?.name || record?.f_name || record?.fName || record?.display_name || record?.displayName);
}

export function validateFlowManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Flow manifest must be a JSON object');
  if (!String(manifest.name || '').trim()) throw new Error('Flow manifest requires name');
  if (!String(manifest.scope || '').trim()) throw new Error('Flow manifest requires scope');
  if (manifest.logic !== undefined) throw new Error('Flow Logic is unsupported in this creation slice');
  if (manifest.subflows !== undefined || manifest.subFlows !== undefined) throw new Error('Subflows are unsupported in this creation slice');
  if (manifest.variables !== undefined || manifest.flowVariables !== undefined) throw new Error('Flow-variable lifecycle is unsupported in this creation slice');
  if (manifest.errorHandling !== undefined) throw new Error('Error handling is unsupported in this creation slice');
  const trigger = manifest.trigger;
  if (!trigger || trigger.type !== 'record_create_or_update') throw new Error('Only trigger.type=record_create_or_update is supported');
  if (!String(trigger.table || '').trim()) throw new Error('Record trigger requires table');
  if (trigger.condition !== undefined && typeof trigger.condition !== 'string') throw new Error('Record trigger condition must be a string');
  if (trigger.condition && !/^[A-Za-z_][A-Za-z0-9_.]*(?:STARTSWITH|ENDSWITH|LIKE|NOT LIKE|=|!=|IN|ISEMPTY|ISNOTEMPTY)[^,^]*$/.test(trigger.condition)) {
    throw new Error('Record trigger condition uses an unsupported encoded-query condition subset');
  }
  if (!Array.isArray(manifest.actions)) throw new Error('Flow manifest requires an actions array');
  for (const [index, action] of manifest.actions.entries()) {
    if (!action || typeof action !== 'object' || !String(action.type || '').trim()) throw new Error(`Action ${index + 1} requires type`);
    if (action.inputs !== undefined && (!action.inputs || typeof action.inputs !== 'object' || Array.isArray(action.inputs))) throw new Error(`Action ${index + 1} inputs must be an object`);
  }
  return manifest;
}

export function buildFlowProperties(manifest) {
  return {
    name: manifest.name,
    description: manifest.description || '',
    type: 'flow',
    status: 'draft',
    active: false,
    scope: manifest.scope,
    runAs: 'user',
    flowPriority: 'MEDIUM',
    access: 'public',
    protection: '',
    runWithRoles: { value: '', displayValue: '' },
    deleted: false,
    security: { can_read: true, can_write: true },
  };
}

export function buildFlowPatchMutation({ flowId, trigger, actions }) {
  const triggerUpdate = {
    id: trigger.id,
    metadata: trigger.metadata,
    inputs: trigger.inputs,
  };
  const actionInsert = actions.map(action => ({
    actionTypeSysId: action.actionTypeSysId,
    flowSysId: action.flowSysId,
    generationSource: action.generationSource,
    type: action.type,
    order: action.order,
    parent: action.parent,
    uiUniqueIdentifier: action.uiUniqueIdentifier,
    parentUiId: action.parentUiId,
    metadata: action.metadata,
    inputs: action.inputs,
  }));
  const patch = `flowPatch: {flowId: ${gqlString(flowId)}, triggerInstances: {update: [${gqlInputObject(triggerUpdate)}]}, actions: {insert: [${actionInsert.map(gqlInputObject).join(', ')}]}}`;
  return `mutation { global { snFlowDesigner { flow(${patch}) { triggerInstances { inserts { sysId uiUniqueIdentifier } updates { sysId uiUniqueIdentifier } } actions { inserts { sysId uiUniqueIdentifier } updates { sysId uiUniqueIdentifier } } } } } }`;
}

export function buildFlowUpdateMutation({ flowId, triggerUpdates = [], actionUpdates = [] }) {
  const updates = [];
  if (triggerUpdates.length) updates.push(`triggerInstances: {update: [${triggerUpdates.map(gqlInputObject).join(', ')}]}`);
  if (actionUpdates.length) updates.push(`actions: {update: [${actionUpdates.map(gqlInputObject).join(', ')}]}`);
  const patch = `flowPatch: {flowId: ${gqlString(flowId)}, ${updates.join(', ')}}`;
  return `mutation { global { snFlowDesigner { flow(${patch}) { triggerInstances { updates } actions { updates } } } } }`;
}

async function readProcessFlow(sdk, instance, flowId, scope) {
  if (!scope) throw new Error(`Flow ${flowId} has no transaction scope for ProcessFlow read`);
  const endpoint = `${instance}${FLOW_ENDPOINT}/${encodeURIComponent(flowId)}?sysparm_transaction_scope=${encodeURIComponent(scope)}`;
  const response = await sdk.request(endpoint, { method: 'GET' });
  const data = findFlowData(response);
  if (!data || typeof data !== 'object') throw new Error(`ProcessFlow read-back failed for flow ${flowId}`);
  const returnedScope = stringValue(data.scope);
  if (returnedScope && returnedScope !== scope) throw new Error(`ProcessFlow read-back scope did not match flow ${flowId}`);
  return data;
}

async function resolveActionType(sdk, actionType) {
  if (isSysId(actionType)) return { id: actionType, record: { sys_id: actionType, name: actionType } };
  const params = new URLSearchParams({
    sysparm_query: `name=${actionType}^ORf_name=${actionType}^active=true`,
    sysparm_limit: '20',
    sysparm_display_value: 'all',
    sysparm_fields: 'sys_id,name,f_name,fName,active,published',
  });
  const records = await sdk.list('sys_hub_action_type_definition', params);
  const exact = records.filter(record => exactActionName(record).toLowerCase() === actionType.toLowerCase());
  if (exact.length !== 1) throw new Error(exact.length === 0 ? `Published action type not found: ${actionType}` : `Action type is ambiguous: ${actionType}`);
  const record = exact[0];
  if (record.active === false || record.active === 'false' || record.published === false || record.published === 'false') throw new Error(`Action type is not published: ${actionType}`);
  return { id: actionTypeId(record), record };
}

async function readActionDefinition(sdk, instance, actionTypeId, scope) {
  const endpoint = `${instance}/api/now/processflow/action/action_types/${encodeURIComponent(actionTypeId)}?sysparm_transaction_scope=${encodeURIComponent(scope)}`;
  const response = await sdk.request(endpoint, { method: 'GET' });
  const definition = response?.result ?? response?.data?.result ?? response?.data ?? response;
  const schema = schemaEntries(definition);
  if (schema.length === 0) throw new Error(`Action type ${actionTypeId} returned no input schema`);
  return { definition, schema };
}

function buildTypedInputs(action, schema) {
  const supplied = action.inputs || {};
  const allowed = new Set(schema.map(field => field.name));
  for (const key of Object.keys(supplied)) if (!allowed.has(key)) throw new Error(`Unsupported input "${key}" for action ${action.type}`);
  return schema.map(field => {
    if (!field || typeof field !== 'object' || !field.id || !field.parameter || typeof field.parameter !== 'object') {
      throw new Error(`Action ${action.type} returned an incomplete input schema; refusing to invent input metadata for "${field?.name || 'unknown'}"`);
    }
    const suppliedValue = Object.prototype.hasOwnProperty.call(supplied, field.name) ? supplied[field.name] : field.default;
    if ((suppliedValue === undefined || suppliedValue === null) && (field.mandatory === true || field.required === true)) throw new Error(`Missing required input "${field.name}" for action ${action.type}`);
    const value = suppliedValue ?? null;
    const displayValue = field.displayValue ?? field.display_value ?? value;
    return {
      ...field,
      name: field.name,
      value: { schemaless: false, schemalessValue: '', value },
      displayValue: { schemaless: false, schemalessValue: '', value: displayValue },
    };
  });
}

function parseSimpleCondition(condition) {
  if (!condition) return null;
  const match = condition.match(/^([A-Za-z_][A-Za-z0-9_.]*)(STARTSWITH|ENDSWITH|LIKE|NOT LIKE|=|!=|IN|ISEMPTY|ISNOTEMPTY)([^,^]*)$/);
  if (!match) throw new Error('Record trigger condition cannot be encoded as a single supported predicate');
  return { field: match[1], operator: match[2], term: match[3] };
}

async function readTableDescriptor(sdk, instance, scope, table, override) {
  if (override) return override(table);
  const endpoint = `${instance}${TABLE_DESCRIPTOR_ENDPOINT}?table=${encodeURIComponent(table)}&sysparm_transaction_scope=${encodeURIComponent(scope)}`;
  const response = await sdk.request(endpoint, { method: 'GET' });
  const descriptor = response?.result ?? response?.data?.result ?? response?.data ?? response;
  if (!descriptor || typeof descriptor !== 'object') throw new Error(`ProcessFlow table descriptor was unavailable for ${table}`);
  const label = stringValue(descriptor.label || descriptor.displayValue || descriptor.display_value || descriptor.name);
  const displayField = stringValue(descriptor.displayField || descriptor.display_field || descriptor.displayColumn || descriptor.display_column);
  if (!label || !displayField) throw new Error(`ProcessFlow table descriptor for ${table} lacks label/display field`);
  return { ...descriptor, label, displayField };
}

function buildPredicateMetadata(condition, descriptor) {
  const predicate = parseSimpleCondition(condition);
  if (!predicate) return { predicates: [], order_by: [], group_by: [], has_rlq_conditions: false };
  const field = descriptor.fields?.find(item => stringValue(item.name || item.element || item.field) === predicate.field)
    || descriptor.schema?.find(item => stringValue(item.name || item.element || item.field) === predicate.field);
  if (!field) throw new Error(`Record trigger condition field "${predicate.field}" is absent from the table descriptor`);
  const fieldLabel = stringValue(field.label || field.column_label || predicate.field);
  const operatorLabel = stringValue(field?.operators?.[predicate.operator] || predicate.operator);
  const comparison = {
    field_type: stringValue(field?.field_type || field?.type || 'string'),
    operator: predicate.operator,
    term_label: predicate.term,
    or_query: false,
    field_label: fieldLabel,
    column_type: stringValue(field?.column_type || 'element'),
    term: predicate.term,
    display_value: '',
    new_query: false,
    goto_query: false,
    is_pre_evaluated: false,
    rlqc_query: false,
    operator_label: operatorLabel,
    value: predicate.term,
    field: predicate.field,
    type: 'comparison',
  };
  return {
    predicates: [{ compound_type: 'or', subpredicates: [{ compound_type: 'and', subpredicates: [{ compound_type: 'and', subpredicates: [comparison], type: 'compound' }], type: 'compound' }], type: 'compound' }],
    order_by: [],
    group_by: [],
    has_rlq_conditions: false,
  };
}

function makeTriggerPatch(flow, manifest, descriptor) {
  const trigger = findArray(flow, 'triggerInstances')[0];
  if (!trigger) throw new Error('Created flow did not return its default record trigger instance');
  const id = findId(trigger, ['sysId', 'sys_id', 'id', 'triggerId']);
  if (!id) throw new Error('Created flow trigger has no usable identity');
  const metadata = buildPredicateMetadata(manifest.trigger.condition || '', descriptor);
  const wrapped = value => ({ schemaless: false, schemalessValue: '', value });
  return {
    id,
    metadata: JSON.stringify(metadata),
    inputs: [
      { name: 'table', displayField: descriptor.displayField, displayValue: wrapped(descriptor.label), value: wrapped(manifest.trigger.table) },
      { name: 'condition', displayField: manifest.trigger.condition || '', displayValue: wrapped(manifest.trigger.condition || ''), value: wrapped(manifest.trigger.condition || '') },
    ],
  };
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function inputList(component) {
  return component?.inputs || component?.inputValues || [];
}

function inputRawValue(input) {
  return input?.value?.value ?? input?.value ?? input?.displayValue?.value ?? input?.displayValue ?? null;
}

function wrappedValue(value) {
  return { schemaless: false, schemalessValue: '', value };
}

function buildActionUpdate(existing, requested, index) {
  const existingInputs = new Set(inputList(existing).map(input => stringValue(input?.name)));
  for (const name of Object.keys(requested.inputs)) {
    if (!existingInputs.has(name)) throw new Error(`Update action ${index + 1} input "${name}" is not present in the saved flow; refusing to add an input`);
  }
  const uiUniqueIdentifier = stringValue(existing.uiUniqueIdentifier || existing.ui_unique_identifier);
  if (!uiUniqueIdentifier) throw new Error(`Update action ${index + 1} has no saved uiUniqueIdentifier`);
  return {
    uiUniqueIdentifier,
    type: 'action',
    inputs: Object.entries(requested.inputs).map(([name, value]) => ({ name, value: wrappedValue(value) })),
  };
}

function findExistingActions(definition) {
  const actionInstances = findArray(definition, 'actionInstances');
  return actionInstances.length ? actionInstances : findArray(definition, 'actions');
}

async function resolveExistingAction(sdk, actions, requested, index) {
  const actionType = await resolveActionType(sdk, requested.type);
  const matches = actions.filter(action => String(action.order) === String(requested.order)
    && idValue(action.actionTypeSysId || action.action_type_sys_id || action.actionType?.sys_id || action.actionType?.sysId) === actionType.id);
  if (matches.length !== 1) throw new Error(matches.length === 0
    ? `Update action ${index + 1} did not match an existing Action instance at order ${requested.order} with type ${requested.type}`
    : `Update action ${index + 1} matched multiple Action instances at order ${requested.order} with type ${requested.type}`);
  return matches[0];
}

export function validateFlowUpdateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Flow update manifest must be a JSON object');
  const allowed = new Set(['scope', 'trigger', 'actions']);
  for (const key of Object.keys(manifest)) if (!allowed.has(key)) throw new Error(`Flow update field "${key}" is unsupported; only trigger and existing action inputs may be updated`);
  if (manifest.scope !== undefined && !String(manifest.scope).trim()) throw new Error('Flow update scope must not be empty');
  if (manifest.trigger !== undefined) {
    if (!manifest.trigger || typeof manifest.trigger !== 'object' || Array.isArray(manifest.trigger)) throw new Error('Flow update trigger must be an object');
    for (const key of Object.keys(manifest.trigger)) if (!['type', 'table', 'condition'].includes(key)) throw new Error(`Flow update trigger field "${key}" is unsupported`);
    if (manifest.trigger.type !== undefined && manifest.trigger.type !== 'record_create_or_update') throw new Error('Only record_create_or_update trigger updates are supported');
    if (manifest.trigger.table !== undefined && !String(manifest.trigger.table).trim()) throw new Error('Flow update trigger table must not be empty');
    if (manifest.trigger.condition !== undefined && typeof manifest.trigger.condition !== 'string') throw new Error('Flow update trigger condition must be a string');
    if (manifest.trigger.table === undefined && manifest.trigger.condition === undefined) throw new Error('Flow update trigger must specify table and/or condition');
    if (manifest.trigger.condition && !/^[A-Za-z_][A-Za-z0-9_.]*(?:STARTSWITH|ENDSWITH|LIKE|NOT LIKE|=|!=|IN|ISEMPTY|ISNOTEMPTY)[^,^]*$/.test(manifest.trigger.condition)) throw new Error('Flow update trigger condition uses an unsupported encoded-query condition subset');
  }
  if (manifest.actions !== undefined) {
    if (!Array.isArray(manifest.actions)) throw new Error('Flow update actions must be an array');
    for (const [index, action] of manifest.actions.entries()) {
      if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error(`Update action ${index + 1} must be an object`);
      for (const key of Object.keys(action)) if (!['order', 'type', 'inputs'].includes(key)) throw new Error(`Update action ${index + 1} field "${key}" is unsupported; caller-supplied identities are not accepted`);
      if (!Number.isInteger(action.order) || action.order < 1 || !String(action.type || '').trim()) throw new Error(`Update action ${index + 1} requires a positive integer order and type`);
      if (!action.inputs || typeof action.inputs !== 'object' || Array.isArray(action.inputs)) throw new Error(`Update action ${index + 1} inputs must be an object`);
      if (Object.keys(action.inputs).length === 0) throw new Error(`Update action ${index + 1} inputs must contain at least one changed value`);
    }
  }
  if (manifest.trigger === undefined && manifest.actions === undefined) throw new Error('Flow update manifest must specify trigger and/or actions');
  return manifest;
}

function readFlowRecord(sdk, identifier) {
  const exactIdentifier = String(identifier ?? '');
  if (!exactIdentifier) throw new Error('Flow identifier must be an exact sys_id or name');
  assertSafeExactMatch(exactIdentifier);
  const query = isSysId(exactIdentifier) ? `sys_id=${exactIdentifier}` : `name=${exactIdentifier}`;
  return sdk.list('sys_hub_flow', new URLSearchParams({ sysparm_query: query, sysparm_limit: '2', sysparm_display_value: 'all', sysparm_fields: 'sys_id,name,scope,active,status,type' }));
}

async function resolveDraftFlow(sdk, identifier) {
  const rows = await readFlowRecord(sdk, identifier);
  if (rows.length !== 1) throw new Error(rows.length === 0 ? `Flow not found: ${identifier}` : `Flow identifier is ambiguous: ${identifier}; exact target ID or unique name is required`);
  const flow = rows[0];
  const flowId = idValue(flow.sys_id);
  const flowName = stringValue(flow.name);
  if (flowId === PROTECTED_FLOW_ID || flowName === PROTECTED_FLOW_NAME) throw new Error(`Protected flow ${PROTECTED_FLOW_NAME} cannot be updated`);
  if (String(flow.active?.value ?? flow.active ?? '').toLowerCase() === 'true' || String(flow.status?.value ?? flow.status ?? '').toLowerCase() !== 'draft') throw new Error(`Flow ${flowId} is not an inactive Draft; refusing update`);
  return { flow, flowId, flowName };
}

function updatedTrigger(flow, manifest, descriptor) {
  const existing = clone(findArray(flow, 'triggerInstances')[0]);
  if (!existing) throw new Error('Saved flow has no trigger instance');
  const existingMetadata = parseMaybeJson(existing.metadata, null);
  if (existing.metadata && (!existingMetadata || typeof existingMetadata !== 'object' || Array.isArray(existingMetadata))) throw new Error('Saved record trigger metadata is unreadable; refusing to replace it');
  const existingType = stringValue(existing.triggerType || existing.trigger_type || existingMetadata?.triggerType || existingMetadata?.trigger_type);
  if (existingType && existingType !== 'record_create_or_update') throw new Error(`Only record_create_or_update trigger updates are supported; found ${existingType}`);
  const inputs = clone(inputList(existing));
  const tableInput = inputs.find(input => input.name === 'table');
  const conditionInput = inputs.find(input => input.name === 'condition');
  if (!tableInput || !conditionInput) throw new Error('Saved record trigger must have table and condition inputs');
  const currentTable = inputRawValue(tableInput);
  const currentCondition = inputRawValue(conditionInput);
  const table = manifest.trigger.table ?? currentTable;
  const condition = manifest.trigger.condition ?? currentCondition;
  if (manifest.trigger.table !== undefined) {
    tableInput.displayField = descriptor.displayField;
    tableInput.displayValue = wrappedValue(descriptor.label);
    tableInput.value = wrappedValue(table);
  }
  if (manifest.trigger.condition !== undefined) {
    conditionInput.displayValue = wrappedValue(condition);
    conditionInput.value = wrappedValue(condition);
  }
  const id = findId(existing, ['sysId', 'sys_id', 'id', 'triggerId']);
  if (!id) throw new Error('Saved record trigger has no usable identity');
  const update = { id, inputs };
  if (manifest.trigger.condition !== undefined) {
    const generated = buildPredicateMetadata(condition, descriptor);
    const metadata = { ...generated, ...(existingMetadata || {}), predicates: generated.predicates };
    update.metadata = JSON.stringify(metadata);
  } else if (Object.prototype.hasOwnProperty.call(existing, 'metadata')) {
    update.metadata = existing.metadata;
  }
  return { update, currentTable: table };
}

function insertedActions(response) {
  let found = [];
  walk(response, object => {
    if (!found.length && object.actions?.inserts) found = object.actions.inserts;
  });
  return found;
}

async function reconcileAmbiguousCreate(sdk, manifest) {
  const params = new URLSearchParams({ sysparm_query: `name=${manifest.name}`, sysparm_limit: '2', sysparm_display_value: 'all', sysparm_fields: 'sys_id,name,active,status,scope' });
  const records = await sdk.list('sys_hub_flow', params);
  throw new Error(`Flow parent creation was ambiguous; reconciliation found ${records.length} flow(s) named "${manifest.name}". No retry was attempted.`);
}

async function mutationContext(label, readUpdateSet, snapshots, operation, capture) {
  const before = await readUpdateSet();
  const captureBefore = capture ? await capture(before) : undefined;
  try {
    const result = await operation();
    const after = await readUpdateSet();
    const captureAfter = capture ? await capture(after) : undefined;
    snapshots.push({ label, before, after, ...(capture ? { capture_before: captureBefore, capture_after: captureAfter } : {}) });
    return result;
  } catch (error) {
    let after;
    try { after = await readUpdateSet(); } catch (readError) { after = { unavailable: true, reason: readError.message }; }
    let captureAfter;
    if (capture) {
      try { captureAfter = await capture(after); } catch (readError) { captureAfter = unavailableCapture(`capture read failed: ${readError.message}`); }
    }
    snapshots.push({ label, before, after, ...(capture ? { capture_before: captureBefore, capture_after: captureAfter } : {}), error: error.message });
    throw error;
  }
}

function unavailableCapture(reason) {
  return { available: false, status: 'unavailable', reason };
}

async function addPostMutationCapture(snapshot, sdk, readUpdateSet, flowId) {
  const updateSet = await readUpdateSet();
  snapshot.after = updateSet;
  snapshot.capture_after = await readUpdateSetCapture(sdk, updateSet, flowId);
}

export async function readUpdateSetCapture(sdk, updateSet, flowId) {
  const updateSetId = idValue(updateSet?.sys_id || updateSet?.sysId);
  if (!updateSetId) return unavailableCapture('current update set has no selected sys_id (likely Default)');
  const rows = await sdk.list('sys_update_xml', new URLSearchParams({
    sysparm_query: `update_set=${updateSetId}`,
    sysparm_limit: '200',
    sysparm_display_value: 'all',
    sysparm_fields: 'sys_id,name,type,action,target_name,update_set,payload,xml',
  }));
  const matches = rows.filter(row => JSON.stringify(row).includes(flowId));
  return {
    available: true,
    status: matches.length ? 'captured' : 'missing',
    update_set: updateSet,
    count: matches.length,
    records: matches,
  };
}

export async function createFlowFromManifest(sdk, instance, inputManifest, options = {}) {
  const manifest = validateFlowManifest(inputManifest);
  const scope = manifest.scope;
  const idFactory = options.idFactory || (() => randomUUID());
  const readUpdateSet = options.readUpdateSet || (async () => null);
  const snapshots = [];

  let parentResponse;
  try {
    parentResponse = await mutationContext('parent_create', readUpdateSet, snapshots, () => sdk.request(`${instance}${FLOW_ENDPOINT}?param_only_properties=true&sysparm_transaction_scope=${encodeURIComponent(scope)}`, {
      method: 'POST',
      body: JSON.stringify(buildFlowProperties(manifest)),
    }));
  } catch (error) {
    await reconcileAmbiguousCreate(sdk, manifest);
    throw error;
  }
  const flowId = findId(parentResponse, ['sys_id', 'sysId', 'flowId', 'id']);
  if (!flowId) throw new Error('Flow creation response did not include a Flow ID');
  try {
    const parentSnapshot = snapshots.find(snapshot => snapshot.label === 'parent_create');
    if (parentSnapshot) {
      parentSnapshot.capture_before = unavailableCapture('flow ID was not known before parent creation');
      await addPostMutationCapture(parentSnapshot, sdk, readUpdateSet, flowId);
    }
    const initialDefinition = await readProcessFlow(sdk, instance, flowId, scope);
    const tableDescriptor = await readTableDescriptor(sdk, instance, scope, manifest.trigger.table, options.readTableDescriptor);
    const trigger = makeTriggerPatch(initialDefinition, manifest, tableDescriptor);

    const actionInstances = [];
    for (const [index, action] of manifest.actions.entries()) {
      const resolved = await resolveActionType(sdk, action.type);
      const actionDefinition = await readActionDefinition(sdk, instance, resolved.id, scope);
      actionInstances.push({
        actionTypeSysId: resolved.id,
        flowSysId: flowId,
        generationSource: '',
        type: 'action',
        order: String(index + 1),
        parent: '',
        uiUniqueIdentifier: idFactory(),
        parentUiId: '',
        metadata: JSON.stringify(parseMaybeJson(actionDefinition.definition.metadata, {})),
        inputs: buildTypedInputs(action, actionDefinition.schema),
      });
    }

    const patchResponse = await mutationContext('trigger_and_actions_patch', readUpdateSet, snapshots, () => sdk.request(`${instance}${GRAPHQL_ENDPOINT}`, {
      method: 'POST',
      body: JSON.stringify({ query: buildFlowPatchMutation({ flowId, trigger, actions: actionInstances }), variables: {} }),
    }), updateSet => readUpdateSetCapture(sdk, updateSet, flowId));
    assertGraphQLSuccess(patchResponse, 'Flow trigger/action patch');
    const inserted = insertedActions(patchResponse);
    if (inserted.length !== actionInstances.length) throw new Error(`Flow action patch returned ${inserted.length} inserted action identities; expected ${actionInstances.length}`);

    const processflow = await readProcessFlow(sdk, instance, flowId, scope);
    const { version } = await mutationContext('autosave_version', readUpdateSet, snapshots, () => createVerifiedFlowVersion(sdk, {
      instance, flowId, scope, type: 'Autosave', annotation: 'JSN flow create',
    }), updateSet => readUpdateSetCapture(sdk, updateSet, flowId));
    const selectedUpdateSet = await readUpdateSet();
    const updateSetCapture = await readUpdateSetCapture(sdk, selectedUpdateSet, flowId);

    const triggerReadback = findArray(processflow, 'triggerInstances')[0] || {};
    return {
      flow: { id: flowId, name: manifest.name, status: 'draft', active: false },
      trigger: { ...triggerReadback, id: findId(triggerReadback, ['sysId', 'sys_id', 'id']) || trigger.id },
      actions: inserted,
      processflow,
      definition_readback: { available: true, status: 'read_back', flow_id: flowId },
      version,
      update_set_capture: updateSetCapture,
      update_set_mutations: snapshots,
      lifecycle: { published: false, supported: ['draft', 'autosave'], deferred: ['publish/activation', 'Flow Logic', 'subflows', 'flow variables', 'error handling'] },
    };
  } catch (error) {
    throw new Error(`Flow ${flowId} creation incomplete: ${error.message}; reconciliation: ${JSON.stringify(snapshots)}`, { cause: error });
  }
}

export async function updateFlowFromManifest(sdk, instance, identifier, inputManifest, options = {}) {
  const manifest = validateFlowUpdateManifest(inputManifest);
  const target = await resolveDraftFlow(sdk, identifier);
  const flowId = target.flowId;
  const scope = stringValue(manifest.scope ?? target.flow.scope);
  const readUpdateSet = options.readUpdateSet || (async () => null);
  if (!scope) throw new Error(`Flow ${flowId} has no transaction scope`);
  if (manifest.scope !== undefined && stringValue(target.flow.scope) && manifest.scope !== stringValue(target.flow.scope)) throw new Error(`Flow ${flowId} scope does not match the update manifest`);
  const beforeDefinition = await readProcessFlow(sdk, instance, flowId, scope);
  const snapshots = [];
  const triggerUpdates = [];
  const actionUpdates = [];
  const changedActionInputs = new Map();
  const actionTargets = new Map();
  let triggerUpdate;
  if (manifest.trigger !== undefined) {
    const currentTrigger = findArray(beforeDefinition, 'triggerInstances')[0];
    const currentTable = inputRawValue(inputList(currentTrigger).find(input => input.name === 'table'));
    const descriptor = await readTableDescriptor(sdk, instance, scope, manifest.trigger.table ?? currentTable, options.readTableDescriptor);
    triggerUpdate = updatedTrigger(beforeDefinition, manifest, descriptor).update;
    triggerUpdates.push(triggerUpdate);
  }
  const existingActions = findExistingActions(beforeDefinition);
  for (const [index, requested] of (manifest.actions || []).entries()) {
    const existing = await resolveExistingAction(sdk, existingActions, requested, index);
    const update = buildActionUpdate(existing, requested, index);
    actionUpdates.push(update);
    const uiId = stringValue(existing.uiUniqueIdentifier || existing.ui_unique_identifier);
    actionTargets.set(uiId, existing);
    changedActionInputs.set(uiId, new Set(Object.keys(requested.inputs)));
  }
  if (triggerUpdates.length === 0 && actionUpdates.length === 0) throw new Error(`Flow ${flowId} update has no supported changes`);

  try {
    const patchResponse = await mutationContext('trigger_and_actions_update', readUpdateSet, snapshots, () => sdk.request(`${instance}${GRAPHQL_ENDPOINT}`, {
      method: 'POST',
      body: JSON.stringify({ query: buildFlowUpdateMutation({ flowId, triggerUpdates, actionUpdates }), variables: {} }),
    }), updateSet => readUpdateSetCapture(sdk, updateSet, flowId));
    assertGraphQLSuccess(patchResponse, 'Flow trigger/action update');
    const processflow = await readProcessFlow(sdk, instance, flowId, scope);
    const readbackTrigger = findArray(processflow, 'triggerInstances')[0];
    if (triggerUpdate) {
      if (!readbackTrigger || findId(readbackTrigger, ['sysId', 'sys_id', 'id', 'triggerId']) !== triggerUpdate.id) throw new Error(`Flow ${flowId} trigger update was not readable after mutation`);
      const beforeTrigger = findArray(beforeDefinition, 'triggerInstances')[0];
      const preserveBefore = { ...beforeTrigger, inputs: undefined, metadata: undefined };
      const preserveAfter = { ...readbackTrigger, inputs: undefined, metadata: undefined };
      if (JSON.stringify(preserveBefore) !== JSON.stringify(preserveAfter)) throw new Error(`Flow ${flowId} trigger readback changed fields omitted by the manifest`);
      const readbackInputs = inputList(readbackTrigger);
      const beforeInputs = inputList(beforeTrigger);
      if (readbackInputs.length !== beforeInputs.length) throw new Error(`Flow ${flowId} trigger input count changed during update`);
      const requestedInputs = new Set();
      if (manifest.trigger.table !== undefined) requestedInputs.add('table');
      if (manifest.trigger.condition !== undefined) requestedInputs.add('condition');
      for (const beforeInput of beforeInputs) {
        const afterInput = readbackInputs.find(input => input.name === beforeInput.name);
        if (!afterInput) throw new Error(`Flow ${flowId} trigger lost input ${beforeInput.name} during update`);
        if (!requestedInputs.has(beforeInput.name) && JSON.stringify(beforeInput) !== JSON.stringify(afterInput)) throw new Error(`Flow ${flowId} trigger changed omitted input ${beforeInput.name}`);
      }
      if (manifest.trigger.table !== undefined && inputRawValue(readbackInputs.find(input => input.name === 'table')) !== manifest.trigger.table) throw new Error(`Flow ${flowId} trigger table readback did not match the requested value`);
      if (manifest.trigger.condition !== undefined) {
        if (inputRawValue(readbackInputs.find(input => input.name === 'condition')) !== manifest.trigger.condition) throw new Error(`Flow ${flowId} trigger condition readback did not match the requested value`);
        if (!JSON.stringify(parseMaybeJson(readbackTrigger.metadata, {})).includes(manifest.trigger.condition)) throw new Error(`Flow ${flowId} trigger metadata readback did not retain the requested predicate`);
        const beforeMetadata = parseMaybeJson(beforeTrigger.metadata, {});
        const afterMetadata = parseMaybeJson(readbackTrigger.metadata, {});
        delete beforeMetadata.predicates;
        delete afterMetadata.predicates;
        if (JSON.stringify(beforeMetadata) !== JSON.stringify(afterMetadata)) throw new Error(`Flow ${flowId} trigger metadata changed fields omitted by the manifest`);
      } else if (JSON.stringify(parseMaybeJson(beforeTrigger.metadata, {})) !== JSON.stringify(parseMaybeJson(readbackTrigger.metadata, {}))) {
        throw new Error(`Flow ${flowId} trigger metadata changed when the condition was omitted`);
      }
    }
    const readbackActions = findExistingActions(processflow);
    for (const update of actionUpdates) {
      const uiId = stringValue(update.uiUniqueIdentifier);
      const readback = readbackActions.find(action => stringValue(action.uiUniqueIdentifier || action.ui_unique_identifier) === uiId);
      if (!readback) throw new Error(`Flow ${flowId} Action ${uiId} was not readable after mutation`);
      const before = actionTargets.get(uiId);
      const changed = changedActionInputs.get(uiId) || new Set();
      for (const input of inputList(before)) {
        const afterInput = inputList(readback).find(candidate => candidate.name === input.name);
        if (!afterInput) throw new Error(`Flow ${flowId} Action ${uiId} lost input ${input.name} during update`);
        if (!changed.has(input.name) && JSON.stringify(input) !== JSON.stringify(afterInput)) throw new Error(`Flow ${flowId} Action ${uiId} changed omitted input ${input.name}`);
        if (changed.has(input.name) && inputRawValue(afterInput) !== inputRawValue(update.inputs.find(candidate => candidate.name === input.name))) throw new Error(`Flow ${flowId} Action ${uiId} input ${input.name} did not match the requested value`);
      }
    }
    const { version } = await mutationContext('autosave_version', readUpdateSet, snapshots, () => createVerifiedFlowVersion(sdk, {
      instance, flowId, scope, type: 'Autosave', annotation: 'JSN flow update',
    }), updateSet => readUpdateSetCapture(sdk, updateSet, flowId));
    const selectedUpdateSet = await readUpdateSet();
    const updateSetCapture = await readUpdateSetCapture(sdk, selectedUpdateSet, flowId);
    return {
      flow: { id: flowId, name: target.flowName, status: 'draft', active: false },
      processflow,
      definition_readback: { available: true, status: 'read_back', flow_id: flowId },
      version,
      update_set_capture: updateSetCapture,
      update_set_mutations: snapshots,
      lifecycle: { published: false, supported: ['draft', 'autosave'], deferred: ['publish/activation', 'Flow Logic', 'subflows', 'flow variables', 'error handling'] },
    };
  } catch (error) {
    throw new Error(`Flow ${flowId} update incomplete: ${error.message}; reconciliation: ${JSON.stringify(snapshots)}`, { cause: error });
  }
}

export async function readCurrentUpdateSet(sdk) {
  const params = new URLSearchParams({ sysparm_query: 'user_name=javascript:gs.getUserName()', sysparm_limit: '1', sysparm_fields: 'sys_id' });
  const users = await sdk.list('sys_user', params);
  const userId = idValue(users[0]?.sys_id);
  if (!userId) return { name: 'Default', sys_id: '' };
  const preference = await sdk.list('sys_user_preference', new URLSearchParams({ sysparm_query: `user=${userId}^name=sys_update_set`, sysparm_limit: '1', sysparm_fields: 'value' }));
  const updateSetId = idValue(preference[0]?.value);
  if (!updateSetId || updateSetId === '-') return { name: 'Default', sys_id: '' };
  const records = await sdk.list('sys_update_set', new URLSearchParams({ sysparm_query: `sys_id=${updateSetId}`, sysparm_limit: '1', sysparm_fields: 'sys_id,name,state' }));
  return records[0] || { name: updateSetId, sys_id: updateSetId };
}
