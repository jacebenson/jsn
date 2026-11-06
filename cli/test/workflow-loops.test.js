import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectWorkflow, formatWorkflowOutline } from '../src/workflow-inspection.js';

const id = n => n.toString(16).padStart(32, '0');
async function inspect(names, edges, options = {}) {
  const calls = [];
  const tables = {
    wf_workflow: [{ sys_id: id(900), name: 'Graph' }],
    wf_workflow_version: [{ sys_id: id(901), workflow: id(900), name: 'Graph', published: 'true', active: 'true' }],
    wf_activity: names.map((name, i) => ({ sys_id: id(i + 1), name })),
    wf_transition: edges.map(([from, to], i) => ({
      sys_id: id(100 + i), from: id(from), to: id(to), condition: id(500 + i),
    })),
    wf_condition: edges.map(([from, , name = 'Success'], i) => ({
      sys_id: id(500 + i), activity: id(from), name,
    })),
  };
  const sdk = { listStrict: async (table, params) => {
    calls.push(table);
    if (options.denied === table) throw Object.assign(new Error('denied'), { status: 403 });
    const rows = tables[table] || [];
    if (options.reverse) return [...rows].reverse();
    assert.ok(params instanceof URLSearchParams);
    return rows;
  } };
  const data = await inspectWorkflow(sdk, { identifier: id(900), limit: options.limit || 200 });
  // Round-trip the actual public JSON, rather than a separate graph-only API.
  const json = JSON.parse(JSON.stringify(data));
  const text = formatWorkflowOutline(json);
  const expectedCalls = ['wf_workflow', 'wf_workflow_version', 'wf_activity'];
  if (names.length && options.denied !== 'wf_activity') expectedCalls.push('wf_condition', 'wf_transition');
  expectedCalls.push('wf_stage');
  if (names.length && options.denied !== 'wf_activity') expectedCalls.push('sys_variable_value');
  assert.deepEqual(calls, expectedCalls);
  assert.equal(json.transitions_by_activity.reduce((n, group) => n + group.transitions.length, 0),
    options.denied === 'wf_transition' || options.denied === 'wf_activity' ? 0 : edges.length);
  assert.deepEqual(json.transitions_by_activity.flatMap(group => group.transitions).sort((a, b) => a.sys_id.localeCompare(b.sys_id)),
    [...json.transitions].sort((a, b) => a.sys_id.localeCompare(b.sys_id)));
  return { json, text };
}

const cases = [
  ['pure DAG explicitly reports zero loops', ['Begin', 'End', 'Middle'], [[1, 3], [3, 2]], []],
  ['two-activity cycle includes both edges and external entry', ['Begin', 'A', 'B'], [[1, 2], [2, 3], [3, 2]], [[2, 3]]],
  ['self-loop is a loop', ['A'], [[1, 1]], [[1]]],
  ['two disjoint cycles are separate loops', ['A', 'B', 'C', 'D'], [[1, 2], [2, 1], [3, 4], [4, 3]], [[1, 2], [3, 4]]],
  ['duplicate edges retain different conditions', ['A', 'B'], [[1, 2, 'Approved'], [1, 2, 'Rejected'], [2, 1]], [[1, 2]]],
  ['cycle reachable only through one branch is found', ['Begin', 'End', 'A', 'B'], [[1, 2], [1, 3], [3, 4], [4, 3]], [[3, 4]]],
];
for (const [name, names, edges, expected] of cases) {
  test(name, async () => {
    const { json, text } = await inspect(names, edges);
    assert.equal(json.coverage.loop_detection_complete, true);
    assert.equal(json.coverage.loops_found, expected.length);
    assert.deepEqual(json.loops.map(loop => loop.members.map(member => member.sys_id)), expected.map(ids => ids.map(id)));
    assert.match(text, /▶ LOOPS/);
    if (!expected.length) {
      assert.match(text, /no loops detected/);
      assert.doesNotMatch(text, /↺/);
    } else {
      assert.doesNotMatch(text, /no loops detected/);
      for (const loop of json.loops) {
        const memberIds = new Set(loop.members.map(member => member.sys_id));
        const internal = json.transitions.filter(edge => memberIds.has(edge.from_id) && memberIds.has(edge.to_id));
        assert.deepEqual(loop.edges.map(edge => edge.sys_id).sort(), internal.map(edge => edge.sys_id).sort());
        const entries = new Set(json.transitions.filter(edge => !memberIds.has(edge.from_id) && memberIds.has(edge.to_id)).map(edge => edge.to_id));
        assert.deepEqual(loop.entry_points.map(member => member.sys_id).sort(), [...entries].sort());
        for (const member of loop.members) assert.ok(text.includes(`${member.name} [${member.sys_id}]`));
        for (const edge of loop.edges) assert.ok(text.includes(`↺ → ${edge.to_name} [${edge.condition_name}]`));
      }
    }
    for (const group of json.transitions_by_activity) {
      assert.ok(text.includes(`\n  ${group.name}\n`));
      for (const edge of group.transitions) assert.ok(text.includes(`→ ${edge.to_name} [${edge.condition_name}]`));
    }
  });
}

test('activity with no outgoing transitions retains explicit group heading', async () => {
  const { json, text } = await inspect(['Begin', 'End'], [[1, 2]]);
  assert.deepEqual(json.transitions_by_activity.find(group => group.name === 'End').transitions, []);
  assert.match(text, /\n {2}End\n {4}\(no outgoing transitions\)/);
});

test('group and edge ordering uses name then sys_id without mutating flat transitions', async () => {
  const names = ['Z', 'A', 'A'];
  const edges = [[1, 3, 'Rejected'], [1, 2, 'Approved'], [1, 2, 'Skipped']];
  const normal = await inspect(names, edges);
  const reversed = await inspect(names, edges, { reverse: true });
  assert.deepEqual(normal.json.transitions_by_activity, reversed.json.transitions_by_activity);
  assert.deepEqual(normal.json.transitions_by_activity.map(group => group.sys_id), [id(2), id(3), id(1)]);
  assert.deepEqual(normal.json.transitions_by_activity[2].transitions.map(edge => edge.sys_id), [id(100), id(101), id(102)]);
  assert.deepEqual(normal.json.transitions.map(edge => edge.sys_id), [id(100), id(101), id(102)]);
});

for (const [name, names, edges, options] of [
  ['denied activities', ['A'], [], { denied: 'wf_activity' }],
  ['denied transitions', ['A'], [[1, 1]], { denied: 'wf_transition' }],
  ['truncated activities', ['A', 'B'], [[1, 2]], { limit: 1 }],
  ['outside endpoint', ['A'], [[1, 2]], {}],
  ['unset endpoint', ['A'], [[1, 0]], {}],
  ['transition bound reached', ['A', 'End'], Array.from({ length: 1000 }, () => [1, 2]), {}],
]) {
  test(`${name}: incomplete detection never claims no loops`, async () => {
    const { json, text } = await inspect(names, edges, options);
    assert.equal(json.coverage.loop_detection_complete, false);
    assert.equal(json.coverage.loops_found, 0);
    assert.match(text, /detection is incomplete/);
    assert.doesNotMatch(text, /no loops detected/);
    if (edges.length === 1000) {
      assert.equal(json.coverage.transitions_truncated, true);
      assert.equal(json.coverage.complete, false);
    }
  });
}

test('empty complete graph explicitly reports zero loops', async () => {
  const { json, text } = await inspect([], []);
  assert.equal(json.coverage.loop_detection_complete, true);
  assert.deepEqual(json.loops, []);
  assert.deepEqual(json.transitions_by_activity, []);
  assert.match(text, /no loops detected/);
});

test('unreadable conditions preserve topology detection and integrity warnings', async () => {
  const { json, text } = await inspect(['A'], [[1, 1]], { denied: 'wf_condition' });
  assert.equal(json.coverage.complete, false);
  assert.equal(json.coverage.loop_detection_complete, true);
  assert.equal(json.loops.length, 1);
  assert.equal(json.integrity.unresolved_transition_conditions.length, 1);
  assert.match(text, /↺ → A \[.*unreadable\]/);
  assert.match(text, /conditions: inaccessible/);
});

test('observed cycle remains visible when overall detection is incomplete', async () => {
  const { json, text } = await inspect(['A', 'B'], [[1, 1], [1, 3]]);
  assert.equal(json.coverage.loop_detection_complete, false);
  assert.equal(json.loops.length, 1);
  assert.match(text, /↺ → A/);
  assert.match(text, /observed; detection incomplete/);
  assert.doesNotMatch(text, /no loops detected/);
});
