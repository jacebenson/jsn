// Shared batch engine: dependency-ordered execution, reference resolution,
// per-step status, partial results and per-step safety. Uses a mock transport —
// no live instance.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeAdapterRegistry, validateBatchManifest } from '../src/batch-manifest.js';
import { applyBatch as applyPlannedBatch, planBatch, resolveUpdateTarget } from '../src/batch-engine.js';

// Every apply exercises the public plan prerequisite; avoid consuming the
// injected mid-run context sequence while preparing the receipt.
async function applyBatch(options) {
  const plan = await planBatch({ ...options, instance: options.app?.getEffectiveInstance?.() || '', readContext: async () => CONTEXT });
  return applyPlannedBatch({ ...options, plan });
}
import { catalogBatchAdapters } from '../src/batch-adapters/catalog.js';

const registry = makeAdapterRegistry(catalogBatchAdapters);
const CONTEXT = {
  scope: 'x_app',
  application_id: 'app1',
  update_set: { name: 'My Feature', sys_id: 'set1', state: 'in progress' },
  diagnostics: [],
  approval_required: false,
  approved: false,
};

function manifestOf(steps) {
  return validateBatchManifest({ version: 1, steps }, registry);
}

function createManifest() {
  return manifestOf([
    { name: 'laptop', type: 'catalog_item', operation: 'create', fields: { name: 'Laptop' } },
    {
      name: 'cpu', type: 'catalog_variable', operation: 'create',
      fields: { cat_item: { $ref: 'steps.laptop.sys_id' }, label: 'CPU', mandatory: true },
    },
    {
      name: 'standalone', type: 'catalog_item', operation: 'create', fields: { name: 'Standalone' },
    },
  ]);
}

function harness({ list = async () => [], get = async (table, id) => ({ sys_id: id, name: 'Existing' }), failOn = null } = {}) {
  const calls = [];
  const sdk = {
    baseURL: 'https://fixture.invalid',
    async create(table, data) {
      calls.push({ op: 'create', table, data });
      if (failOn === table) throw Object.assign(new Error(`create failed for ${table}`), { code: 'api_error' });
      return { sys_id: table === 'sc_cat_item' ? `item${calls.length}` : `var${calls.length}` };
    },
    async update(table, id, data) {
      calls.push({ op: 'update', table, id, data });
      if (failOn === table) throw Object.assign(new Error(`update failed for ${table}`), { code: 'api_error' });
      return { sys_id: id };
    },
    async get(table, id) { calls.push({ op: 'get', table, id }); return get(table, id); },
    async list(table, params) { calls.push({ op: 'list', table, params }); return list(table, params); },
  };
  return { sdk, calls };
}

const writes = (calls) => calls.filter(call => call.op === 'create' || call.op === 'update');

describe('batch engine plan', () => {
  it('resolves targets and payloads but performs zero writes', async () => {
    const { sdk, calls } = harness();
    const manifest = manifestOf([
      { name: 'laptop', type: 'catalog_item', operation: 'create', fields: { name: 'Laptop' } },
      {
        name: 'cpu', type: 'catalog_variable', operation: 'create',
        fields: { cat_item: { $ref: 'steps.laptop.sys_id' }, label: 'CPU' },
      },
      {
        name: 'existing', type: 'catalog_item', operation: 'update',
        target: { sys_id: 'a'.repeat(32) }, fields: { short_description: 'Updated' },
      },
    ]);
    const result = await planBatch({ sdk, manifest, instance: 'https://fixture.invalid', readContext: async () => CONTEXT });

    assert.equal(writes(calls).length, 0, 'plan never calls create/update');
    assert.equal(result.writes_performed, false);
    assert.equal(result.counts.writes, 0);
    assert.equal(result.counts.creates, 2);
    assert.equal(result.counts.updates, 1);
    assert.deepEqual(result.order, ['laptop', 'cpu', 'existing']);
    const cpu = result.steps.find(step => step.name === 'cpu');
    assert.deepEqual(cpu.pending_refs, [{ location: 'fields.cat_item', ref: 'steps.laptop.sys_id' }]);
    assert.deepEqual(cpu.payload.cat_item, { $ref: 'steps.laptop.sys_id' }, 'plan leaves generated values unresolved');
    const existing = result.steps.find(step => step.name === 'existing');
    assert.equal(existing.target.mode, 'update');
    assert.equal(existing.target.sys_id, 'a'.repeat(32));
    assert.equal(result.context.update_set.name, 'My Feature');
  });

  it('fails an ambiguous update target before any write', async () => {
    const { sdk, calls } = harness({
      list: async () => [{ sys_id: 'one', name: 'Laptop' }, { sys_id: 'two', name: 'Laptop' }],
    });
    const manifest = manifestOf([
      {
        name: 'existing', type: 'catalog_item', operation: 'update',
        target: { identifier: 'Laptop' }, fields: { short_description: 'x' },
      },
    ]);
    await assert.rejects(
      () => planBatch({ sdk, manifest, readContext: async () => CONTEXT }),
      (error) => {
        assert.equal(error.code, 'ambiguous');
        assert.match(error.message, /Step "existing"/);
        return true;
      },
    );
    assert.equal(writes(calls).length, 0);
  });
});

describe('batch engine apply', () => {
  it('creates in dependency order and resolves references to prior sys_ids', async () => {
    const { sdk, calls } = harness();
    const result = await applyBatch({
      sdk, manifest: createManifest(), initialContext: CONTEXT, readContext: async () => CONTEXT,
    });

    assert.deepEqual(result.steps.map(step => [step.name, step.status]),
      [['laptop', 'created'], ['cpu', 'created'], ['standalone', 'created']]);
    assert.equal(result.counts.created, 3);
    assert.equal(result.partial, false);
    assert.deepEqual(result.recovery, []);
    const order = calls.filter(call => call.op === 'create');
    assert.deepEqual(order.map(call => call.table), ['sc_cat_item', 'item_option_new', 'sc_cat_item']);
    assert.equal(order[1].data.cat_item, 'item1', 'variable references the created item');
    assert.equal(result.steps[1].sys_id, 'var2');
    assert.deepEqual(result.steps[1].depends_on, ['laptop']);
  });

  it('resolves an explicit update target before writes and reports the updated id', async () => {
    const { sdk, calls } = harness();
    const sysId = 'b'.repeat(32);
    const manifest = manifestOf([
      { name: 'existing', type: 'catalog_item', operation: 'update', target: { sys_id: sysId }, fields: { name: 'Renamed' } },
    ]);
    const result = await applyBatch({
      sdk, manifest, initialContext: CONTEXT, readContext: async () => CONTEXT,
    });
    assert.equal(result.steps[0].status, 'updated');
    assert.equal(result.steps[0].sys_id, sysId);
    assert.deepEqual(writes(calls), [{ op: 'update', table: 'sc_cat_item', id: sysId, data: { name: 'Renamed' } }]);
    assert.equal(calls[0].op, 'get', 'target existence is read before the write');
  });

  it('resolves an identifier target with an allowlisted parent scope', async () => {
    const { sdk, calls } = harness({
      list: async (table, params) => {
        assert.equal(table, 'item_option_new');
        assert.match(params.get('sysparm_query'), /cat_item=item1\^name=cpu/);
        return [{ sys_id: 'var-existing', name: 'cpu', cat_item: 'item1' }];
      },
    });
    const manifest = manifestOf([
      {
        name: 'cpu', type: 'catalog_variable', operation: 'update',
        target: { identifier: 'cpu', matchField: 'name', scope: { cat_item: 'item1' } },
        fields: { label: 'Processor' },
      },
    ]);
    const result = await applyBatch({ sdk, manifest, initialContext: CONTEXT, readContext: async () => CONTEXT });
    assert.equal(result.steps[0].status, 'updated');
    assert.deepEqual(writes(calls), [{ op: 'update', table: 'item_option_new', id: 'var-existing', data: { question_text: 'Processor' } }]);
  });

  it('skips dependents after a failure but still applies independent steps', async () => {
    const { sdk, calls } = harness({ failOn: 'sc_cat_item' });
    const result = await applyBatch({
      sdk, manifest: createManifest(), initialContext: CONTEXT, readContext: async () => CONTEXT,
    });

    const byName = Object.fromEntries(result.steps.map(step => [step.name, step]));
    assert.equal(byName.laptop.status, 'failed');
    assert.equal(byName.laptop.error.code, 'api_error');
    assert.equal(byName.cpu.status, 'skipped');
    assert.match(byName.cpu.skipped_reason, /dependency "laptop" did not complete/);
    assert.equal(byName.standalone.status, 'failed', 'independent step was still attempted');
    assert.deepEqual(result.counts, { total: 3, created: 0, updated: 0, deleted: 0, failed: 2, skipped: 1 });
    assert.equal(result.partial, true);
    assert.equal(result.writes_performed, false);
    assert.ok(result.recovery.some(line => /not an atomic ServiceNow transaction/.test(line)));
    assert.equal(writes(calls).length, 2, 'the skipped step made no write');
  });

  it('reports accurate partial success with completed ids', async () => {
    const { sdk } = harness({ failOn: 'item_option_new' });
    const result = await applyBatch({
      sdk, manifest: createManifest(), initialContext: CONTEXT, readContext: async () => CONTEXT,
    });
    const byName = Object.fromEntries(result.steps.map(step => [step.name, step]));
    assert.equal(byName.laptop.status, 'created');
    assert.equal(byName.laptop.sys_id, 'item1');
    assert.equal(byName.cpu.status, 'failed');
    assert.equal(byName.standalone.status, 'created');
    assert.deepEqual(result.counts, { total: 3, created: 2, updated: 0, deleted: 0, failed: 1, skipped: 0 });
    assert.equal(result.partial, true);
  });

  it('makes no write when an ambiguous target exists anywhere in the manifest', async () => {
    const { sdk, calls } = harness({
      list: async () => [{ sys_id: 'one' }, { sys_id: 'two' }],
    });
    const manifest = manifestOf([
      { name: 'laptop', type: 'catalog_item', operation: 'create', fields: { name: 'Laptop' } },
      {
        name: 'existing', type: 'catalog_item', operation: 'update',
        target: { identifier: 'Laptop' }, fields: { short_description: 'x' },
      },
    ]);
    await assert.rejects(
      () => applyBatch({ sdk, manifest, initialContext: CONTEXT, readContext: async () => CONTEXT }),
      /Step "existing"/,
    );
    assert.equal(writes(calls).length, 0, 'preflight failure happens before the first write');
  });

  it('stops before a step when the capture context becomes blocked mid-run', async () => {
    const { sdk, calls } = harness();
    let reads = 0;
    const readContext = async () => {
      reads += 1;
      return reads === 1 ? CONTEXT : {
        ...CONTEXT,
        scope: 'global',
        update_set: { name: 'Default', sys_id: 'set-default', state: 'in progress' },
      };
    };
    const result = await applyBatch({ sdk, manifest: createManifest(), initialContext: CONTEXT, readContext });

    const byName = Object.fromEntries(result.steps.map(step => [step.name, step]));
    assert.equal(byName.laptop.status, 'created');
    assert.equal(byName.cpu.status, 'skipped');
    assert.equal(byName.standalone.status, 'skipped');
    assert.equal(result.stopped.code, 'confirmation_required');
    assert.equal(result.counts.created, 1);
    assert.equal(result.counts.skipped, 2);
    assert.equal(result.partial, true);
    assert.equal(result.context_changes.length, 1);
    assert.equal(result.context_changes[0].after.update_set.name, 'Default');
    assert.equal(writes(calls).length, 1, 'no write happened in the blocked context');
  });

  it('stops before the first write when the profile became read-only', async () => {
    const { sdk, calls } = harness();
    const result = await applyBatch({
      sdk, manifest: createManifest(), initialContext: CONTEXT,
      app: { session: { readOnly: true, profileName: 'prod' }, getEffectiveInstance: () => 'https://fixture.invalid' },
      readContext: async () => CONTEXT,
    });
    assert.equal(result.stopped.code, 'read_only');
    assert.equal(result.counts.created, 0);
    assert.equal(result.counts.skipped, 3);
    assert.equal(writes(calls).length, 0);
  });

  it('records a changed but still-writable context without blocking', async () => {
    const { sdk } = harness();
    let reads = 0;
    const readContext = async () => {
      reads += 1;
      return reads === 1 ? CONTEXT : { ...CONTEXT, update_set: { name: 'Other Set', sys_id: 'set2', state: 'in progress' } };
    };
    const result = await applyBatch({ sdk, manifest: createManifest(), initialContext: CONTEXT, readContext });
    assert.equal(result.partial, false);
    assert.equal(result.steps.every(step => step.status === 'created'), true);
    assert.equal(result.context_changes.length, 1);
    assert.equal(result.context_changes[0].before.update_set.name, 'My Feature');
  });
});

describe('resolveUpdateTarget', () => {
  it('fails a missing explicit sys_id before writing', async () => {
    const { sdk, calls } = harness({ get: async () => null });
    const manifest = manifestOf([
      { name: 'gone', type: 'catalog_item', operation: 'update', target: { sys_id: 'c'.repeat(32) }, fields: { name: 'x' } },
    ]);
    await assert.rejects(() => resolveUpdateTarget(sdk, manifest.byName.get('gone')), (error) => {
      assert.equal(error.code, 'not_found');
      assert.match(error.message, /Step "gone"/);
      return true;
    });
    assert.equal(writes(calls).length, 0);
  });

  it('rejects query metacharacters in identifiers', async () => {
    const { sdk } = harness();
    const manifest = manifestOf([
      { name: 'x', type: 'catalog_item', operation: 'update', target: { identifier: 'a^b' }, fields: { name: 'x' } },
    ]);
    await assert.rejects(() => resolveUpdateTarget(sdk, manifest.byName.get('x')), /Unsafe identifier/);
  });
});
