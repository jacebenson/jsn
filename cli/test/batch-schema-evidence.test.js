import { it } from 'node:test';
import assert from 'node:assert/strict';
import { checkBatchSchema } from '../scripts/check-batch-schema.mjs';

const adapters = [
  { type: 'catalog_ui_policy', table: 'catalog_ui_policy', fields: { short_description: { type: 'string' } } },
  { type: 'catalog_ui_policy_action', table: 'catalog_ui_policy_action', fields: { ui_policy: { type: 'string', parent: true, ref: ['catalog_ui_policy'] } } },
];
const rows = [
  { name: 'sys_ui_policy', element: 'short_description', internal_type: { value: 'string' }, sys_id: 'fixture-description' },
  { name: 'sys_ui_policy_action', element: 'ui_policy', internal_type: { value: 'reference' }, reference: { value: 'sys_ui_policy' }, sys_id: 'fixture-link' },
];
it('schema evidence checker resolves inherited fields and exact base-table references', () => {
  assert.deepEqual(checkBatchSchema(rows, adapters), [
    { adapter: 'catalog_ui_policy', table: 'catalog_ui_policy', field: 'short_description', declared_on: 'sys_ui_policy', internal_type: 'string', reference: null, dictionary_sys_id: 'fixture-description' },
    { adapter: 'catalog_ui_policy_action', table: 'catalog_ui_policy_action', field: 'ui_policy', declared_on: 'sys_ui_policy_action', internal_type: 'reference', reference: 'sys_ui_policy', dictionary_sys_id: 'fixture-link' },
  ]);
});
it('schema evidence checker rejects missing fields and invented parent mappings', () => {
  assert.throws(() => checkBatchSchema(rows.slice(0, 1), adapters), /Unconfirmed field/);
  assert.throws(() => checkBatchSchema([rows[0], { ...rows[1], reference: { value: 'sc_cat_item' } }], adapters), /Unconfirmed reference/);
});
it('schema evidence checker rejects incompatible boolean and integer declarations', () => {
  for (const type of ['boolean', 'integer']) {
    assert.throws(() => checkBatchSchema([rows[0]], [{ ...adapters[0], fields: { short_description: { type } } }]), /Wrong .* type/);
  }
});
