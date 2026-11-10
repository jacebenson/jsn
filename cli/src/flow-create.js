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
  validateLogicManifest(manifest);
  if (manifest.subflows !== undefined || manifest.subFlows !== undefined) throw new Error('Subflows are unsupported in this creation slice');
  if (manifest.variables !== undefined || manifest.flowVariables !== undefined) throw new Error('Flow-variable lifecycle is unsupported in this creation slice');
  if (manifest.errorHandling !== undefined) validateErrorHandling(manifest.errorHandling);
  if (manifest.stages !== undefined) validateStages(manifest.stages);
  if (manifest.stageTemplate !== undefined && !String(manifest.stageTemplate).trim()) throw new Error('Flow manifest stageTemplate must not be empty');
  if (manifest.stageSet !== undefined && !String(manifest.stageSet).trim()) throw new Error('Flow manifest stageSet must not be empty');
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
    for (const key of Object.keys(action)) if (!['type', 'inputs', 'order', 'parent', 'parentOrder', 'parentUiId'].includes(key)) throw new Error(`Unsupported action field ${key}`);
    if (action.order !== undefined && (!Number.isInteger(action.order) || action.order < 1)) throw new Error('Action order must be a positive integer');
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

// Stage placement. Shapes come from a captured Flow Designer session that both
// created stages and moved steps onto them: the V1-style
// `PUT /processflow/flow/{id}/stages` body and the `stages {insert|update}`
// snFlowDesigner patch. A stage carries a UUID `stageId`, a display `label`, a
// machine `value`, an `order`, and `componentIndexes` — the flow-step orders
// placed on that stage. `componentIndexes` is why a placement update must run
// after the actions exist.
const STAGE_DURATION = '1970-01-01 00:00:00';
// ProcessFlow returns `states` as a list of {label, name}; the REST stage map
// (PUT /processflow/flow/{id}/stages) returns it keyed by name. Sending the
// keyed form is not what Flow Designer sends, so use the list on insert.
const STAGE_STATES = [
  { label: 'Pending - has not started', name: 'pending' },
  { label: 'In progress', name: 'in_progress' },
  { label: 'Skipped', name: 'skipped' },
  { label: 'Completed', name: 'complete' },
  { label: 'Error', name: 'error' },
];
const STAGE_KEYS = ['label', 'value', 'order', 'system', 'componentIndexes', 'stageId', 'duration', 'states'];

const asBool = (value) => value === true || value === 'true';

/**
 * Stages as a list, whichever shape the definition uses.
 *
 * ProcessFlow readback carries `stages` as an object keyed by stageId; the REST
 * stage map uses the same shape while a definition built in code may hold an
 * array. Treating only the array form as data made a live flow look like it had
 * no stages at all.
 */
export function stageList(definition) {
  const stages = definition?.stages;
  if (Array.isArray(stages)) return stages;
  if (stages && typeof stages === 'object') return Object.values(stages).filter(stage => stage && typeof stage === 'object');
  return [];
}

function stageValueFromLabel(label) {
  return String(label).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Validate a manifest `stages` array.
 *
 * `stageId` is only meaningful for updates: an entry without one inserts a new
 * stage, an entry with one edits the stage it names.
 */

export async function resolveStageTemplate(sdk, templateIdentifier) {
  const ident = String(templateIdentifier || "").trim();
  if (!ident) throw new Error('Stage template identifier must not be empty');
  // The identifier is embedded in an encoded query, so a separator character
  // would silently change which records match.
  if (/[\^=\n\r]/.test(ident)) throw new Error(`Stage template "${ident}" contains a query separator (^ or =); pass a plain name or sys_id`);
  // 1. Check if ident matches a stage_set sys_id or name
  let setId = "";
  if (/^[0-9a-fA-F]{32}$/.test(ident)) {
    setId = ident;
  } else {
    // Resolve by table first, then by stage set name. Provider failures must
    // surface: a swallowed 401 would read as "template not found".
    const tableMatches = await sdk.list("stage_set_table", new URLSearchParams({
      sysparm_query: `table=${ident}^ORset.nameLIKE${ident}`,
      sysparm_limit: "1"
    }));
    if (tableMatches.length && tableMatches[0].set) {
      setId = typeof tableMatches[0].set === "object" ? tableMatches[0].set.value : tableMatches[0].set;
    } else {
      const setMatches = await sdk.list("stage_set", new URLSearchParams({
        sysparm_query: `nameLIKE${ident}`,
        sysparm_limit: "1"
      }));
      if (setMatches.length) setId = setMatches[0].sys_id;
    }
  }
  if (!setId) throw new Error(`Stage template "${ident}" not found in stage_set or stage_set_table`);

  // 2. Fetch stage_set_entry records for setId
  const entries = await sdk.list("stage_set_entry", new URLSearchParams({
    sysparm_query: `set=${setId}`,
    sysparm_display_value: "all"
  }));
  if (!entries.length) throw new Error(`No stage entries found for stage template "${ident}" (${setId})`);

  // Sort: Request Cancelled & Completed system stages, or order-based
  const mapped = entries.map(e => {
    const label = e.name?.display_value || e.name?.value || e.name || "";
    const value = e.value?.display_value || e.value?.value || e.value || stageValueFromLabel(label);
    const duration = e.ola?.value || e.ola?.display_value || STAGE_DURATION;
    // `order` comes back display-formatted ("1,000"), so parseInt alone reads 1.
    const rawOrder = String(e.order?.value ?? e.order ?? "0").replace(/[^0-9-]/g, "");
    const orderNum = Number.isFinite(parseInt(rawOrder, 10)) ? parseInt(rawOrder, 10) : 0;
    return {
      label,
      value,
      duration,
      rawOrder: orderNum,
      system: (label === "Request Cancelled" || label === "Completed" || value === "complete" || value === "Request Cancelled")
    };
  });

  // Flow Designer sorts Request Cancelled (order 0, system: true), Completed (order 1, system: true), then non-system stages by rawOrder
  const systemStages = mapped.filter(s => s.system).sort((a, b) => {
    if (a.value === "Request Cancelled" || a.label === "Request Cancelled") return -1;
    if (b.value === "Request Cancelled" || b.label === "Request Cancelled") return 1;
    return a.rawOrder - b.rawOrder;
  });
  const normalStages = mapped.filter(s => !s.system).sort((a, b) => a.rawOrder - b.rawOrder);

  const finalStages = [...systemStages, ...normalStages].map((s, idx) => ({
    label: s.label,
    value: s.value,
    duration: s.duration,
    order: idx,
    system: s.system,
    alwaysShow: true,
    componentIndexes: []
  }));

  return finalStages;
}

export function validateErrorHandling(eh) {
  if (eh === null || typeof eh !== 'object' || Array.isArray(eh)) throw new Error('Flow errorHandling must be an object');
  for (const key of Object.keys(eh)) if (key !== 'actions') throw new Error(`Unsupported errorHandling field ${key}`);
  if (eh.actions !== undefined) {
    if (!Array.isArray(eh.actions)) throw new Error('Flow errorHandling.actions must be an array');
    for (const [index, action] of eh.actions.entries()) {
      if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error(`Error action ${index + 1} must be an object`);
      if (typeof action.type !== 'string' || !action.type.trim()) throw new Error(`Error action ${index + 1} requires type`);
      for (const key of Object.keys(action)) if (!['type', 'inputs'].includes(key)) throw new Error(`Unsupported error action field ${key}; identities are allocated by the provider editor`);
      if (action.inputs !== undefined && (!action.inputs || typeof action.inputs !== 'object' || Array.isArray(action.inputs))) throw new Error(`Error action ${index + 1} inputs must be an object`);
    }
  }
}

export function validateStages(stages, { update = false } = {}) {
  if (!Array.isArray(stages)) throw new Error('Flow stages must be an array');
  for (const [index, stage] of stages.entries()) {
    const where = `Stage ${index + 1}`;
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) throw new Error(`${where} must be an object`);
    for (const key of Object.keys(stage)) if (!STAGE_KEYS.includes(key)) throw new Error(`${where} field "${key}" is unsupported`);
    if (stage.stageId !== undefined && !update) throw new Error(`${where} stageId is only accepted when updating an existing stage; omit it to insert`);
    if (update && stage.stageId !== undefined && !/^[0-9a-fA-F-]{32,36}$/.test(String(stage.stageId))) throw new Error(`${where} stageId must be the stage UUID`);
    if (stage.label !== undefined && !String(stage.label).trim()) throw new Error(`${where} label must not be empty`);
    if (stage.value !== undefined && !String(stage.value).trim()) throw new Error(`${where} value must not be empty`);
    if (stage.order !== undefined && (!Number.isInteger(stage.order) || stage.order < 0)) throw new Error(`${where} order must be a non-negative integer`);
    if (stage.system !== undefined && typeof stage.system !== 'boolean') throw new Error(`${where} system must be a boolean`);
    if (stage.componentIndexes !== undefined) {
      if (!Array.isArray(stage.componentIndexes) || stage.componentIndexes.some(value => !Number.isInteger(value) || value < 1)) {
        throw new Error(`${where} componentIndexes must be an array of flow-step orders (integers >= 1)`);
      }
    }
    if (stage.duration !== undefined && typeof stage.duration !== 'string') throw new Error(`${where} duration must be a string`);
    if (stage.states !== undefined && (!stage.states || typeof stage.states !== 'object' || Array.isArray(stage.states))) throw new Error(`${where} states must be an object`);
    const inserts = stage.stageId === undefined;
    if (inserts && !String(stage.label ?? '').trim()) throw new Error(`${where} requires a label`);
    if (!inserts) {
      const edited = ['label', 'value', 'order', 'componentIndexes'].filter(key => stage[key] !== undefined);
      if (!edited.length) throw new Error(`${where} must change label, value, order or componentIndexes`);
    }
  }
  return stages;
}

export function buildStageInserts(stages = [], { idFactory = () => randomUUID(), flowId } = {}) {
  return stages
    .map((stage, index) => ({ stage, index }))
    .sort((a, b) => (a.stage.order ?? a.index) - (b.stage.order ?? b.index))
    .map(({ stage, index }) => ({
      stageId: idFactory(),
      label: String(stage.label).trim(),
      value: stage.value ?? stageValueFromLabel(stage.label),
      type: 'standard',
      duration: stage.duration ?? STAGE_DURATION,
      ancestorArrPos: '0',
      ...(flowId ? { flow: flowId } : {}),
      alwaysShow: true,
      order: stage.order ?? index,
      system: stage.system ?? false,
      componentIndexes: stage.componentIndexes ?? [],
      states: stage.states ?? STAGE_STATES,
    }));
}

export function buildStageUpdates(stages = []) {
  return stages.map((stage) => {
    const update = { stageId: stage.stageId };
    if (stage.label !== undefined) update.label = String(stage.label).trim();
    if (stage.value !== undefined) update.value = stage.value;
    if (stage.order !== undefined) update.order = stage.order;
    if (stage.componentIndexes !== undefined) update.componentIndexes = stage.componentIndexes;
    return update;
  });
}

/**
 * `stages` is part of the same snFlowDesigner patch as actions, but placement
 * has to follow the actions: `componentIndexes` name flow-step orders that must
 * already exist. Creation therefore sends stages in a second patch.
 */
export function buildFlowStageMutation({ flowId, inserts = [], updates = [] }) {
  const parts = [];
  if (inserts.length) parts.push(`insert: [${inserts.map(gqlInputObject).join(', ')}]`);
  if (updates.length) parts.push(`update: [${updates.map(gqlInputObject).join(', ')}]`);
  if (!parts.length) throw new Error('Flow stage patch requires at least one insert or update');
  return `mutation { global { snFlowDesigner { flow(flowPatch: {flowId: ${gqlString(flowId)}, stages: {${parts.join(', ')}}}) { id stages { inserts { sysId } } } } } }`;
}

/**
 * Read the catalog item's variables as a `service_catalog` flow sees them.
 *
 * A service_catalog trigger takes `template_catalog_item` (an sc_cat_item
 * sys_id) plus `catalog_variables`, a comma-joined list of item_option_new
 * sys_ids. This is the lookup Flow Designer runs when you pick the item, so the
 * ids a manifest needs are the `id` values returned here.
 */
export async function readCatalogItemVariables(sdk, instance, flowId, catalogItemId, { scope = 'global', includeMultiRowVariableSets = true, selectedVariables = '' } = {}) {
  if (!String(catalogItemId || '').trim()) throw new Error('catalog-variables requires a catalog item sys_id');
  const query = new URLSearchParams({ sysparm_transaction_scope: scope });
  const response = await sdk.request(`${instance}${FLOW_ENDPOINT}/${encodeURIComponent(flowId)}/service_get_catalog_variables?${query}`, {
    method: 'POST',
    body: JSON.stringify({ flow_catalog_model: catalogItemId, includeMultiRowVariableSets, selectedVariables }),
  });
  const data = response?.result?.data;
  if (!data || !Array.isArray(data.availableList)) throw new Error('Catalog variable lookup returned no availableList; check the flow and catalog item sys_ids and the transaction scope');
  const variables = data.availableList.map(variable => ({
    id: stringValue(variable.id),
    name: stringValue(variable.name),
    label: stringValue(variable.label),
    type: stringValue(variable.type),
    mandatory: asBool(variable.mandatory),
    readonly: asBool(variable.readonly),
  }));
  return {
    flow_id: flowId,
    catalog_item: catalogItemId,
    count: variables.length,
    variables,
    // Exactly what the trigger input expects, so it can be pasted into a manifest.
    catalog_variables_input: variables.map(variable => variable.id).join(','),
  };
}

export function buildFlowPatchMutation({ flowId, trigger, actions, flowLogicInserts = [], labelCacheInserts = [] }) {
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
  const extra = `${flowLogicInserts.length ? `, flowLogics: {insert: [${flowLogicInserts.map(gqlInputObject).join(', ')}]}` : ''}${labelCacheInserts.length ? `, labelCache: {insert: [${labelCacheInserts.map(gqlInputObject).join(', ')}]}` : ''}`;
  const patch = `flowPatch: {flowId: ${gqlString(flowId)}, triggerInstances: {insert: [${gqlInputObject(triggerInsert)}]}, actions: {insert: [${actionInsert.map(gqlInputObject).join(', ')}]}${extra}}`;
  // `triggerInstances.updates` is a leaf [String] on this schema; only `inserts`
  // carries identities, and only for triggers does `inserts` lack a uiUniqueIdentifier.
  return `mutation { global { snFlowDesigner { flow(${patch}) { triggerInstances { inserts { sysId } updates } actions { inserts { sysId uiUniqueIdentifier } } } } } }`;
}


const FLOW_LOGIC_DEFINITIONS = {
  'top level try': {
    id: 'e9060aa2c3013010ace8b740ad40dd51',
    name: 'Top Level Try',
    type: 'TOP_LEVEL_TRY',
    description: 'Begin a top level try block',
    compilationClass: 'com.glide.flow.compiler.logic_block.TryCompiler',
    order: 18,
    connectedTo: '',
    attributes: 'allow_siblings=true,draw_curve=true,line_type=q_curve,visible_in_picker=false,visible_in_ui=false,',
  },
  'top level catch': {
    id: '35d60003e6022010a5e40cdd1254dd23',
    name: 'Top Level Catch',
    type: 'TOP_LEVEL_CATCH',
    description: 'Catch and handle an error',
    compilationClass: 'com.glide.flow.compiler.logic_block.CatchCompiler',
    order: 17,
    connectedTo: '07223332de022010ec58424b73829721,e9060aa2c3013010ace8b740ad40dd51',
    attributes: 'allow_siblings=true,draw_curve=true,line_type=q_curve,visible_in_picker=false,visible_in_ui=false,',
  },
  'try': {
    id: '07223332de022010ec58424b73829721',
    name: 'Try',
    type: 'TRY',
    description: 'Allow a flow to continue running when an error occurs within a flow logic block. Run a sequence of actions in response to errors within the flow logic block',
    compilationClass: 'com.glide.flow.compiler.logic_block.TryCompiler',
    order: 15,
    connectedTo: '',
    attributes: 'allow_siblings=true,disable_opening=true,draw_curve=true,icon_class=try,line_type=cc_curve,visible_in_picker=true,',
  },
  'catch': {
    id: '35d60003e6022010a5e40cdd1254dd21',
    name: 'Catch',
    type: 'CATCH',
    description: 'Catch and handle an error',
    compilationClass: 'com.glide.flow.compiler.logic_block.CatchCompiler',
    order: 16,
    connectedTo: '07223332de022010ec58424b73829721',
    attributes: 'allow_siblings=true,disable_opening=true,draw_curve=true,icon_class=catch,line_type=q_curve,visible_in_picker=false,',
  },
  'if': {
    id: 'af4e1945c3e232002841b63b12d3ae3e',
    name: 'If',
    type: 'IF',
    description: 'Selectively apply one or more actions only when a list of conditions is met.',
    compilationClass: 'com.glide.flow.compiler.logic_block.IfCompiler',
    order: 1,
    connectedTo: '',
    attributes: 'allow_children=true,allow_siblings=true,icon_class=diamond-if-icon,line_type=q_if_curve,pills_draggable_outside_block=false,',
  },
  'else if': {
    id: '666e5545c3e232002841b63b12d3ae99',
    name: 'Else If',
    type: 'ELSEIF',
    description: 'Selectively apply one or more actions only when a list of conditions is met.',
    compilationClass: 'com.glide.flow.compiler.logic_block.ElseIfCompiler',
    order: 2,
    connectedTo: 'af4e1945c3e232002841b63b12d3ae3e,666e5545c3e232002841b63b12d3ae99',
    attributes: 'allow_children=true,allow_siblings=true,icon_class=elseif-icon,line_type=q_if_curve,pills_draggable_outside_block=false,',
  },
  'else': {
    id: '1f781bf3c32232002841b63b12d3aee6',
    name: 'Else',
    type: 'ELSE',
    description: 'Else statement',
    compilationClass: 'com.glide.flow.compiler.logic_block.ElseCompiler',
    order: 3,
    connectedTo: '666e5545c3e232002841b63b12d3ae99,af4e1945c3e232002841b63b12d3ae3e',
    attributes: 'allow_children=true,allow_siblings=true,disable_opening=true,icon_class=else-icon,line_type=q_if_curve,pills_draggable_outside_block=false,',
  },
  'set flow variables': {
    id: '4f787d1e0f9b0010ecf0cc52ff767ea0',
    name: 'Set Flow Variables',
    type: 'SETFLOWVARIABLES',
    description: "Assign a value to one or more flow variables. Change or update a variable's value during a flow.",
    compilationClass: 'com.glide.flow.compiler.logic_block.SetVariablesCompiler',
    order: 14,
    connectedTo: '',
    attributes: 'allow_children=false,allow_siblings=true,',
  },
  'end flow': {
    id: 'd176605ea76103004f27b0d2187901c7',
    name: 'End Flow',
    type: 'END',
    description: 'Use this flow logic to stop a flow within flow designer.',
    compilationClass: 'com.glide.flow.compiler.logic_block.EndCompiler',
    order: 10,
    connectedTo: '',
    attributes: 'allow_children=false,allow_siblings=false,disable_opening=true,',
  }
};

export function buildFlowUpdateMutation({ flowId, triggerUpdates = [], actionUpdates = [], actionInserts = [], actionDeletes = [], flowVariableInserts = [], flowLogicInserts = [], flowLogicUpdates = [], flowLogicDeletes = [], labelCacheUpdates = [], labelCacheInserts = [], stageInserts = [], stageUpdates = [] }) {
  const updates = [];
  if (triggerUpdates.length) updates.push(`triggerInstances: {update: [${triggerUpdates.map(gqlInputObject).join(', ')}]}`);
  const actionParts = [];
  if (actionInserts.length) actionParts.push(`insert: [${actionInserts.map(gqlInputObject).join(', ')}]`);
  if (actionUpdates.length) actionParts.push(`update: [${actionUpdates.map(gqlInputObject).join(', ')}]`);
  if (actionDeletes.length) actionParts.push(`delete: [${actionDeletes.map(id => gqlString(id)).join(', ')}]`);
  if (actionParts.length) updates.push(`actions: {${actionParts.join(', ')}}`);
  if (flowVariableInserts.length) updates.push(`flowVariables: {insert: [${flowVariableInserts.map(gqlInputObject).join(', ')}]}`);
  const logicParts = [];
  if (flowLogicInserts.length) logicParts.push(`insert: [${flowLogicInserts.map(gqlInputObject).join(', ')}]`);
  if (flowLogicUpdates.length) logicParts.push(`update: [${flowLogicUpdates.map(gqlInputObject).join(', ')}]`);
  if (flowLogicDeletes.length) logicParts.push(`delete: [${flowLogicDeletes.map(id => gqlString(id)).join(', ')}]`);
  if (logicParts.length) updates.push(`flowLogics: {${logicParts.join(', ')}}`);
  const labelParts = [];
  if (labelCacheInserts.length) labelParts.push(`insert: [${labelCacheInserts.map(gqlInputObject).join(', ')}]`);
  if (labelCacheUpdates.length) labelParts.push(`update: [${labelCacheUpdates.map(gqlInputObject).join(', ')}]`);
  if (labelParts.length) updates.push(`labelCache: {${labelParts.join(', ')}}`);
  const stageParts = [];
  if (stageInserts.length) stageParts.push(`insert: [${stageInserts.map(s => {
    const copy = { ...s };
    delete copy.system;
    return gqlInputObject(copy);
  }).join(', ')}]`);
  if (stageUpdates.length) stageParts.push(`update: [${stageUpdates.map(gqlInputObject).join(', ')}]`);
  if (stageParts.length) updates.push(`stages: {${stageParts.join(', ')}}`);
  if (!updates.length) throw new Error('Flow update mutation requires at least one change');
  const patch = `flowPatch: {flowId: ${gqlString(flowId)}, ${updates.join(', ')}}`;
  const returnFields = ['triggerInstances { updates }'];
  if (actionInserts.length) returnFields.push('actions { inserts { sysId uiUniqueIdentifier } updates }');
  else returnFields.push('actions { updates }');
  if (flowLogicInserts.length) returnFields.push('flowLogics { inserts { sysId uiUniqueIdentifier } }');
  if (flowVariableInserts.length) returnFields.push('flowVariables { inserts { sysId uiUniqueIdentifier } }');
  returnFields.push('stages { inserts { sysId } }');
  return `mutation { global { snFlowDesigner { flow(${patch}) { ${returnFields.join(' ')} } } } }`;
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

/**
 * Confirm the stages this command asked for are the ones the flow now carries.
 * Matching is by generated stageId: a label-only check could pass while the
 * placement landed on a different stage.
 */
function assertStagesPlaced(processflow, stageInserts, flowId) {
  if (!stageInserts.length) return;
  const saved = stageList(processflow);
  if (!saved.length) throw new Error(`Flow ${flowId} stage read-back returned no stages after placing ${stageInserts.length}`);
  for (const expected of stageInserts) {
    const matches = saved.filter(stage => stringValue(stage.stageId || stage.stage_id) === expected.stageId);
    if (matches.length !== 1) throw new Error(`Flow ${flowId} stage "${expected.label}" (${expected.stageId}) was not uniquely present in ProcessFlow read-back`);
    const savedStage = matches[0];
    if (expected.label !== undefined && stringValue(savedStage.label) !== expected.label) throw new Error(`Flow ${flowId} stage ${expected.stageId} label did not match the requested "${expected.label}"`);
    if (expected.order !== undefined && String(savedStage.order) !== String(expected.order)) throw new Error(`Flow ${flowId} stage ${expected.stageId} order did not match the requested ${expected.order}`);
    if (expected.componentIndexes !== undefined) {
      const savedIndexes = (Array.isArray(savedStage.componentIndexes) ? savedStage.componentIndexes : []).map(String).sort();
      const expectedIndexes = expected.componentIndexes.map(String).sort();
      if (JSON.stringify(savedIndexes) !== JSON.stringify(expectedIndexes)) {
        throw new Error(`Flow ${flowId} stage ${expected.stageId} placement did not match the requested componentIndexes`);
      }
    }
  }
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

function validateLogicManifest(manifest) {
  if (manifest.logic !== undefined && manifest.flowLogics !== undefined) throw new Error('Specify logic or flowLogics, not both');
  const logics = manifest.logic ?? manifest.flowLogics;
  if (logics === undefined) return;
  if (!Array.isArray(logics)) throw new Error('Flow logic must be an array');
  const orders = new Set();
  for (const l of logics) {
    if (!l || typeof l !== 'object' || Array.isArray(l)) throw new Error('Flow logic must be an object');
    for (const key of Object.keys(l)) if (!['order', 'type', 'name', 'parent', 'parentOrder', 'parentUiId', 'connectedTo', 'connectedToOrder', 'condition', 'condition_name', 'conditionName', 'label', 'values'].includes(key)) throw new Error(`Unsupported logic field ${key}; caller identities are not accepted`);
    if (!Number.isInteger(l.order) || l.order < 1 || orders.has(l.order)) throw new Error('Logic order must be a unique positive integer');
    orders.add(l.order);
    if (!FLOW_LOGIC_DEFINITIONS[String(l.type || l.name || '').toLowerCase().trim()]) throw new Error('Unsupported flow logic type');
    if (l.condition !== undefined && typeof l.condition !== 'string') throw new Error('Logic condition must be a string');
    if (l.values !== undefined && (!l.values || typeof l.values !== 'object' || Array.isArray(l.values))) throw new Error('Logic values must be an object');
    for (const key of ['parent', 'parentOrder', 'parentUiId', 'connectedTo', 'connectedToOrder']) if (l[key] !== undefined && !((typeof l[key] === 'string' && l[key].trim()) || (Number.isInteger(l[key]) && l[key] > 0))) throw new Error(`Malformed logic ${key}`);
  }
}

export function validateFlowUpdateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Flow update manifest must be a JSON object');
  const allowed = new Set(['scope', 'trigger', 'actions', 'stages', 'stageTemplate', 'stageSet', 'flowVariables', 'variables', 'flowLogics', 'logic', 'deleteSteps', 'delete', 'deleteOrders', 'errorHandling', 'errorHandler']);
  for (const key of Object.keys(manifest)) if (!allowed.has(key)) throw new Error(`Flow update field "${key}" is unsupported; editable: trigger, action inputs, action inserts, step deletes, flow variables, flow logic, stage placement`);
  validateLogicManifest(manifest);
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
      for (const key of Object.keys(action)) if (!['order', 'type', 'inputs', 'parent', 'parentOrder', 'parentUiId'].includes(key)) throw new Error(`Update action ${index + 1} field "${key}" is unsupported; caller-supplied identities are not accepted`);
      for (const key of ['parent', 'parentOrder', 'parentUiId']) if (action[key] !== undefined && !((typeof action[key] === 'string' && action[key].trim()) || (Number.isInteger(action[key]) && action[key] > 0))) throw new Error(`Malformed action ${key}`);
      if (!Number.isInteger(action.order) || action.order < 1 || !String(action.type || '').trim()) throw new Error(`Update action ${index + 1} requires a positive integer order and type`);
      if (!action.inputs || typeof action.inputs !== 'object' || Array.isArray(action.inputs)) throw new Error(`Update action ${index + 1} inputs must be an object`);
      if (Object.keys(action.inputs).length === 0) throw new Error(`Update action ${index + 1} inputs must contain at least one changed value`);
    }
  }
  if (manifest.trigger === undefined && manifest.actions === undefined && manifest.stages === undefined && manifest.stageTemplate === undefined && manifest.stageSet === undefined && manifest.flowVariables === undefined && manifest.variables === undefined && manifest.flowLogics === undefined && manifest.logic === undefined && manifest.deleteSteps === undefined && manifest.delete === undefined && manifest.deleteOrders === undefined && manifest.errorHandling === undefined && manifest.errorHandler === undefined) throw new Error('Flow update manifest must specify trigger, actions and/or stages');
  if (manifest.stages !== undefined) validateStages(manifest.stages, { update: true });
  if (manifest.errorHandling !== undefined && manifest.errorHandler !== undefined) throw new Error('Specify errorHandling or errorHandler, not both');
  // Accepting the key without checking its shape would still insert the Try and
  // Catch blocks while silently dropping a malformed action list.
  for (const key of ['errorHandling', 'errorHandler']) {
    if (manifest[key] !== undefined) validateErrorHandling(manifest[key]);
  }
  for (const key of ['stageTemplate', 'stageSet']) {
    if (manifest[key] === undefined) continue;
    if (typeof manifest[key] !== 'string' || !manifest[key].trim()) throw new Error(`Flow update ${key} must be a non-empty string`);
  }
  if (manifest.stages !== undefined && (manifest.stageTemplate !== undefined || manifest.stageSet !== undefined)) {
    throw new Error('Flow update takes stages or a stage template, not both; rename the stage entries to change them');
  }
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

// Reporting reads the persisted preference, but the provider captures into the
// session's effective selection. Reconcile the two before the first content
// write and carry the result into the payload so a save can never claim a set
// it did not use.
async function resolveCaptureContext(options, readUpdateSet) {
  if (!options.ensureCapture) return undefined;
  const intended = await readUpdateSet();
  return options.ensureCapture(intended);
}

async function addPostMutationCapture(snapshot, sdk, readUpdateSet, flowId) {
  const updateSet = await readUpdateSet();
  snapshot.after = updateSet;
  snapshot.capture_after = await readUpdateSetCapture(sdk, updateSet, flowId);
}

export async function readUpdateSetCapture(sdk, updateSet, flowId, { locateElsewhere = false } = {}) {
  const updateSetId = idValue(updateSet?.sys_id || updateSet?.sysId);
  if (!updateSetId) return unavailableCapture('current update set has no selected sys_id (likely Default)');
  const rows = await sdk.list('sys_update_xml', new URLSearchParams({
    sysparm_query: `update_set=${updateSetId}`,
    sysparm_limit: '200',
    sysparm_display_value: 'all',
    sysparm_fields: 'sys_id,name,type,action,target_name,update_set,payload,xml',
  }));
  const matches = rows.filter(row => JSON.stringify(row).includes(flowId));
  const capture = {
    available: true,
    status: matches.length ? 'captured' : 'missing',
    update_set: updateSet,
    count: matches.length,
    records: matches,
  };
  if (!matches.length && locateElsewhere) {
    capture.elsewhere = await findCaptureElsewhere(sdk, flowId, updateSetId);
    const destinations = capture.elsewhere.update_sets || [];
    capture.diagnosis = destinations.length
      ? `Content was saved, but no update XML for this flow is in ${updateSet?.name || updateSetId}. `
        + `${destinations.reduce((sum, set) => sum + set.count, 0)} matching record(s) are in `
        + `${destinations.map(set => `${set.name || set.sys_id} (${set.sys_id})`).join(', ')}. `
        + 'These may be historical captures and do not prove this save was routed elsewhere. '
        + 'Capture can be asynchronous; re-check the intended set before completing or exporting it.'
      : `Content was saved, but no update XML naming this flow was found in ${updateSet?.name || updateSetId} `
        + `or by nameLIKE${flowId}. Capture may be absent or recorded under a different name; `
        + 'inspect sys_update_xml for the flow sys_id before completing the set.';
  }
  return capture;
}

// The flow's own update XML is named `<table>_<sys_id>`, so the flow sys_id is
// searchable across every set. This locates candidate captures without moving
// records; a historical match alone cannot establish where this save landed.
async function findCaptureElsewhere(sdk, flowId, intendedSetId) {
  const id = idValue(flowId);
  // Only a single opaque token may reach the encoded query; never allow query
  // operators such as ^ or = to be injected through a caller-supplied id.
  if (!/^[0-9a-zA-Z_-]{1,64}$/.test(id)) {
    return { checked: false, reason: 'flow identifier is not a safe exact token', update_sets: [] };
  }
  const params = new URLSearchParams({
    sysparm_query: `nameLIKE${id}`,
    sysparm_limit: '50',
    sysparm_display_value: 'all',
    sysparm_fields: 'sys_id,name,type,action,target_name,update_set,sys_created_on',
  });
  let rows;
  try {
    rows = await sdk.list('sys_update_xml', params);
  } catch (error) {
    return { checked: true, available: false, reason: error.message, update_sets: [] };
  }
  const bySet = new Map();
  for (const row of rows) {
    const raw = row.update_set;
    const setId = idValue(raw);
    if (!setId || setId === intendedSetId) continue;
    const entry = bySet.get(setId) || { sys_id: setId, name: raw?.display_value || '', count: 0, records: [] };
    entry.count += 1;
    entry.records.push({
      sys_id: idValue(row.sys_id),
      name: row.name?.display_value || row.name || '',
      action: row.action?.display_value || row.action || '',
      sys_created_on: row.sys_created_on?.display_value || row.sys_created_on || '',
    });
    bySet.set(setId, entry);
  }
  return { checked: true, available: true, query: `nameLIKE${id}`, update_sets: [...bySet.values()] };
}

// Verify requested step content independently of the mutation acknowledgement.
function labelCacheEntry({ name, label, type, baseType, usedInstances }) {
    // The provider stores usedInstances as a map, but a map key is a UUID and an
    // unquoted UUID key is not valid GraphQL. Send the array form it accepts.
    const instances = Object.entries(usedInstances || {}).flatMap(([uiUniqueIdentifier, inputNames]) =>
      (Array.isArray(inputNames) ? inputNames : [inputNames]).map(inputName => ({ uiUniqueIdentifier, inputName })));
    const entry = { name, usedInstances: instances };
    if (label) entry.label = label;
    if (type) entry.type = type;
    if (baseType) entry.base_type = baseType;
    return entry;
 }

function assertStepReadback(definition, expectedSteps, kind, flowId) {
  const saved = kind === 'action' ? findExistingActions(definition) : (definition.flowLogicInstances || definition.flowLogics || []);
  for (const expected of expectedSteps) {
    const matches = saved.filter(step => stringValue(step.uiUniqueIdentifier || step.ui_unique_identifier) === expected.uiUniqueIdentifier);
    if (matches.length !== 1) throw new Error(`Flow ${flowId} ${kind} ${expected.uiUniqueIdentifier} was not uniquely persisted`);
    const actual = matches[0];
    if (!findId(actual, ['sysId', 'id', 'sys_id'])) throw new Error(`Flow ${flowId} ${kind} has no persisted identity`);
    for (const key of ['order', 'parent', 'parentUiId', 'connectedTo', 'definitionId', 'actionTypeSysId']) {
      if (expected[key] === undefined) continue;
      const value = key === 'actionTypeSysId' ? actionTypeIdOf(actual) : actual[key];
      if (String(value ?? '') !== String(expected[key])) throw new Error(`Flow ${flowId} ${kind} ${expected.uiUniqueIdentifier} ${key} did not match requested value`);
    }
    if (expected.inputs) {
      for (const input of expected.inputs) {
        const found = inputList(actual).filter(i => i.name === input.name);
        if (found.length !== 1 || !isDeepStrictEqual(inputRawValue(found[0]), inputRawValue(input))) throw new Error(`Flow ${flowId} ${kind} ${expected.uiUniqueIdentifier} input ${input.name} did not match the requested value`);
      }
    }
  }
}

function assertLogicPreserved(before, after, inserts, updates, deletes, flowId) {
  const ids = new Set(inserts.map(l => l.uiUniqueIdentifier));
  const mask = (definition, isAfter) => (definition.flowLogicInstances || definition.flowLogics || []).filter(l => {
    const ui = stringValue(l.uiUniqueIdentifier || l.ui_unique_identifier);
    return !(isAfter ? ids.has(ui) : deletes.includes(stringValue(l.sysId || l.id || l.sys_id || ui)));
  }).map(l => {
    const copy = clone(l);
    const update = updates.find(u => u.uiUniqueIdentifier === stringValue(l.uiUniqueIdentifier || l.ui_unique_identifier));
    if (update) for (const key of Object.keys(update)) if (!['uiUniqueIdentifier', 'type'].includes(key)) delete copy[key];
    return copy;
  });
  if (!isDeepStrictEqual(mask(before, false), mask(after, true))) throw new Error(`Flow ${flowId} changed omitted logic fields; preservation failed`);
}

async function planErrorHandling({ sdk, instance, scope, flowId, beforeDefinition, existingActions, actionInserts, actionUpdates, flowLogicInserts, flowLogicUpdates, changes, idFactory, actionUiMap, pendingSteps, changedActionInputs, collectPills, errorHandlingInput, actionTargets = new Map() }) {
    const existingLogics = beforeDefinition.flowLogicInstances || beforeDefinition.flowLogics || [];
    let topTry = existingLogics.find(fl => String(fl.definitionId) === 'e9060aa2c3013010ace8b740ad40dd51');
    let topCatch = existingLogics.find(fl => String(fl.definitionId) === '35d60003e6022010a5e40cdd1254dd23');

    for (const id of ['e9060aa2c3013010ace8b740ad40dd51', '35d60003e6022010a5e40cdd1254dd23']) {
      if (existingLogics.filter(fl => String(fl.definitionId) === id).length > 1) throw new Error('Ambiguous existing error handling blocks');
    }
    if (Boolean(topTry) !== Boolean(topCatch)) throw new Error('Incomplete existing error handling pair; reconcile in Flow Designer before retrying');
    if (topTry && (!topTry.uiUniqueIdentifier || !topCatch.uiUniqueIdentifier || !Number.isInteger(Number(topCatch.order)))) throw new Error('Malformed existing error handling identities');
    if (topCatch?.connectedTo && topCatch.connectedTo !== topTry.uiUniqueIdentifier) throw new Error('Existing Catch is connected to a different Try');
    // 1. Ensure Top Level Try (order 0)
    let tryUiId = topTry ? stringValue(topTry.uiUniqueIdentifier || topTry.ui_unique_identifier) : '';
    if (!topTry) {
      tryUiId = idFactory();
      const tryDef = FLOW_LOGIC_DEFINITIONS['top level try'];
      flowLogicInserts.push({
        order: '0',
        uiUniqueIdentifier: tryUiId,
        parent: '',
        parentUiId: '',
        connectedTo: '',
        metadata: '{"predicates":[]}',
        flowSysId: flowId,
        generationSource: '',
        definitionId: tryDef.id,
        type: 'flowlogic',
        inputs: [],
        outputsToAssign: [],
        flowLogicDefinition: {
          id: tryDef.id,
          name: tryDef.name,
          description: tryDef.description,
          connectedTo: '',
          quiescence: 'never',
          compilationClass: tryDef.compilationClass,
          order: tryDef.order,
          type: tryDef.type,
          visible: true,
          attributes: tryDef.attributes,
          userCanRead: true,
          category: '',
          inputs: [],
          variables: '[]'
        }
      });
      changes.push({ component: 'flowLogic', order: 0, type: 'Top Level Try', input: 'insert', before: null, after: { uiUniqueIdentifier: tryUiId } });

      // Re-parent all existing unparented main body actions (order >= 1) to Top Level Try
      for (const a of existingActions) {
        if (!a.parent) {
          const uiId = stringValue(a.uiUniqueIdentifier || a.ui_unique_identifier);
          actionUpdates.push({
            uiUniqueIdentifier: uiId,
            type: 'action',
            parent: tryUiId,
            parentUiId: tryUiId
          });
        }
      }
      // Re-parent all newly inserted actions that lack parent to Top Level Try
      for (const a of actionInserts) {
        if (!a.parent) {
          a.parent = tryUiId;
          a.parentUiId = tryUiId;
        }
      }
      // Re-parent all unparented logic blocks
      for (const fl of existingLogics) {
        if (!fl.parent && String(fl.definitionId) !== '35d60003e6022010a5e40cdd1254dd23') {
          const uiId = stringValue(fl.uiUniqueIdentifier || fl.ui_unique_identifier);
          flowLogicUpdates.push({
            uiUniqueIdentifier: uiId,
            type: 'flowlogic',
            parent: tryUiId,
            parentUiId: tryUiId
          });
        }
      }
      for (const fl of flowLogicInserts) {
        if (!fl.parent && fl.definitionId !== 'e9060aa2c3013010ace8b740ad40dd51' && fl.definitionId !== '35d60003e6022010a5e40cdd1254dd23') {
          fl.parent = tryUiId;
          fl.parentUiId = tryUiId;
        }
      }
    }

    // 2. Ensure Top Level Catch
    let catchUiId = topCatch ? stringValue(topCatch.uiUniqueIdentifier || topCatch.ui_unique_identifier) : '';
    // An existing Catch already owns its order; re-running the same manifest must
    // place error actions after it instead of guessing a fixed slot.
    let catchOrder = topCatch ? parseInt(topCatch.order, 10) : NaN;
    if (!topCatch) {
      catchUiId = idFactory();
      const catchDef = FLOW_LOGIC_DEFINITIONS['top level catch'];
      // Determine max order
      let maxOrder = 0;
      for (const a of existingActions) maxOrder = Math.max(maxOrder, parseInt(a.order, 10) || 0);
      for (const fl of existingLogics) maxOrder = Math.max(maxOrder, parseInt(fl.order, 10) || 0);
      for (const a of actionInserts) maxOrder = Math.max(maxOrder, parseInt(a.order, 10) || 0);
      for (const fl of flowLogicInserts) maxOrder = Math.max(maxOrder, parseInt(fl.order, 10) || 0);
      catchOrder = maxOrder + 1;

      flowLogicInserts.push({
        order: String(catchOrder),
        uiUniqueIdentifier: catchUiId,
        parent: '',
        parentUiId: '',
        connectedTo: tryUiId,
        metadata: '{"predicates":[]}',
        flowSysId: flowId,
        generationSource: '',
        definitionId: catchDef.id,
        type: 'flowlogic',
        inputs: [
          { name: 'enabled', value: { schemaless: false, schemalessValue: '', value: 'true' } }
        ],
        outputsToAssign: [],
        flowLogicDefinition: {
          id: catchDef.id,
          name: catchDef.name,
          description: catchDef.description,
          connectedTo: catchDef.connectedTo,
          quiescence: 'never',
          compilationClass: catchDef.compilationClass,
          order: catchDef.order,
          type: catchDef.type,
          visible: true,
          attributes: catchDef.attributes,
          userCanRead: true,
          category: '',
          inputs: [],
          variables: '[]'
        }
      });
      changes.push({ component: 'flowLogic', order: catchOrder, type: 'Top Level Catch', input: 'insert', before: null, after: { uiUniqueIdentifier: catchUiId } });
    }

    // Register Catch step in pendingSteps for data pill resolution
    pendingSteps.push({
      name: 'Error Handler',
      order: String(Number.isFinite(catchOrder) ? catchOrder : existingActions.length + 1),
      uiUniqueIdentifier: catchUiId,
      inputs: [
        { name: '__status__.message', parameter: { label: 'Error Status➛Message', type: 'string' } },
        { name: '__status__.code', parameter: { label: 'Error Status➛Code', type: 'integer' } }
      ]
    });

    // 3. Process errorHandling actions
    const errorActions = Array.isArray(errorHandlingInput.actions) ? errorHandlingInput.actions : [];
    const errorPill = name => String(name)
      .replace(/\{\{error\.message\}\}/g, `{{${catchUiId}.__status__.message}}`)
      .replace(/\{\{error\.code\}\}/g, `{{${catchUiId}.__status__.code}}`);
    const children = existingActions.filter(a => a.parent === catchUiId || a.parentUiId === catchUiId).sort((a, b) => Number(a.order) - Number(b.order));
    if (existingLogics.some(l => l.parent === catchUiId || l.parentUiId === catchUiId)) throw new Error('Ambiguous Catch children include logic blocks');
    const childOrders = children.map(a => String(a.order));
    if (new Set(childOrders).size !== childOrders.length || children.some(a => !a.uiUniqueIdentifier || !Number.isInteger(Number(a.order)))) throw new Error('Ambiguous Catch child identities or orders');
    let errActionOrder = Math.max(catchOrder, ...existingActions.map(a => Number(a.order)), ...existingLogics.map(a => Number(a.order)), ...actionInserts.map(a => Number(a.order)), ...flowLogicInserts.map(a => Number(a.order))) + 1;
    for (const [eIdx, eAction] of errorActions.entries()) {
      const resolved = await resolveActionType(sdk, eAction.type);
      const actionDefinition = await readActionDefinition(sdk, instance, resolved.id, scope);
      const existingChild = children[eIdx];
      if (existingChild && actionTypeIdOf(existingChild) !== resolved.id) throw new Error(`Error action ${eIdx + 1} does not match existing Catch child type; ambiguous reconciliation`);
      const uiUniqueIdentifier = existingChild ? existingChild.uiUniqueIdentifier : idFactory();
      actionUiMap.set(`error_${eIdx + 1}`, uiUniqueIdentifier);
      // Resolve the friendly {{error.*}} tokens before the typed inputs are
      // built: the value that reaches the instance has to name the Catch
      // instance's own pill, otherwise the canvas stores an unresolved
      // reference and no labelCache entry can draw it.
      const errorInputs = Object.fromEntries(Object.entries(eAction.inputs || {})
        .map(([input, value]) => [input, typeof value === 'string' ? errorPill(value) : value]));
      if (existingChild) {
        const update = buildActionUpdate(existingChild, { ...eAction, inputs: errorInputs }, eIdx);
        actionUpdates.push(update);
        actionTargets.set(uiUniqueIdentifier, existingChild);
        changedActionInputs.set(uiUniqueIdentifier, new Set(Object.keys(errorInputs)));
        for (const [input, after] of Object.entries(errorInputs)) {
          changes.push({ component: 'errorAction', order: existingChild.order, type: eAction.type, input, before: inputRawValue(inputList(existingChild).find(i => i.name === input)), after });
          collectPills(after, uiUniqueIdentifier, input);
        }
        continue;
      }
      const insertInputs = buildTypedInputs({ ...eAction, inputs: errorInputs }, actionDefinition.schema);
      pendingSteps.push({ name: eAction.type, order: String(errActionOrder), uiUniqueIdentifier, inputs: insertInputs });
      actionInserts.push({
        actionTypeSysId: resolved.id,
        flowSysId: flowId,
        generationSource: '',
        type: 'action',
        order: String(errActionOrder),
        parent: catchUiId,
        uiUniqueIdentifier,
        parentUiId: catchUiId,
        metadata: JSON.stringify(parseMaybeJson(actionDefinition.definition.metadata, {})),
        inputs: insertInputs,
      });
      changedActionInputs.set(uiUniqueIdentifier, new Set(Object.keys(eAction.inputs || {})));
      for (const [input, after] of Object.entries(eAction.inputs || {})) {
        const resolvedVal = typeof after === 'string' ? errorPill(after) : after;
        changes.push({ component: 'errorAction', order: errActionOrder, type: eAction.type, input, before: null, after: resolvedVal });
        collectPills(resolvedVal, uiUniqueIdentifier, input);
      }
      errActionOrder++;
    }
}

async function planManifestSteps({ manifest, beforeDefinition, existingActions, existingOrders, actionUiMap, logicUiMap, pendingSteps, idFactory, sdk, instance, scope, flowId, actionInserts, actionUpdates, flowLogicInserts, actionTargets, changedActionInputs, changes, collectPills }) {
  const existingLogics = beforeDefinition.flowLogicInstances || beforeDefinition.flowLogics || [];
  const registry = new Map();
  const byUi = new Map();
  const register = (step, kind) => {
    const ui = stringValue(step.uiUniqueIdentifier || step.ui_unique_identifier);
    const order = String(step.order);
    if (registry.has(order) && kind === 'action') throw new Error(`Ambiguous step order ${order}: multiple Action instances`);
    if (!ui || byUi.has(ui) || registry.has(order)) throw new Error(`Ambiguous step identity or order ${order}`);
    const entry = { ...step, uiUniqueIdentifier: ui, kind };
    registry.set(order, entry); byUi.set(ui, entry);
    (kind === 'action' ? actionUiMap : logicUiMap).set(order, ui);
    return entry;
  };
  for (const step of existingActions) register(step, 'action');
  for (const step of existingLogics) register(step, 'logic');
  const logicSpecs = manifest.flowLogics || manifest.logic || [];
  for (const l of logicSpecs) {
    const type = String(l.type || l.name).toLowerCase().trim();
    register({ ...l, definitionId: FLOW_LOGIC_DEFINITIONS[type].id, uiUniqueIdentifier: idFactory() }, 'logic');
  }
  const actionPlans = new Map();
  for (const [index, a] of (manifest.actions || []).entries()) {
    if (actionPlans.has(String(a.order))) throw new Error(`Duplicate action update for order ${a.order}`);
    if (existingOrders.has(String(a.order))) { actionPlans.set(String(a.order), { existing: true }); continue; }
    const resolved = await resolveActionType(sdk, a.type);
    const actionDefinition = await readActionDefinition(sdk, instance, resolved.id, scope);
    const uiUniqueIdentifier = idFactory();
    const entry = register({ ...a, uiUniqueIdentifier }, 'action');
    // Schemas exist before any value is resolved, including forward references.
    pendingSteps.push({ ...entry, name: a.type, inputs: buildTypedInputs(a, actionDefinition.schema) });
    actionPlans.set(String(a.order), { resolved, actionDefinition, uiUniqueIdentifier, index });
  }
  const resolveLink = (values, label, owner) => {
    const supplied = values.filter(v => v !== undefined);
    if (!supplied.length) return '';
    const targets = supplied.map(v => {
      const target = registry.get(String(v)) || byUi.get(String(v));
      if (!target || target.kind !== 'logic' || target.uiUniqueIdentifier === owner) throw new Error(`Absent, wrong-type or self ${label} target ${v}`);
      return target;
    });
    if (new Set(targets.map(t => t.uiUniqueIdentifier)).size !== 1) throw new Error(`Conflicting ${label} aliases`);
    const target = targets[0];
    if (label === 'Catch' && !['07223332de022010ec58424b73829721', 'e9060aa2c3013010ace8b740ad40dd51'].includes(target.definitionId)) throw new Error('Catch target must be a Try block');
    if (label === 'parent' && !Object.values(FLOW_LOGIC_DEFINITIONS).some(d => d.id === target.definitionId && /^(TRY|TOP_LEVEL_TRY|CATCH|TOP_LEVEL_CATCH|IF|ELSE|ELSE_IF)$/.test(d.type))) throw new Error('Parent target cannot contain children');
    return target.uiUniqueIdentifier;
  };
  for (const l of logicSpecs) {
    const entry = registry.get(String(l.order));
    entry.resolvedParent = resolveLink([l.parent, l.parentOrder, l.parentUiId], 'parent', entry.uiUniqueIdentifier);
  }
  for (const entry of registry.values()) {
    const seen = new Set([entry.uiUniqueIdentifier]);
    let parent = entry.resolvedParent || entry.parentUiId || entry.parent;
    while (parent && byUi.has(String(parent))) {
      if (seen.has(parent)) throw new Error('Cyclic parent links');
      seen.add(parent); const next = byUi.get(parent); parent = next.resolvedParent || next.parentUiId || next.parent;
    }
  }

  // Handle flowLogics insertion and update
  const requestedLogics = manifest.flowLogics || manifest.logic || [];
  const logicTypeKey = t => String(t || '').toLowerCase().trim();
  // A manifest names steps by order ({{step_4.__status__.message}} or
  // {{4.message}}). Resolve that only once the owning map entry exists, but do
  // it before any value is packaged: a token that survives into the payload
  // stores an unresolvable reference the canvas renders blank.
  const resolveStepPill = value => String(value).replace(/\{\{(?:step_)?(\d+)\.([^}]+)\}\}/g, (match, order, field) => {
    const ui = actionUiMap.get(String(order)) || logicUiMap.get(String(order));
    if (!ui) throw new Error(`Absent step reference ${match}`);
    return `{{${ui}.${field}}}`;
  });
  const resolveStepInputs = inputs => Object.fromEntries(Object.entries(inputs || {})
    .map(([input, value]) => [input, typeof value === 'string' ? resolveStepPill(value) : value]));

  for (const [logicIdx, l] of requestedLogics.entries()) {
    const lType = logicTypeKey(l.type || l.name);
    const logicDef = FLOW_LOGIC_DEFINITIONS[lType] || {
      id: l.definitionId || l.id || '',
      name: l.name || l.type,
      type: (l.type || '').toUpperCase(),
      description: '',
      compilationClass: '',
      order: l.order || logicIdx + 1,
      connectedTo: l.connectedTo || '',
      attributes: 'allow_children=true,allow_siblings=true,'
    };

    const uiUniqueIdentifier = logicUiMap.get(String(l.order));
    const parentUiId = resolveLink([l.parent, l.parentOrder, l.parentUiId], 'parent', uiUniqueIdentifier);
    const connectedTo = resolveLink([l.connectedTo, l.connectedToOrder], 'Catch', uiUniqueIdentifier);
    // A Catch only works when it points at one specific Try instance. Falling
    // back to the definition id writes a link the instance cannot resolve, so
    // demand the pairing instead of guessing it.
    if ((lType === 'catch' || lType === 'top level catch') && l.connectedTo === undefined && l.connectedToOrder === undefined) {
      throw new Error(`Flow logic at order ${l.order} is a Catch block; set connectedToOrder to the Try block's order so the pair stays linked`);
    }

    let resolvedCondition = resolveStepPill(l.condition || '');

    const inputs = [];
    collectPills(resolvedCondition, uiUniqueIdentifier, 'condition');

    if (lType === 'if' || lType === 'else if') {
      inputs.push({
        name: 'condition_name',
        value: { schemaless: false, schemalessValue: '', value: l.condition_name || l.conditionName || l.label || '' }
      });
      inputs.push({
        name: 'condition',
        value: { schemaless: false, schemalessValue: '', value: resolvedCondition }
      });
    } else if (lType === 'catch' || lType === 'top level catch') {
      inputs.push({
        name: 'enabled',
        value: { schemaless: false, schemalessValue: '', value: 'true' }
      });
    }

    const flowVarsArray = [];
    if (lType === 'set flow variables' && l.values) {
      for (const [varName, varVal] of Object.entries(l.values)) {
        flowVarsArray.push({
          id: '',
          name: varName,
          children: [],
          displayValue: { value: '' },
          value: { schemaless: false, schemalessValue: '', value: String(varVal) }
        });
      }
    }

    flowLogicInserts.push({
      order: String(l.order || logicIdx + 1),
      uiUniqueIdentifier,
      parent: parentUiId,
      parentUiId,
      connectedTo,
      metadata: '{"predicates":[]}',
      flowSysId: flowId,
      generationSource: '',
      definitionId: logicDef.id,
      type: 'flowlogic',
      inputs,
      outputsToAssign: [],
      ...(flowVarsArray.length ? { flowVariables: flowVarsArray } : {}),
      flowLogicDefinition: {
        id: logicDef.id,
        name: logicDef.name,
        description: logicDef.description,
        connectedTo: logicDef.connectedTo,
        quiescence: 'never',
        compilationClass: logicDef.compilationClass,
        order: logicDef.order,
        type: logicDef.type,
        visible: true,
        attributes: logicDef.attributes,
        userCanRead: true,
        category: '',
        inputs: [],
        variables: '[]'
      }
    });

    if (lType === 'catch' || lType === 'top level catch') {
      pendingSteps.push({
        name: 'Catch',
        order: String(l.order || logicIdx + 1),
        uiUniqueIdentifier,
        inputs: [
          { name: '__status__.message', parameter: { label: 'Error Status➛Message', type: 'string' } },
          { name: '__status__.code', parameter: { label: 'Error Status➛Code', type: 'integer' } }
        ]
      });
    }

    changes.push({ component: 'flowLogic', order: l.order, type: logicDef.name, input: 'insert', before: null, after: { parent: parentUiId, connectedTo } });
  }

  for (const [index, requested] of (manifest.actions || []).entries()) {
    const isInsert = !existingOrders.has(String(requested.order));
    if (isInsert) {
      const { resolved, actionDefinition, uiUniqueIdentifier } = actionPlans.get(String(requested.order));
      actionUiMap.set(String(requested.order), uiUniqueIdentifier);
      // Resolve before packaging: the instance must receive the producing step's
      // own pill name, not the order-based token from the manifest.
      const insertInputs = buildTypedInputs({ ...requested, inputs: resolveStepInputs(requested.inputs) }, actionDefinition.schema);
      // A later step in this same manifest may reference this one; its identity
      // and schema exist now even though the flow does not carry it yet.
      Object.assign(pendingSteps.find(s => s.uiUniqueIdentifier === uiUniqueIdentifier), { inputs: insertInputs });
      const actParent = resolveLink([requested.parentUiId, requested.parentOrder, requested.parent], 'parent', uiUniqueIdentifier);
      actionInserts.push({
        actionTypeSysId: resolved.id,
        flowSysId: flowId,
        generationSource: '',
        type: 'action',
        order: String(requested.order),
        parent: actParent,
        uiUniqueIdentifier,
        parentUiId: actParent,
        metadata: JSON.stringify(parseMaybeJson(actionDefinition.definition.metadata, {})),
        inputs: insertInputs,
      });
      changedActionInputs.set(uiUniqueIdentifier, new Set(Object.keys(requested.inputs || {})));
      for (const [input, after] of Object.entries(requested.inputs || {})) {
        const resolvedAfter = typeof after === 'string' ? resolveStepPill(after) : after;
        changes.push({ component: 'action', order: requested.order, type: requested.type, input, before: null, after: resolvedAfter });
        collectPills(resolvedAfter, uiUniqueIdentifier, input);
      }
    } else {
      const existing = await resolveExistingAction(sdk, existingActions, requested, index);
      const resolvedRequest = { ...requested, inputs: resolveStepInputs(requested.inputs) };
      const update = buildActionUpdate(existing, resolvedRequest, index);
      if (['parent', 'parentOrder', 'parentUiId'].some(k => requested[k] !== undefined)) {
        const parent = resolveLink([requested.parentUiId, requested.parentOrder, requested.parent], 'parent', existing.uiUniqueIdentifier);
        update.parent = parent; update.parentUiId = parent;
      }
      actionUpdates.push(update);
      const uiId = stringValue(existing.uiUniqueIdentifier || existing.ui_unique_identifier);
      if (actionTargets.has(uiId)) throw new Error(`Duplicate action update for order ${requested.order}; combine input changes in one action entry`);
      actionTargets.set(uiId, existing);
      changedActionInputs.set(uiId, new Set(Object.keys(requested.inputs)));
      for (const [input, after] of Object.entries(requested.inputs)) {
        const resolvedAfter = typeof after === 'string' ? resolveStepPill(after) : after;
        changes.push({ component: 'action', order: requested.order, type: requested.type, input, before: inputRawValue(inputList(existing).find(field => field.name === input)), after: resolvedAfter });
        collectPills(resolvedAfter, uiId, input);
      }
    }
  }

}

export async function createFlowFromManifest(sdk, instance, inputManifest, options = {}) {
  const manifest = validateFlowManifest(inputManifest);
  const scope = manifest.scope;
  const idFactory = options.idFactory || (() => randomUUID());
  const readUpdateSet = options.readUpdateSet || (async () => null);
  const snapshots = [];
  let captureContext;
  try {
    captureContext = await resolveCaptureContext(options, readUpdateSet);
  } catch (error) {
    throw new Error(`Flow creation refused before any content write: capture context could not be established. ${error.message}`, { cause: error });
  }

  const actionInstances = [];
  const flowLogicInserts = [];
  const labelCacheInserts = [];
  const pendingSteps = [];
  const pills = [];
  const collectPills = (value, uiUniqueIdentifier, inputName) => {
    for (const match of String(value).matchAll(/\{\{([^}]+)\}\}/g)) pills.push({ name: match[1], uiUniqueIdentifier, inputName });
  };
  const orderedManifest = { ...manifest, actions: manifest.actions.map((a, index) => ({ ...a, order: a.order ?? index + 1, inputs: a.inputs || {} })) };
  await planManifestSteps({ manifest: orderedManifest, beforeDefinition: {}, existingActions: [], existingOrders: new Set(), actionUiMap: new Map(), logicUiMap: new Map(), pendingSteps, idFactory, sdk, instance, scope, flowId: '', actionInserts: actionInstances, actionUpdates: [], flowLogicInserts, actionTargets: new Map(), changedActionInputs: new Map(), changes: [], collectPills });
  if (manifest.errorHandling !== undefined) await planErrorHandling({ sdk, instance, scope, flowId: '', beforeDefinition: {}, existingActions: [], actionInserts: actionInstances, actionUpdates: [], flowLogicInserts, flowLogicUpdates: [], changes: [], idFactory, actionUiMap: new Map(), pendingSteps, changedActionInputs: new Map(), collectPills, errorHandlingInput: manifest.errorHandling });
  for (const pill of pills) {
    const binding = resolvePillBinding({}, pill.name, '', [], pendingSteps);
    const previous = labelCacheInserts.find(e => e.name === pill.name);
    if (previous) {
      if (!previous.usedInstances.some(i => i.uiUniqueIdentifier === pill.uiUniqueIdentifier && i.inputName === pill.inputName)) previous.usedInstances.push({ uiUniqueIdentifier: pill.uiUniqueIdentifier, inputName: pill.inputName });
    } else labelCacheInserts.push(labelCacheEntry({ name: pill.name, label: binding.label, type: binding.type, baseType: binding.type, usedInstances: { [pill.uiUniqueIdentifier]: [pill.inputName] } }));
  }

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

    for (const action of actionInstances) action.flowSysId = flowId;
    for (const logic of flowLogicInserts) logic.flowSysId = flowId;

    const patchResponse = await mutationContext('trigger_and_actions_patch', readUpdateSet, snapshots, () => sdk.request(`${instance}${GRAPHQL_ENDPOINT}`, {
      method: 'POST',
      body: JSON.stringify({ query: buildFlowPatchMutation({ flowId, trigger, actions: actionInstances, flowLogicInserts, labelCacheInserts }), variables: {} }),
    }), updateSet => readUpdateSetCapture(sdk, updateSet, flowId));
    assertGraphQLSuccess(patchResponse, 'Flow trigger/action patch');
    const insertedTrigger = insertedTriggers(patchResponse)[0];
    if (!insertedTrigger) throw new Error('Flow trigger insert returned no trigger identity');
    const inserted = insertedActions(patchResponse);
    if (inserted.length !== actionInstances.length) throw new Error(`Flow action patch returned ${inserted.length} inserted action identities; expected ${actionInstances.length}`);

    // Stages carry componentIndexes that name flow-step orders, so placement
    // runs after the actions exist — the same order Flow Designer uses.
    let manifestStages = manifest.stages || [];
    if ((manifest.stageTemplate || manifest.stageSet) && manifestStages.length === 0) {
      manifestStages = await resolveStageTemplate(sdk, manifest.stageTemplate || manifest.stageSet);
    }
    const stageInserts = buildStageInserts(manifestStages, { idFactory, flowId });
    if (stageInserts.length) {
      const stageResponse = await mutationContext('stage_placement', readUpdateSet, snapshots, () => sdk.request(`${instance}${GRAPHQL_ENDPOINT}`, {
        method: 'POST',
        body: JSON.stringify({ query: buildFlowStageMutation({ flowId, inserts: stageInserts }), variables: {} }),
      }), updateSet => readUpdateSetCapture(sdk, updateSet, flowId));
      assertGraphQLSuccess(stageResponse, 'Flow stage placement');
    }

    const processflow = await readProcessFlow(sdk, instance, flowId, scope);
    verifyCreatedFlowReadback({ flowId, processflow, trigger, insertedTrigger, manifest, actionInstances, inserted, stageInserts });
    assertStagesPlaced(processflow, stageInserts, flowId);
    assertStepReadback(processflow, actionInstances, 'action', flowId);
    assertStepReadback(processflow, flowLogicInserts, 'logic', flowId);
    for (const entry of labelCacheInserts) if (!readLabelCache(processflow).some(e => e.name === entry.name && e.label)) throw new Error(`Flow ${flowId} did not persist data pill ${entry.name}`);
    const { version } = await mutationContext('autosave_version', readUpdateSet, snapshots, () => createVerifiedFlowVersion(sdk, {
      instance, flowId, scope, type: 'Autosave', annotation: 'JSN flow create',
    }), updateSet => readUpdateSetCapture(sdk, updateSet, flowId));
    const selectedUpdateSet = await readUpdateSet();
    const updateSetCapture = await readUpdateSetCapture(sdk, selectedUpdateSet, flowId, { locateElsewhere: true });

    const triggerReadback = findArray(processflow, 'triggerInstances')[0] || {};
    return {
      flow: { id: flowId, name: manifest.name, status: 'draft', active: false },
      trigger: { ...triggerReadback, id: findId(triggerReadback, ['sysId', 'sys_id', 'id']) || findId(insertedTrigger, ['sysId', 'sys_id', 'id']) },
      actions: inserted,
      processflow,
      definition_readback: { available: true, status: 'read_back', flow_id: flowId },
      version,
      ...(captureContext ? { capture_context: captureContext } : {}),
      update_set_capture: updateSetCapture,
      update_set_mutations: snapshots,
      lifecycle: { published: false, supported: ['draft', 'autosave'], deferred: ['publish/activation', 'subflows', 'flow variables'] },
    };
  } catch (error) {
    // Creation is two-stage: the parent POST leaves a real draft behind when the
    // trigger/action patch fails. Name that orphan explicitly instead of leaving
    // the caller to hunt for it.
    throw new Error(`Flow ${flowId} creation incomplete and left orphan draft flow ${flowId} (delete it in Flow Designer): ${error.message}; reconciliation: ${JSON.stringify(snapshots)}`, { cause: error });
  }
}

// Flow Designer renders a canvas pill from the `label` of its label_cache entry;
// the ProcessFlow read exposes that cache as `labelCacheAsJsonString` (a JSON
// string), never as a `label_cache` array. Reading the wrong field is how a
// write ends up with an entry that has a name and no label to draw.
function normalizeUsedInstances(used) {
  const out = new Map();
  const add = (uiId, inputName) => {
    if (!uiId || !inputName) return;
    if (!out.has(uiId)) out.set(uiId, []);
    const names = out.get(uiId);
    if (!names.includes(inputName)) names.push(inputName);
  };
  if (Array.isArray(used)) {
    for (const entry of used) add(stringValue(entry?.uiUniqueIdentifier), stringValue(entry?.inputName));
  } else if (used && typeof used === 'object') {
    for (const [uiId, names] of Object.entries(used)) {
      for (const name of (Array.isArray(names) ? names : [names])) add(uiId, stringValue(name));
    }
  }
  const result = {};
  for (const [uiId, names] of out) result[uiId] = names;
  return result;
}

export function readLabelCache(definition) {
  const raw = definition?.labelCacheAsJsonString ?? definition?.label_cache ?? definition?.labelCache;
  let entries = raw;
  if (typeof raw === 'string') {
    try { entries = raw.trim() ? JSON.parse(raw) : []; } catch { entries = []; }
  }
  if (!Array.isArray(entries)) return [];
  return entries
    .map(entry => ({
      name: stringValue(entry?.name),
      label: stringValue(entry?.label),
      type: stringValue(entry?.type),
      baseType: stringValue(entry?.base_type || entry?.baseType),
      usedInstances: normalizeUsedInstances(entry?.usedInstances),
    }))
    .filter(entry => entry.name);
}

function describeKnownPills(cache) {
  const names = cache.map(entry => entry.name);
  if (!names.length) return 'this flow has no registered data pills';
  return `registered pills: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ` (+${names.length - 8} more)` : ''}`;
}

// A pill no entry covers still needs a label the canvas can draw. Resolve the
// producing step and the field it names, then build the label Flow Designer
// itself would: `Trigger - <trigger>➛<input>` or `<order> - <action>➛<input>`.
// `pending` covers steps this same manifest is inserting: their identity and
// input schema already exist here even though the flow does not carry them yet.
export function resolvePillBinding(definition, pillName, flowId, cache, pending = []) {
  const fail = () => {
    throw new Error(`Flow ${flowId} has no label_cache entry for data pill {{${pillName}}}; ${describeKnownPills(cache)}. Use a pill this flow already registers, or resave the flow in Flow Designer first. No content write attempted.`);
  };
  const separator = pillName.indexOf('.');
  if (separator <= 0) return fail();
  const stepKey = pillName.slice(0, separator);
  const remainder = pillName.slice(separator + 1);
  const fieldName = remainder.startsWith('__status__.') ? remainder : remainder.split('.')[0];
  const describe = (fields, name) => {
    const field = inputList({ inputs: fields }).find(entry => stringValue(entry?.name) === name);
    if (!field) return null;
    return {
      label: stringValue(field?.parameter?.label) || stringValue(field?.parameter?.name) || String(field?.name ?? ''),
      type: stringValue(field?.parameter?.type),
    };
  };

  const candidates = [
    ...findArray(definition, 'triggerInstances').map(step => ({ ...step, trigger: true })),
    ...findExistingActions(definition).map(step => ({ ...step, trigger: false })),
    ...pending.map(step => ({ ...step, trigger: false })),
    ...(findArray(definition, 'flowLogicInstances') || []).filter(fl => String(fl.definitionId) === '35d60003e6022010a5e40cdd1254dd23' || String(fl.definitionId) === '35d60003e6022010a5e40cdd1254dd21').map(fl => ({
      name: String(fl.definitionId) === '35d60003e6022010a5e40cdd1254dd23' ? 'Error Handler' : 'Catch',
      order: stringValue(fl.order),
      uiUniqueIdentifier: stringValue(fl.uiUniqueIdentifier || fl.ui_unique_identifier),
      trigger: false,
      inputs: [
        { name: '__status__.message', parameter: { label: 'Error Status➛Message', type: 'string' } },
        { name: '__status__.code', parameter: { label: 'Error Status➛Code', type: 'integer' } }
      ]
    }))
  ];
  for (const step of candidates) {
    const name = stringValue(step.name);
    const order = stringValue(step.order) || '1';
    const uiId = stringValue(step.uiUniqueIdentifier || step.ui_unique_identifier);
    const matchesAlias = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_\\d+$`).test(stepKey);
    if (!matchesAlias && stepKey !== uiId) continue;
    // Inputs and outputs both become draggable pills; look at each before failing.
    const field = describe(step.inputs, fieldName) || describe(step.outputs, fieldName);
    if (!field) continue;
    const prefix = step.trigger ? `Trigger - ${name}` : `${order} - ${name}`;
    return { label: `${prefix}➛${field.label}`, type: field.type };
  }
  return fail();
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
  const actionInserts = [];
  const actionDeletes = [];
  const flowVariableInserts = [];
  const flowLogicInserts = [];
  const flowLogicUpdates = [];
  const flowLogicDeletes = [];
  const labelCacheUpdates = [];
  let manifestStages = manifest.stages || [];
  if ((manifest.stageTemplate || manifest.stageSet) && manifestStages.length === 0) {
    const templateStages = await resolveStageTemplate(sdk, manifest.stageTemplate || manifest.stageSet);
    manifestStages = templateStages;
  }
  const stageInserts = buildStageInserts(manifestStages.filter(stage => stage.stageId === undefined), { idFactory: options.idFactory || (() => randomUUID()), flowId });
  const stageUpdates = buildStageUpdates((manifest.stages || []).filter(stage => stage.stageId !== undefined));
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
  const existingOrders = new Set(existingActions.map(a => String(a.order)));
  const idFactory = options.idFactory || (() => randomUUID());
  const pillToInstances = new Map();
  const pendingSteps = [];
  const actionUiMap = new Map();
  const logicUiMap = new Map(); // order -> uiUniqueIdentifier
  for (const a of existingActions) {
    const ui = stringValue(a.uiUniqueIdentifier || a.ui_unique_identifier);
    if (a.order && ui) actionUiMap.set(String(a.order), ui);
  }
  // One input value can carry several pills; register every reference, not just
  // the first, or the later ones never reach label_cache and stay blank.
  const collectPills = (value, uiUniqueIdentifier, inputName) => {
    for (const match of String(value).matchAll(/\{\{([^}]+)\}\}/g)) {
      const pillName = match[1].trim();
      if (!pillName) continue;
      if (!pillToInstances.has(pillName)) pillToInstances.set(pillName, []);
      const instances = pillToInstances.get(pillName);
      if (!instances.some(entry => entry.uiUniqueIdentifier === uiUniqueIdentifier && entry.inputName === inputName)) {
        instances.push({ uiUniqueIdentifier, inputName });
      }
    }
  };

  await planManifestSteps({ manifest, beforeDefinition, existingActions, existingOrders, actionUiMap, logicUiMap, pendingSteps, idFactory, sdk, instance, scope, flowId, actionInserts, actionUpdates, flowLogicInserts, actionTargets, changedActionInputs, changes, collectPills });

  const savedStages = stageList(beforeDefinition);
  const savedStageById = new Map(savedStages.map(stage => [stringValue(stage.stageId || stage.stage_id), stage]));
  // The provider replaces a flow's whole stage list when the patch inserts
  // stages, so an insert-only manifest silently drops the stages already there.
  // Refuse before any write rather than let the preservation check fail after.
  const namedStageIds = new Set(stageUpdates.map(update => update.stageId));
  const unlistedStages = savedStages.filter(stage => !namedStageIds.has(stringValue(stage.stageId || stage.stage_id)));
  if (stageInserts.length && unlistedStages.length) {
    const names = unlistedStages.map(stage => stringValue(stage.label)).filter(Boolean).join(', ');
    throw new Error(`Flow ${flowId} already has ${unlistedStages.length} stage(s) (${names}); inserting stages replaces the flow's stage list. Name every existing stage with its stageId in the manifest so it is kept. No content write attempted.`);
  }
  for (const update of stageUpdates) {
    const before = savedStageById.get(update.stageId);
    if (!before) throw new Error(`Flow ${flowId} has no stage ${update.stageId}; omit stageId to insert a new stage`);
    for (const [field, after] of Object.entries(update)) {
      if (field === 'stageId') continue;
      changes.push({ component: 'stage', stage: stringValue(before.label), input: field, before: before[field], after });
    }
  }
  for (const insert of stageInserts) {
    changes.push({ component: 'stage', stage: insert.label, input: 'insert', before: null, after: { order: insert.order, componentIndexes: insert.componentIndexes } });
  }

  // Handle flowVariables insertion
  const requestedVariables = manifest.flowVariables || manifest.variables || [];
  const existingVars = beforeDefinition.flowVariables || [];
  for (const [varIdx, v] of requestedVariables.entries()) {
    const label = v.label || v.name;
    const name = (v.name || v.label).toLowerCase().replace(/[^a-z0-9_]/g, '');
    const rawType = (v.type || 'string').toLowerCase();
    const TYPE_MAP = {
      'string': { type: 'string', label: 'String' },
      'boolean': { type: 'boolean', label: 'True/False' },
      'true/false': { type: 'boolean', label: 'True/False' },
      'bool': { type: 'boolean', label: 'True/False' },
      'integer': { type: 'integer', label: 'Integer' },
      'int': { type: 'integer', label: 'Integer' },
      'decimal': { type: 'decimal', label: 'Decimal' },
      'float': { type: 'float', label: 'Floating Point Number' },
      'date': { type: 'glide_date', label: 'Date' },
      'glide_date': { type: 'glide_date', label: 'Date' },
      'date/time': { type: 'glide_date_time', label: 'Date/Time' },
      'datetime': { type: 'glide_date_time', label: 'Date/Time' },
      'glide_date_time': { type: 'glide_date_time', label: 'Date/Time' },
      'reference': { type: 'reference', label: 'Reference' },
      'choice': { type: 'choice', label: 'Choice' },
      'array.string': { type: 'array.string', label: 'Array.String' },
      'array.reference': { type: 'array.reference', label: 'Array.Reference' },
      'array.integer': { type: 'array.integer', label: 'Array.Integer' },
      'array.boolean': { type: 'array.boolean', label: 'Array.True/False' },
      'json': { type: 'json', label: 'JSON' },
      'html': { type: 'html', label: 'HTML' }
    };
    const mapped = TYPE_MAP[rawType] || { type: rawType, label: v.type_label || (rawType.charAt(0).toUpperCase() + rawType.slice(1)) };
    const type = mapped.type;
    const type_label = v.type_label || mapped.label;
    const varOrder = v.order || (existingVars.length + varIdx + 1);
    const varUiId = v.uiUniqueIdentifier || idFactory();
    flowVariableInserts.push({
      label,
      name,
      type,
      type_label,
      order: varOrder,
      mandatory: Boolean(v.mandatory),
      readonly: Boolean(v.readonly),
      attributes: `sourceUiUniqueId=,sourceType=,sourceId=,uiUniqueId=${varUiId},`,
      uiDisplayType: type,
      uiDisplayTypeLabel: type_label
    });
    changes.push({ component: 'flowVariable', input: name, before: null, after: { label, type, order: varOrder } });
  }

  // Handle deletions by step order or uiUniqueIdentifier
  const rawDeletes = manifest.deleteSteps || manifest.delete || manifest.deleteOrders || [];
  const deleteTargets = new Set((Array.isArray(rawDeletes) ? rawDeletes : [rawDeletes]).map(String));
  if (deleteTargets.size > 0) {
    const existingLogics = beforeDefinition.flowLogicInstances || beforeDefinition.flowLogics || [];
    for (const a of existingActions) {
      const uiId = stringValue(a.uiUniqueIdentifier || a.ui_unique_identifier);
      const targetId = stringValue(a.sysId || a.id || a.sys_id || uiId);
      if (deleteTargets.has(String(a.order)) || deleteTargets.has(uiId) || deleteTargets.has(targetId)) {
        actionDeletes.push(targetId);
        changes.push({ component: 'action', order: a.order, type: a.name, input: 'delete', before: targetId, after: null });
      }
    }
    for (const fl of existingLogics) {
      const uiId = stringValue(fl.uiUniqueIdentifier || fl.ui_unique_identifier);
      const targetId = stringValue(fl.sysId || fl.id || fl.sys_id || uiId);
      if (deleteTargets.has(String(fl.order)) || deleteTargets.has(uiId) || deleteTargets.has(targetId)) {
        flowLogicDeletes.push(targetId);
        changes.push({ component: 'flowLogic', order: fl.order, type: fl.name, input: 'delete', before: targetId, after: null });
      }
    }
  }
  const errorHandlingInput = manifest.errorHandling ?? manifest.errorHandler;
  if (errorHandlingInput !== undefined) await planErrorHandling({ sdk, instance, scope, flowId, beforeDefinition, existingActions, actionInserts, actionUpdates, flowLogicInserts, flowLogicUpdates, changes, idFactory, actionUiMap, pendingSteps, changedActionInputs, collectPills, errorHandlingInput, actionTargets });

  // Register every referenced pill so the canvas can draw it. Runs after every
  // collection point (actions and logic blocks) so no reference is missed.
  // Existing entries keep their label/type; a pill this flow has never seen gets
  // a label resolved from its producing step.
  const labelCacheInserts = [];
  const existingLabelCache = readLabelCache(beforeDefinition);
  const mergeUsedInstances = (existing, instances) => {
    const merged = { ...(existing || {}) };
    for (const { uiUniqueIdentifier, inputName } of instances) {
      if (!merged[uiUniqueIdentifier]) merged[uiUniqueIdentifier] = [];
      if (!merged[uiUniqueIdentifier].includes(inputName)) merged[uiUniqueIdentifier].push(inputName);
    }
    return merged;
  };
  for (const [pillName, instances] of pillToInstances.entries()) {
    const existing = existingLabelCache.find(entry => entry.name === pillName);
    const usedInstances = mergeUsedInstances(existing?.usedInstances, instances);
    // An entry with no caption draws nothing, so a missing label is repaired
    // rather than passed through; a missing type is filled in when resolvable.
    let binding = null;
    if (!existing?.label) {
      binding = resolvePillBinding(beforeDefinition, pillName, flowId, existingLabelCache, pendingSteps);
    } else if (!existing.type) {
      try { binding = resolvePillBinding(beforeDefinition, pillName, flowId, existingLabelCache, pendingSteps); } catch { binding = null; }
    }
    if (existing) {
      labelCacheUpdates.push(labelCacheEntry({
        ...existing,
        label: existing.label || binding.label,
        type: existing.type || binding.type,
        baseType: existing.baseType || binding.type,
        usedInstances,
      }));
    } else {
      labelCacheInserts.push(labelCacheEntry({ name: pillName, label: binding.label, type: binding.type, baseType: binding.type, usedInstances }));
    }
  }
  if (triggerUpdates.length === 0 && actionUpdates.length === 0 && actionInserts.length === 0 && actionDeletes.length === 0 && flowVariableInserts.length === 0 && flowLogicInserts.length === 0 && flowLogicDeletes.length === 0 && stageInserts.length === 0 && stageUpdates.length === 0) throw new Error(`Flow ${flowId} update has no supported changes`);
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
  let captureContext;
  try {
    captureContext = await resolveCaptureContext(options, readUpdateSet);
  } catch (error) {
    throw new Error(`Flow ${flowId} update refused before any content write: capture context could not be established. ${error.message}`, { cause: error });
  }
  // Baseline the published runtime after the definition read (a legacy read can
  // materialize a version row) and before the edit session exists.
  const runtimeBefore = published ? await readFlowRuntime(sdk, instance, flowId, { scope, snapshotId }) : null;
  const outcome = await withFlowSafeEdit(sdk, instance, flowId, beforeDefinition.updated, async () => {
    let completedStage = 'validated';
    try {
      if (stageInserts.length > 0) {
        const stagesPayload = {};
        for (const s of stageInserts) {
          stagesPayload[s.stageId] = {
            stageId: s.stageId,
            duration: s.duration || STAGE_DURATION,
            componentIndexes: s.componentIndexes || [],
            label: s.label,
            value: s.value,
            type: s.type || 'standard',
            order: s.order,
            alwaysShow: s.alwaysShow ?? true,
            states: {
              pending: 'Pending - has not started',
              in_progress: 'In progress',
              skipped: 'Skipped',
              complete: 'Completed',
              error: 'Error'
            },
            system: Boolean(s._system ?? s.system)
          };
        }
        const stageRegRes = await sdk.request(`${instance}${FLOW_ENDPOINT}/${encodeURIComponent(flowId)}/stages?sysparm_transaction_scope=${encodeURIComponent(scope)}`, {
          method: 'PUT',
          body: JSON.stringify(stagesPayload)
        });
        const returnedStages = stageRegRes?.result?.data || {};
        // The PUT writes stage rows before the patch runs, so a silent omission
        // here would leave the flow holding stages nothing points at.
        const unconfirmed = [];
        for (const s of stageInserts) {
          if (returnedStages[s.stageId]?.id) s.id = returnedStages[s.stageId].id;
          else unconfirmed.push(s.label || s.stageId);
        }
        if (unconfirmed.length) {
          throw new Error(`Flow ${flowId} stage registration did not confirm ${unconfirmed.join(', ')}; those stages may already be attached to the flow. Inspect it before retrying`);
        }
      }
      const patchQuery = buildFlowUpdateMutation({ flowId, triggerUpdates, actionUpdates, actionInserts, actionDeletes, flowVariableInserts, flowLogicInserts, flowLogicUpdates, flowLogicDeletes, labelCacheUpdates, labelCacheInserts, stageInserts, stageUpdates });
      const patchResponse = await mutationContext('trigger_and_actions_update', readUpdateSet, snapshots, () => sdk.request(`${instance}${GRAPHQL_ENDPOINT}`, {
        method: 'POST',
        body: JSON.stringify({ query: patchQuery, variables: {} }),
      }), updateSet => readUpdateSetCapture(sdk, updateSet, flowId));
      assertGraphQLSuccess(patchResponse, 'Flow trigger/action update');
      completedStage = 'patch_acknowledged';
      const processflow = await readProcessFlow(sdk, instance, flowId, scope);
      assertStepReadback(processflow, [...actionInserts, ...actionUpdates], 'action', flowId);
      assertStepReadback(processflow, [...flowLogicInserts, ...flowLogicUpdates], 'logic', flowId);
      assertLogicPreserved(beforeDefinition, processflow, flowLogicInserts, flowLogicUpdates, flowLogicDeletes, flowId);
      // Only requested values may differ. Preserve array order and opaque fields.
      // `stages` is compared separately below: a stage edit may touch specific
      // fields, while every stage the manifest did not name must stay identical.
      const checkFields = ['subFlowInstances', 'flowInputs', 'flowOutputs', 'inputs', 'outputs'];
      if (flowVariableInserts.length === 0) checkFields.push('flowVariables');
      if (flowLogicInserts.length === 0 && flowLogicUpdates.length === 0 && flowLogicDeletes.length === 0) checkFields.push('flowLogicInstances');
      for (const field of checkFields) {
        if (!isDeepStrictEqual(beforeDefinition[field], processflow[field])) throw new Error(`Flow ${flowId} changed omitted ${field}; preservation failed`);
      }
      if (stageInserts.length || stageUpdates.length) {
        const requestedStageIds = new Set([...stageInserts.map(stage => stage.stageId), ...stageUpdates.map(stage => stage.stageId)]);
        const untouched = definition => stageList(definition)
          .filter(stage => !requestedStageIds.has(stringValue(stage.stageId || stage.stage_id)));
        if (!isDeepStrictEqual(untouched(beforeDefinition), untouched(processflow))) throw new Error(`Flow ${flowId} changed omitted stages; preservation failed`);
        assertStagesPlaced(processflow, [...stageInserts, ...stageUpdates.map(update => ({
          stageId: update.stageId,
          label: update.label ?? stringValue(savedStageById.get(update.stageId)?.label),
          order: update.order ?? savedStageById.get(update.stageId)?.order,
          componentIndexes: update.componentIndexes,
        }))].filter(stage => stage.label !== undefined), flowId);
      } else if (!isDeepStrictEqual(beforeDefinition.stages, processflow.stages)) {
        throw new Error(`Flow ${flowId} changed omitted stages; preservation failed`);
      }
      if (!triggerUpdate && !isDeepStrictEqual(beforeDefinition.triggerInstances, processflow.triggerInstances)) throw new Error(`Flow ${flowId} changed omitted triggerInstances`);
      const insertedUiIds = new Set(actionInserts.map(a => a.uiUniqueIdentifier));
      const deletedActionIds = new Set(actionDeletes);
      const maskActions = (definition, isAfter = false) => findExistingActions(definition)
        .filter(action => {
          const uiId = stringValue(action.uiUniqueIdentifier || action.ui_unique_identifier);
          const sId = stringValue(action.sysId || action.id || action.sys_id);
          if (isAfter && insertedUiIds.has(uiId)) return false;
          if (!isAfter && (deletedActionIds.has(uiId) || deletedActionIds.has(sId))) return false;
          return true;
        })
        .map(action => {
          const copy = clone(action);
          const move = actionUpdates.find(update => update.uiUniqueIdentifier === stringValue(action.uiUniqueIdentifier || action.ui_unique_identifier) && update.parent !== undefined);
          if (move) {
            if (isAfter && (copy.parent !== move.parent || copy.parentUiId !== move.parentUiId)) throw new Error(`Flow ${flowId} action parent readback did not match requested target`);
            delete copy.parent;
            delete copy.parentUiId;
          }
          const changed = changedActionInputs.get(stringValue(action.uiUniqueIdentifier || action.ui_unique_identifier));
          for (const [index, input] of inputList(copy).entries()) if (changed?.has(input.name)) inputList(copy)[index] = maskInputValue(input);
          return copy;
        });
      if (!isDeepStrictEqual(maskActions(beforeDefinition), maskActions(processflow, true))) throw new Error(`Flow ${flowId} changed omitted action fields; preservation failed`);
      // A pill the provider accepted but did not store still renders blank, so
      // read the cache back instead of trusting the mutation acknowledgement.
      const readbackCache = readLabelCache(processflow);
      for (const entry of [...labelCacheInserts, ...labelCacheUpdates]) {
        const saved = readbackCache.find(candidate => candidate.name === entry.name);
        if (!saved) throw new Error(`Flow ${flowId} did not persist data pill ${entry.name} to label_cache; the reference would render blank`);
        if (!saved.label) throw new Error(`Flow ${flowId} persisted data pill ${entry.name} without a label; the reference would render blank`);
      }
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
      const updateSetCapture = await readUpdateSetCapture(sdk, selectedUpdateSet, flowId, { locateElsewhere: true });
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
        ...(captureContext ? { capture_context: captureContext } : {}),
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
