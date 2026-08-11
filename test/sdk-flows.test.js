import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { decodeGzipJson, hydrateFlowBlocks } from '../src/sdk.js';

function gzipB64(obj) {
  return gzipSync(Buffer.from(JSON.stringify(obj), 'utf-8')).toString('base64');
}

test('decodeGzipJson decodes base64-gzip JSON with surrounding whitespace', () => {
  const payload = { inputs: [{ name: 'condition', value: '{{x}}ISNOTEMPTY' }], variables: [] };
  const raw = `\n\t\t\t${gzipB64(payload)}`;
  const result = decodeGzipJson(raw);
  assert.deepEqual(result, payload);
});

test('decodeGzipJson handles display_value/value object form', () => {
  const payload = { inputs: [] };
  const result = decodeGzipJson({ display_value: gzipB64(payload), value: gzipB64(payload) });
  assert.deepEqual(result, payload);
});

test('decodeGzipJson returns null for empty input', () => {
  assert.equal(decodeGzipJson(''), null);
  assert.equal(decodeGzipJson(null), null);
  assert.equal(decodeGzipJson(undefined), null);
  assert.equal(decodeGzipJson('   '), null);
});

test('decodeGzipJson returns null for non-gzip strings', () => {
  assert.equal(decodeGzipJson('plain json {"a":1}'), null);
  assert.equal(decodeGzipJson('H4sI not-valid-base64'), null);
});

test('decodeGzipJson returns null for corrupt gzip', () => {
  assert.equal(decodeGzipJson('H4sIAAAAAAAA/w=='), null);
});

test('hydrateFlowBlocks builds flowBlock nesting from flat parent links', () => {
  const payload = {
    flowLogicInstances: [
      { uiUniqueIdentifier: 'if-1', flowLogicDefinition: { name: 'If' }, order: '1' },
      { uiUniqueIdentifier: 'if-2', flowLogicDefinition: { name: 'If' }, order: '3', parent: 'if-1' },
    ],
    actionInstances: [
      { name: 'Update Record', order: '2', parent: 'if-1' },
      { name: 'Log', order: '4', parent: 'if-2' },
    ],
  };
  hydrateFlowBlocks(payload);
  const if1 = payload.flowLogicInstances[0];
  const if2 = payload.flowLogicInstances[1];
  assert.ok(Array.isArray(if1.flowBlock), 'If-1 should have a flowBlock');
  assert.equal(if1.flowBlock.length, 2, 'If-1 should contain action + nested If');
  assert.deepEqual(if1.flowBlock.map(x => x.name ?? x.uiUniqueIdentifier), ['Update Record', 'if-2']);
  assert.ok(Array.isArray(if2.flowBlock), 'If-2 should have a flowBlock');
  assert.deepEqual(if2.flowBlock.map(x => x.name), ['Log']);
});

test('hydrateFlowBlocks leaves existing flowBlock arrays alone (version-payload shape)', () => {
  const payload = {
    flowLogicInstances: [
      { uiUniqueIdentifier: 'if-1', flowLogicDefinition: { name: 'If' }, flowBlock: [{ name: 'Update Record' }] },
    ],
    actionInstances: [{ name: 'Update Record', parent: 'if-1' }],
  };
  hydrateFlowBlocks(payload);
  assert.deepEqual(payload.flowLogicInstances[0].flowBlock.map(x => x.name), ['Update Record']);
});

test('hydrateFlowBlocks handles empty input', () => {
  const payload = {};
  hydrateFlowBlocks(payload);
  assert.deepEqual(payload, {});
});

test('formatFlowInspection renders flow variables with labels and types', async () => {
  const { formatFlowInspection } = await import('../src/commands/dev/flows.js');
  const inspection = {
    flow: { name: 'jace flow', active: true, version: '2', type: 'Flow', sysID: 'abc123' },
    version: {},
    payload: {},
    triggerInstances: [],
    actionInstances: [],
    flowLogicInstances: [],
    subFlowInstances: [],
    flowInputs: [],
    flowOutputs: [],
    flowVariables: [
      { name: 'food', label: 'food', type: 'string', type_label: 'String', order: 1 },
      { name: 'quantity', label: 'quantity', type: 'integer', type_label: 'Integer', order: 2 },
      { name: 'ordering_person', label: 'ordering person', type: 'reference', type_label: 'Reference', order: 3 },
    ],
  };
  const output = await formatFlowInspection(inspection, { instanceURL: '', depth: 1, visited: new Set() });
  assert.ok(output.includes('▶ FLOW VARIABLES'), 'section header present');
  assert.ok(output.includes('• food: String'), 'food variable with type');
  assert.ok(output.includes('• quantity: Integer'), 'quantity variable with type');
  assert.ok(output.includes('• ordering person: Reference'), 'ordering person variable with type');
});

test('formatFlowInspection omits variables section when none exist', async () => {
  const { formatFlowInspection } = await import('../src/commands/dev/flows.js');
  const inspection = {
    flow: { name: 'plain', active: true, version: '2', type: 'Flow', sysID: 'abc123' },
    version: {},
    payload: {},
    triggerInstances: [],
    actionInstances: [],
    flowLogicInstances: [],
    subFlowInstances: [],
    flowInputs: [],
    flowOutputs: [],
    flowVariables: [],
  };
  const output = await formatFlowInspection(inspection, { instanceURL: '', depth: 1, visited: new Set() });
  assert.ok(!output.includes('FLOW VARIABLES'), 'no section when no variables');
});

test('formatSubFlowStep resolves parentFlow (real flow id) over subflowSysId (snapshot id)', async () => {
  const { formatSubFlowStep } = await import('../src/commands/dev/flows.js');
  const subFlow = {
    subflowSysId: 'snapshot-123', // snapshot id — should NOT be used
    subFlow: { parentFlow: 'flow-456', name: 'My Subflow' },
    name: 'My Subflow',
  };
  let resolvedId = null;
  const ctx = {
    sdk: { inspectFlow: async (id) => { resolvedId = id; return { flow: { sysID: id }, payload: {} }; } },
    instanceURL: 'https://x.service-now.com',
    depth: 2,
    visited: new Set(['parent-flow']),
  };
  const lines = await formatSubFlowStep(1, '', subFlow, ctx);
  assert.equal(resolvedId, 'flow-456', 'should recurse into subFlow.parentFlow, not subflowSysId');
  assert.ok(lines[0].includes('My Subflow'), 'first line names the subflow');
});

test('formatSubFlowStep shows hint at depth 1 instead of recursing', async () => {
  const { formatSubFlowStep } = await import('../src/commands/dev/flows.js');
  const subFlow = {
    subflowSysId: 'snapshot-123',
    subFlow: { parentFlow: 'flow-456', name: 'My Subflow' },
    name: 'My Subflow',
  };
  let called = false;
  const ctx = {
    sdk: { inspectFlow: async () => { called = true; return {}; } },
    instanceURL: 'https://x.service-now.com',
    depth: 1,
    visited: new Set(['parent-flow']),
  };
  const lines = await formatSubFlowStep(1, '', subFlow, ctx);
  assert.equal(called, false, 'should not fetch at depth 1');
  assert.ok(lines.some(l => l.includes('jsn flows show')), 'should show drill hint');
});

test('formatSubFlowStep guards against cycles via visited set', async () => {
  const { formatSubFlowStep } = await import('../src/commands/dev/flows.js');
  const subFlow = {
    subflowSysId: 'snapshot-123',
    subFlow: { parentFlow: 'flow-456', name: 'Loop Subflow' },
    name: 'Loop Subflow',
  };
  let called = false;
  const ctx = {
    sdk: { inspectFlow: async () => { called = true; return {}; } },
    instanceURL: 'https://x.service-now.com',
    depth: 3,
    visited: new Set(['flow-456']), // already visited → cycle
  };
  await formatSubFlowStep(1, '', subFlow, ctx);
  assert.equal(called, false, 'should not re-fetch an already-visited subflow');
});

test('formatActionStep keeps long single-line values untruncated', async () => {
  const { formatActionStep } = await import('../src/commands/dev/flows.js');
  const longValue = 'x'.repeat(200);
  const action = {
    actionType: { fName: 'Create Record' },
    inputs: [
      { name: 'short_description', displayValue: longValue, value: longValue },
    ],
  };
  const lines = formatActionStep(1, '', action);
  const line = lines.find(l => l.includes('short_description'));
  assert.ok(line.includes(longValue), 'long value should appear in full, not truncated');
  assert.ok(!line.includes('...'), 'no ellipsis truncation');
  assert.equal(lines.length, 2, 'name line + one value line');
});

test('formatActionStep splits carrot-separated fields onto separate lines', async () => {
  const { formatActionStep } = await import('../src/commands/dev/flows.js');
  const action = {
    actionType: { fName: 'Update Record' },
    inputs: [
      { name: 'fields', displayValue: 'state=7^work_notes=Auto-closing: No application found^priority=1', value: 'state=7^work_notes=Auto-closing: No application found^priority=1' },
    ],
  };
  const lines = formatActionStep(1, '', action);
  const fieldLines = lines.filter(l => l.includes('fields:'));
  assert.equal(fieldLines.length, 3, 'each carrot field gets its own line');
  assert.ok(fieldLines.some(l => l.includes('state=7')), 'first field present');
  assert.ok(fieldLines.some(l => l.includes('work_notes=Auto-closing: No application found')), 'second field present, untruncated');
  assert.ok(fieldLines.some(l => l.includes('priority=1')), 'third field present');
});

test('formatActionStep resolves catalog variable sys_ids to readable names', async () => {
  const { formatActionStep } = await import('../src/commands/dev/flows.js');
  const action = {
    actionType: { fName: 'Get Catalog Variables' },
    inputs: [
      {
        name: 'catalog_variables',
        displayValue: 'a524f7ca9fa502100f8b65b23b0a1cdb:item_option_new,03fc6fc29fa502100f8b65b23b0a1c29:item_option_new',
        value: 'a524f7ca9fa502100f8b65b23b0a1cdb:item_option_new,03fc6fc29fa502100f8b65b23b0a1c29:item_option_new',
        parameter: { label: 'Catalog Variables' },
      },
    ],
  };
  const ctx = {
    catalogVarNames: new Map([
      ['a524f7ca9fa502100f8b65b23b0a1cdb', 'Permission type'],
      ['03fc6fc29fa502100f8b65b23b0a1c29', 'Application Name'],
    ]),
  };
  const lines = formatActionStep(1, '', action, ctx);
  const catalogLine = lines.find(l => l.includes('Catalog Variables:'));
  assert.ok(catalogLine, 'catalog variables line present');
  assert.ok(catalogLine.includes('Permission type'), 'first variable resolved to question_text');
  assert.ok(catalogLine.includes('Application Name'), 'second variable resolved to question_text');
  assert.ok(!catalogLine.includes('item_option_new'), 'raw sys_id pairs replaced');
});

test('formatActionStep keeps raw sys_ids when no resolver map exists', async () => {
  const { formatActionStep } = await import('../src/commands/dev/flows.js');
  const action = {
    actionType: { fName: 'Get Catalog Variables' },
    inputs: [
      {
        name: 'catalog_variables',
        displayValue: 'a524f7ca9fa502100f8b65b23b0a1cdb:item_option_new',
        value: 'a524f7ca9fa502100f8b65b23b0a1cdb:item_option_new',
        parameter: { label: 'Catalog Variables' },
      },
    ],
  };
  const lines = formatActionStep(1, '', action); // no ctx
  const catalogLine = lines.find(l => l.includes('Catalog Variables:'));
  assert.ok(catalogLine.includes('a524f7ca9fa502100f8b65b23b0a1cdb:item_option_new'), 'raw pairs preserved without resolver');
});

test('formatActionStep leaves non-catalog values untouched even with resolver map', async () => {
  const { formatActionStep } = await import('../src/commands/dev/flows.js');
  const action = {
    actionType: { fName: 'Update Record' },
    inputs: [
      { name: 'short_description', displayValue: '{{Created_1.table_name}}', value: '{{Created_1.table_name}}' },
    ],
  };
  const ctx = {
    catalogVarNames: new Map([['a524f7ca9fa502100f8b65b23b0a1cdb', 'Permission type']]),
  };
  const lines = formatActionStep(1, '', action, ctx);
  const line = lines.find(l => l.includes('short_description'));
  assert.ok(line.includes('{{Created_1.table_name}}'), 'pills stay raw');
  assert.ok(!line.includes('Permission type'), 'no catalog substitution on non-pair values');
});
