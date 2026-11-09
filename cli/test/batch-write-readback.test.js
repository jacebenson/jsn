import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyBatch, planBatch } from '../src/batch-engine.js';
import { makeAdapterRegistry, validateBatchManifest } from '../src/batch-manifest.js';
import { familyBatchAdapters } from '../src/batch-adapters/families.js';

const registry = makeAdapterRegistry(familyBatchAdapters);
const id = number => String(number).padStart(32, '0');
const ref = name => ({ $ref: `steps.${name}.sys_id` });
function fixture({ operation = 'create', readback = row => row } = {}) {
  const document = { version: 1, steps: [
    { name: 'page', type: 'sp_page', operation, fields: { id: 'inert', public: false, draft: true } },
    { name: 'container', type: 'sp_container', operation, fields: { sp_page: ref('page'), order: 100 } },
    { name: 'row', type: 'sp_row', operation, fields: { sp_container: ref('container') } },
    { name: 'column', type: 'sp_column', operation, fields: { sp_row: ref('row'), size: 12 } },
  ] };
  if (operation === 'update') document.steps.forEach((step, index) => { step.target = { sys_id: id(index + 1) }; });
  const rows = new Map(document.steps.map((step, index) => [id(index + 1), { sys_id: id(index + 1) }]));
  const writes = [];
  const reads = [];
  let next = 0;
  const sdk = {
    async create(table, payload) {
      const sys_id = id(++next);
      writes.push({ table, sys_id, payload });
      rows.set(sys_id, { sys_id, ...payload });
      return { sys_id, ...payload }; // A 201 echo is not persisted evidence.
    },
    async update(table, sys_id, payload) {
      writes.push({ table, sys_id, payload });
      rows.set(sys_id, { sys_id, ...payload });
      return { sys_id, ...payload };
    },
    async get(table, sys_id) {
      reads.push({ table, sys_id });
      const row = rows.get(sys_id);
      return writes.some(write => write.sys_id === sys_id) ? readback(row, table) : row;
    },
  };
  const manifest = validateBatchManifest(document, registry);
  return { sdk, manifest, writes, reads };
}
const options = { readContext: async () => null };
async function apply(fixture) {
  const plan = await planBatch({ sdk: fixture.sdk, manifest: fixture.manifest, ...options });
  return applyBatch({ sdk: fixture.sdk, manifest: fixture.manifest, plan, ...options });
}

describe('batch persisted write verification (demo regressions)', () => {
  for (const operation of ['create', 'update']) {
    it(`${operation}: silently discarded parent is failed with recoverable id and descendants skipped`, async () => {
      const f = fixture({ operation, readback: (row, table) => table === 'sp_container' ? { ...row, sp_page: '' } : row });
      const result = await apply(f);
      assert.deepEqual(result.steps.map(step => step.status), [operation === 'create' ? 'created' : 'updated', 'failed', 'skipped', 'skipped']);
      assert.equal(result.steps[1].sys_id, id(2));
      assert.equal(result.steps[1].write_outcome, operation === 'create' ? 'created_unverified' : 'updated_unverified');
      assert.match(result.steps[1].error.message, /readback mismatch at sp_page/);
      assert.deepEqual(f.writes.map(write => write.table), ['sp_page', 'sp_container']);
      assert.equal(result.counts.failed, 1);
      assert.equal(result.counts.skipped, 2);
      assert.equal(result.partial, true);
    });
  }
  it('coerced out-of-range integer fails instead of publishing child outputs', async () => {
    const f = fixture({ readback: (row, table) => table === 'sp_container' ? { ...row, order: '0' } : row });
    const result = await apply(f);
    assert.equal(result.steps[1].status, 'failed');
    assert.match(result.steps[1].error.message, /readback mismatch at order/);
    assert.equal(result.steps[1].sys_id, id(2));
    assert.deepEqual(f.writes.map(write => write.table), ['sp_page', 'sp_container']);
    assert.equal(result.counts.skipped, 2);
  });
  for (const mode of ['missing', 'throw']) {
    it(`unreadable persisted child (${mode}) retains id and blocks descendants`, async () => {
      const f = fixture({ readback: (row, table) => {
        if (table !== 'sp_container') return row;
        if (mode === 'throw') throw new Error('read denied');
        return null;
      } });
      const result = await apply(f);
      assert.equal(result.steps[1].status, 'failed');
      assert.equal(result.steps[1].sys_id, id(2));
      assert.equal(result.counts.skipped, 2);
      assert.equal(f.writes.length, 2);
    });
  }
  it('raw reference values, not display names, verify correctly before descendants write', async () => {
    const f = fixture({ readback: (row, table) => table === 'sp_container'
      ? { ...row, sp_page: { value: row.sp_page, display_value: 'An unrelated display name' }, order: '100' } : row });
    const result = await apply(f);
    assert.equal(result.partial, false);
    assert.equal(result.counts.created, 4);
    assert.ok(f.reads.some(read => read.table === 'sp_container'));
  });
  it('UI action 201 echo with blank persisted links is not success', async () => {
    const manifest = validateBatchManifest({ version: 1, steps: [
      { name: 'policy', type: 'ui_policy', operation: 'create', fields: { short_description: 'inert', active: false } },
      { name: 'action', type: 'ui_policy_action', operation: 'create', fields: { ui_policy: ref('policy'), field: 'short_description' } },
    ] }, registry);
    let next = 0;
    const sdk = { create: async () => ({ sys_id: id(++next) }), get: async () => ({ sys_id: id(2), ui_policy: '' }) };
    const plan = await planBatch({ sdk, manifest, ...options });
    const result = await applyBatch({ sdk, manifest, plan, ...options });
    assert.equal(result.steps[1].status, 'failed');
    assert.equal(result.steps[1].sys_id, id(2));
    assert.match(result.steps[1].error.message, /ui_policy/);
  });
});
