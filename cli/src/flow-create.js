import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { flowSafeEditRequest, withFlowSafeEdit } from './flow-safe-edit.js';
import { assertSafeExactMatch } from './helpers.js';
import { createVerifiedFlowVersion } from './flow-versioning.js';
import {
  RECORD_TRIGGER_FAMILY,
  SUPPORTED_TRIGGER_TYPES,
  TRIGGER_DEFINITION_TABLE,
  buildTriggerInputs,
  buildTriggerInstance,
  conditionInputFor,
  readTableDescriptor,
  readTriggerInputDefinitions,
  tableInputFor,
  flowDesignParameter,
  triggerFamily,
} from './flow-triggers.js';

const FLOW_ENDPOINT = '/api/now/processflow/flow';
const GRAPHQL_ENDPOINT = '/api/now/graphql';
const PROTECTED_FLOW_ID = 'c215135293bf03d087b0f14fdd03d652';
const PROTECTED_FLOW_NAME = 'jace-test-flow';
// Design-time revisions this CLI itself creates. Published version rows must be
// unchanged by an edit, but every save necessarily adds one Autosave row.
const AUTOSAVE_VERSION_TYPE = 'Autosave';
const FLOW_RECORD_FIELDS = 'sys_id,name,sys_scope,scope,active,status,type,sys_updated_on,master_snapshot,latest_snapshot,version_record,version';

// Everything this partial-update contract still cannot do, whatever the
// lifecycle state. Published edits reuse the same component rules.
const DEFERRED_LIFECYCLE = ['publish/activation', 'Flow Logic', 'subflows', 'flow variables', 'error handling'];

function supportedLifecycle(published) {
  return published
    ? ['draft', 'autosave', 'published working-definition edit']
    : ['draft', 'autosave'];
}

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

function schemaEntries(definition, requireTypes = false) {
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
        if (requireTypes && !stringValue(field.type || field.inputType || field.valueType)) throw new Error(`Input ${name} has no provider type; refusing to invent a guided schema`);
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
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) throw new Error('Flow manifest requires a trigger object');
  for (const key of Object.keys(trigger)) if (!['type', 'table', 'condition', 'inputs'].includes(key)) throw new Error(`Flow manifest trigger field "${key}" is unsupported`);
  if (!SUPPORTED_TRIGGER_TYPES.has(String(trigger.type))) throw new Error(`Unsupported trigger.type "${trigger.type}"; supported families are ${[...SUPPORTED_TRIGGER_TYPES].join(', ')}`);
  if (trigger.table !== undefined && !String(trigger.table).trim()) throw new Error('Trigger table must not be empty');
  if (trigger.condition !== undefined && typeof trigger.condition !== 'string') throw new Error('Record trigger condition must be a string');
  if (trigger.condition && !/^[A-Za-z_][A-Za-z0-9_.]*(?:STARTSWITH|ENDSWITH|LIKE|NOT LIKE|=|!=|IN|ISEMPTY|ISNOTEMPTY)[^,^]*$/.test(trigger.condition)) {
    throw new Error('Record trigger condition uses an unsupported encoded-query condition subset');
  }
  if (trigger.inputs !== undefined && (!trigger.inputs || typeof trigger.inputs !== 'object' || Array.isArray(trigger.inputs))) throw new Error('Trigger inputs must be an object');
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
  const triggerInsert = {
    flowSysId: trigger.flowSysId,
    name: trigger.name,
    type: trigger.type,
    triggerType: trigger.triggerType,
    triggerDefinitionId: trigger.triggerDefinitionId,
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
  const patch = `flowPatch: {flowId: ${gqlString(flowId)}, triggerInstances: {insert: [${gqlInputObject(triggerInsert)}]}, actions: {insert: [${actionInsert.map(gqlInputObject).join(', ')}]}}`;
  // `triggerInstances.updates` is a leaf [String] on this schema; only `inserts`
  // carries identities, and only for triggers does `inserts` lack a uiUniqueIdentifier.
  return `mutation { global { snFlowDesigner { flow(${patch}) { triggerInstances { inserts { sysId } updates } actions { inserts { sysId uiUniqueIdentifier } } } } } }`;
}

export function buildFlowUpdateMutation({ flowId, triggerUpdates = [], actionUpdates = [] }) {
  const updates = [];
  if (triggerUpdates.length) updates.push(`triggerInstances: {update: [${triggerUpdates.map(gqlInputObject).join(', ')}]}`);
  if (actionUpdates.length) updates.push(`actions: {update: [${actionUpdates.map(gqlInputObject).join(', ')}]}`);
  const patch = `flowPatch: {flowId: ${gqlString(flowId)}, ${updates.join(', ')}}`;
  return `mutation { global { snFlowDesigner { flow(${patch}) { triggerInstances { updates } actions { updates } } } } }`;
}

export async function readProcessFlow(sdk, instance, flowId, scope) {
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

export async function readActionDefinition(sdk, instance, actionTypeId, scope, { requireTypes = false } = {}) {
  const endpoint = `${instance}/api/now/processflow/action/action_types/${encodeURIComponent(actionTypeId)}?sysparm_transaction_scope=${encodeURIComponent(scope)}`;
  const response = await sdk.request(endpoint, { method: 'GET' });
  const definition = response?.result ?? response?.data?.result ?? response?.data ?? response;
  const schema = schemaEntries(definition, requireTypes);
  if (schema.length === 0) throw new Error(`Action type ${actionTypeId} returned no input schema`);
  return { definition, schema };
}

export function buildTypedInputs(action, schema) {
  const supplied = action.inputs || {};
  const allowed = new Set(schema.map(field => field?.name).filter(Boolean));
  for (const key of Object.keys(supplied)) if (!allowed.has(key)) throw new Error(`Unsupported input "${key}" for action ${action.type}`);
  return schema.map(field => {
    // The instance's own definition is the contract: identity is required,
    // everything else is echoed back untouched. Demanding a key the provider
    // omits breaks real actions.
    if (!field || typeof field !== 'object' || !field.id || !field.name) {
      throw new Error(`Action ${action.type} returned an incomplete input schema; refusing to invent input metadata for "${field?.name || 'unknown'}"`);
    }
    if (field.parameter !== undefined && (typeof field.parameter !== 'object' || field.parameter === null || Array.isArray(field.parameter))) {
      throw new Error(`Action ${action.type} input "${field.name}" has a malformed parameter block; refusing to change it`);
    }
    const suppliedValue = Object.prototype.hasOwnProperty.call(supplied, field.name) ? supplied[field.name] : field.default;
    const parameter = field.parameter || {};
    if ((suppliedValue === undefined || suppliedValue === null)
      && (field.mandatory === true || field.required === true || parameter.mandatory === true || parameter.required === true)) {
      throw new Error(`Missing required input "${field.name}" for action ${action.type}`);
    }
    const value = suppliedValue ?? null;
    const displayValue = field.displayValue ?? field.display_value ?? value;
    // global_snFlowDesigner_ActionInstanceValue accepts ONLY these keys. The
    // ProcessFlow action definition hands back the whole UI schema on the input
    // object (uiDisplayTypeLabel, choices, type_label, …) and spreading it makes
    // the mutation fail validation, so the schema is carried inside `parameter`.
    return {
      id: field.id,
      name: field.name,
      children: Array.isArray(field.children) ? field.children : [],
      displayField: stringValue(field.displayField || field.display_field || ''),
      scriptActive: false,
      parameter: actionInputParameter(field),
      value: { schemaless: false, schemalessValue: '', value },
      displayValue: { schemaless: false, schemalessValue: '', value: displayValue },
    };
  });
}

// Providers hand back the input metadata in one of two shapes: nested inside a
// `parameter` block (the earlier contract) or FLAT on the input object (the real
// published Log action's action_types route). The nested block wins when it
// exists, flat keys fill in only what it leaves empty, and the result is always
// narrowed to the fields global_snFlowDesigner_FlowDesignParameter accepts.
export function actionInputParameter(field) {
  if (field?.parameter === undefined) return flowDesignParameter(field);
  const parameter = flowDesignParameter(field.parameter);
  const flat = flowDesignParameter(field);
  for (const key of Object.keys(flat)) {
    if (flat[key] === undefined || flat[key] === '') continue;
    if (parameter[key] === undefined || parameter[key] === '') parameter[key] = flat[key];
  }
  return parameter;
}

function parseSimpleCondition(condition) {
  if (!condition) return null;
  const match = condition.match(/^([A-Za-z_][A-Za-z0-9_.]*)(STARTSWITH|ENDSWITH|LIKE|NOT LIKE|=|!=|IN|ISEMPTY|ISNOTEMPTY)([^,^]*)$/);
  if (!match) throw new Error('Record trigger condition cannot be encoded as a single supported predicate');
  return { field: match[1], operator: match[2], term: match[3] };
}

// Trigger predicate metadata is DERIVED BY THE INSTANCE, not by this CLI: the
// snFlowDesigner patch parses the `condition` input into
// `metadata.query_parse.predicates` itself (verified live on insert and on
// update — the returned field_label/operator_label/field_type match Flow
// Designer's own output). Sending `{}` and verifying the derived predicate by
// read-back is therefore both simpler and more faithful than rebuilding the
// predicate tree from a table descriptor, and it removes the dependency on the
// ProcessFlow table-descriptor route, which returns 400 on this instance.
const DEFAULT_TRIGGER_METADATA = '{}';

function predicateMetadataMatches(metadata, condition) {
  const expected = parseSimpleCondition(condition);
  if (!expected) return true;
  const parsed = parseMaybeJson(metadata, null);
  const comparisons = [];
  walk(parsed, object => {
    if (stringValue(object.type).toLowerCase() !== 'comparison') return;
    // The instance stores the parsed predicate with `term` holding the WHOLE
    // encoded condition and `value` holding the extracted term, so the term
    // comparison must prefer `value` (e.g. for
    // "short_descriptionSTARTSWITHjacetest": term = the full string,
    // value = "jacetest").
    comparisons.push({
      field: stringValue(object.field),
      operator: stringValue(object.operator),
      term: stringValue(object.value ?? object.term),
    });
  });
  return comparisons.some(comparison => comparison.field === expected.field
    && comparison.operator === expected.operator
    && comparison.term === expected.term);
}

function assertPredicateMetadataMatches(metadata, condition, label) {
  if (!predicateMetadataMatches(metadata, condition)) throw new Error(`${label} predicate metadata did not match the requested field, operator, and term`);
}

// The instance stores predicate metadata as {query_parse: {predicates: [...]}},
// so dropping only a top-level `predicates` key is not enough to compare the
// parts of the metadata a manifest did not ask to change.
function stripPredicates(value) {
  if (Array.isArray(value)) return value.map(stripPredicates);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'predicates') continue;
    out[key] = stripPredicates(item);
  }
  return out;
}

function actionTypeIdOf(action) {
  return idValue(action?.actionTypeSysId || action?.action_type_sys_id || action?.actionType?.sys_id || action?.actionType?.sysId);
}

function verifyCreatedFlowReadback({ flowId, processflow, trigger, insertedTrigger, manifest, actionInstances, inserted }) {
  const returnedFlowId = stringValue(processflow.flowId || processflow.flow_id || processflow.sysId || processflow.sys_id);
  if (returnedFlowId && returnedFlowId !== flowId) throw new Error(`ProcessFlow read-back returned a different flow ID (${returnedFlowId})`);

  const triggers = findArray(processflow, 'triggerInstances');
  if (triggers.length !== 1) throw new Error(`ProcessFlow read-back returned ${triggers.length} trigger instances; expected one`);
  const savedTrigger = triggers[0];
  const savedTriggerId = findId(savedTrigger, ['sysId', 'sys_id', 'id', 'triggerId']);
  const insertedTriggerId = findId(insertedTrigger || {}, ['sysId', 'sys_id', 'id']);
  if (!insertedTriggerId) throw new Error('Flow trigger insert did not return a trigger identity');
  if (savedTriggerId !== insertedTriggerId) throw new Error('Created trigger identity was not preserved in ProcessFlow read-back');
  if (stringValue(savedTrigger.triggerDefinitionId || savedTrigger.trigger_definition_id) !== trigger.triggerDefinitionId) {
    throw new Error(`Created trigger definition did not match the requested ${trigger.triggerDefinitionId}`);
  }
  if (stringValue(savedTrigger.type) !== trigger.type) throw new Error(`Created trigger type did not match the requested ${trigger.type}`);
  const savedTriggerInputs = inputList(savedTrigger);
  for (const expected of trigger.inputs) {
    const actual = savedTriggerInputs.find(input => input.name === expected.name);
    if (!actual || inputRawValue(actual) !== inputRawValue(expected)) throw new Error(`Created trigger ${expected.name} did not match the requested value in ProcessFlow read-back`);
  }
  assertPredicateMetadataMatches(savedTrigger.metadata, manifest.trigger.condition || '', 'Created trigger');

  const savedActions = findExistingActions(processflow);
  if (savedActions.length !== actionInstances.length) throw new Error(`ProcessFlow read-back returned ${savedActions.length} Actions; expected ${actionInstances.length}`);
  const insertedByUiId = new Map(inserted.map(action => [stringValue(action.uiUniqueIdentifier || action.ui_unique_identifier), action]));
  for (const expected of actionInstances) {
    const insertedAction = insertedByUiId.get(expected.uiUniqueIdentifier);
    if (!insertedAction) throw new Error(`Created Action ${expected.uiUniqueIdentifier} was not returned by the GraphQL mutation`);
    const savedMatches = savedActions.filter(action => stringValue(action.uiUniqueIdentifier || action.ui_unique_identifier) === expected.uiUniqueIdentifier);
    if (savedMatches.length !== 1) throw new Error(`Created Action ${expected.uiUniqueIdentifier} was not uniquely present in ProcessFlow read-back`);
    const savedAction = savedMatches[0];
    const insertedId = findId(insertedAction, ['sysId', 'sys_id', 'id']);
    const savedId = findId(savedAction, ['sysId', 'sys_id', 'id']);
    if (!insertedId || savedId !== insertedId) throw new Error(`Created Action ${expected.uiUniqueIdentifier} identity did not match the GraphQL mutation read-back`);
    if (actionTypeIdOf(savedAction) !== expected.actionTypeSysId) throw new Error(`Created Action ${expected.uiUniqueIdentifier} type did not match the requested Action`);
    if (String(savedAction.order) !== String(expected.order)) throw new Error(`Created Action ${expected.uiUniqueIdentifier} order did not match the requested order`);
    const savedInputs = inputList(savedAction);
    if (savedInputs.length !== expected.inputs.length) throw new Error(`Created Action ${expected.uiUniqueIdentifier} input count did not match the installed schema`);
    for (const expectedInput of expected.inputs) {
      const actualInput = savedInputs.find(input => input.name === expectedInput.name);
      if (!actualInput || inputRawValue(actualInput) !== inputRawValue(expectedInput)) throw new Error(`Created Action ${expected.uiUniqueIdentifier} input ${expectedInput.name} did not match the requested value`);
    }
  }
}

export async function resolveTriggerDefinition(sdk, type) {
  if (!SUPPORTED_TRIGGER_TYPES.has(String(type))) throw new Error(`Unsupported trigger.type "${type}"`);
  const rows = await sdk.list(TRIGGER_DEFINITION_TABLE, new URLSearchParams({
    sysparm_query: `type=${type}^active=true`,
    sysparm_limit: '5',
    sysparm_display_value: 'all',
    sysparm_fields: 'sys_id,name,type,active,category',
  }));
  if (rows.length !== 1) throw new Error(rows.length === 0
    ? `Trigger definition not found or inactive: ${type}`
    : `Trigger definition is ambiguous: ${type}`);
  const row = rows[0];
  return {
    sysId: idValue(row.sys_id || row.sysId),
    name: stringValue(row.name),
    type: stringValue(row.type),
    // The definition's category display name is what the trigger instance stores
    // as triggerType ("Record", "Scheduled", "Application"). The raw value is the
    // category sys_id, so take the display value when the API returned one.
    triggerType: categoryDisplay(row.category),
  };
}

function categoryDisplay(value) {
  if (value && typeof value === 'object') return stringValue(value.display_value ?? value.value);
  return stringValue(value);
}

/**
 * Build the triggerInstances.insert payload from the definition's own declared
 * inputs. `manifest.trigger.table` / `.condition` are shortcuts onto whichever
 * declared input carries them; everything else goes through `trigger.inputs`.
 */
export async function buildCreateTrigger(sdk, flowId, manifest, definition, options = {}) {
  const declared = await readTriggerInputDefinitions(sdk, definition.sysId);
  if (!declared.length && options.requireInputs === true) throw new Error(`Trigger definition ${definition.type} declares no inputs`);
  const tableInput = tableInputFor(declared);
  const conditionInput = conditionInputFor(declared);
  const supplied = { ...(manifest.trigger.inputs || {}) };

  if (manifest.trigger.table !== undefined) {
    if (!tableInput) throw new Error(`Trigger ${definition.type} does not declare a table input`);
    supplied[tableInput.name] = manifest.trigger.table;
  }
  if (manifest.trigger.condition !== undefined) {
    if (!conditionInput) throw new Error(`Trigger ${definition.type} does not declare a condition input`);
    supplied[conditionInput.name] = manifest.trigger.condition;
  }
  let descriptor = null;
  if (tableInput && supplied[tableInput.name]) {
    descriptor = options.readTableDescriptor
      ? await options.readTableDescriptor(supplied[tableInput.name])
      : await readTableDescriptor(sdk, supplied[tableInput.name]);
  }

  return buildTriggerInstance({
    flowId,
    definition,
    triggerType: definition.triggerType,
    metadata: DEFAULT_TRIGGER_METADATA,
    inputs: buildTriggerInputs(declared, supplied, descriptor),
  });
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

function maskInputValue(input) {
  const copy = clone(input);
  for (const field of ['value', 'displayValue']) {
    if (copy[field] && typeof copy[field] === 'object' && Object.hasOwn(copy[field], 'value')) copy[field].value = null;
    else if (Object.hasOwn(copy, field)) copy[field] = null;
  }
  return copy;
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
  return sdk.list('sys_hub_flow', new URLSearchParams({ sysparm_query: query, sysparm_limit: '2', sysparm_display_value: 'all', sysparm_fields: FLOW_RECORD_FIELDS }));
}

// A flow is editable either as an inactive Draft (working definition only) or as
// a published/active flow whose definition reports write access. `draft` is the
// only state that skips the provider write-permission check: a published flow is
// not inherently unwritable, and the decision belongs to the provider.
export function flowLifecycleState(flow) {
  const active = stringValue(flow.active).toLowerCase() === 'true';
  const status = stringValue(flow.status).toLowerCase();
  return { active, status: status || 'unknown', draft: !active && status === 'draft' };
}

function describeState(lifecycle) {
  const parts = [lifecycle.active ? 'active' : 'inactive'];
  if (lifecycle.status && lifecycle.status !== 'unknown') parts.push(`status=${lifecycle.status}`);
  return parts.join(', ');
}

async function resolveFlowForUpdate(sdk, identifier) {
  const rows = await readFlowRecord(sdk, identifier);
  if (rows.length !== 1) throw new Error(rows.length === 0 ? `Flow not found: ${identifier}` : `Flow identifier is ambiguous: ${identifier}; exact target ID or unique name is required`);
  const flow = rows[0];
  const flowId = idValue(flow.sys_id);
  const flowName = stringValue(flow.name);
  if (flowId === PROTECTED_FLOW_ID || flowName === PROTECTED_FLOW_NAME) throw new Error(`Protected flow ${PROTECTED_FLOW_NAME} cannot be updated`);
  return { flow, flowId, flowName, lifecycle: flowLifecycleState(flow) };
}

// The ProcessFlow definition is the write contract for a published flow. A
// missing or false can_write means the provider will reject the content patch
// with "Insufficient access level for operation [write]", so refuse before any
// edit session exists and say which permission is missing.
function assertDefinitionWritable(flowId, scope, lifecycle, definition) {
  if (lifecycle.draft) return;
  const security = definition?.security;
  const canWrite = security && typeof security === 'object' ? security.can_write : undefined;
  if (canWrite === true) return;
  const reported = canWrite === false ? 'security.can_write=false' : 'no security.can_write';
  throw new Error(`Flow ${flowId} is ${describeState(lifecycle)} and its ProcessFlow definition reports ${reported}, so the provider would reject a content write with "Insufficient access level for operation [write]". This is a flow content-permission problem, not a published-flow limitation: no edit session, content write or Autosave was attempted. Use an account/scope with write access to the flow's application (${scope}) or edit the flow in Flow Designer as a user who can write it. Published snapshots were not touched.`);
}

function digestDefinition(definition) {
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex');
}

// Runtime state of a published flow: the parent pointers that decide whether it
// runs, the frozen published definition read through its master snapshot id, and
// the version rows that a publish created. Autosave rows are excluded because
// every accepted edit adds exactly one design-time revision.
async function readFlowRuntime(sdk, instance, flowId, { scope, snapshotId }) {
  const records = await sdk.list('sys_hub_flow', new URLSearchParams({
    sysparm_query: `sys_id=${flowId}`,
    sysparm_limit: '1',
    sysparm_display_value: 'all',
    sysparm_fields: FLOW_RECORD_FIELDS,
  }));
  if (records.length !== 1) throw new Error(`Flow ${flowId} runtime read returned ${records.length} records; cannot verify published state`);
  const record = records[0];
  const pointers = {
    active: stringValue(record.active),
    status: stringValue(record.status),
    master_snapshot: stringValue(record.master_snapshot),
    latest_snapshot: stringValue(record.latest_snapshot),
    version_record: stringValue(record.version_record),
  };
  let publishedDefinition;
  if (snapshotId) {
    const response = await sdk.request(`${instance}${FLOW_ENDPOINT}/${encodeURIComponent(snapshotId)}?sysparm_transaction_scope=${encodeURIComponent(scope)}`, { method: 'GET' });
    const definition = findFlowData(response);
    if (!definition || typeof definition !== 'object') throw new Error(`Published snapshot ${snapshotId} for flow ${flowId} was unreadable; refusing to compare published runtime state`);
    publishedDefinition = { snapshot_id: snapshotId, digest: digestDefinition(definition) };
  } else {
    publishedDefinition = { snapshot_id: '', digest: '' };
  }
  const versionRows = await sdk.list('sys_hub_flow_version', new URLSearchParams({
    sysparm_query: `flow=${flowId}^ORDERBYDESCsys_updated_on`,
    sysparm_limit: '50',
    sysparm_display_value: 'all',
    sysparm_fields: 'sys_id,flow,type,sys_created_on',
  }));
  const versionRowsStable = versionRows
    .map(row => ({ sys_id: stringValue(row.sys_id), type: stringValue(row.type), created: stringValue(row.sys_created_on) }))
    .filter(row => row.type !== AUTOSAVE_VERSION_TYPE)
    .sort((left, right) => left.sys_id.localeCompare(right.sys_id));
  return { record: pointers, published_definition: publishedDefinition, version_rows: versionRowsStable };
}

// Published runtime must not move. Two parent fields do move by platform design
// when a published flow is saved: the record's status becomes a draft working
// copy and version_record points at the new Autosave. Those are accepted only in
// that exact shape (and reported), because the runtime gates are `active`, the
// frozen snapshot pointers and the published definition itself.
function runtimeDifferences(before, after, { autosaveVersionId, newVersionType } = {}) {
  const differences = [];
  const checkout = [];
  for (const field of ['active', 'master_snapshot', 'latest_snapshot']) {
    if (before.record[field] !== after.record[field]) differences.push({ field, before: before.record[field], after: after.record[field] });
  }
  if (before.record.status !== after.record.status) {
    const publishedToDraft = before.record.status === 'published' && after.record.status === 'draft';
    const entry = { field: 'status', before: before.record.status, after: after.record.status };
    if (publishedToDraft) checkout.push({ ...entry, reason: 'platform checkout: the published flow now has a draft working copy; the published snapshot still runs' });
    else differences.push(entry);
  }
  if (before.record.version_record !== after.record.version_record) {
    const entry = { field: 'version_record', before: before.record.version_record, after: after.record.version_record };
    if (autosaveVersionId && after.record.version_record === autosaveVersionId) checkout.push({ ...entry, reason: `pointer moved to this command's ${newVersionType || 'Autosave'} version` });
    else differences.push(entry);
  }
  if (before.published_definition.digest !== after.published_definition.digest) {
    differences.push({ field: 'published_definition', before: before.published_definition, after: after.published_definition });
  }
  if (JSON.stringify(before.version_rows) !== JSON.stringify(after.version_rows)) {
    differences.push({ field: 'published_version_rows', before: before.version_rows, after: after.version_rows });
  }
  return { differences, design_time_changes: checkout };
}

function updatedTrigger(flow, manifest, descriptor) {
  if (findArray(flow, 'triggerInstances').length !== 1) throw new Error('Saved flow must have exactly one trigger for trigger updates');
  const existing = clone(findArray(flow, 'triggerInstances')[0]);
  if (!existing) throw new Error('Saved flow has no trigger instance');
  const existingMetadata = parseMaybeJson(existing.metadata, null);
  if (existing.metadata && (!existingMetadata || typeof existingMetadata !== 'object' || Array.isArray(existingMetadata))) throw new Error('Saved record trigger metadata is unreadable; refusing to replace it');
  const existingFamily = triggerFamily(existing);
  if (existingFamily && existingFamily !== RECORD_TRIGGER_FAMILY) throw new Error(`Only ${RECORD_TRIGGER_FAMILY} trigger updates are supported; found ${existingFamily}`);
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
  const changed = inputs.filter(input => manifest.trigger[input.name] !== undefined);
  const update = { id, inputs: changed.map(input => ({
    ...(input.id ? { id: input.id } : {}),
    name: input.name,
    displayField: input.displayField,
    scriptActive: input.scriptActive,
    ...(input.parameter ? { parameter: flowDesignParameter(input.parameter) } : {}),
    value: input.value,
    displayValue: input.displayValue,
  })) };
  if (manifest.trigger.condition !== undefined) {
    // The instance re-derives predicate metadata from the condition input; see
    // DEFAULT_TRIGGER_METADATA. The read-back check below still proves the
    // derived predicate matches what was asked for.
    update.metadata = DEFAULT_TRIGGER_METADATA;
  } else if (Object.prototype.hasOwnProperty.call(existing, 'metadata')) {
    update.metadata = typeof existing.metadata === 'string' ? existing.metadata : JSON.stringify(existing.metadata);
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

function insertedTriggers(response) {
  let found = [];
  walk(response, object => {
    if (!found.length && object.triggerInstances?.inserts) found = object.triggerInstances.inserts;
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
    // A newly POSTed ProcessFlow has NO trigger (verified live: triggerInstances
    // comes back empty), so the trigger is inserted by the same snFlowDesigner
    // patch as the actions. There is nothing to read back from the parent apart
    // from the flow identity.
    const definition = await resolveTriggerDefinition(sdk, manifest.trigger.type);
    const trigger = await buildCreateTrigger(sdk, flowId, manifest, definition, options);

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
    const insertedTrigger = insertedTriggers(patchResponse)[0];
    if (!insertedTrigger) throw new Error('Flow trigger insert returned no trigger identity');
    const inserted = insertedActions(patchResponse);
    if (inserted.length !== actionInstances.length) throw new Error(`Flow action patch returned ${inserted.length} inserted action identities; expected ${actionInstances.length}`);

    const processflow = await readProcessFlow(sdk, instance, flowId, scope);
    verifyCreatedFlowReadback({ flowId, processflow, trigger, insertedTrigger, manifest, actionInstances, inserted });
    const { version } = await mutationContext('autosave_version', readUpdateSet, snapshots, () => createVerifiedFlowVersion(sdk, {
      instance, flowId, scope, type: 'Autosave', annotation: 'JSN flow create',
    }), updateSet => readUpdateSetCapture(sdk, updateSet, flowId));
    const selectedUpdateSet = await readUpdateSet();
    const updateSetCapture = await readUpdateSetCapture(sdk, selectedUpdateSet, flowId);

    const triggerReadback = findArray(processflow, 'triggerInstances')[0] || {};
    return {
      flow: { id: flowId, name: manifest.name, status: 'draft', active: false },
      trigger: { ...triggerReadback, id: findId(triggerReadback, ['sysId', 'sys_id', 'id']) || findId(insertedTrigger, ['sysId', 'sys_id', 'id']) },
      actions: inserted,
      processflow,
      definition_readback: { available: true, status: 'read_back', flow_id: flowId },
      version,
      update_set_capture: updateSetCapture,
      update_set_mutations: snapshots,
      lifecycle: { published: false, supported: ['draft', 'autosave'], deferred: ['publish/activation', 'Flow Logic', 'subflows', 'flow variables', 'error handling'] },
    };
  } catch (error) {
    // Creation is two-stage: the parent POST leaves a real draft behind when the
    // trigger/action patch fails. Name that orphan explicitly instead of leaving
    // the caller to hunt for it.
    throw new Error(`Flow ${flowId} creation incomplete and left orphan draft flow ${flowId} (delete it in Flow Designer): ${error.message}; reconciliation: ${JSON.stringify(snapshots)}`, { cause: error });
  }
}

export async function updateFlowFromManifest(sdk, instance, identifier, inputManifest, options = {}) {
  const manifest = validateFlowUpdateManifest(inputManifest);
  const target = await resolveFlowForUpdate(sdk, identifier);
  const flowId = target.flowId;
  const lifecycle = target.lifecycle;
  const published = !lifecycle.draft;
  const targetScope = stringValue(target.flow.sys_scope) || stringValue(target.flow.scope);
  const scope = manifest.scope ?? targetScope;
  const readUpdateSet = options.readUpdateSet || (async () => null);
  if (!scope) throw new Error(`Flow ${flowId} has no transaction scope`);
  if (manifest.scope !== undefined && targetScope && manifest.scope !== targetScope) throw new Error(`Flow ${flowId} scope does not match the update manifest`);
  const snapshotId = stringValue(target.flow.master_snapshot);
  // A published/active target is judged by the provider, not by its lifecycle
  // label: read the definition and require security.can_write before any lock.
  const definitionRead = async () => {
    const definition = await readProcessFlow(sdk, instance, flowId, scope);
    assertDefinitionWritable(flowId, scope, lifecycle, definition);
    return definition;
  };
  let beforeDefinition = await definitionRead();
  // A legacy ProcessFlow read can expose the preceding version's timestamp
  // immediately after Autosave. Never substitute the newer Table timestamp into
  // an older definition: reread the whole document, then let safeEdit check it.
  const recordUpdated = stringValue(target.flow.sys_updated_on);
  if (recordUpdated && beforeDefinition.updated !== recordUpdated) {
    // A publish moves the record, not the definition, so a published flow may
    // legitimately report an older definition timestamp. The definition's own
    // `updated` is what safeEdit checks; only a draft must match its record.
    beforeDefinition = await definitionRead();
    if (!published && beforeDefinition.updated !== recordUpdated) throw new Error(`Flow ${flowId} definition is stale relative to its record; no edit session or content mutation attempted`);
  }
  if (published && !snapshotId) throw new Error(`Flow ${flowId} is ${describeState(lifecycle)} but has no master_snapshot; refusing to edit without a published-definition baseline`);
  const snapshots = [];
  const triggerUpdates = [];
  const actionUpdates = [];
  const changedActionInputs = new Map();
  const actionTargets = new Map();
  const changes = [];
  let triggerUpdate;
  if (manifest.trigger !== undefined) {
    const currentTrigger = findArray(beforeDefinition, 'triggerInstances')[0];
    const currentTable = inputRawValue(inputList(currentTrigger).find(input => input.name === 'table'));
    const descriptor = options.readTableDescriptor
      ? await options.readTableDescriptor(manifest.trigger.table ?? currentTable)
      : await readTableDescriptor(sdk, manifest.trigger.table ?? currentTable);
    triggerUpdate = updatedTrigger(beforeDefinition, manifest, descriptor).update;
    triggerUpdates.push(triggerUpdate);
    for (const input of ['table', 'condition']) {
      if (manifest.trigger[input] !== undefined) changes.push({ component: 'trigger', input, before: inputRawValue(inputList(currentTrigger).find(field => field.name === input)), after: manifest.trigger[input] });
    }
  }
  const existingActions = findExistingActions(beforeDefinition);
  for (const [index, requested] of (manifest.actions || []).entries()) {
    const existing = await resolveExistingAction(sdk, existingActions, requested, index);
    const update = buildActionUpdate(existing, requested, index);
    actionUpdates.push(update);
    const uiId = stringValue(existing.uiUniqueIdentifier || existing.ui_unique_identifier);
    if (actionTargets.has(uiId)) throw new Error(`Duplicate action update for order ${requested.order}; combine input changes in one action entry`);
    actionTargets.set(uiId, existing);
    changedActionInputs.set(uiId, new Set(Object.keys(requested.inputs)));
    for (const [input, after] of Object.entries(requested.inputs)) changes.push({ component: 'action', order: requested.order, type: requested.type, input, before: inputRawValue(inputList(existing).find(field => field.name === input)), after });
  }
  if (triggerUpdates.length === 0 && actionUpdates.length === 0) throw new Error(`Flow ${flowId} update has no supported changes`);
  if (options.preview) return {
    preview: true,
    flow: { id: flowId, name: target.flowName, status: lifecycle.status, active: lifecycle.active },
    changes,
    lifecycle: {
      published,
      active: lifecycle.active,
      executed: false,
      writable: true,
      lock_acquired: false,
      supported: supportedLifecycle(published),
      deferred: DEFERRED_LIFECYCLE,
    },
  };
  // Baseline the published runtime after the definition read (a legacy read can
  // materialize a version row) and before the edit session exists.
  const runtimeBefore = published ? await readFlowRuntime(sdk, instance, flowId, { scope, snapshotId }) : null;
  const outcome = await withFlowSafeEdit(sdk, instance, flowId, beforeDefinition.updated, async () => {
    let completedStage = 'validated';
    try {
      const patchResponse = await mutationContext('trigger_and_actions_update', readUpdateSet, snapshots, () => sdk.request(`${instance}${GRAPHQL_ENDPOINT}`, {
        method: 'POST',
        body: JSON.stringify({ query: buildFlowUpdateMutation({ flowId, triggerUpdates, actionUpdates }), variables: {} }),
      }), updateSet => readUpdateSetCapture(sdk, updateSet, flowId));
      assertGraphQLSuccess(patchResponse, 'Flow trigger/action update');
      completedStage = 'patch_acknowledged';
      const processflow = await readProcessFlow(sdk, instance, flowId, scope);
      // Only requested values may differ. Preserve array order and opaque fields.
      for (const field of ['flowVariables', 'flowLogicInstances', 'subFlowInstances', 'flowInputs', 'flowOutputs', 'inputs', 'outputs', 'stages']) {
        if (!isDeepStrictEqual(beforeDefinition[field], processflow[field])) throw new Error(`Flow ${flowId} changed omitted ${field}; preservation failed`);
      }
      if (!triggerUpdate && !isDeepStrictEqual(beforeDefinition.triggerInstances, processflow.triggerInstances)) throw new Error(`Flow ${flowId} changed omitted triggerInstances`);
      const maskActions = definition => findExistingActions(definition).map(action => {
        const copy = clone(action);
        const changed = changedActionInputs.get(stringValue(action.uiUniqueIdentifier || action.ui_unique_identifier));
        for (const [index, input] of inputList(copy).entries()) if (changed?.has(input.name)) inputList(copy)[index] = maskInputValue(input);
        return copy;
      });
      if (!isDeepStrictEqual(maskActions(beforeDefinition), maskActions(processflow))) throw new Error(`Flow ${flowId} changed omitted action fields; preservation failed`);
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
        const maskTriggerInputs = inputs => inputs.map(input => {
          if (!requestedInputs.has(input.name)) return input;
          const copy = maskInputValue(input);
          delete copy.displayField;
          // Live table saves materialize only this absent display label as ''.
          // Do not collapse named values, defaults or arbitrary empty fields.
          if (copy.parameter?.type_label === '') delete copy.parameter.type_label;
          return copy;
        });
        if (!isDeepStrictEqual(maskTriggerInputs(beforeInputs), maskTriggerInputs(readbackInputs))) throw new Error(`Flow ${flowId} trigger input preservation failed`);
        for (const beforeInput of beforeInputs) {
          const afterInput = readbackInputs.find(input => input.name === beforeInput.name);
          if (!afterInput) throw new Error(`Flow ${flowId} trigger lost input ${beforeInput.name} during update`);
          if (!requestedInputs.has(beforeInput.name) && JSON.stringify(beforeInput) !== JSON.stringify(afterInput)) throw new Error(`Flow ${flowId} trigger changed omitted input ${beforeInput.name}`);
        }
        if (manifest.trigger.table !== undefined && inputRawValue(readbackInputs.find(input => input.name === 'table')) !== manifest.trigger.table) throw new Error(`Flow ${flowId} trigger table readback did not match the requested value`);
        if (manifest.trigger.condition !== undefined) {
          if (inputRawValue(readbackInputs.find(input => input.name === 'condition')) !== manifest.trigger.condition) throw new Error(`Flow ${flowId} trigger condition readback did not match the requested value`);
          assertPredicateMetadataMatches(readbackTrigger.metadata, manifest.trigger.condition, `Flow ${flowId} trigger`);
          const beforeMetadata = stripPredicates(parseMaybeJson(beforeTrigger.metadata, {}));
          const afterMetadata = stripPredicates(parseMaybeJson(readbackTrigger.metadata, {}));
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
      completedStage = 'definition_verified';
      const { version } = await mutationContext('autosave_version', readUpdateSet, snapshots, () => createVerifiedFlowVersion(sdk, {
        instance, flowId, scope, type: 'Autosave', annotation: 'JSN flow update',
      }), updateSet => readUpdateSetCapture(sdk, updateSet, flowId));
      completedStage = 'autosave_verified';
      let runtime;
      if (published) {
        runtime = { before: runtimeBefore, after: await readFlowRuntime(sdk, instance, flowId, { scope, snapshotId }) };
        const comparison = runtimeDifferences(runtime.before, runtime.after, {
          autosaveVersionId: stringValue(version?.sys_id || version?.sysId),
          newVersionType: stringValue(version?.type) || AUTOSAVE_VERSION_TYPE,
        });
        if (comparison.differences.length) {
          throw new Error(`Flow ${flowId} was edited but its published runtime state changed: ${JSON.stringify(comparison.differences)}. The edit may have altered runtime. Do not republish, retry, unpublish or deactivate; inspect published snapshot ${snapshotId}, the version rows and the active/status pointers in Flow Designer. No rollback, publish or execution was attempted.`);
        }
        runtime.verified = true;
        runtime.design_time_changes = comparison.design_time_changes;
        completedStage = 'runtime_verified';
      }
      const selectedUpdateSet = await readUpdateSet();
      const updateSetCapture = await readUpdateSetCapture(sdk, selectedUpdateSet, flowId);
      // Report what the record says after the save, not the pre-edit label: a
      // published flow that now has a draft working copy must not look published
      // in the result. `active` and the snapshot pointers are the runtime gates.
      const finalRecord = runtime?.after?.record;
      return {
        flow: {
          id: flowId,
          name: target.flowName,
          status: finalRecord?.status || lifecycle.status,
          active: finalRecord ? finalRecord.active === 'true' : lifecycle.active,
        },
        changes,
        processflow,
        definition_readback: { available: true, status: 'read_back', flow_id: flowId },
        version,
        ...(runtime ? { runtime_preservation: runtime } : {}),
        update_set_capture: updateSetCapture,
        update_set_mutations: snapshots,
        lifecycle: {
          published,
          active: lifecycle.active,
          executed: false,
          runtime_preserved: published ? true : undefined,
          supported: supportedLifecycle(published),
          deferred: DEFERRED_LIFECYCLE,
        },
      };
    } catch (error) {
      throw new Error(`Flow ${flowId} update incomplete; last completed stage: ${completedStage}. Changes may already be persisted; inspect this exact flow before retrying. No rollback, publish or execution attempted. ${error.message}; reconciliation: ${JSON.stringify(snapshots)}`, { cause: error });
    }
  });
  if (published) {
    // The lease is user-level, so its absence is part of the delivered result.
    const { status } = await flowSafeEditRequest(sdk, instance, flowId, 'read');
    if (!status || status.canUserEdit || status.currentEditor) {
      throw new Error(`Flow ${flowId} update saved (Autosave ${stringValue(outcome.version?.sys_id)}) but its safe edit lease is still present: ${JSON.stringify(status ?? null)}. Inspect and close the Flow Designer session before further edits. No rollback or unpublish attempted.`);
    }
    outcome.lifecycle = { ...outcome.lifecycle, safe_edit_lease: 'absent' };
    outcome.runtime_preservation = { ...outcome.runtime_preservation, safe_edit_lease: 'absent' };
  }
  return outcome;
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
