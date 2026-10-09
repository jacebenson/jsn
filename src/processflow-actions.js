// Resource-specific Flow Designer contract. No Table API definition updates.
import { AppError, errUsage } from './errors.js';

export const ACTION_TABLE = 'sys_hub_action_type_definition';
const ROOT = '/api/now/processflow/action';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const raw = value => object(value) ? value.value : value;
const successCode = value => value === 0 || value === '0';
function token(value, label, global = false) {
  if (typeof value !== 'string' || (!/^[a-fA-F0-9]{32}$/.test(value) && !(global && value === 'global'))) {
    throw errUsage(`${label} must be an exact sys_id${global ? ' or global' : ''}`);
  }
  return value;
}
function failure(code, message, details = {}) {
  const error = new AppError(code, message);
  error.details = details;
  return error;
}
async function request(sdk, id, scope, suffix = '', method = 'GET', body, opts = {}) {
  if (id !== null) token(id, 'Action ID');
  token(scope, 'Transaction scope', true);
  const resource = id === null ? '/step_types' : `/action_types/${encodeURIComponent(id)}${suffix}`;
  const query = new URLSearchParams({ sysparm_transaction_scope: scope });
  const response = await sdk.request(`${sdk.baseURL}${ROOT}${resource}?${query}`, {
    ...opts, method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = response?.result;
  if (response?.error || result?.error || (result?.errorCode !== undefined && !successCode(result.errorCode))) {
    throw failure('action_api_error', result?.errorMessage || response?.error?.message || 'Process Flow request failed');
  }
  if (result === undefined || result === null) throw failure('action_api_error', 'Process Flow returned no result');
  return result;
}
async function metadata(sdk, id, scope, opts) {
  const result = await request(sdk, id, scope, '', 'GET', undefined, opts);
  if (!object(result) || result.id !== id || result.scope !== scope) {
    throw failure('action_identity_mismatch', 'Process Flow definition ID/scope does not match the target', { sys_id: id, scope });
  }
  return result;
}
export async function getAction(sdk, id, scope, opts = {}) {
  const definition = await metadata(sdk, id, scope, opts);
  const result = await request(sdk, id, scope, '/step_instances', 'GET', undefined, opts);
  const steps = Array.isArray(result) ? result : result.steps;
  if (!Array.isArray(steps)) throw failure('action_definition_incomplete', 'step_instances returned no steps array');
  return { ...definition, steps };
}
export function getStepTypes(sdk, scope) {
  return request(sdk, null, scope);
}
export async function validateScope(sdk, scope) {
  token(scope, 'Transaction scope', true);
  const record = await sdk.get('sys_scope', scope);
  if (!record || raw(record.sys_id) !== scope) throw errUsage(`Scope does not exist or is not readable: ${scope}`);
  return scope;
}
export async function actionScope(sdk, id, providedScope) {
  token(id, 'Action ID');
  if (providedScope !== undefined) token(providedScope, 'Transaction scope', true);
  const record = await sdk.get(ACTION_TABLE, id);
  if (!record || raw(record.sys_id) !== id) throw errUsage(`Action does not exist or is not readable: ${id}`);
  const scope = raw(record.sys_scope);
  token(scope, 'Action record scope', true);
  if (providedScope !== undefined && providedScope !== scope) {
    throw errUsage(`--scope ${providedScope} does not match action scope ${scope}`);
  }
  await validateScope(sdk, scope);
  return scope;
}
function validateVariables(list, label) {
  if (list.some(v => !object(v) || typeof v.name !== 'string' || !v.name || typeof v.type !== 'string' || !v.type)) {
    throw errUsage(`${label} requires named, typed variable objects`);
  }
  if (new Set(list.map(v => v.name)).size !== list.length) throw errUsage(`${label} has duplicate variable names`);
}
export function validateDefinition(definition, id, scope) {
  if (!object(definition)) throw errUsage('Expected a full action definition JSON object');
  for (const key of ['inputs', 'outputs', 'steps']) {
    if (!Array.isArray(definition[key])) throw errUsage(`Full definition requires an explicit ${key} array`);
  }
  validateVariables(definition.inputs, 'Action inputs');
  validateVariables(definition.outputs, 'Action outputs');
  if (!definition.steps.length) throw errUsage('Full definition requires at least one executable step');
  if (id !== undefined && definition.id !== id) throw errUsage('Definition ID must match the target action ID');
  if (scope !== undefined && definition.scope !== undefined && definition.scope !== scope) {
    throw errUsage('Definition scope must match the target transaction scope');
  }
  for (const step of definition.steps) {
    if (!object(step) || typeof step.cid !== 'string' || !step.cid || !step.step_type) {
      throw errUsage('Each step requires cid and step_type from its Process Flow schema');
    }
    for (const key of ['inputs', 'outputs', 'extended_inputs', 'extended_outputs']) {
      if (!Array.isArray(step[key])) throw errUsage(`Each step requires an explicit ${key} array`);
      validateVariables(step[key], `Step ${key}`);
    }
    if (id !== undefined && step.action && step.action !== id) throw errUsage('Step action ID must match the target');
  }
  if (new Set(definition.steps.map(s => s.cid)).size !== definition.steps.length) throw errUsage('Step CIDs must be unique');
}

// Check executable intent, not server-assigned record/UI IDs or display caches.
const VARIABLE_FIELDS = ['name', 'type', 'value', 'defaultValue', 'mandatory', 'reference', 'data_structure', 'scriptActive', 'script', 'scriptAsJsonString', 'children', 'complexObjectValue', 'maxsize', 'ref_qual', 'choices', 'defaultChoices', 'choiceOption', 'table', 'dependent_on', 'sys_class_name', 'extended', 'local', 'dynamic'];
function subset(expected, actual, path, mismatches) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length !== actual.length) { mismatches.push(path); return; }
    expected.forEach((v, i) => subset(v, actual[i], `${path}[${i}]`, mismatches));
  } else if (object(expected)) {
    if (!object(actual)) { mismatches.push(path); return; }
    for (const [key, value] of Object.entries(expected)) {
      if (key === 'uiUniqueId' || (typeof expected.name === 'string' && ['id', 'displayValue', 'display_value'].includes(key))) continue;
      subset(value, actual[key], `${path}.${key}`, mismatches);
    }
  } else if (expected !== actual) mismatches.push(path);
}
// Only these attribute keys are UI/generated metadata, not schema constraints.
const UI_ATTRIBUTES = new Set(['uiUniqueId', 'uiTypeLabel', 'uiType', 'element_mapping_provider']);
function semantic(value) {
  if (Array.isArray(value)) return value.map(semantic);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(k => [k, semantic(value[k])]));
  return value;
}
function variableField(variable, field) {
  const value = variable[field];
  if (field === 'children') return (value || []).map(variableIntent);
  if (field === 'mandatory' || field === 'scriptActive') return value ?? false;
  // Process Flow materializes empty defaults. Nonempty mappings/scripts never disappear.
  if (value === undefined || value === null || value === '' || (object(value) && !Object.keys(value).length)) return null;
  return value;
}
function variableIntent(variable) {
  return { ...Object.fromEntries(VARIABLE_FIELDS.map(f => [f, variableField(variable, f)])),
    attributes: Object.fromEntries(Object.entries(variable.attributes || {}).filter(([k]) => !UI_ATTRIBUTES.has(k))) };
}
function equalIntent(expected, actual) {
  return JSON.stringify(semantic(expected)) === JSON.stringify(semantic(actual));
}
function lifecycleDefault(variable, found) {
  const normalized = { ...variable };
  if (!variable.scriptActive && variable.script === null && equalIntent(found.script, {})) normalized.script = {};
  if (variable.name === '__dont_treat_as_error__' && variable.type === 'boolean' && variable.value === false && !variable.scriptActive && variable.maxsize === 0 && found.maxsize === 40) normalized.maxsize = 40;
  if (variable.name !== '__action_status__' || variable.type !== 'object' || variable.value !== '' || variable.complexObjectValue !== null || variable.scriptActive) return normalized;
  // Captured fresh status becomes a serialized EMPTY code/message object on PUT.
  try {
    const value = JSON.parse(found.value);
    const empty = { code: { $cv: { $c: 'java.lang.String', $v: '' } }, message: { $cv: { $c: 'java.lang.String', $v: '' } } };
    const schema = value.complexObjectSchema?.['FlowDesigner:FDACTIONSTATUS'];
    const facetKeys = ['uiTypeLabel', 'read_only', 'hint', 'uiType', 'default_value', 'label', 'action_error_output', 'mandatory', 'order', 'max_length', 'uiUniqueId', 'co_type_name', 'element_mapping_provider'];
    const emptyFacet = (facet, size, type) => {
      if (!object(facet) || !equalIntent(Object.keys(facet), ['SimpleMapFacet'])) return false;
      const fields = JSON.parse(facet.SimpleMapFacet);
      return Object.keys(fields).every(k => facetKeys.includes(k)) && fields.mandatory === 'false' && fields.default_value === '' && fields.max_length === String(size) && fields.uiType === type && fields.action_error_output === 'true';
    };
    const defaultSchema = equalIntent(Object.keys(value.complexObjectSchema || {}).sort(), ['FlowDesigner:FDACTIONSTATUS', 'FlowDesigner:FDACTIONSTATUS.$type_facets'])
      && equalIntent(Object.keys(schema || {}).sort(), ['code', 'code.$field_facets', 'message', 'message.$field_facets'])
      && emptyFacet(schema['code.$field_facets'], 40, 'integer') && emptyFacet(schema['message.$field_facets'], 4000, 'string')
      && emptyFacet(value.complexObjectSchema['FlowDesigner:FDACTIONSTATUS.$type_facets'], 65000, 'object');
    if (equalIntent(Object.keys(value).sort(), ['complexObject', 'complexObjectSchema', 'serializationFormat', 'version']) && value.version === '1.0' && value.serializationFormat === 'JSON' && defaultSchema && schema?.code === 'Integer' && schema?.message === 'String' && equalIntent(value.complexObject, empty)) normalized.value = found.value;
  } catch { /* Non-default values remain mismatches. */ }
  if (normalized.value === found.value && variable.maxsize === 0 && found.maxsize === 65000) normalized.maxsize = 65000;
  const emptyObject = { name: variable.name, value: null, scriptActive: false, script: null, scriptAsJsonString: null, parameter: null,
    children: (variable.children || []).map(child => ({ name: child.name, value: null, scriptActive: false, script: null, scriptAsJsonString: null, children: null, parameter: child })) };
  const statusIntent = node => {
    if (!object(node)) return node;
    return Object.fromEntries(Object.entries(node).filter(([key]) => !['id', 'displayValue', 'displayField'].includes(key)).map(([key, value]) => [key,
      key === 'parameter' && value ? variableIntent(value) : key === 'children' && Array.isArray(value) ? value.map(statusIntent) : value]));
  };
  if (equalIntent(statusIntent(emptyObject), statusIntent(found.complexObjectValue))) normalized.complexObjectValue = found.complexObjectValue;
  return normalized;
}
function variables(expected, actual, path, mismatches, inherited = new Set()) {
  if (!Array.isArray(actual) || expected.length !== actual.length) { mismatches.push(`${path}.length`); return; }
  for (const variable of expected) {
    const found = actual.find(v => v.name === variable.name);
    if (!found) { mismatches.push(`${path}.${variable.name}`); continue; }
    const intent = variableIntent(inherited.has(variable.name) ? lifecycleDefault(variable, found) : variable);
    const persisted = variableIntent(found);
    for (const field of [...VARIABLE_FIELDS, 'attributes']) {
      if (!equalIntent(intent[field], persisted[field])) mismatches.push(`${path}.${variable.name}.${field}`);
    }
  }
}
function verify(expected, actual, inherited) {
  const mismatches = [];
  for (const key of ['id', 'scope', 'name', 'description', 'internal_name', 'state', 'master_snapshot', 'latest_snapshot']) {
    if (Object.hasOwn(expected, key)) subset(expected[key], actual[key], key, mismatches);
  }
  for (const key of ['sysId', 'actionTypeId']) {
    const before = expected.action_status_metadata?.[key];
    const after = actual.action_status_metadata?.[key];
    // The first create PUT allocates the status row; later updates must retain it.
    const allocated = key === 'sysId' && inherited !== undefined && (before === '' || before === null || before === undefined)
      && typeof after === 'string' && /^[a-fA-F0-9]{32}$/.test(after);
    if (!allocated && (before !== after || (key === 'sysId' && inherited !== undefined && !before))) mismatches.push(`action_status_metadata.${key}`);
  }
  variables(expected.inputs, actual.inputs, 'inputs', mismatches);
  variables(expected.outputs, actual.outputs, 'outputs', mismatches, inherited);
  if (inherited === undefined) {
    for (const output of expected.outputs.filter(o => o.name.startsWith('__'))) {
      if (actual.outputs.find(o => o.name === output.name)?.id !== output.id) mismatches.push(`outputs.${output.name}.id`);
    }
  }
  if (actual.steps.length !== expected.steps.length) mismatches.push('steps.length');
  for (const step of expected.steps) {
    const found = actual.steps.find(s => s.cid === step.cid);
    if (!found) { mismatches.push(`steps.${step.cid}`); continue; }
    for (const key of ['cid', 'action', 'step_type', 'step_type_id', 'order', 'error_handling_type', 'quiescence']) {
      if (!equalIntent(step[key] ?? null, found[key] ?? null)) mismatches.push(`steps.${step.cid}.${key}`);
    }
    for (const key of ['inputs', 'outputs', 'extended_inputs', 'extended_outputs']) variables(step[key], found[key], `steps.${step.cid}.${key}`, mismatches);
  }
  if (mismatches.length) throw failure('action_verification_failed', `Persisted definition differs at: ${mismatches.join(', ')}`, { mismatches });
}
async function save(sdk, id, scope, definition, inherited) {
  let writeError;
  let returned;
  try {
    returned = await request(sdk, id, scope, '', 'PUT', definition);
  } catch (error) {
    // A timeout is ambiguous: reconcile once via reads, NEVER retry the PUT.
    if (!/timed?\s*out|timeout/i.test(error.message)) throw error;
    writeError = error;
  }
  const persisted = await getAction(sdk, id, scope);
  verify(definition, persisted, inherited);
  if (returned?.id !== undefined && returned.id !== id) throw failure('action_identity_mismatch', 'PUT returned a different action ID');
  if (returned?.scope !== undefined && returned.scope !== scope) throw failure('action_identity_mismatch', 'PUT returned a different action scope');
  if (Array.isArray(returned?.inputs) && Array.isArray(returned?.outputs) && Array.isArray(returned?.steps)) verify(definition, returned, inherited);
  return { sys_id: id, scope, status: writeError ? 'persisted_after_timeout' : 'verified',
    http_write_confirmed: !writeError, definition: persisted };
}
export async function updateAction(sdk, id, providedScope, definition) {
  validateDefinition(definition, id, providedScope);
  const scope = await actionScope(sdk, id, providedScope);
  validateDefinition(definition, id, scope);
  // A full read document is required, so table fields cannot erase lifecycle defaults.
  for (const key of ['scope', 'name', 'state', 'master_snapshot', 'latest_snapshot', 'action_status_metadata']) {
    if (!Object.hasOwn(definition, key)) throw errUsage(`Full update definition requires ${key}; use actions definition first`);
  }
  const current = await getAction(sdk, id, scope);
  const omitted = Object.keys(current).filter(key => !Object.hasOwn(definition, key));
  if (omitted.length) throw errUsage(`Full update definition is missing ${omitted.join(', ')}; use actions definition first`);
  for (const key of ['state', 'master_snapshot', 'latest_snapshot']) {
    if (definition[key] !== current[key]) throw errUsage(`Do not replace target-owned ${key}`);
  }
  for (const key of ['sysId', 'actionTypeId']) {
    if (definition.action_status_metadata?.[key] !== current.action_status_metadata?.[key]) {
      throw errUsage(`Do not replace target-owned action_status_metadata.${key}`);
    }
  }
  const currentReserved = current.outputs.filter(o => o.name.startsWith('__'));
  const suppliedReserved = definition.outputs.filter(o => o.name.startsWith('__'));
  if (currentReserved.length !== suppliedReserved.length || currentReserved.some(o => {
    const supplied = suppliedReserved.find(v => v.name === o.name);
    return !supplied || supplied.id !== o.id;
  })) {
    throw errUsage('Do not replace or remove target-owned reserved output IDs');
  }
  try { return await save(sdk, id, scope, definition); }
  catch (error) {
    throw failure(error.code?.startsWith('action_') ? error.code : 'action_update_failed', `Action ${id} update is unverified: ${error.message}`, {
      ...error.details, sys_id: id, scope, status: 'unverified', cleanup: 'explicit',
    });
  }
}
export async function createAction(sdk, scope, source) {
  validateDefinition(source, undefined, scope);
  for (const step of source.steps) {
    if (['step_id', 'action'].some(key => step[key] !== undefined && step[key] !== null && step[key] !== '')) throw errUsage('Create requires new steps with blank step_id and action; do not reuse persisted Step IDs');
  }
  const name = source.name || source.displayName;
  if (typeof name !== 'string' || !name.trim()) throw errUsage('Create requires a definition name');
  await validateScope(sdk, scope);
  const parentData = { name, description: source.description || '', sys_scope: scope };
  if (source.internal_name !== undefined) parentData.internal_name = source.internal_name;
  let parent;
  try { parent = await sdk.create(ACTION_TABLE, parentData); }
  catch (error) {
    throw failure('action_create_partial', `Parent creation is unverified: ${error.message}. Inspect actions named '${name}' before retrying.`, {
      scope, name, status: 'unknown_parent', cleanup: 'explicit',
    });
  }
  const id = raw(parent?.sys_id);
  if (!id) throw failure('action_create_partial', 'Parent creation returned no action ID; inspect the action table before retrying', { status: 'unknown_parent', cleanup: 'explicit' });
  try {
    token(id, 'Created action ID');
    await actionScope(sdk, id, scope);
    const fresh = await metadata(sdk, id, scope);
    // Keep this parent's lifecycle/status objects and reserved output IDs.
    const reserved = (fresh.outputs || []).filter(o => o.name?.startsWith('__'));
    const definition = { ...fresh, name, displayName: name, description: parentData.description,
      inputs: source.inputs, outputs: [...reserved, ...source.outputs.filter(o => !o.name?.startsWith('__'))],
      steps: source.steps.map(step => ({ ...step, action: id })) };
    if (source.internal_name !== undefined) definition.internal_name = source.internal_name;
    validateDefinition(definition, id, scope);
    return await save(sdk, id, scope, definition, new Set(reserved.filter(o => ['__action_status__', '__dont_treat_as_error__'].includes(o.name)).map(o => o.name)));
  } catch (error) {
    throw failure('action_create_partial', `Action parent ${id} exists; full definition is unverified: ${error.message}. No automatic cleanup was performed.`, {
      ...error.details, sys_id: id, scope, status: 'parent_created_definition_unverified', cleanup: 'explicit',
    });
  }
}

function waitTimeout(context, state) {
  return failure('action_test_timeout', `Action test ${context} exceeded --timeout; state=${state}. Execution was not cancelled.`, { context, state, status: 'timeout' });
}
export async function testAction(sdk, id, providedScope, suppliedDefinition, outputMap = {}, opts = {}) {
  if (!object(outputMap)) throw errUsage('--output-map must be a JSON object of input names to values');
  const timeout = opts.timeout ?? 60;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 3600) throw errUsage('--timeout must be between 0 and 3600 seconds, exclusive of 0');
  if (suppliedDefinition !== undefined) validateDefinition(suppliedDefinition, id, providedScope);
  const scope = await actionScope(sdk, id, providedScope);
  const definition = suppliedDefinition ?? await getAction(sdk, id, scope);
  validateDefinition(definition, id, scope);
  const dispatched = await request(sdk, id, scope, '/test', 'POST', {
    action: definition, outputMap, runOnThread: opts.runOnThread ?? true, tracingEnabled: opts.tracingEnabled ?? false,
  });
  if (!successCode(dispatched.errorCode) || dispatched.errorMessage) throw failure('action_test_dispatch_failed', dispatched.errorMessage || 'Test dispatch did not return errorCode 0');
  const context = token(dispatched.data, 'Test context ID');
  if (!opts.wait) return { context, state: 'DISPATCHED', status: 'dispatched', outputs: null };
  const deadline = Date.now() + timeout * 1000;
  let state = 'UNKNOWN';
  const expected = definition.outputs.filter(o => !o.name.startsWith('__')).map(o => o.name);
  const bounded = async (url) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw waitTimeout(context, state);
    try { return await sdk.request(url, { method: 'GET', timeout: Math.min(sdk.timeout || 30000, remaining) }); }
    catch (error) {
      if (Date.now() >= deadline || /timed?\s*out|timeout/i.test(error.message)) throw waitTimeout(context, state);
      throw failure('action_test_read_failed', `Cannot read test ${context} ${state}: ${error.message}`, { context, state, status: 'read_failed' });
    }
  };
  while (Date.now() < deadline) {
    const response = await bounded(`${sdk.baseURL}/api/now/table/sys_flow_context/${context}`);
    const record = response?.result;
    if (!record || raw(record.sys_id) !== context) throw failure('action_test_read_failed', `Test context ${context} is missing or unreadable`, { context, state, status: 'read_failed' });
    state = String(raw(record.state) || 'UNKNOWN').toUpperCase();
    const message = raw(record.error_message);
    if (message || ['ERROR', 'FAILED', 'CANCELLED', 'CANCELED', 'TERMINATED'].includes(state)) {
      throw failure('action_test_failed', `Test ${context} ended ${state}: ${message || 'terminal failure'}`, { context, state, status: 'failed' });
    }
    if (state === 'COMPLETE') {
      if (!Object.hasOwn(record, 'error_message')) throw failure('action_test_read_failed', `Test ${context} COMPLETE but error_message is unreadable`, { context, state, status: 'read_failed' });
      const query = new URLSearchParams({ sysparm_query: `context=${context}^type=output`, sysparm_fields: 'context,type,value', sysparm_display_value: 'false' });
      const runtime = await bounded(`${sdk.baseURL}/api/now/table/sys_flow_runtime_value?${query}`);
      const values = Object.create(null);
      if (!Array.isArray(runtime?.result)) throw failure('action_test_outputs_missing', `Test ${context} output records are missing`, { context, state, status: 'outputs_missing' });
      try {
        for (const row of runtime.result) {
          if (raw(row.context) !== context || raw(row.type) !== 'output') throw new Error('Runtime output belongs to a different context/type');
          const map = JSON.parse(raw(row.value));
          if (!object(map)) throw new Error('Runtime value is not a map');
          Object.assign(values, map);
        }
      } catch (error) {
        throw failure('action_test_outputs_invalid', `Test ${context} has invalid runtime outputs: ${error.message}`, { context, state, status: 'outputs_invalid' });
      }
      const missing = expected.filter(name => values[name]?.hasValue !== true || !Object.hasOwn(values[name], 'value'));
      if (missing.length) throw failure('action_test_outputs_missing', `Test ${context} COMPLETE but missing actual outputs: ${missing.join(', ')}`, { context, state, status: 'outputs_missing', missing });
      const outputs = Object.fromEntries(Object.entries(values).filter(([, v]) => v?.hasValue === true && Object.hasOwn(v, 'value')).map(([name, v]) => [name, { value: v.value, displayValue: v.displayValue, hasValue: v.hasValue }]));
      return { context, state, status: 'complete', outputs };
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now()))));
  }
  throw waitTimeout(context, state);
}
