import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { decodeGzipJson, hydrateFlowBlocks } from '../src/sdk.js';
import { normalizeFlowContext, summarizeFlowContexts, formatFlowContextSummary, aggregateFlowContextMappings, mergeFlowContextStats, buildFlowContextQuery } from '../src/flow-context.js';
import { catalogResolver } from '../src/flow-inspection-internals.js';

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



const baseFlow = (name, payload = {}) => ({
  flow: { name, active: true, version: '2', type: 'Flow', sysID: name },
  version: {}, payload, triggerInstances: [], actionInstances: [], flowLogicInstances: [],
  subFlowInstances: [], flowInputs: [], flowOutputs: [], flowVariables: [],
});

async function inspectPublic(inspection, { depth = 2, nested = new Map(), customAction, catalogResolverFn } = {}) {
  const calls = [];
  const adapter = {
    inspectFlow: async (identifier) => {
      calls.push(identifier);
      if (identifier === inspection.flow.sysID) {
        const result = { ...inspection };
        if (catalogResolverFn) Object.defineProperty(result, catalogResolver, { value: catalogResolverFn });
        return result;
      }
      if (nested.has(identifier)) {
        const value = nested.get(identifier);
        if (value instanceof Error) throw value;
        return value;
      }
      throw new Error(`missing fixture: ${identifier}`);
    },
    inspectCustomAction: async (identifier) => customAction?.(identifier),
  };
  const { inspectFlow } = await import('../src/flow-inspection.js');
  return { result: await inspectFlow({ adapter, identifier: inspection.flow.sysID, instanceURL: 'https://example.service-now.com', depth }), calls };
}

test('public inspection seam propagates a missing root unchanged', async () => {
  const { inspectFlow } = await import('../src/flow-inspection.js');
  const error = Object.assign(new Error('flow not found: missing'), { code: 'not_found' });
  await assert.rejects(() => inspectFlow({ adapter: { inspectFlow: async () => { throw error; } }, identifier: 'missing' }), (actual) => actual === error);
});

test('public inspection seam degrades nested subflow failures inline', async () => {
  const parent = baseFlow('parent', { subFlowInstances: [{ order: 1, subFlow: { parentFlow: 'child', name: 'Child' } }] });
  const { result } = await inspectPublic(parent, { nested: new Map([['child', new Error('permission denied')]]) });
  assert.match(result._formatted, /could not load subflow: permission denied/);
});

test('public seam degrades malformed nested inspection payloads through fallback', async () => {
  const parent = baseFlow('parent', { subFlowInstances: [{ order: 1, subFlow: { parentFlow: 'child', name: 'Child' } }] });
  const { result } = await inspectPublic(parent, { nested: new Map([['child', null]]) });
  assert.match(result._formatted, /↪ Child/);
  assert.doesNotMatch(result._formatted, /could not load subflow/);
});

test('public inspection seam reuses custom-action results for repeated references', async () => {
  let count = 0;
  const flow = baseFlow('root', { actionInstances: [
    { order: 1, actionType: { fName: 'Shared action' } },
    { order: 2, actionType: { fName: 'Shared action' } },
  ] });
  const { result } = await inspectPublic(flow, { customAction: async () => { count++; return { steps: [{ label: 'Do useful work', order: 1 }] }; } });
  assert.equal(count, 1);
  assert.equal((result._formatted.match(/Internal action steps/g) || []).length, 2);
});

test('public inspection seam observes depth-one hints and cycle prevention', async () => {
  const flow = baseFlow('root', { subFlowInstances: [{ order: 1, subFlow: { parentFlow: 'child', name: 'Child' } }] });
  const child = baseFlow('child', { subFlowInstances: [{ order: 1, subFlow: { parentFlow: 'root', name: 'Root' } }] });
  const shallow = await inspectPublic(flow, { depth: 1, nested: new Map([['child', child]]) });
  assert.match(shallow.result._formatted, /jsn flows show "Child"/);
  const deep = await inspectPublic(flow, { depth: 3, nested: new Map([['child', child]]) });
  assert.equal(deep.calls.filter(id => id === 'child').length, 1);
  assert.doesNotMatch(deep.result._formatted, /missing fixture/);
});

test('public inspection seam consumes catalog labels supplied by the adapter result', async () => {
  const id = 'a524f7ca9fa502100f8b65b23b0a1cdb';
  const flow = baseFlow('catalog', { actionInstances: [{ order: 1, actionType: { fName: 'Get Catalog Variables' }, inputs: [{ name: 'catalog_variables', displayValue: `${id}:item_option_new`, parameter: { label: 'Catalog Variables' } }] }] });
  const { result } = await inspectPublic(flow, { catalogResolverFn: async () => [{ sys_id: id, question_text: 'Permission type' }] });
  assert.match(result._formatted, /Permission type/);
  assert.doesNotMatch(result._formatted, /item_option_new/);
});

test('public inspection seam returns stable data and formatted output', async () => {
  const flow = baseFlow('stable');
  const { result } = await inspectPublic(flow, { depth: 0 });
  assert.equal(result.flow.name, 'stable');
  assert.equal(typeof result._formatted, 'string');
  assert.match(result._formatted, /sys_hub_flow\.do\?sys_id=stable/);
});

test('public seam renders variables and omits empty sections', async () => {
  const flow = baseFlow('vars');
  flow.flowVariables = [{ name: 'food', label: 'food', type_label: 'String', order: 1 }];
  const { result } = await inspectPublic(flow);
  assert.match(result._formatted, /FLOW VARIABLES/);
  assert.match(result._formatted, /food: String/);
  assert.doesNotMatch(result._formatted, /SUBFLOW/);
});

test('public seam preserves long values and splits encoded fields', async () => {
  const longValue = 'x'.repeat(200);
  const flow = baseFlow('values', { actionInstances: [{ order: 1, actionType: { fName: 'Update Record' }, inputs: [
    { name: 'short_description', displayValue: longValue },
    { name: 'fields', displayValue: 'state=7^work_notes=Auto-closing: No application found^priority=1' },
  ] }] });
  const { result } = await inspectPublic(flow);
  assert.match(result._formatted, new RegExp(longValue));
  assert.match(result._formatted, /state=7/);
  assert.match(result._formatted, /work_notes=Auto-closing: No application found/);
  assert.match(result._formatted, /priority=1/);
});

test('public seam resolves catalog and GUID pills while preserving readable refs', async () => {
  const id = 'a524f7ca9fa502100f8b65b23b0a1cdb';
  const guid = 'a1190b0a-ec10-45db-96b0-38f329306ed3';
  const flow = baseFlow('pills', { labelCacheAsJsonString: JSON.stringify([{ name: `${guid}.session_title`, label: '1 - Get Catalog Variables➛session_title' }]), actionInstances: [{ order: 1, actionType: { fName: 'Get Catalog Variables' }, inputs: [
    { name: 'catalog_variables', displayValue: `${id}:item_option_new` },
    { name: 'fields', displayValue: `x={{${guid}.session_title}}^y={{Created_1.table_name}}` },
  ] }] });
  const { result } = await inspectPublic(flow, {
    catalogResolverFn: async () => [{ sys_id: id, question_text: 'Permission type' }],
  });
  assert.match(result._formatted, /Permission type/);
  assert.doesNotMatch(result._formatted, /item_option_new/);
  assert.match(result._formatted, /1 - Get Catalog Variables➛session_title/);
});

test('public seam suppresses built-in action internals', async () => {
  const flow = baseFlow('builtin', { actionInstances: [{ order: 1, actionType: { fName: 'Update Record' } }] });
  const { result } = await inspectPublic(flow, { customAction: async () => ({ steps: [{ label: 'Update Record step' }] }) });
  assert.doesNotMatch(result._formatted, /Internal action steps/);
});

test('public seam caches catalog lookups by table and id', async () => {
  const id = 'a524f7ca9fa502100f8b65b23b0a1cdb';
  let count = 0;
  const flow = baseFlow('catalog-cache', { actionInstances: [
    { order: 1, actionType: { fName: 'Get Catalog Variables' }, inputs: [{ name: 'catalog_variables', displayValue: `${id}:item_option_new` }] },
    { order: 2, actionType: { fName: 'Get Catalog Variables' }, inputs: [{ name: 'catalog_variables', displayValue: `${id}:item_option_new` }] },
  ] });
  const adapter = {
    inspectFlow: async () => {
      const result = { ...flow };
      Object.defineProperty(result, catalogResolver, { value: async () => { count++; return [{ sys_id: id, question_text: 'Permission type' }]; } });
      return result;
    },
    inspectCustomAction: async () => null,
  };
  const { inspectFlow } = await import('../src/flow-inspection.js');
  const result = await inspectFlow({ adapter, identifier: 'catalog-cache' });
  assert.equal(count, 1);
  assert.equal((result._formatted.match(/Permission type/g) || []).length, 2);
});

test('flow inspection exports only inspectFlow', async () => {
  const module = await import('../src/flow-inspection.js');
  assert.deepEqual(Object.keys(module), ['inspectFlow']);
});
