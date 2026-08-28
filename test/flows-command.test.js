import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flowsCmd } from '../src/commands/dev/flows.js';
import { catalogResolver } from '../src/flow-inspection-internals.js';

function commandTree() {
  const commands = [];
  const yargs = {
    command(definition) { commands.push(definition); return this; },
    option() { return this; },
  };
  flowsCmd(fn => fn).builder(yargs);
  return commands;
}

test('flows show handler emits the normal Output envelope and formatted data', async () => {
  const show = commandTree().find(command => command.command === 'show <identifier>');
  assert.ok(show);
  const id = 'a524f7ca9fa502100f8b65b23b0a1cdb';
  const inspection = { flow: { name: 'Production flow', active: true, version: '2', type: 'Flow', sysID: 'flow-1' }, version: {}, payload: {
    actionInstances: [{ order: 1, actionType: { fName: 'Get Catalog Variables' }, inputs: [{ name: 'catalog_variables', displayValue: `${id}:item_option_new` }] }],
  }, triggerInstances: [], actionInstances: [], flowLogicInstances: [], subFlowInstances: [], flowInputs: [], flowOutputs: [], flowVariables: [] };
  Object.defineProperty(inspection, catalogResolver, { value: async () => [{ sys_id: id, question_text: 'Permission type' }] });
  const output = [];
  const app = {
    sdk: { inspectFlow: async () => inspection, inspectCustomAction: async () => null },
    output: { ok(data, opts) { output.push({ ok: true, data, summary: opts.summary }); } },
    ok(data, opts) { this.output.ok(data, opts); },
    getEffectiveInstance: () => 'https://example.service-now.com',
  };
  await show.handler({ identifier: 'flow-1', depth: 2 }, app);
  assert.equal(output.length, 1);
  assert.equal(output[0].ok, true);
  assert.equal(output[0].summary, 'Flow: Production flow');
  assert.match(output[0].data._formatted, /Permission type/);
});
