import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTypedInputs, validateFlowManifest } from '../src/flow-create.js';

// Shape captured from a live ServiceNow instance (Australia patch 3) for the
// Global "Log" action: identity plus schema, with NO `parameter` block. The
// earlier contract demanded `parameter` and rejected every real published action.
const liveLogAction = {
  type: '0e0ae8c2531003003bf1d9109ec587c8',
  inputs: { log_level: 'info', log_message: 'hello' },
};
const liveLogSchema = [
  {
    name: 'log_level', label: 'Level', type: 'choice', mandatory: false,
    id: '8f4aa006531003003bf1d9109ec587aa', defaultValue: 'info',
    choices: [{ label: 'Info', value: 'info' }, { label: 'Error', value: 'error' }],
    attributes: { uiUniqueId: 'ignored-generated-metadata' },
  },
  { name: 'log_message', label: 'Message', type: 'string', mandatory: false, id: 'c34aa006531003003bf1d9109ec587c4' },
];

test('a real published action schema without a parameter block is accepted', () => {
  const inputs = buildTypedInputs(liveLogAction, liveLogSchema);
  assert.equal(inputs.length, 2);
  assert.deepEqual(inputs.map(input => input.name), ['log_level', 'log_message']);
  assert.deepEqual(inputs[0].value, { schemaless: false, schemalessValue: '', value: 'info' });
  assert.deepEqual(inputs[0].displayValue, { schemaless: false, schemalessValue: '', value: 'info' });
  assert.equal(inputs[0].id, '8f4aa006531003003bf1d9109ec587aa');
  assert.equal(inputs[0].attributes.uiUniqueId, 'ignored-generated-metadata');
  assert.equal(inputs[0].parameter, undefined, 'the provider omitted parameter, so it must stay omitted');
});

test('an optional parameter block is echoed back unchanged when the provider sends one', () => {
  const schema = [{ name: 'condition', type: 'conditions', id: 'abc123', parameter: { label: 'Condition', nested: true } }];
  const inputs = buildTypedInputs({ type: 'action-1', inputs: { condition: 'x=1' } }, schema);
  assert.deepEqual(inputs[0].parameter, { label: 'Condition', nested: true });
});

test('identity-free or malformed schemas are still refused', () => {
  assert.throws(() => buildTypedInputs({ type: 'action-1', inputs: {} }, [{ name: 'missing_id', type: 'string' }]), /incomplete input schema/);
  assert.throws(() => buildTypedInputs({ type: 'action-1', inputs: {} }, [{ id: 'only-id', type: 'string' }]), /incomplete input schema/);
  assert.throws(() => buildTypedInputs({ type: 'action-1', inputs: {} }, [null]), /incomplete input schema/);
  assert.throws(() => buildTypedInputs({ type: 'action-1', inputs: {} }, [{ name: 'x', id: 'i', type: 'string', parameter: [] }]), /malformed parameter block/);
});

test('required inputs and unknown supplied names are still enforced', () => {
  assert.throws(() => buildTypedInputs({ type: 'action-1', inputs: {} }, [{ name: 'x', id: 'i', type: 'string', mandatory: true }]), /Missing required input "x"/);
  assert.throws(() => buildTypedInputs({ type: 'action-1', inputs: { nope: 1 } }, [{ name: 'x', id: 'i', type: 'string' }]), /Unsupported input "nope"/);
});

test('the guided flow manifest accepts a real action input map', () => {
  const manifest = validateFlowManifest({
    name: 'JSN real action', scope: 'global',
    trigger: { type: 'record_create_or_update', table: 'ticket', condition: 'short_descriptionLIKEtest' },
    actions: [{ type: liveLogAction.type, inputs: liveLogAction.inputs }],
  });
  assert.equal(manifest.actions[0].inputs.log_level, 'info');
});
