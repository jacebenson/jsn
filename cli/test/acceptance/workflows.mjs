import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectUpdateSetXML } from '../../src/update-set-xml.js';
import { raw, rows, blocked, requirePdi, runName, command, readOne, equalFields, register, dictionary, assertCapture, denied } from './resources.mjs';

const id = () => randomBytes(16).toString('hex');
const deleteArgs = (table, recordId) => ['records', 'delete', '--table', table, '--sys-id', recordId, '--force', '--json'];
const own = (ctx, table, recordId, kind, dependencies = []) => register(ctx, table, recordId, kind, dependencies, deleteArgs(table, recordId));
const escapeXml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export async function poll(read, complete, { attempts = 30, intervalMs = 1000 } = {}) {
  assert.ok(Number.isInteger(attempts) && attempts > 0 && attempts <= 60);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await read();
    for (const row of rows(result)) {
      const state = String(raw(row?.state) ?? '').toUpperCase();
      assert.ok(!['ERROR', 'FAILED', 'FAILURE', 'CANCELLED', 'CANCELED'].includes(state), `asynchronous operation entered ${state}`);
    }
    if (complete(result)) return result;
    if (attempt + 1 < attempts) await delay(intervalMs);
  }
  assert.fail(`provider readback did not converge within ${attempts} bounded attempts; no write retried`);
}

async function picker(ctx, kind) {
  return (await command(ctx, ['rest', `/api/now/ui/concoursepicker/${kind}`, '--method', 'GET', '--json']))?.result?.current;
}
async function restorableUpdateSet(ctx, snapshot) {
  // `updatesets set` takes a NAME, not a sys_id, and also selects its scope.
  // Refuse duplicate names even across scopes rather than rely on the CLI's
  // first-match/fallback rules or a bounded sample to recover exact identity.
  const record = await readOne(ctx, 'sys_update_set', snapshot.updateset, ['sys_id', 'name', 'application', 'state']);
  const name = raw(record.name);
  if (typeof name !== 'string' || !name.trim() || name.length > 200 || /[\\^=<>~!,*\r\n]/.test(name) ||
      raw(record.application) !== snapshot.application || raw(record.state) !== 'in progress') blocked('Original update-set name, scope or state cannot be restored exactly; no context writes performed');
  const matches = await ctx.read('sys_update_set', { query: `name=${name}`, fields: ['sys_id', 'name', 'application', 'state'], limit: 2 });
  if (!Array.isArray(matches) || matches.length !== 1 || raw(matches[0].sys_id) !== snapshot.updateset ||
      raw(matches[0].name) !== name || raw(matches[0].application) !== snapshot.application || raw(matches[0].state) !== 'in progress') blocked('Original update-set name is ambiguous or unreadable; no context writes performed');
  return name;
}
async function savePrivate(ctx, name, value) {
  await fs.mkdir(ctx.outputDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(ctx.outputDir, name), value, { flag: 'wx', mode: 0o600 });
}
async function retainFlows(ctx) {
  if (ctx.state.get('workflows.allowRetainedFlows') !== true) blocked('Flow deletion is explicitly unimplemented in JSN. Flow mutation requires explicit retained-fixture/UI-cleanup approval; no guessed Table API graph deletion.');
}
async function createFlow(ctx, manifest) {
  const created = await command(ctx, ['flows', 'create', '--data', JSON.stringify(manifest), '--json']);
  const flowId = created?.flow?.id;
  // Native flow deletion is a genuine product gap. Null cleanup never means done.
  await register(ctx, 'sys_hub_flow', flowId, 'flow:manual-designer-cleanup-required', [ctx.state.get('workflows.context').captureId], null);
  const flow = await readOne(ctx, 'sys_hub_flow', flowId, ['sys_id', 'name', 'active', 'status']);
  equalFields(flow, { name: manifest.name, active: false });
  const triggerId = created.trigger?.id;
  await register(ctx, 'sys_hub_trigger_instance_v2', triggerId, 'flow-component:manual-designer-cleanup-required', [flowId], null);
  assert.equal(created.actions?.length, manifest.actions.length, 'flow did not return every created action identity');
  for (const action of created.actions) await register(ctx, 'sys_hub_action_instance', raw(action.sys_id ?? action.sysId ?? action.id), 'flow-action:manual-designer-cleanup-required', [flowId], null);
  await register(ctx, 'sys_hub_flow_version', raw(created.version?.sys_id), 'flow-autosave:manual-designer-cleanup-required', [flowId], null);
  // Never infer that unenumerated provider autosaves/snapshots are absent.
  ctx.state.set(`workflows.flow.${flowId}`, { flowId, definition: created });
  return flowId;
}

const context = {
  id: 'workflows.context', title: 'Snapshot application/session and select a dedicated owned capture set',
  commandPaths: ['scopes set', 'updatesets create', 'updatesets set', 'rest'],
  sources: ['cli/src/context.js', 'cli/src/mutation-context.js', 'cli/src/commands/updatesets.js', 'cli/src/commands/scopes.js'],
  modes: ['pdi'], mutates: true, requires: [],
  async run(ctx) {
    requirePdi(ctx);
    const application = await picker(ctx, 'application');
    const updateset = await picker(ctx, 'updateset');
    if (typeof application !== 'string' || !/^(global|[a-f0-9]{32})$/.test(application) || !/^[a-f0-9]{32}$/.test(updateset?.sysId ?? '')) blocked('Original effective application/update-set cannot be restored exactly; no context writes performed');
    const snapshot = { application, updateset: updateset.sysId };
    await restorableUpdateSet(ctx, snapshot);
    await savePrivate(ctx, 'workflow-context.json', JSON.stringify(snapshot));
    ctx.state.set('workflows.originalContext', snapshot);
    const name = runName(ctx, 'capture');
    const created = await command(ctx, ['updatesets', 'create', '--name', name, '--scope', 'global', '--json']);
    const captureId = raw(created?.sys_id);
    await own(ctx, 'sys_update_set', captureId, 'capture-set');
    ctx.state.set('workflows.context', { captureId, scope: 'global', name });
    // Create selects its capture set already. Verify independently; a partial
    // create/selection failure must not trigger a second write or allocation.
    await assertCapture(ctx);
    assert.equal(await picker(ctx, 'application'), 'global');
    return { verified: ['context-snapshot', 'capture-create', 'session-selection'] };
  },
  async cleanup(ctx) {
    const snapshot = ctx.state.get('workflows.originalContext');
    if (!snapshot) return;
    if (ctx.state.get('writes.unresolved') || ctx.state.get('cleanup.unresolvedChildren')) blocked('Unresolved writes or children; retain capture context for read-only reconciliation');
    const name = await restorableUpdateSet(ctx, snapshot);
    // Runner must invoke this AFTER artifact cleanup: deletion is captured only
    // in our dedicated set, never in the user's restored working set/Default.
    await command(ctx, ['scopes', 'set', snapshot.application, '--json']);
    await command(ctx, ['updatesets', 'set', name, '--json']);
    assert.equal(await picker(ctx, 'application'), snapshot.application, 'application restoration failed');
    assert.equal((await picker(ctx, 'updateset'))?.sysId, snapshot.updateset, 'update-set restoration failed');
    ctx.state.delete('workflows.context');
  },
};

const updateSetTransfer = {
  id: 'workflows.update-set-transfer', title: 'Owned XML import → preview → commit → independently verify property',
  commandPaths: ['updatesets import', 'updatesets preview', 'updatesets problems', 'updatesets commit'],
  sources: ['cli/src/commands/updatesets.js', 'cli/src/update-set-xml.js', 'cli/src/update-set-apply.js', 'cli/src/sdk.js'],
  modes: ['pdi'], mutates: true, requires: ['workflows.context'],
  async run(ctx) {
    const { captureId } = await assertCapture(ctx);
    const setId = id(), sourceId = id(), memberId = id(), propertyId = id();
    const name = runName(ctx, 'transfer');
    const property = { name: `${name}_property`, value: ctx.runKey, description: name };
    await dictionary(ctx, 'sys_properties', property);
    // Real native update-set XML, not a fabricated remote API or eval workaround.
    // Every target ID is generated locally, checked absent, then checkpointed
    // before import/commit can create dependent records.
    const payload = `<record_update table="sys_properties"><sys_properties action="INSERT_OR_UPDATE"><sys_id>${propertyId}</sys_id><name>${property.name}</name><value>${escapeXml(property.value)}</value><description>${name}</description><type>string</type><sys_scope>global</sys_scope></sys_properties></record_update>`;
    const xml = `<unload><sys_remote_update_set action="INSERT_OR_UPDATE"><sys_id>${setId}</sys_id><remote_sys_id>${sourceId}</remote_sys_id><name>${name}</name><state>loaded</state><application>global</application></sys_remote_update_set><sys_update_xml action="INSERT_OR_UPDATE"><sys_id>${memberId}</sys_id><name>sys_properties_${propertyId}</name><remote_update_set>${setId}</remote_update_set><action>INSERT_OR_UPDATE</action><target_name>${property.name}</target_name><payload><![CDATA[${payload}]]></payload></sys_update_xml></unload>`;
    const inspection = inspectUpdateSetXML(xml);
    assert.equal(inspection.count, 1);
    for (const [table, recordId] of [['sys_remote_update_set', setId], ['sys_update_xml', memberId], ['sys_properties', propertyId]]) assert.equal(rows(await ctx.read(table, { query: `sys_id=${recordId}`, fields: ['sys_id'], limit: 1 })).length, 0, 'preallocated fixture ID already exists');
    await own(ctx, 'sys_remote_update_set', setId, 'planned-native-import', [captureId]);
    await own(ctx, 'sys_update_xml', memberId, 'planned-import-member', [setId]);
    await own(ctx, 'sys_properties', propertyId, 'planned-commit-effect', [memberId]);
    const file = path.join(ctx.outputDir, `${name}.xml`);
    await savePrivate(ctx, `${name}.xml`, xml);
    await denied(ctx, ['updatesets', 'import', file, '--json'], /confirmation_required|confirmation required/i);
    const loaded = await command(ctx, ['updatesets', 'import', file, '--yes', '--json'], { timeoutMs: 150000 });
    assert.equal(loaded.sys_id, setId);
    equalFields(await readOne(ctx, 'sys_remote_update_set', setId, ['sys_id', 'state', 'name']), { state: 'loaded', name });
    equalFields(await readOne(ctx, 'sys_update_xml', memberId, ['sys_id', 'name', 'remote_update_set']), { name: `sys_properties_${propertyId}`, remote_update_set: setId });
    await denied(ctx, ['updatesets', 'commit', setId, '--json'], /not been previewed|not.*preview|loaded/i);
    const preview = await command(ctx, ['updatesets', 'preview', setId, '--yes', '--timeout', '60', '--json'], { timeoutMs: 75000 });
    equalFields(await readOne(ctx, 'sys_remote_update_set', setId, ['sys_id', 'state']), { state: 'previewed' });
    assert.equal(preview.unresolved, 0, 'unresolved preview problems require human review; never auto-accept');
    assert.equal(preview.truncated, false, 'preview problems truncated');
    const problems = await command(ctx, ['updatesets', 'problems', setId, '--json']);
    assert.equal(problems.unresolved, 0, 'unresolved preview problems');
    assert.equal(problems.truncated, false);
    const committed = await command(ctx, ['updatesets', 'commit', setId, '--yes', '--timeout', '60', '--json'], { timeoutMs: 75000 });
    if (committed.local_update_set?.sys_id) {
      const localId = committed.local_update_set.sys_id;
      assert.notEqual(localId, captureId, 'commit must not reuse our capture set');
      const local = await readOne(ctx, 'sys_update_set', localId, ['sys_id', 'name']);
      equalFields(local, { name });
      await own(ctx, 'sys_update_set', localId, 'commit-local-set', [captureId]);
    } else assert.fail('commit did not identify its local set; reconcile ownership before continuing');
    equalFields(await readOne(ctx, 'sys_remote_update_set', setId, ['sys_id', 'state']), { state: 'committed' });
    // A successful tracker/CLI exit is not evidence that the payload was applied.
    equalFields(await readOne(ctx, 'sys_properties', propertyId, ['sys_id', 'name', 'value']), { name: property.name, value: ctx.runKey });
    return { verified: ['import-denial', 'native-import', 'unpreviewed-commit-denial', 'preview', 'commit', 'payload-readback'] };
  },
};

const flowLifecycle = {
  id: 'workflows.flow-lifecycle', title: 'Create/edit/publish/test an owned inert record flow',
  commandPaths: ['flows schemas', 'flows create', 'flows show', 'flows update', 'flows publish', 'flows status', 'flows test', 'flows executions', 'flows unlock'],
  sources: ['cli/src/commands/flows.js', 'cli/src/flow-create.js', 'cli/src/flow-safe-edit.js', 'cli/src/flow-publish.js', 'cli/src/flow-test.js'],
  modes: ['pdi'], mutates: true, requires: ['workflows.context'],
  async run(ctx) {
    await retainFlows(ctx);
    const { captureId } = await assertCapture(ctx);
    const name = runName(ctx, 'flow');
    await dictionary(ctx, 'sys_properties', { name, value: ctx.runKey });
    const fixture = await command(ctx, ['properties', 'create', '--data', JSON.stringify({ name, value: ctx.runKey }), '--json']);
    const recordId = raw(fixture.sys_id);
    await own(ctx, 'sys_properties', recordId, 'flow-trigger-record', [captureId]);
    await readOne(ctx, 'sys_properties', recordId, ['sys_id']);
    await command(ctx, ['flows', 'schemas', '--json']);
    const flowId = await createFlow(ctx, { name, scope: 'global', trigger: { type: 'record_create_or_update', table: 'sys_properties', condition: `name=${name}` }, actions: [{ type: 'Log', inputs: { log_level: 'info', log_message: name } }] });
    await command(ctx, ['flows', 'show', flowId, '--json']);
    const patch = { actions: [{ order: 1, type: 'Log', inputs: { log_message: `${name}_updated` } }] };
    const preview = await command(ctx, ['flows', 'update', flowId, '--data', JSON.stringify(patch), '--preview', '--json']);
    assert.equal(preview.preview, true);
    await denied(ctx, ['flows', 'update', flowId, '--data', JSON.stringify(patch), '--json'], /confirmation_required|confirmation required/i);
    await command(ctx, ['flows', 'update', flowId, '--data', JSON.stringify(patch), '--force', '--json']);
    await command(ctx, ['flows', 'unlock', flowId, '--force', '--json']);
    await denied(ctx, ['flows', 'publish', flowId, '--json'], /confirmation_required|confirmation required/i);
    await command(ctx, ['flows', 'publish', flowId, '--force', '--json']);
    equalFields(await readOne(ctx, 'sys_hub_flow', flowId, ['sys_id', 'active']), { active: true });
    assert.equal((await command(ctx, ['flows', 'status', flowId, '--json'])).ok, true);
    const dispatched = await command(ctx, ['flows', 'test', flowId, '--record', recordId, '--force', '--json']);
    assert.notEqual(dispatched.success, false, 'synchronous flow failure');
    if (!dispatched.context_id) blocked('Flow test did not expose execution context; accepted dispatch is not completion');
    await register(ctx, 'sys_flow_context', dispatched.context_id, 'flow-execution:manual-cleanup-required', [flowId, recordId], null);
    await poll(() => readOne(ctx, 'sys_flow_context', dispatched.context_id, ['sys_id', 'state']), record => ['COMPLETE', 'COMPLETED'].includes(String(raw(record.state)).toUpperCase()));
    const logs = rows(await ctx.read('syslog', { query: `message=${name}_updated`, fields: ['sys_id', 'message'], limit: 2 }));
    assert.ok(logs.some(log => raw(log.message) === `${name}_updated`), 'completed flow has no independent expected log effect');
    await command(ctx, ['flows', 'executions', '--record', recordId, '--limit', '10', '--json']);
    ctx.state.set('workflows.flow-lifecycle.evidence', { verified: ['create', 'preview', 'edit', 'unlock', 'publish', 'execution-completion', 'effect-readback'] });
    blocked('Lifecycle effects verified, but native flow deletion and complete graph ownership/cleanup remain unavailable; reconcile retained graph in Flow Designer');
  },
};

function inputEntries(schema) {
  const result = new Map();
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (['inputs', 'inputSchema', 'parameters', 'fields'].includes(key) && Array.isArray(item)) for (const field of item) if (field?.name) result.set(field.name, field);
      visit(item);
    }
  }
  visit(schema);
  return result;
}

const catalogFulfillment = {
  id: 'workflows.catalog-fulfillment', title: 'Create item + variable + dependent flow, publish, order and verify fulfillment task',
  commandPaths: ['catalogitems create', 'catalogitems show', 'catalogitems order', 'records create', 'records update', 'flows create', 'flows publish', 'actions action-type-schema'],
  sources: ['cli/src/commands/catalog.js', 'cli/src/commands/catalog-order.js', 'cli/src/commands/catalog/enrich.js', 'cli/src/flow-create.js', 'cli/src/flow-triggers.js', 'cli/src/commands/actions.js'],
  modes: ['pdi'], mutates: true, requires: ['workflows.context'],
  async run(ctx) {
    const recipe = ctx.state.get('workflows.catalogRecipe');
    if (!recipe) blocked('No provider-verified Create Catalog Task fulfillment recipe. Read actions action-type-schema on target; no guessed action inputs or order against existing item.');
    await retainFlows(ctx);
    await assertCapture(ctx);
    const name = runName(ctx, 'catalog');
    assert.match(recipe.actionTypeId ?? '', /^[a-f0-9]{32}$/i);
    const action = await readOne(ctx, 'sys_hub_action_type_definition', recipe.actionTypeId, ['sys_id', 'name']);
    assert.equal(raw(action.name), 'Create Catalog Task', 'only inert owned catalog task action allowed');
    const schema = inputEntries(await command(ctx, ['actions', 'action-type-schema', '--id', recipe.actionTypeId, '--scope', 'global', '--json']));
    const inputs = JSON.parse(JSON.stringify(recipe.inputs ?? {}).replaceAll('$RUN_NAME', name));
    assert.ok(Object.values(inputs).some(value => typeof value === 'string' && value.includes(name)), 'fulfillment must carry unique run marker');
    for (const key of Object.keys(inputs)) {
      if (!schema.has(key)) blocked(`Catalog task input ${key} absent from provider schema`);
      if (/script|email|url/i.test(String(schema.get(key).type ?? ''))) blocked(`Unsafe catalog task input ${key}`);
    }
    const binding = await dictionary(ctx, 'sc_cat_item', { name, short_description: name, flow_designer_flow: 'schema-only' });
    if (String(raw(binding.get('flow_designer_flow')?.reference)) !== 'sys_hub_flow') blocked('Catalog flow_designer_flow is not a verified sys_hub_flow reference');
    await dictionary(ctx, 'item_option_new', { name: 'acceptance_marker', question_text: name, type: 6, order: 100, cat_item: 'schema-only', mandatory: true, active: true });
    const item = await command(ctx, ['catalogitems', 'create', '--name', name, '--short-description', name, '--json']);
    const itemId = raw(item.sys_id);
    await own(ctx, 'sc_cat_item', itemId, 'catalog-item', [ctx.state.get('workflows.context').captureId]);
    equalFields(await readOne(ctx, 'sc_cat_item', itemId, ['sys_id', 'name']), { name });
    // Separate generic variable creation is intentional: catalog --variable batches
    // child writes before we can checkpoint item ownership and swallows failures.
    const variableData = { name: 'acceptance_marker', question_text: name, type: 6, order: 100, cat_item: itemId, mandatory: true, active: true };
    const variable = await command(ctx, ['records', 'create', '--table', 'item_option_new', '--data', JSON.stringify(variableData), '--json']);
    const variableId = raw(variable.sys_id);
    await own(ctx, 'item_option_new', variableId, 'catalog-variable', [itemId]);
    equalFields(await readOne(ctx, 'item_option_new', variableId, ['sys_id', ...Object.keys(variableData)]), variableData);
    const flowId = await createFlow(ctx, { name: `${name}_fulfillment`, scope: 'global', trigger: { type: 'service_catalog', inputs: recipe.triggerInputs ?? {} }, actions: [{ type: recipe.actionTypeId, inputs }] });
    await command(ctx, ['flows', 'publish', flowId, '--force', '--json']);
    equalFields(await readOne(ctx, 'sys_hub_flow', flowId, ['sys_id', 'active']), { active: true });
    await command(ctx, ['records', 'update', '--table', 'sc_cat_item', '--sys-id', itemId, '--data', JSON.stringify({ flow_designer_flow: flowId }), '--json']);
    equalFields(await readOne(ctx, 'sc_cat_item', itemId, ['sys_id', 'flow_designer_flow']), { flow_designer_flow: flowId });
    await command(ctx, ['catalogitems', 'show', itemId, '--json']);
    const variables = JSON.stringify({ acceptance_marker: ctx.runKey });
    await denied(ctx, ['catalogitems', 'order', itemId, '--variables', '{}', '--force', '--json'], /missing.*variable|required.*variable/i);
    await denied(ctx, ['catalogitems', 'order', itemId, '--variables', variables, '--json'], /confirmation_required|confirmation required/i);
    assert.equal((await command(ctx, ['catalogitems', 'order', itemId, '--variables', variables, '--dry-run', '--json'])).submitted, false);
    const order = await command(ctx, ['catalogitems', 'order', itemId, '--variables', variables, '--quantity', '1', '--force', '--json']);
    assert.equal(order.submitted, true);
    await own(ctx, 'sc_request', order.request_id, 'catalog-request', [itemId]);
    await readOne(ctx, 'sc_request', order.request_id, ['sys_id']);
    const requested = rows(await ctx.read('sc_req_item', { query: `request=${order.request_id}^cat_item=${itemId}`, fields: ['sys_id', 'request', 'cat_item'], limit: 2 }));
    assert.equal(requested.length, 1, 'exactly one owned requested item required');
    const requestedId = raw(requested[0].sys_id);
    await own(ctx, 'sc_req_item', requestedId, 'catalog-requested-item', [order.request_id, flowId]);
    equalFields(requested[0], { request: order.request_id, cat_item: itemId });
    const tasks = await poll(() => ctx.read('sc_task', { query: `request_item=${requestedId}^short_description=${name}`, fields: ['sys_id', 'request_item', 'short_description'], limit: 2 }), result => rows(result).length > 0);
    assert.equal(rows(tasks).length, 1, 'ambiguous fulfillment effect');
    const task = rows(tasks)[0];
    await own(ctx, 'sc_task', raw(task.sys_id), 'catalog-fulfillment-effect', [requestedId]);
    equalFields(task, { request_item: requestedId, short_description: name });
    // Variable answers and links are separately owned asynchronous provider rows.
    const answers = rows(await ctx.read('sc_item_option_mtom', { query: `request_item=${requestedId}`, fields: ['sys_id', 'sc_item_option', 'request_item'], limit: 10 }));
    assert.ok(answers.length > 0 && answers.length < 10, 'variable-answer links missing/truncated');
    let markerVerified = false;
    for (const answer of answers) {
      const answerId = raw(answer.sc_item_option);
      await own(ctx, 'sc_item_option', answerId, 'catalog-answer', [requestedId, variableId]);
      await own(ctx, 'sc_item_option_mtom', raw(answer.sys_id), 'catalog-answer-link', [requestedId, answerId]);
      const value = await readOne(ctx, 'sc_item_option', answerId, ['sys_id', 'item_option_new', 'value']);
      if (raw(value.item_option_new) === variableId) { equalFields(value, { value: ctx.runKey }); markerVerified = true; }
    }
    assert.equal(markerVerified, true, 'submitted marker variable not persisted');
    ctx.state.set('workflows.catalog-fulfillment.evidence', { verified: ['item-create', 'variable-create', 'flow-create', 'flow-publish', 'flow-binding', 'missing-variable-denial', 'confirmation-denial', 'order-preview', 'order', 'request-readback', 'variable-answer-readback', 'fulfillment-effect'] });
    blocked('Catalog fulfillment effects verified, but native flow deletion and complete graph ownership/cleanup remain unavailable; reconcile retained graph in Flow Designer');
  },
};

const interactive = {
  id: 'workflows.interactive', title: 'Interactive workflow mutation and cancellation coverage remains required',
  commandPaths: ['flows create', 'flows update', 'flows publish', 'catalogitems order', 'updatesets preview', 'updatesets commit'],
  sources: ['cli/src/flow-designer-interactive.js', 'cli/src/prompts.js'], modes: ['pdi'], mutates: true, requires: ['workflows.context'],
  async run() { blocked('Interactive mutation success/cancellation is not proven by scripted --json confirmation-denial. Existing cli/test/support/flow-designer-pty-driver.py technique must be integrated with owned fixture identities before this capability passes.'); },
};

export const scenarios = [context, updateSetTransfer, flowLifecycle, catalogFulfillment, interactive];
