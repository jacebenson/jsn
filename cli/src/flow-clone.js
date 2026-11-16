import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AppError, CodeAPI, errUsage } from './errors.js';
import { assertSafeExactMatch } from './helpers.js';
import { resolveRecord, unwrapSysId, isSysId } from './resolve-record.js';
import { readProcessFlow, readCurrentUpdateSet } from './flow-create.js';
import { readEffectiveUpdateSet } from './context.js';
import { verifyCopyCapture } from './flow-clone-capture.js';

const raw = value => value && typeof value === 'object' && 'value' in value ? value.value : value;
const collections = ['triggerInstances', 'actionInstances', 'inputs', 'outputs'];
// Native copy handles allocation. Unknown graph contracts must be rejected BEFORE
// asking it to allocate, not reconstructed through the create-manifest adapter.
const unsupported = ['flowLogicInstances', 'subFlowInstances', 'flowVariables', 'flowCatalogVariables', 'stages', 'connection_configurations', 'deletedFlowLogicInstances', 'nonCriticalErrors'];
const contextual = ['id', 'name', 'copiedFrom', 'internalName', 'flowCatalogVariableModelId', 'versionRecordId', 'version', 'created', 'updated', 'updatedBy', 'security', 'canWriteProtection', 'userCanRead', 'isFlowEntitled', 'userHasRolesAssignedToFlow'];
const preserved = ['masterSnapshotId', 'deleted', 'description', 'scope', 'scopeDisplayName', 'scopeName', 'scopeLogo', 'scopeProtectionPolicyReadOnly', 'status', 'active', 'protection', 'type', 'annotation', 'natlang', 'category', 'remoteTriggerSysId', 'access', 'serviceCatalogCallable', 'clientCallable', 'runAs', 'domainName', 'domainId', 'compilerBuild', 'runWithRoles', 'allowHighSecurityRoles', 'pharmacy', 'startingIndexOfErrorHandlingInstances', 'flowPriority', 'attributes', 'authoredOnReleaseVersion', 'generationSource', 'displayNameAfterPreview', 'substatus', 'flowEngineVersion', 'masterSnapshot', 'labelCacheAsJsonString', 'latestSnapshot', 'snapshot', 'isPublished', 'savedAsJson', 'jsonSnapshot'];
const triggerKeys = ['id', 'flowSysId', 'remoteSysId', 'name', 'inputs', 'outputs', 'displayText', 'deleted', 'metadata', 'comment', 'type', 'triggerDefinitionId', 'publishedVersion', 'userCanRead', 'triggerType', 'hasDynamicOutputs'];
const actionKeys = ['id', 'flowSysId', 'order', 'displayText', 'uiUniqueIdentifier', 'deleted', 'metadata', 'parent', 'comment', 'generationSource', 'uiComponentIndex', 'actionTypeSysId', 'inputs', 'actionType', 'parentActionTypeId', 'compiledSnapshot', 'aliasIds', 'internalName', 'name', 'type', 'snapshot'];
const pill = /^\{\{([a-f0-9]{32}|[a-f0-9-]{36})(\.[A-Za-z0-9_.]+)\}\}$/;
export const flowCloneDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function refuse(message) { throw errUsage(`${message}. No clone allocated.`); }
function empty(value) { return Array.isArray(value) ? value.length === 0 : value && typeof value === 'object' && Object.keys(value).length === 0; }
function knownKeys(value, allowed, path) {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) refuse(`Unverified provider fields at ${path}: ${unknown.join(', ')}`);
}
function variableEntries(items) { return items.flatMap(item => [item, ...variableEntries(item.children || [])]); }
function owned(source) {
  return [...source.triggerInstances, ...source.actionInstances, ...variableEntries(source.inputs), ...variableEntries(source.outputs)];
}
function validateValues(value, path = 'definition') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) return value.forEach((item, index) => validateValues(item, `${path}[${index}]`));
  // A complete typed value pill is a known reference. Embedded pills, scripts
  // containing pills and opaque binding encodings are not safe to certify.
  if (typeof value.value === 'string' && value.value.includes('{{')) {
    if (value.scriptActive || !pill.test(value.value)) refuse(`Unsupported embedded/script binding at ${path}`);
  }
  for (const [key, child] of Object.entries(value)) validateValues(child, `${path}.${key}`);
}
export function validateCloneSource(source) {
  if (!source || source.type !== 'flow' || !isSysId(source.id)) refuse('A readable Flow definition is required');
  if (source.active !== false || source.status !== 'draft' || source.deleted !== false) refuse('Only inactive, nondeleted Draft sources are supported');
  if (source.security?.can_read !== true || source.security?.can_write !== true) refuse('Source must explicitly permit read and write');
  for (const field of ['scope', 'domainId', 'domainName', 'access', 'protection', 'runAs', 'runWithRoles', 'description']) {
    if (!Object.hasOwn(source, field)) refuse(`Source security/property inventory is missing ${field}`);
  }
  knownKeys(source, [...collections, ...unsupported, ...contextual, ...preserved], 'flow');
  for (const key of unsupported) if (source[key] !== undefined && !empty(source[key])) refuse(`Clone verification does not yet support nonempty ${key}`);
  if (source.startingIndexOfErrorHandlingInstances !== -1) refuse('Error-handler graph cloning is not yet verified');
  for (const key of collections) if (!Array.isArray(source[key])) refuse(`Unreadable ${key}`);
  if (source.triggerInstances.length !== 1) refuse('Exactly one record trigger is required');
  for (const trigger of source.triggerInstances) {
    knownKeys(trigger, triggerKeys, 'trigger');
    if (!['record_create', 'record_update', 'record_create_or_update'].includes(trigger.type) || trigger.deleted !== false) refuse('Unsupported trigger lifecycle/family');
    if (trigger.remoteSysId) refuse('Remote trigger cloning is not verified');
  }
  for (const action of source.actionInstances) {
    knownKeys(action, actionKeys, 'action');
    if (action.parent || action.compiledSnapshot || action.snapshot || action.aliasIds?.length || action.deleted !== false) refuse('Nested/runtime/aliased action cloning is not verified');
    if (!isSysId(action.actionTypeSysId) || action.actionType?.state !== 'published') refuse('Action must reference a published reusable definition');
  }
  if (source.masterSnapshotId || source.latestSnapshot || source.masterSnapshot || source.snapshot || source.isPublished || source.jsonSnapshot) refuse('Source has runtime snapshot state');
  for (const item of [...source.triggerInstances, ...source.actionInstances]) {
    if (!isSysId(item.id) || item.flowSysId !== source.id) refuse('Component identity/ownership is incomplete');
  }
  if (!isSysId(source.versionRecordId)) refuse('Source has no readable saved version pointer');
  const identities = new Set([source.id]);
  for (const item of owned(source)) {
    if (!item.id) continue; // nested anonymous schema children have no identity
    if (!isSysId(item.id) || identities.has(item.id)) refuse('Ambiguous owned component identity');
    identities.add(item.id);
    if (item.flowSysId !== undefined && item.flowSysId !== source.id) refuse('Invalid component ownership');
    if (item.uiUniqueIdentifier) {
      if (identities.has(item.uiUniqueIdentifier)) refuse('Duplicate UI identity');
      identities.add(item.uiUniqueIdentifier);
    }
  }
  if (!isSysId(source.flowCatalogVariableModelId) || identities.has(source.flowCatalogVariableModelId)) refuse('Missing or reused catalog model identity');
  validateValues(source);
  return { collections, unsupported, preserved, contextual };
}

// Identity maps apply only to owned identity/ownership paths and complete typed
// input pills. User scripts, conditions, arbitrary keys and literal IDs stay exact.
export function verifyClonedFlow(source, destination, name) {
  validateCloneSource(source);
  try { validateCloneSource(destination); }
  catch (cause) { throw new Error(`Destination definition invalid: ${cause.message.replace(/\. No clone allocated\.$/, '')}`); }
  if (destination.name !== name || destination.scope !== source.scope || destination.copiedFrom !== source.id) throw new Error('Clone identity/name/scope/provenance mismatch');
  const before = owned(source), after = owned(destination);
  if (before.length !== after.length) throw new Error('Clone owned component count changed');
  const old = new Set([source.id, source.flowCatalogVariableModelId, ...before.flatMap(item => [item.id, item.uiUniqueIdentifier]).filter(Boolean)]);
  const fresh = new Set();
  const mapping = new Map();
  function allocate(a, b) {
    if (!a) { if (b) throw new Error('Unexpected owned identity'); return; }
    if (!b || old.has(b) || fresh.has(b)) throw new Error('Clone reused or omitted an owned identity');
    fresh.add(b); mapping.set(a, b);
  }
  allocate(source.id, destination.id);
  allocate(source.flowCatalogVariableModelId, destination.flowCatalogVariableModelId);
  before.forEach((item, index) => { allocate(item.id, after[index].id); allocate(item.uiUniqueIdentifier, after[index].uiUniqueIdentifier); });
  const ref = value => mapping.get(value) || value;
  function values(value) {
    if (Array.isArray(value)) return value.map(values);
    if (!value || typeof value !== 'object') return value;
    const result = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, values(child)]));
    if (!value.scriptActive && typeof value.value === 'string' && pill.test(value.value)) {
      result.value = value.value.replace(pill, (_all, id, path) => `{{${ref(id)}${path}}}`);
      if (value.displayValue === value.value) result.displayValue = result.value;
    }
    return result;
  }
  function component(item) {
    const result = values(item);
    for (const key of ['id', 'uiUniqueIdentifier', 'flowSysId']) if (Object.hasOwn(item, key)) result[key] = ref(item[key]);
    if (item.children) result.children = item.children.map(component);
    return result;
  }
  for (const key of collections) {
    if (!isDeepStrictEqual(source[key].map(component), destination[key])) throw new Error(`Clone changed or miswired ${key}`);
  }
  for (const key of [...preserved, ...unsupported]) if (!isDeepStrictEqual(source[key], destination[key])) throw new Error(`Clone did not preserve ${key}`);
  return { verified: true, identity_count: mapping.size, inventory: { preserved, regenerated: ['id', 'flowCatalogVariableModelId', 'component.id', 'component.uiUniqueIdentifier'], contextual, unsupported_nonempty: unsupported } };
}

async function readSavedCloneVersion(sdk, flow) {
  const rows = await sdk.list('sys_hub_flow_version', new URLSearchParams({ sysparm_query: `sys_id=${flow.versionRecordId}^flow=${flow.id}`, sysparm_limit: '2', sysparm_fields: 'sys_id,flow,payload' }));
  if (!Array.isArray(rows) || rows.length !== 1 || raw(rows[0].flow) !== flow.id || raw(rows[0].sys_id) !== flow.versionRecordId) throw new Error('Exact saved version is not readable');
  const payload = JSON.parse(raw(rows[0].payload));
  if (payload?.id !== flow.id || payload.name !== flow.name || payload.scope !== flow.scope) throw new Error('Saved version identity/name/scope mismatch');
  // Independently link each saved component/value to the current definition.
  // Parameter schemas differ between native serialized and GET forms; the full
  // serialized schemas are compared source-to-destination below, not flattened.
  const valueTree = values => (values || []).map(value => ({ name: value.name, value: value.value, scriptActive: value.scriptActive, children: valueTree(value.children) }));
  for (const key of collections) {
    if (!Array.isArray(payload[key]) || payload[key].length !== flow[key].length) throw new Error(`Saved version has incomplete ${key}`);
    payload[key].forEach((item, index) => {
      const current = flow[key][index];
      if (item.id !== current.id || item.flowSysId !== current.flowSysId || !isDeepStrictEqual(valueTree(item.inputs), valueTree(current.inputs))) throw new Error(`Saved version has stale identity/input values in ${key}`);
    });
  }
  return payload;
}

export function verifyClonedVersions(source, destination) {
  const mapping = new Map([[source.id, destination.id], [source.flowCatalogVariableModelId, destination.flowCatalogVariableModelId]]);
  for (const key of collections) {
    const before = key === 'inputs' || key === 'outputs' ? variableEntries(source[key]) : source[key];
    const after = key === 'inputs' || key === 'outputs' ? variableEntries(destination[key]) : destination[key];
    if (before.length !== after.length) throw new Error(`Saved version changed ${key}`);
    before.forEach((item, index) => { for (const field of ['id', 'uiUniqueIdentifier']) if (item[field]) mapping.set(item[field], after[index][field]); });
  }
  function translate(value) {
    if (Array.isArray(value)) return value.map(translate);
    if (!value || typeof value !== 'object') return value;
    const result = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, translate(child)]));
    if (!value.scriptActive && typeof value.value === 'string' && pill.test(value.value)) {
      result.value = value.value.replace(pill, (_all, id, path) => `{{${mapping.get(id) || id}${path}}}`);
      if (value.displayValue === value.value) result.displayValue = result.value;
    }
    return result;
  }
  function component(item) {
    const result = translate(item);
    for (const field of ['id', 'uiUniqueIdentifier', 'flowSysId']) if (item[field]) result[field] = mapping.get(item[field]) || item[field];
    if (item.children) result.children = item.children.map(component);
    return result;
  }
  const expected = translate(source);
  for (const key of collections) expected[key] = source[key].map(component);
  // These are version-level provenance/permission fields, never graph content.
  const omitted = new Set(contextual);
  const stable = value => Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.has(key)));
  if (!isDeepStrictEqual(stable(expected), stable(destination))) throw new Error('Saved version content/schema was not preserved under the explicit identity map');
  return true;
}

async function assertUnusedName(sdk, scope, name) {
  const rows = await sdk.list('sys_hub_flow', new URLSearchParams({ sysparm_query: `name=${name}^sys_scope=${scope}`, sysparm_limit: '1', sysparm_fields: 'sys_id,name,sys_scope' }));
  if (!Array.isArray(rows)) refuse('Collision lookup was unreadable');
  if (rows.length) refuse(`A flow named ${JSON.stringify(name)} already exists in the source scope; no overwrite`);
}
export async function prepareFlowClone(sdk, instance, identifier, options = {}) {
  try {
    assertSafeExactMatch(identifier);
    const record = await resolveRecord(sdk, { table: 'sys_hub_flow', identifier, matchField: 'name', resource: 'Flow', fields: ['sys_scope', 'name', 'active', 'status'] });
    const id = unwrapSysId(record), scope = raw(record.sys_scope);
    if (!isSysId(id) || !(scope === 'global' || isSysId(scope))) refuse('Unreadable native source scope or identity');
    const source = await readProcessFlow(sdk, instance, id, scope);
    if (source.id !== id || source.scope !== scope) refuse('Source definition identity/scope mismatch');
    validateCloneSource(source);
    if (!options.name && !options.interactive) refuse('--name is required for automation');
    const name = options.name ?? `${source.name} copy`;
    if (typeof name !== 'string' || !name.trim()) refuse('--name must be nonempty');
    assertSafeExactMatch(name);
    await assertUnusedName(sdk, scope, name);
    const saved_version = await readSavedCloneVersion(sdk, source);
    return { source, scope, name, source_digest: flowCloneDigest(source), saved_version, version_digest: flowCloneDigest(saved_version) };
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError(CodeAPI, `Clone preflight failed: ${cause.message}`, 'No clone allocated.', 0, cause);
  }
}

export async function cloneFlow(sdk, instance, plan, { capturePolls = 21, pollDelay = 250 } = {}) {
  let id, stage = 'preflight';
  let allocationAttempted = false;
  try {
    validateCloneSource(plan.source);
    if (flowCloneDigest(plan.source) !== plan.source_digest) refuse('Clone plan changed');
    await assertUnusedName(sdk, plan.scope, plan.name);
    const current = await readCurrentUpdateSet(sdk), effective = await readEffectiveUpdateSet(sdk);
    const setId = raw(current?.sys_id || current?.sysId);
    if (!isSysId(setId) || raw(current?.state) !== 'in progress' || raw(current?.name) === 'Default' || effective.sys_id !== setId) refuse('Select a named in-progress update set and align the effective session before cloning');
    // No session context writes. Caller selection must already be aligned.
    const sourceBefore = await readProcessFlow(sdk, instance, plan.source.id, plan.scope);
    if (flowCloneDigest(sourceBefore) !== plan.source_digest) refuse('Source changed after confirmation');
    if (flowCloneDigest(plan.saved_version) !== plan.version_digest || flowCloneDigest(await readSavedCloneVersion(sdk, sourceBefore)) !== plan.version_digest) refuse('Source saved version changed after confirmation');
    stage = 'native_copy'; allocationAttempted = true;
    // Source-confirmed Designer contract. Exactly one allocation, no fallbacks.
    const response = await sdk.request(`${instance}/api/now/processflow/flow/${plan.source.id}/copy?sysparm_transaction_scope=${encodeURIComponent(plan.scope)}`, { method: 'POST', body: JSON.stringify({ name: plan.name, scope: plan.scope }) });
    const allocated = response?.result?.data;
    if (!isSysId(allocated) || allocated === plan.source.id) throw new Error('Provider returned no fresh clone identity');
    id = allocated;
    stage = 'definition_readback';
    const flow = await readProcessFlow(sdk, instance, id, plan.scope);
    const graph = verifyClonedFlow(plan.source, flow, plan.name);
    stage = 'saved_version';
    if (!isSysId(flow.versionRecordId) || flow.versionRecordId === plan.source.versionRecordId) throw new Error('No fresh saved version pointer');
    const savedVersion = await readSavedCloneVersion(sdk, flow);
    verifyClonedVersions(plan.saved_version, savedVersion);
    stage = 'update_set_capture';
    let captures;
    for (let attempt = 0; attempt < capturePolls; attempt++) {
      const rows = await sdk.list('sys_update_xml', new URLSearchParams({ sysparm_query: `update_set=${setId}^name=sys_hub_flow_${id}`, sysparm_limit: '2', sysparm_fields: 'sys_id,name,update_set,action,payload' }));
      if (!Array.isArray(rows)) throw new Error('Unreadable update-set capture');
      if (rows.length === 1 && raw(rows[0].name) === `sys_hub_flow_${id}` && raw(rows[0].update_set) === setId && raw(rows[0].action) === 'INSERT_OR_UPDATE' && verifyCopyCapture(raw(rows[0].payload), id, flow.versionRecordId)) { captures = rows; break; }
      if (attempt + 1 < capturePolls) await new Promise(resolve => setTimeout(resolve, pollDelay));
    }
    if (!captures) throw new Error('Exact new parent/version XML capture not verified within bounded read polling');
    stage = 'source_and_context_preservation';
    const sourceAfter = await readProcessFlow(sdk, instance, plan.source.id, plan.scope);
    if (flowCloneDigest(sourceAfter) !== plan.source_digest) throw new Error('Source digest changed during clone');
    const finalSet = await readCurrentUpdateSet(sdk), finalEffective = await readEffectiveUpdateSet(sdk);
    if (!isDeepStrictEqual(current, finalSet) || !isDeepStrictEqual(effective, finalEffective)) throw new Error('Capture context changed during clone');
    return { flow, source: { id: plan.source.id, unchanged: true, before_digest: plan.source_digest, after_digest: flowCloneDigest(sourceAfter) }, graph, version: { id: flow.versionRecordId, flow: id }, capture: { update_set: setId, parent: id, version: flow.versionRecordId, records: captures.map(row => raw(row.sys_id)) }, context_unchanged: true, published: false, activated: false, executed: false };
  } catch (cause) {
    if (!allocationAttempted && cause instanceof AppError) throw cause;
    throw new AppError(CodeAPI, `Flow clone ${id ? `allocated ${id}, verification failed` : allocationAttempted ? 'allocation outcome uncertain' : 'failed before allocation'} at ${stage}: ${cause.message}`, `${id ? `Inspect flows show ${id}.` : allocationAttempted ? `Reconcile source ${plan.source.id} and name ${JSON.stringify(plan.name)} before retrying.` : 'No clone allocated.'} No automatic retry, cleanup, publish or execution.`, 0, cause);
  }
}
