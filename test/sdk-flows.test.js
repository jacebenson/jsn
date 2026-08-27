import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { decodeGzipJson, hydrateFlowBlocks } from '../src/sdk.js';
import { normalizeFlowContext, summarizeFlowContexts, formatFlowContextSummary, aggregateFlowContextMappings, mergeFlowContextStats, buildFlowContextQuery } from '../src/flow-context.js';

test('normalizeFlowContext maps runtime timestamps and derives duration', () => {
  const result = normalizeFlowContext({
    sys_id: 'ctx-1', name: { display_value: 'Approval flow' }, execution_id: 'exec-1',
    state: { display_value: 'COMPLETED' }, started: '2026-08-26 10:00:00', ended: '2026-08-26 10:01:12',
  });
  assert.equal(result.flow, 'Approval flow');
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.started, '2026-08-26 10:00:00');
  assert.equal(result.ended, '2026-08-26 10:01:12');
  assert.equal(result.duration_seconds, 72);
});

test('normalizeFlowContext derives waiting age and exposes errors', () => {
  const result = normalizeFlowContext({
    name: 'Wait flow', state: 'WAITING', sys_created_on: '2026-08-26 09:58:00',
    wait_for: 'approval', error_message: 'Approval timed out',
  }, { now: new Date('2026-08-26T10:00:00Z') });
  assert.equal(result.waiting_age_seconds, 120);
  assert.equal(result.wait_for, 'approval');
  assert.equal(result.error, 'Approval timed out');
});
function gzipB64(obj) {
  return gzipSync(Buffer.from(JSON.stringify(obj), 'utf-8')).toString('base64');
}

test('normalizeFlowContext separates waiting age from running age and reports mapping', () => {
  const waiting = normalizeFlowContext({ state: 'WAITING', started: '2026-08-26 09:58:00' }, { now: new Date('2026-08-26T10:00:00Z') });
  const running = normalizeFlowContext({ state: 'RUNNING', started: '2026-08-26 09:58:00' }, { now: new Date('2026-08-26T10:00:00Z') });
  assert.equal(waiting.waiting_age_seconds, 120);
  assert.equal(waiting.execution_age_seconds, null);
  assert.equal(running.waiting_age_seconds, null);
  assert.equal(running.execution_age_seconds, 120);
  assert.equal(waiting.field_mapping.started, 'started');
  assert.deepEqual(waiting.missing_fields, ['ended', 'duration']);
});

test('normalizeFlowContext does not call row creation time execution age', () => {
  const result = normalizeFlowContext({ state: 'RUNNING', sys_created_on: '2026-08-26 09:58:00' }, { now: new Date('2026-08-26T10:00:00Z') });
  assert.equal(result.execution_age_seconds, null);
  assert.equal(result.duration_seconds, null);
  assert.equal(result.field_mapping.started, 'sys_created_on');
});
test('buildFlowContextQuery creates bounded, ordered queries', () => {
  assert.equal(
    buildFlowContextQuery({ record: 'abc', since: '2026-08-25 00:00:00', until: '2026-08-26 00:00:00', query: 'state=WAITING' }),
    'source_record=abc^sys_created_on>=2026-08-25 00:00:00^sys_created_on<=2026-08-26 00:00:00^state=WAITING^ORDERBYDESCsys_created_on',
  );
  assert.throws(() => buildFlowContextQuery({ since: '2026-08-25^bad=true' }), /invalid --since/);
});

test('summarizeFlowContexts groups statuses and duration metrics by flow', () => {
  const result = summarizeFlowContexts([
    { flow: 'Approval', status: 'COMPLETED', duration_seconds: 10, waiting_age_seconds: null },
    { flow: 'Approval', status: 'ERROR', duration_seconds: 30, waiting_age_seconds: null },
    { flow: 'Wait', status: 'WAITING', duration_seconds: null, waiting_age_seconds: 90 },
  ]);
  assert.equal(result.count, 3);
  assert.deepEqual(result.by_flow.Approval.statuses, { COMPLETED: 1, ERROR: 1 });
  assert.deepEqual(result.by_flow.Approval.duration_seconds, { count: 2, min: 10, max: 30, average: 20 });
  assert.equal(result.by_flow.Wait.waiting_count, 1);
});
test('formatFlowContextSummary renders the local summary for terminal users', () => {
  const text = formatFlowContextSummary({ total_count: 2, sample_count: 2, by_flow: {
    Approval: { count: 2, sampled: 2, statuses: { COMPLETED: 1, ERROR: 1 }, waiting_count: 0, duration_seconds: { count: 2, min: 10, max: 30, average: 20 } },
  } });
  assert.match(text, /FLOW EXECUTIONS/);
  assert.match(text, /Approval/);
  assert.match(text, /COMPLETED: 1, ERROR: 1/);
  assert.match(text, /10s-30s, avg 20s/);
});
test('aggregateFlowContextMappings reports mixed record mappings', () => {
  assert.deepEqual(aggregateFlowContextMappings([
    { field_mapping: { status: 'state', started: 'started' } },
    { field_mapping: { status: 'execution_state', started: 'started' } },
  ]), { status: 'mixed', started: 'started', ended: null, duration: null, wait_for: null, error: null });
});
test('mergeFlowContextStats keeps server counts separate from sampled metrics', () => {
  const result = mergeFlowContextStats([
    { groupby_fields: [{ field: 'name', value: 'Approval' }, { field: 'state', value: 'Waiting' }], stats: { count: '99' } },
  ], { count: 2, by_flow: { Approval: { count: 2, statuses: { Waiting: 2 }, waiting_count: 2, duration_seconds: { count: 0, min: null, max: null, average: null } } } }, 99);
  assert.equal(result.total_count, 99);
  assert.equal(result.sample_count, 2);
  assert.equal(result.by_flow.Approval.count, 99);
  assert.equal(result.by_flow.Approval.sampled, 2);
  assert.equal(result.by_flow.Approval.waiting_count, 2);
});
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

test('formatActionStep resolves guid-prefixed pills via label cache', async () => {
  const { formatActionStep } = await import('../src/commands/dev/flows.js');
  const action = {
    actionType: { fName: 'Create Catalog Task' },
    inputs: [
      {
        name: 'ah_fields',
        displayValue: 'short_description=Session: {{a1190b0a-ec10-45db-96b0-38f329306ed3.session_title}}^description={{a1190b0a-ec10-45db-96b0-38f329306ed3.first_name}}',
        value: 'short_description=Session: {{a1190b0a-ec10-45db-96b0-38f329306ed3.session_title}}^description={{a1190b0a-ec10-45db-96b0-38f329306ed3.first_name}}',
      },
    ],
  };
  const ctx = {
    labelCache: new Map([
      ['a1190b0a-ec10-45db-96b0-38f329306ed3.session_title', '1 - Get Catalog Variables➛session_title'],
      ['a1190b0a-ec10-45db-96b0-38f329306ed3.first_name', '1 - Get Catalog Variables➛first_name'],
    ]),
  };
  const lines = formatActionStep(1, '', action, ctx);
  const fieldLines = lines.filter(l => l.includes('ah_fields:'));
  assert.equal(fieldLines.length, 2, 'each carrot field gets its own line');
  assert.ok(fieldLines[0].includes('1 - Get Catalog Variables➛session_title'), 'guid pill resolved to label');
  assert.ok(fieldLines[1].includes('1 - Get Catalog Variables➛first_name'), 'second guid pill resolved');
  assert.ok(!fieldLines[0].includes('a1190b0a-ec10-45db-96b0-38f329306ed3'), 'raw guid gone');
});

test('formatActionStep keeps guid pills raw when label cache is absent', async () => {
  const { formatActionStep } = await import('../src/commands/dev/flows.js');
  const action = {
    actionType: { fName: 'Create Catalog Task' },
    inputs: [
      {
        name: 'ah_fields',
        displayValue: 'short_description=Session: {{a1190b0a-ec10-45db-96b0-38f329306ed3.session_title}}',
        value: 'short_description=Session: {{a1190b0a-ec10-45db-96b0-38f329306ed3.session_title}}',
      },
    ],
  };
  const lines = formatActionStep(1, '', action); // no ctx
  const fieldLine = lines.find(l => l.includes('ah_fields:'));
  assert.ok(fieldLine.includes('{{a1190b0a-ec10-45db-96b0-38f329306ed3.session_title}}'), 'guid pill preserved without cache');
});

test('formatActionStep resolves only guid pills, leaves readable step refs raw', async () => {
  const { formatActionStep } = await import('../src/commands/dev/flows.js');
  const action = {
    actionType: { fName: 'Create Catalog Task' },
    inputs: [
      {
        name: 'ah_fields',
        displayValue: 'requested_item={{Service Catalog_1.request_item}}^track={{a1190b0a-ec10-45db-96b0-38f329306ed3.track}}',
        value: 'requested_item={{Service Catalog_1.request_item}}^track={{a1190b0a-ec10-45db-96b0-38f329306ed3.track}}',
      },
    ],
  };
  const ctx = {
    labelCache: new Map([
      ['a1190b0a-ec10-45db-96b0-38f329306ed3.track', '1 - Get Catalog Variables➛track'],
    ]),
  };
  const lines = formatActionStep(1, '', action, ctx);
  const fieldLines = lines.filter(l => l.includes('ah_fields:'));
  const joined = fieldLines.join('\n');
  assert.ok(joined.includes('{{Service Catalog_1.request_item}}'), 'readable step ref stays raw');
  assert.ok(joined.includes('1 - Get Catalog Variables➛track'), 'guid pill resolved');
  assert.ok(!joined.includes('a1190b0a-ec10-45db-96b0-38f329306ed3'), 'guid gone from resolved pill');
});

test('formatActionStep renders unset inputs instead of hiding them', async () => {
  const { formatActionStep } = await import('../src/commands/dev/flows.js');
  const lines = formatActionStep(1, '', {
    actionType: { fName: 'Create Flow Data' },
    inputs: [
      { name: 'definition', displayValue: 'Update Record', parameter: { label: 'Definition' } },
      { name: 'assigned_to', value: '', parameter: { label: 'Assigned To' } },
      { name: 'wait', displayValue: 'No', parameter: { label: 'Wait for user input' } },
      { name: 'assignment_group', value: '', parameter: { label: 'Assignment group' } },
      { name: 'state', displayValue: 'In Progress', parameter: { label: 'State' } },
    ],
  });
  assert.deepEqual(lines, [
    '1. Create Flow Data',
    '    Definition: Update Record',
    '    Assigned To: (not set)',
    '    Wait for user input: No',
    '    Assignment group: (not set)',
    '    State: In Progress',
  ]);
});
test('formatFlowInspection expands custom action steps as numbered recipes', async () => {
  const { formatFlowInspection } = await import('../src/commands/dev/flows.js');
  const inspection = {
    flow: { name: 'Uses custom action', active: true, version: '2', type: 'Flow', sysID: 'flow-1' },
    version: {},
    payload: {
      actionInstances: [{
        actionType: { fName: 'Call controller' },
        order: 1,
      }],
    },
    triggerInstances: [],
    actionInstances: [],
    flowLogicInstances: [],
    subFlowInstances: [],
    flowInputs: [],
    flowOutputs: [],
    flowVariables: [],
  };
  const output = await formatFlowInspection(inspection, {
    depth: 2,
    visited: new Set(['flow-1']),
    sdk: {
      inspectCustomAction: async (name) => {
        assert.equal(name, 'Call controller');
        return { steps: [
          { label: 'Call jace.pro/rest', step_type: { display_value: 'REST' }, order: 2 },
          { label: 'Transform response', step_type: { display_value: 'Transform' }, order: 3 },
          { label: 'Run cleanup script', step_type: { display_value: 'Script' }, order: 1 },
        ] };
      },
    },
  });
  assert.match(output, /Step 1: Run cleanup script - Script/);
  assert.match(output, /Step 2: Call jace\.pro\/rest - REST/);
  assert.match(output, /Step 3: Transform response - Transform/);
  assert.match(output, /Internal action steps/);
});

test('formatFlowInspection hides redundant built-in action internals', async () => {
  const { formatFlowInspection } = await import('../src/commands/dev/flows.js');
  const output = await formatFlowInspection({
    flow: { name: 'Built-in flow', active: true, type: 'Flow', sysID: 'flow-3' },
    version: {}, payload: { actionInstances: [{ actionType: { fName: 'Update Record' }, order: 1 }] },
    triggerInstances: [], actionInstances: [], flowLogicInstances: [], subFlowInstances: [],
    flowInputs: [], flowOutputs: [], flowVariables: [],
  }, {
    depth: 2,
    visited: new Set(['flow-3']),
    sdk: { inspectCustomAction: async () => ({ steps: [
      { label: 'Update Record step', step_type: { display_value: 'Update Record' }, order: 1 },
    ] }) },
  });
  assert.doesNotMatch(output, /Internal action steps/);
});

test('formatFlowInspection does not fetch custom action steps at depth 1', async () => {
  const { formatFlowInspection } = await import('../src/commands/dev/flows.js');
  let called = false;
  const output = await formatFlowInspection({
    flow: { name: 'Shallow flow', active: true, type: 'Flow', sysID: 'flow-2' },
    version: {}, payload: { actionInstances: [{ actionType: { fName: 'Hidden details' }, order: 1 }] },
    triggerInstances: [], actionInstances: [], flowLogicInstances: [], subFlowInstances: [],
    flowInputs: [], flowOutputs: [], flowVariables: [],
  }, {
    depth: 1,
    visited: new Set(['flow-2']),
    sdk: { inspectCustomAction: async () => { called = true; return { steps: [] }; } },
  });
  assert.equal(called, false);
  assert.doesNotMatch(output, /CUSTOM ACTION STEPS/);
});
