import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { flowsCmd } from '../src/commands/flows.js';
import { OutputWriter, FormatJSON } from '../src/output.js';
import { collectCapabilities, mutationPaths } from '../src/capabilities.js';

function commandTree() {
  const commands = [];
  const yargs = {
    command(definition) { commands.push(definition); return this; },
    option() { return this; },
  };
  flowsCmd(fn => fn).builder(yargs);
  return commands;
}

function jsonApp(sdk, { requireInstance = () => {} } = {}) {
  let serialized = '';
  const writer = new Writable({ write(chunk, _encoding, callback) { serialized += chunk.toString(); callback(); } });
  const output = new OutputWriter({ format: FormatJSON, writer });
  return {
    app: {
      sdk,
      output,
      requireInstance,
      ok(data, opts) { this.output.ok(data, opts); },
      getEffectiveInstance: () => 'https://example.service-now.com',
    },
    envelope: () => JSON.parse(serialized),
  };
}

function handler(name) {
  return commandTree().find(command => command.command === name);
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

test('publish, status, and doctor handlers require an instance', async () => {
  const cases = [
    ['publish <identifier>', { identifier: 'flow-name' }],
    ['status <identifier>', { identifier: 'flow-name' }],
    ['doctor', {}],
  ];

  for (const [name, argv] of cases) {
    const { app } = jsonApp({
      get: async () => { throw new Error('SDK should not be called'); },
      list: async () => { throw new Error('SDK should not be called'); },
    }, { requireInstance: () => { throw new Error('Instance URL required'); } });
    await assert.rejects(() => handler(name).handler(argv, app), /Instance URL required/);
  }
});

test('publish handler resolves a named flow, declares mutation, and emits JSON', async () => {
  const calls = [];
  const sdk = {
    baseURL: 'https://example.service-now.com',
    async list(table, params) {
      calls.push(['list', table, Object.fromEntries(params)]);
      return [{ sys_id: 'flow-1', name: 'Named flow' }];
    },
    async fetchResponse(url, options) {
      calls.push(['publish', url, JSON.parse(options.body)]);
      return {
        status: 200,
        async text() {
          return JSON.stringify({ result: {
            summary: { total: 1, succeeded: 1, failed: 0 },
            results: [{ sys_id: 'flow-1', status: 'success', flow_name: 'Named flow' }],
          } });
        },
      };
    },
  };
  const { app, envelope } = jsonApp(sdk);

  await handler('publish <identifier>').handler({ identifier: 'flow-name', action: false }, app);

  assert.deepEqual(calls[0], ['list', 'sys_hub_flow', {
    sysparm_query: 'name=flow-name',
    sysparm_limit: '1',
    sysparm_display_value: 'all',
  }]);
  assert.deepEqual(calls[1][2].flows, [{ sys_id: 'flow-1', active: 'true', state: '' }]);
  assert.deepEqual(calls[1][2].actions, []);
  assert.ok(mutationPaths(collectCapabilities()).some(path =>
    path.length === 2 && path[0] === 'flows' && path[1] === 'publish'));
  const out = envelope();
  assert.equal(out.ok, true);
  assert.equal(out.data.results[0].sys_id, 'flow-1');
  assert.match(out.summary, /Published 1\/1/);
});

test('publish --action skips flow lookup and publishes the supplied action sys_id', async () => {
  let flowLookup = false;
  let published;
  const sdk = {
    baseURL: 'https://example.service-now.com',
    async list(table) {
      if (table === 'sys_hub_flow') flowLookup = true;
      if (table === 'sys_hub_action_type_definition') return [{ sys_id: 'action-1', name: 'Named action' }];
      return [];
    },
    async fetchResponse(_url, options) {
      published = JSON.parse(options.body);
      return { status: 200, async text() { return JSON.stringify({ result: {
        summary: { total: 1, succeeded: 1, failed: 0 }, results: [{ sys_id: 'action-1', status: 'success' }],
      } }); } };
    },
  };
  const { app } = jsonApp(sdk);
  await handler('publish <identifier>').handler({ identifier: 'action-name', action: true }, app);
  assert.equal(flowLookup, false);
  assert.deepEqual(published.actions, [{ sys_id: 'action-1', active: 'true', state: '' }]);
  assert.deepEqual(published.flows, []);
});

test('status handler resolves the flow and uses flow status SDK seams', async () => {
  const calls = [];
  const sdk = {
    async get(table, identifier) {
      calls.push(['get', table, identifier]);
      return { sys_id: 'flow-1', name: 'Named flow', type: 'flow', master_snapshot: 'snap-1', version: '2', active: 'true' };
    },
    async list(table, params) {
      calls.push(['list', table, Object.fromEntries(params)]);
      if (table === 'sys_hub_flow') return [{ sys_id: 'flow-1', name: 'Named flow' }];
      if (table === 'sys_hub_trigger_instance_v2') return [{ trigger_type: 'service_catalog', trigger_inputs: '' }];
      return [];
    },
  };
  const { app, envelope } = jsonApp(sdk);

  await handler('status <identifier>').handler({ identifier: 'flow-name' }, app);

  assert.deepEqual(calls.map(call => call.slice(0, 3)), [
    ['list', 'sys_hub_flow', calls[0][2]],
    ['get', 'sys_hub_flow', 'flow-1'],
    ['list', 'sys_hub_trigger_instance_v2', calls[2][2]],
  ]);
  assert.equal(calls[0][2].sysparm_query, 'name=flow-name');
  assert.equal(calls[2][2].sysparm_query, 'flow=flow-1');
  const out = envelope();
  assert.equal(out.ok, true);
  assert.equal(out.data.flow.sysID, 'flow-1');
  assert.equal(out.data.ok, true);
});

test('doctor handler uses the SDK health-check tables and emits JSON', async () => {
  const tables = [];
  const sdk = {
    async list(table, params) {
      tables.push([table, Object.fromEntries(params)]);
      if (table === 'sys_ws_definition') return [{ name: 'WFA', base_uri: '/api/now/wfa_fluent', active: 'true' }];
      if (table === 'sys_ws_operation') return [{ name: 'Activate', http_method: 'POST', relative_path: '/activate_flows', active: 'true' }];
      if (table === 'sys_plugins') return [
        { name: 'ServiceNow IDE Platform', active: 'true' },
        { name: 'ServiceNow IDE Runtime Services', active: 'true' },
      ];
      return [];
    },
  };
  const { app, envelope } = jsonApp(sdk);

  await handler('doctor').handler({}, app);

  assert.deepEqual(tables.map(([table]) => table), ['sys_ws_definition', 'sys_ws_operation', 'sys_plugins']);
  assert.equal(tables[0][1].sysparm_query, 'service_id=wfa_fluent');
  assert.equal(tables[1][1].sysparm_query, 'relative_path=/activate_flows');
  const out = envelope();
  assert.equal(out.ok, true);
  assert.equal(out.data.ok, true);
  assert.match(out.summary, /Flow publishing/);
});
