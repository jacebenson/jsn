import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectWorkflow, formatWorkflowOutline } from '../src/workflow-inspection.js';

const id = n => n.toString(16).padStart(32, '0');
async function inspect(names, edges, options = {}) {
  const calls = [];
  const tables = {
    wf_workflow: [{ sys_id: id(900), name: 'Graph' }],
    wf_workflow_version: [{ sys_id: id(901), workflow: id(900), start: options.noStart ? '' : id(options.start || 1), name: 'Graph', published: 'true', active: 'true' }],
    wf_activity: names.map((name, i) => ({ sys_id: id(i + 1), name })),
    wf_transition: edges.map(([from, to, name], i) => ({
      sys_id: id(100 + i), from: id(from), to: id(to), condition: name === null ? '' : id(500 + i),
    })),
    wf_condition: edges.map(([from, , name = 'Success'], i) => ({
      sys_id: id(500 + i), activity: id(from), name,
    })),
    sys_variable_value: options.variables || [],
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
    assert.doesNotMatch(text, /▶ LOOPS|no loops detected/);
    if (!expected.length) {
      assert.doesNotMatch(text, /↺/);
    } else {
      assert.doesNotMatch(text, /no loops detected/);
      for (const loop of json.loops) {
        const memberIds = new Set(loop.members.map(member => member.sys_id));
        const internal = json.transitions.filter(edge => memberIds.has(edge.from_id) && memberIds.has(edge.to_id));
        assert.deepEqual(loop.edges.map(edge => edge.sys_id).sort(), internal.map(edge => edge.sys_id).sort());
        const entries = new Set(json.transitions.filter(edge => !memberIds.has(edge.from_id) && memberIds.has(edge.to_id)).map(edge => edge.to_id));
        assert.deepEqual(loop.entry_points.map(member => member.sys_id).sort(), [...entries].sort());
        assert.ok(text.includes('↺'));
      }
    }
    assert.doesNotMatch(text, /\b[0-9a-f]{32}\b/i);
    for (const step of json.steps) {
      assert.ok(text.includes(`\n  ${step.number}. ${step.name}`));
    }
  });
}

test('activity with no outgoing transitions retains explicit group heading', async () => {
  const { json, text } = await inspect(['Begin', 'End'], [[1, 2]]);
  assert.deepEqual(json.transitions_by_activity.find(group => group.name === 'End').transitions, []);
  assert.match(text, /\n {2}2\. End\n/);
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
  assert.doesNotMatch(text, /no loops detected|▶ LOOPS/);
});

test('unreadable conditions preserve topology detection and integrity warnings', async () => {
  const { json, text } = await inspect(['A'], [[1, 1]], { denied: 'wf_condition' });
  assert.equal(json.coverage.complete, false);
  assert.equal(json.coverage.loop_detection_complete, true);
  assert.equal(json.loops.length, 1);
  assert.equal(json.integrity.unresolved_transition_conditions.length, 1);
  assert.match(text, /↺ → step 1 A \[unreadable condition\]/);
  assert.match(text, /conditions: inaccessible/);
});

test('observed cycle remains visible when overall detection is incomplete', async () => {
  const { json, text } = await inspect(['A', 'B'], [[1, 1], [1, 3]]);
  assert.equal(json.coverage.loop_detection_complete, false);
  assert.equal(json.loops.length, 1);
  assert.match(text, /↺ → step 1 A/);
  assert.equal(text.split('\n').filter(line => line.includes('Loop detection is incomplete')).length, 1);
  assert.doesNotMatch(text, /▶ LOOPS/);
  assert.doesNotMatch(text, /no loops detected/);
});

function section(text, heading) {
  return text.split(`▶ ${heading}\n${'─'.repeat(50)}\n`)[1].split('\n\n')[0].split('\n');
}

for (const condition of ['Approved', 'Approve', 'Success', 'OK', 'True', 'Yes', 'Completed']) {
  test(`success condition ${condition} wins case-insensitively over neutral and exception edges`, async () => {
    const mixed = condition.toUpperCase();
    const { json, text } = await inspect(['Begin', 'A failure', 'B neutral', 'Z success'],
      [[1, 2, 'Rejected'], [1, 3, 'Other'], [1, 4, mixed]]);
    assert.deepEqual(section(text, 'STEPS'), ['  1. Begin', '       → step 4 A failure [Rejected]',
      '       → step 3 B neutral [Other]', '  2. Z success (end)', '  3. B neutral (end)', '  4. A failure (end)']);
    assert.deepEqual(json.transitions.filter(edge => edge.is_sequential).map(edge => edge.sys_id), [id(102)]);
  });
}

for (const condition of ['Rejected', 'Reject', 'Failure', 'Failed', 'Error', 'Skipped', 'Cancelled', 'Canceled', 'Timeout', 'Expired']) {
  test(`exception ${condition} is sequential only as the sole outgoing edge`, async () => {
    const mixed = condition.toUpperCase();
    const branched = await inspect(['Begin', 'A exception', 'Z neutral'], [[1, 2, mixed], [1, 3, 'Other']]);
    assert.deepEqual(section(branched.text, 'STEPS'), ['  1. Begin', `       → step 3 A exception [${mixed}]`,
      '  2. Z neutral (end)', '  3. A exception (end)']);
    const sole = await inspect(['Begin', 'End'], [[1, 2, mixed]]);
    assert.deepEqual(section(sole.text, 'STEPS'), ['  1. Begin', '  2. End']);
    assert.equal(sole.json.transitions[0].is_sequential, true);
    const multiple = await inspect(['Begin', 'End'], [[1, 2, mixed], [1, 2, mixed]]);
    assert.deepEqual(section(multiple.text, 'STEPS'), ['  1. Begin', `       → step 2 End [${mixed}]`,
      `       → step 2 End [${mixed}]`, '  2. End']);
    assert.ok(multiple.json.transitions.every(edge => !edge.is_sequential));
  });
}

for (const name of ['End', 'Approval END', 'Finish', 'All fInIsH', 'Done', 'All dOnE', 'Stop', 'Please sToP', 'Archive']) {
  test(`terminal label for ${name} suppresses only a redundant end marker`, async () => {
    const { text } = await inspect(['Begin', name], [[1, 2]]);
    assert.deepEqual(section(text, 'STEPS'), ['  1. Begin', `  2. ${name}${name === 'Archive' ? ' (end)' : ''}`]);
  });
}

for (const [name, names, edges, options, expected, sequential] of [
  ['Approved is sequential while Rejected and Skipped stay explicit exceptions',
    ['Begin', 'Change Manager Group Approval', 'Proposal Rejected', 'Show no approvers message', 'Validate Proposal', 'End'],
    [[1, 2], [2, 3, 'Rejected'], [2, 4, 'Skipped'], [2, 5, 'Approved'], [5, 6], [3, 6], [4, 6]], {},
    ['  1. Begin', '  2. Change Manager Group Approval', '       → step 4 Proposal Rejected [Rejected]',
      '       → step 5 Show no approvers message [Skipped]', '  3. Validate Proposal', '       → step 6 End [Success]',
      '  4. Proposal Rejected', '       → step 6 End [Success]', '  5. Show no approvers message', '  6. End'], [100, 103, 106]],
  ['terminal steps follow rollback and retain stable traversal order among themselves',
    ['Begin', 'End', 'Rollback', 'Other terminal'], [[1, 2, 'Always'], [1, 3, 'Rejected'], [3, 4]], {},
    ['  1. Begin', '       → step 3 End [Always]', '       → step 2 Rollback [Rejected]',
      '  2. Rollback', '       → step 4 Other terminal [Success]', '  3. End', '  4. Other terminal (end)'], []],
  ['numbering follows start through a silent linear chain, not activity input order',
    ['End', 'Middle', 'Begin'], [[3, 2], [2, 1]], { start: 3 },
    ['  1. Begin', '  2. Middle', '  3. End'], [100, 101]],
  ['branch prints only the non-sequential edge and prefers Always over a conditioned edge',
    ['Begin', 'A rejected', 'Z accepted'], [[1, 2, 'Rejected'], [1, 3, 'Always']], {},
    ['  1. Begin', '       → step 3 A rejected [Rejected]', '  2. Z accepted (end)', '  3. A rejected (end)'], [101]],
  ['loop back-edge alone gets a closing marker and summary uses step numbers',
    ['Begin', 'Approve', 'Validate', 'End'], [[1, 2], [2, 3], [3, 2, 'Failure'], [3, 4, 'Always']], {},
    ['  1. Begin', '  2. Approve', '  3. Validate', '       ↺ → step 2 Approve [Failure]', '  4. End'], [100, 101, 103]],
  ['unreachable activities append by name then ID and do not imply a sequence',
    ['Begin', 'Z detached', 'A detached', 'End', 'A detached'], [[1, 4], [3, 5]], {},
    ['  1. Begin', '       → step 3 End [Success]', '  2. A detached (not reached from start)',
      '       → step 4 A detached [Success]', '  3. End', '  4. A detached (not reached from start; end)',
      '  5. Z detached (not reached from start; end)'], []],
  ['parallel conditions to the next step retain the non-preferred exception',
    ['Begin', 'End'], [[1, 2, 'Rejected'], [1, 2, 'Always']], {},
    ['  1. Begin', '       → step 2 End [Rejected]', '  2. End'], [101]],
  ['unconditional edge is preferred and duplicate conditions remain explicit',
    ['Begin', 'End'], [[1, 2, 'Rejected'], [1, 2, null]], {},
    ['  1. Begin', '       → step 2 End [Rejected]', '  2. End'], [101]],
  ['unreadable transitions fallback does not invent terminal steps',
    ['Begin', 'End'], [[1, 2]], { denied: 'wf_transition' },
    ['  Order fallback: activities or transitions not readable; stable name/sys_id order, not a flow sequence.',
      '  1. Begin (not reached from start; order fallback; no outgoing transitions observed; detection incomplete)',
      '  2. End (not reached from start; order fallback; no outgoing transitions observed; detection incomplete)'], []],
  ['no-start fallback explicitly disclaims sequence and hides no edges',
    ['Z', 'A'], [[1, 2]], { noStart: true },
    ['  Order fallback: no start activity; stable name/sys_id order, not a flow sequence.',
      '  1. A (not reached from start; order fallback; end)', '  2. Z (not reached from start; order fallback)',
      '       → step 1 A [Success]'], []],
  ['missing-start fallback is stable and explicit',
    ['Z', 'A'], [[2, 1]], { start: 99 },
    ['  Order fallback: start activity not in the readable activities; stable name/sys_id order, not a flow sequence.',
      '  1. A (not reached from start; order fallback)', '       → step 2 Z [Success]',
      '  2. Z (not reached from start; order fallback; end)'], []],
]) {
  test(name, async () => {
    const { json, text } = await inspect(names, edges, options);
    assert.deepEqual(section(text, 'STEPS'), expected);
    assert.deepEqual(json.transitions.filter(edge => edge.is_sequential).map(edge => edge.sys_id).sort(), sequential.map(id));
    assert.ok(json.transitions.every(edge => typeof edge.is_sequential === 'boolean'));
    assert.deepEqual(json.steps.map(step => step.number), names.map((_, i) => i + 1));
    assert.ok(json.steps.every(step => typeof step.reached_from_start === 'boolean' && step.sys_id && step.name));
    const reversed = await inspect(names, edges, { ...options, reverse: true });
    assert.deepEqual(reversed.json.steps, json.steps);
    assert.deepEqual(section(reversed.text, 'STEPS'), expected);
    assert.doesNotMatch(text, /▶ LOOPS/);
  });
}

test('ids inside script content are preserved, never redacted', async () => {
  // A Run Script activity commonly hardcodes a workflow or record id. For a workflow
  // inspector those values are the data; rewriting them inside a script body produces
  // code that looks corrupted and hides what the step actually does.
  const hardcoded = '78d9b342ff010200f6d6ffffffffff9d';
  const { json } = await inspect(['Begin', 'Run It'], [[1, 2, 'Always']], {
    variables: [{
      sys_id: id(700),
      document: id(2),
      document_key: id(2),
      'variable.element': 'script',
      value: `var wf = new Workflow();\nwf.startFlow('${hardcoded}', current, current.operation(), {});`,
    }],
  });
  const text = formatWorkflowOutline(json, { includeConfiguration: true });
  assert.ok(text.includes(hardcoded), 'the hardcoded id must survive into the rendered script');
  assert.ok(!text.includes('(ID in --json)'), 'no blanket id redaction may be applied to rendered output');
});
