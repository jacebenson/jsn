import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeAdapterRegistry, validateBatchManifest } from '../src/batch-manifest.js';
import { planBatch, applyBatch, planId } from '../src/batch-engine.js';
import { catalogBatchAdapters } from '../src/batch-adapters/catalog.js';
import { familyBatchAdapters } from '../src/batch-adapters/families.js';
import { families, familyDocument } from './support/batch-family-fixtures.js';

const registry = makeAdapterRegistry([...catalogBatchAdapters, ...familyBatchAdapters]);
const tables = {
  catalog_item: 'sc_cat_item', catalog_variable: 'item_option_new', catalog_ui_policy: 'catalog_ui_policy',
  catalog_ui_policy_action: 'catalog_ui_policy_action', catalog_client_script: 'catalog_script_client',
  acl: 'sys_security_acl', acl_role: 'sys_security_acl_role', ui_policy: 'sys_ui_policy',
  ui_policy_action: 'sys_ui_policy_action', data_policy: 'sys_data_policy2', data_policy_rule: 'sys_data_policy_rule',
  sp_page: 'sp_page', sp_container: 'sp_container', sp_row: 'sp_row', sp_column: 'sp_column', sp_instance: 'sp_instance',
};
const id = index => (index + 1).toString(16).padStart(32, '0');
const refs = fields => Object.entries(fields).filter(([, value]) => value?.$ref);
const dependencies = step => refs(step.fields).map(([, value]) => value.$ref.split('.')[1]);
function substitute(fields, family) {
  return Object.fromEntries(Object.entries(fields).map(([field, value]) => {
    if (!value?.$ref) return [field, value];
    const [, name, output] = value.$ref.split('.');
    const valueId = id(family.steps.findIndex(step => step.name === name));
    return [field, output === 'catalog_variable' ? `IO:${valueId}` : valueId];
  }));
}
function harness(family, { fail = null, failDelete = null, remain = false } = {}) {
  const calls = [];
  const rows = new Map(family.steps.map((step, index) => [id(index), { sys_id: id(index), ...substitute(step.fields, family) }]));
  let next = 0;
  const sdk = {
    baseURL: 'https://fixture.invalid',
    async request(endpoint, options) {
      assert.equal(options.method, 'GET');
      assert.equal(options.readOnly, true);
      const url = new URL(endpoint);
      const sysId = url.searchParams.get('sysparm_query').slice('sys_id='.length);
      return { result: rows.has(sysId) ? [rows.get(sysId)] : [] };
    },
    async get(table, sysId) { return rows.get(sysId) || null; },
    async list(table, params) {
      const sysId = params.get('sysparm_query').slice('sys_id='.length);
      return rows.has(sysId) ? [rows.get(sysId)] : [];
    },
    async create(table, payload) {
      calls.push({ operation: 'create', table, payload });
      if (table === fail) throw new Error('parent rejected');
      const sysId = id(next++);
      rows.set(sysId, { ...payload, sys_id: sysId });
      return rows.get(sysId);
    },
    async update(table, sysId, payload) {
      calls.push({ operation: 'update', table, sysId, payload });
      rows.set(sysId, { ...payload, sys_id: sysId });
      return rows.get(sysId);
    },
    async delete(table, sysId) {
      calls.push({ operation: 'delete', table, sysId });
      if (table === failDelete) throw new Error('child delete rejected');
      if (!remain) rows.delete(sysId);
    },
  };
  return { sdk, calls, rows };
}
const validate = document => validateBatchManifest(document, registry);
const planOptions = { readContext: async () => null };
async function execute(sdk, manifest, plan) {
  return applyBatch({ sdk, manifest, plan, ...planOptions });
}
function expectedPlan(family, operation) {
  const steps = family.steps.map((step, index) => {
    const depends = operation === 'delete'
      ? family.steps.filter(child => dependencies(child).includes(step.name)).map(child => child.name)
      : dependencies(step);
    const outputs = step.type === 'catalog_variable' ? ['sys_id', 'catalog_variable'] : ['sys_id'];
    const targetField = ['catalog_item', 'catalog_variable', 'catalog_client_script', 'acl'].includes(step.type) ? 'name' : step.type === 'sp_page' ? 'id' : null;
    const fields = operation === 'delete' ? Object.fromEntries(refs(step.fields)) : step.fields;
    return {
      name: step.name, type: step.type, table: tables[step.type], operation, status: 'planned', depends_on: depends,
      target: operation === 'create' ? { mode: 'create' } : { mode: operation, sys_id: id(index), match_field: 'sys_id', matched: (step.fields[targetField || 'name'] || null) },
      payload: operation === 'delete' ? {} : (operation === 'create' ? step.payload || step.fields : step.type === 'catalog_variable' ? { cat_item: step.fields.cat_item, question_text: step.fields.label } : step.fields),
      pending_refs: refs(fields).map(([field, value]) => ({ location: `fields.${field}`, ref: value.$ref })),
      produces: outputs.map(output => `steps.${step.name}.${output}`),
      notes: step.type === 'catalog_variable' && operation === 'create' ? ['variable name derived as "cpu" from the label'] : [],
    };
  });
  // Explicit expected destructive order for the branching catalog family.
  const order = operation === 'delete'
    ? (family.name === 'catalog UI policies and actions' ? ['action', 'policy', 'variable', 'item'] : family.steps.map(step => step.name).reverse())
    : family.steps.map(step => step.name);
  const expected = {
    command: 'batch plan', instance: null, manifest: { version: 1, description: '', steps: steps.length },
    context: null, context_diagnostics: [], order,
    counts: { steps: steps.length, creates: operation === 'create' ? steps.length : 0, updates: operation === 'update' ? steps.length : 0, deletes: operation === 'delete' ? steps.length : 0, writes: 0 },
    partial: false, writes_performed: false, steps: order.map(name => steps.find(step => step.name === name)),
  };
  expected.plan_id = planId(expected);
  return expected;
}

for (const family of families) describe(`batch family: ${family.name}`, () => {
  for (const operation of ['create', 'update', 'delete']) it(`exact ${operation} plan, order and zero writes`, async () => {
    const { sdk, calls } = harness(family);
    const document = familyDocument(family, operation);
    // Reverse declarations to prove the graph, not input order, drives chains.
    if (family.steps.length === 2) document.steps.reverse();
    const result = await planBatch({ sdk, manifest: validate(document), ...planOptions });
    const expected = expectedPlan(family, operation);
    assert.deepEqual(result, expected);
    assert.deepEqual(calls, []);
  });
  it('resolves symbolic parents and exact prepared payloads on create', async () => {
    const { sdk, calls } = harness(family);
    const manifest = validate(familyDocument(family));
    const plan = await planBatch({ sdk, manifest, ...planOptions });
    const result = await execute(sdk, manifest, plan);
    assert.equal(result.partial, false);
    assert.deepEqual(result.steps.map(step => step.status), family.steps.map(() => 'created'));
    assert.deepEqual(calls, family.steps.map(step => ({ operation: 'create', table: tables[step.type], payload: substitute(step.payload || step.fields, family) })));
  });
  it('updates parents before children with resolved references', async () => {
    const { sdk, calls } = harness(family);
    const manifest = validate(familyDocument(family, 'update'));
    const plan = await planBatch({ sdk, manifest, ...planOptions });
    const result = await execute(sdk, manifest, plan);
    assert.equal(result.partial, false);
    assert.deepEqual(calls, family.steps.map((step, index) => ({ operation: 'update', table: tables[step.type], sysId: id(index),
      payload: substitute(step.type === 'catalog_variable' ? { cat_item: step.fields.cat_item, question_text: step.fields.label } : step.fields, family) })));
  });
  it('failed parent skips children without orphan writes', async () => {
    const { sdk, calls } = harness(family, { fail: tables[family.steps[0].type] });
    const manifest = validate(familyDocument(family));
    const plan = await planBatch({ sdk, manifest, ...planOptions });
    const result = await execute(sdk, manifest, plan);
    assert.deepEqual(result.steps.map(step => step.status), ['failed', ...family.steps.slice(1).map(() => 'skipped')]);
    assert.equal(calls.length, 1);
    assert.equal(result.partial, true);
  });
  it('deletes children first and proves every target absent', async () => {
    const { sdk, calls, rows } = harness(family);
    const manifest = validate(familyDocument(family, 'delete'));
    const plan = await planBatch({ sdk, manifest, ...planOptions });
    const result = await execute(sdk, manifest, plan);
    assert.deepEqual(result.order, expectedPlan(family, 'delete').order);
    assert.deepEqual(calls.map(call => call.table), result.order.map(name => tables[family.steps.find(step => step.name === name).type]));
    assert.equal(result.counts.deleted, family.steps.length);
    assert.equal(rows.size, 0);
    assert.equal(result.partial, false);
  });
  it('failed child deletion blocks ancestors', async () => {
    const leaf = family.steps.at(-1);
    const { sdk, calls } = harness(family, { failDelete: tables[leaf.type] });
    const manifest = validate(familyDocument(family, 'delete'));
    const plan = await planBatch({ sdk, manifest, ...planOptions });
    const result = await execute(sdk, manifest, plan);
    assert.equal(result.steps.find(step => step.name === leaf.name).status, 'failed');
    assert.equal(result.steps.find(step => step.name === family.steps[0].name).status, 'skipped');
    assert.equal(calls.length, 1);
  });
  it('rejects malformed schema, literal parents and unrelated delete targets', async () => {
    const invalid = familyDocument(family);
    invalid.steps.at(-1).fields.invented_field = true;
    assert.throws(() => validate(invalid), /Unsupported .* field/);
    const literal = familyDocument(family);
    literal.steps.at(-1).fields[family.steps.at(-1).parent[0]] = 'a'.repeat(32);
    assert.throws(() => validate(literal), /symbolic \$ref/);
    const { sdk, calls, rows } = harness(family);
    rows.get(id(family.steps.length - 1))[family.steps.at(-1).parent[0]] = 'f'.repeat(32);
    await assert.rejects(() => planBatch({ sdk, manifest: validate(familyDocument(family, 'delete')), ...planOptions }), /parent mismatch/);
    assert.deepEqual(calls, []);
  });
});

it('requires a plan and rejects stale, tampered and wrong-instance plans before writes', async () => {
  const family = families[0];
  const { sdk, calls } = harness(family);
  const manifest = validate(familyDocument(family));
  await assert.rejects(() => execute(sdk, manifest), /requires an intact batch plan/);
  const plan = await planBatch({ sdk, manifest, ...planOptions });
  const tampered = structuredClone(plan);
  tampered.steps[0].payload.name = 'unplanned';
  await assert.rejects(() => execute(sdk, manifest, tampered), /intact/);
  const stale = familyDocument(family);
  stale.steps[0].fields.name = 'changed';
  await assert.rejects(() => execute(sdk, validate(stale), plan), /stale/);
  await assert.rejects(() => applyBatch({ sdk, manifest, plan, app: { getEffectiveInstance: () => 'https://other.invalid' }, ...planOptions }), /stale/);
  assert.deepEqual(calls, []);
});
it('unverified deletion does not allow its parent to run', async () => {
  const family = families[0];
  const { sdk, calls } = harness(family, { remain: true });
  const manifest = validate(familyDocument(family, 'delete'));
  const plan = await planBatch({ sdk, manifest, ...planOptions });
  const result = await execute(sdk, manifest, plan);
  assert.deepEqual(result.steps.map(step => step.status), ['failed', 'skipped']);
  assert.equal(calls.length, 1);
  assert.match(result.steps[0].error.message, /absence was not verified/);
});
for (const response of [{}, { result: null }, { result: {} }, { error: { message: 'denied' }, result: [] }]) {
  it(`delete cannot infer absence from ${JSON.stringify(response)}`, async () => {
    const family = families[0];
    const { sdk, calls } = harness(family);
    sdk.request = async () => response;
    const manifest = validate(familyDocument(family, 'delete'));
    const plan = await planBatch({ sdk, manifest, ...planOptions });
    const result = await execute(sdk, manifest, plan);
    assert.deepEqual(result.steps.map(step => step.status), ['failed', 'skipped']);
    assert.equal(calls.length, 1);
    assert.match(result.steps[0].error.message, /absence was not verified/);
  });
}

it('pre-write confirmation sees the verified plan but cannot alter predicted payloads', async () => {
  const family = families[0];
  const { sdk, calls } = harness(family);
  const manifest = validate(familyDocument(family));
  const plan = await planBatch({ sdk, manifest, ...planOptions });
  let confirmations = 0;
  const result = await applyBatch({ sdk, manifest, plan, ...planOptions, beforeApply: async prediction => {
    confirmations++;
    assert.deepEqual(calls, []);
    prediction.steps[0].payload.name = 'not approved by original plan';
  } });
  assert.equal(result.partial, false);
  assert.equal(confirmations, 1);
  assert.equal(calls[0].payload.name, 'Batch fixture');
});

it('rejects mixed destructive relationships and the unverified dictionary family', () => {
  const doc = familyDocument(families[0], 'delete');
  doc.steps[0] = familyDocument(families[0]).steps[0];
  assert.throws(() => validate(doc), /cannot mix delete/);
  assert.throws(() => validate({ version: 1, steps: [{ name: 'override', type: 'dictionary_override', operation: 'create', fields: { name: 'incident' } }] }), /Unsupported step type/);
});
