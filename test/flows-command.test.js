import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { flowsCmd } from '../src/commands/dev/flows.js';
import { OutputWriter, FormatJSON } from '../src/output.js';

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
  inspection.catalogRecords = [{ sys_id: id, question_text: 'Permission type' }];
  let serialized = '';
  const writer = new Writable({ write(chunk, _encoding, callback) { serialized += chunk.toString(); callback(); } });
  const output = new OutputWriter({ format: FormatJSON, writer });
  const app = {
    sdk: { inspectFlow: async () => inspection, inspectCustomAction: async () => null },
    output,
    ok(data, opts) { this.output.ok(data, opts); },
    getEffectiveInstance: () => 'https://example.service-now.com',
  };
  await show.handler({ identifier: 'flow-1', depth: 2 }, app);
  const envelope = JSON.parse(serialized);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.summary, 'Flow: Production flow');
  assert.match(envelope.data._formatted, /Permission type/);
});

test('flows list handler emits the normal JSON envelope for an interactive selection', async () => {
  const list = commandTree().find(command => command.command === 'list');
  assert.ok(list);
  const id = 'a524f7ca9fa502100f8b65b23b0a1cdb';
  const inspection = { flow: { name: 'Production flow', active: true, version: '2', type: 'Flow', sysID: 'flow-1' }, version: {}, payload: {
    actionInstances: [{ order: 1, actionType: { fName: 'Get Catalog Variables' }, inputs: [{ name: 'catalog_variables', displayValue: `${id}:item_option_new` }] }],
  }, triggerInstances: [], actionInstances: [], flowLogicInstances: [], subFlowInstances: [], flowInputs: [], flowOutputs: [], flowVariables: [],
    catalogRecords: [{ sys_id: id, question_text: 'Permission type' }] };
  let serialized = '';
  const writer = new Writable({ write(chunk, _encoding, callback) { serialized += chunk.toString(); callback(); } });
  const output = new OutputWriter({ format: FormatJSON, writer });
  const app = {
    sdk: { aggregateCount: async () => 1, list: async () => [], inspectFlow: async () => inspection, inspectCustomAction: async () => null },
    output,
    promptFn: async () => ({ value: { sys_id: 'flow-1', name: 'Production flow' } }),
    requireInstance() {},
    ok(data, opts) { this.output.ok(data, opts); },
    getEffectiveInstance: () => 'https://example.service-now.com',
  };
  await list.handler({ columns: undefined, query: '', limit: 50, depth: 2 }, app);
  const envelope = JSON.parse(serialized);
  assert.deepEqual(Object.keys(envelope), ['ok', 'data', 'summary', 'breadcrumbs']);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.summary, 'Flow: Production flow');
  assert.match(envelope.data._formatted, /Permission type/);
  assert.equal('catalogRecords' in envelope.data, false);
});
