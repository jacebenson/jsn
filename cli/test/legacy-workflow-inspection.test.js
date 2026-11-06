import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SDKClient } from '../src/sdk.js';
import {
  listWorkflows,
  inspectWorkflow,
  formatWorkflowOutline,
  listPublishedWorkflowVersionsForTable,
} from '../src/workflow-inspection.js';
import { workflowsCmd, parseWorkflowStep, selectWorkflowStep } from '../src/commands/workflows.js';

const CLI = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
const execute = promisify(execFile);

const WF = 'a'.repeat(32);
const WF2 = 'd'.repeat(32);
const V_PUBLISHED = 'b'.repeat(32);
const V_DRAFT = 'c'.repeat(32);
const V_OLD = 'e'.repeat(32);
const ACT_START = '1'.repeat(32);
const ACT_SCRIPT = '2'.repeat(32);
const ACT_APPROVAL = '3'.repeat(32);
const ACT_MISSING = '4'.repeat(32);
const DEF_START = '5'.repeat(32);
const DEF_SCRIPT = '6'.repeat(32);
const DEF_MISSING = '7'.repeat(32);
const COND_APPROVED = '8'.repeat(32);
const COND_ELSE = '9'.repeat(32);
const COND_UNREADABLE = '0'.repeat(32);

const field = (value, display = value) => ({ value, display_value: display });

const workflows = [
  { sys_id: field(WF), name: 'Incident approval', table: 'incident', description: 'Legacy approval' },
  { sys_id: field(WF2), name: 'Change gate', table: 'change_request', description: '' },
  { sys_id: field('f'.repeat(32)), name: 'Problem follow-up', table: 'problem', description: '' },
];

const versions = [
  {
    sys_id: field(V_PUBLISHED), workflow: field(WF), name: 'Incident approval', table: 'incident',
    published: field('true'), active: field('true'), start: field(ACT_START),
    condition: field('priority=1'), condition_type: field(''), sys_created_on: field('2024-04-02 10:00:00'),
    checked_out: '', checked_out_by: field(''),
  },
  {
    sys_id: field(V_DRAFT), workflow: field(WF), name: 'Incident approval draft', table: 'incident',
    published: field('false'), active: field('false'), start: field(ACT_START),
    condition: field('priority=1'), condition_type: field(''), sys_created_on: field('2024-04-03 10:00:00'),
    checked_out: field('2024-04-03 11:00:00'), checked_out_by: field('u'.repeat(32)), 'checked_out_by.name': field('Ada'),
  },
  {
    sys_id: field(V_OLD), workflow: field(WF), name: 'Incident approval v1', table: 'incident',
    published: field('true'), active: field('false'), start: field(ACT_START),
    condition: field(''), condition_type: field(''), sys_created_on: field('2024-01-02 10:00:00'),
  },
  {
    sys_id: field('9'.repeat(31) + '1'), workflow: field(WF2), name: 'Change gate', table: 'change_request',
    published: field('true'), active: field('true'), start: field(''),
    condition: field(''), condition_type: field(''), sys_created_on: field('2024-05-02 10:00:00'),
  },
];

const activities = [
  {
    sys_id: field(ACT_START), name: 'Begin', activity_definition: field(DEF_START),
    'activity_definition.name': field('Begin'), x: field('100'), y: field('100'), parent: '', stage: '', input: '',
  },
  {
    sys_id: field(ACT_SCRIPT), name: 'Tag record', activity_definition: field(DEF_SCRIPT),
    'activity_definition.name': field('Run Script'), x: field('200'), y: field('120'), parent: '', stage: '', input: '',
  },
  {
    sys_id: field(ACT_APPROVAL), name: 'Approval', activity_definition: field(DEF_MISSING),
    'activity_definition.name': '', x: field('300'), y: field('140'), parent: '', stage: '', input: '',
  },
];

const conditions = [
  {
    sys_id: field(COND_APPROVED), activity: field(ACT_APPROVAL), name: 'approved',
    condition: field('approval=approved'), order: field('1'), else_flag: field('false'),
    error: field('false'), event: '', event_name: '', short_description: '',
  },
  {
    sys_id: field(COND_ELSE), activity: field(ACT_APPROVAL), name: 'else',
    condition: field(''), order: field('2'), else_flag: field('true'),
    error: field('false'), event: '', event_name: '', short_description: '',
  },
];

const transitions = [
  { sys_id: 'a'.repeat(31) + '1', from: field(ACT_START), to: field(ACT_SCRIPT), condition: field('') },
  { sys_id: 'a'.repeat(31) + '2', from: field(ACT_SCRIPT), to: field(ACT_APPROVAL), condition: field('') },
  { sys_id: 'a'.repeat(31) + '3', from: field(ACT_APPROVAL), to: field(ACT_SCRIPT), condition: field(COND_APPROVED) },
  { sys_id: 'a'.repeat(31) + '4', from: field(ACT_APPROVAL), to: field(ACT_MISSING), condition: field(COND_UNREADABLE) },
];

const variableValues = [
  { document_key: field(ACT_SCRIPT), 'variable.element': field('script'), value: field('var gr = new GlideRecord("incident");\ngr.get(current.sys_id);\ngr.update();') },
  { document_key: field(ACT_SCRIPT), 'variable.element': field('table'), value: field('incident') },
];

const definitions = [
  { sys_id: field(DEF_START), name: field('Begin'), description: field('Start of the workflow'), sys_class_name: field('wf_activity_definition') },
  { sys_id: field(DEF_SCRIPT), name: field('Run Script'), description: field('Run a server-side script'), sys_class_name: field('wf_activity_definition') },
];

function queryOf(url) {
  return url.searchParams.get('sysparm_query') || '';
}

function idsIn(query, prefix) {
  const index = query.indexOf(prefix);
  if (index < 0) return null;
  return query.slice(index + prefix.length).split('^')[0].split(',');
}

/** Activities exist only in the version they belong to; other versions are empty. */
function activitiesFor(query) {
  return query.includes(`workflow_version=${V_PUBLISHED}`) || query.includes(`workflow_version=${V_DRAFT}`)
    ? activities
    : [];
}

/**
 * A Table API fixture. Every request is captured and asserted to be a GET;
 * a route may return an explicit {status} to simulate an ACL block.
 */
function fixtureRoutes(overrides = {}) {
  const routes = {
    wf_workflow: (url) => {
      const query = queryOf(url);
      if (query.startsWith('sys_id=')) return workflows.filter(row => query === `sys_id=${row.sys_id.value}`);
      if (query.startsWith('name=')) return workflows.filter(row => row.name === query.slice('name='.length));
      return workflows;
    },
    wf_workflow_version: (url) => {
      const query = queryOf(url);
      if (query.startsWith('sys_id=')) return versions.filter(row => query === `sys_id=${row.sys_id.value}`);
      if (query.includes('workflowIN')) {
        const ids = idsIn(query, 'workflowIN') || [];
        const scoped = versions.filter(row => ids.includes(row.workflow.value));
        if (query.includes('published=true')) return scoped.filter(row => row.published.value === 'true');
        if (query.includes('checked_outISNOTEMPTY')) return scoped.filter(row => row.checked_out);
        return scoped;
      }
      if (query.includes('table=incident')) return versions.filter(row => row.table === 'incident' && row.published.value === 'true');
      if (query.startsWith('workflow=')) {
        const id = query.slice('workflow='.length).split('^')[0];
        return versions.filter(row => row.workflow.value === id);
      }
      return versions;
    },
    wf_activity: (url) => activitiesFor(queryOf(url)),
    wf_condition: (url) => {
      const ids = idsIn(queryOf(url), 'activityIN');
      if (!ids) return conditions;
      return conditions.filter(row => ids.includes(row.activity.value));
    },
    wf_transition: (url) => {
      const ids = idsIn(queryOf(url), 'fromIN');
      if (!ids) return transitions;
      return transitions.filter(row => ids.includes(row.from.value));
    },
    wf_stage: () => [],
    wf_element_definition: (url) => {
      const ids = idsIn(queryOf(url), 'sys_idIN');
      if (!ids) return definitions;
      return definitions.filter(row => ids.includes(row.sys_id.value));
    },
    sys_variable_value: (url) => {
      const ids = idsIn(queryOf(url), 'document_keyIN');
      if (!ids) return variableValues;
      return variableValues.filter(row => ids.includes(row.document_key.value));
    },
    ...overrides,
  };
  return routes;
}

async function startFixture(overrides = {}) {
  const requests = [];
  const routes = fixtureRoutes(overrides);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    const isTable = url.pathname.startsWith('/api/now/table/');
    requests.push({ method: request.method, path: url.pathname, query: queryOf(url), table: isTable });
    response.setHeader('Content-Type', 'application/json');
    // Authentication bootstraps a session with POST /angular.do; record writes
    // are the boundary this reader must never cross.
    if (isTable) assert.equal(request.method, 'GET', `unexpected ${request.method} ${url.pathname}`);
    const table = url.pathname.replace('/api/now/table/', '');
    const route = routes[table];
    const result = typeof route === 'function' ? route(url) : route;
    if (result && !Array.isArray(result) && result.status) {
      response.writeHead(result.status);
      response.end(JSON.stringify({ error: { message: 'ACL denied' } }));
      return;
    }
    response.end(JSON.stringify({ result: result || [] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const sdk = new SDKClient(`http://127.0.0.1:${server.address().port}`, {
    getCredentials: () => ({ auth_method: 'gck', access_token: 'fixture-token' }),
  });
  return {
    sdk,
    requests,
    close: () => new Promise(resolve => {
      // Undici keeps sockets alive; without closing them `server.close`
      // waits out its keep-alive timeout and stretches the test.
      server.closeAllConnections?.();
      server.close(resolve);
    }),
    instance: `http://127.0.0.1:${server.address().port}`,
  };
}

function assertOnlyReads(requests, { allowAuth = false } = {}) {
  const tableRequests = requests.filter(request => request.table);
  assert.ok(tableRequests.length > 0, 'expected table reads');
  assert.deepEqual([...new Set(tableRequests.map(request => request.method))], ['GET']);
  const nonTable = [...new Set(requests.filter(request => !request.table).map(request => request.path))];
  assert.deepEqual(nonTable, allowAuth ? ['/angular.do'] : []);
}

test('workflows list paginates with lookahead and reports published and checked-out versions', async () => {
  const fixture = await startFixture();
  try {
    const data = await listWorkflows(fixture.sdk, { limit: 2, offset: 0 });
    assertOnlyReads(fixture.requests);
    assert.equal(data.engine, 'legacy_workflow_editor');
    assert.equal(data.records.length, 2);
    assert.equal(data.pagination.has_more, true);
    assert.equal(data.pagination.limit, 2);
    assert.equal(data.coverage.complete, true);
    const incident = data.records.find(record => record.name === 'Incident approval');
    assert.equal(incident.published_version.sys_id, V_PUBLISHED);
    assert.equal(incident.checked_out_version.sys_id, V_DRAFT);
    assert.equal(incident.checked_out_version.checked_out_by_name, 'Ada');
    assert.ok(fixture.requests.every(request => !/^\/api\/now\/table\/wf_workflow\//.test(request.path)));
  } finally {
    await fixture.close();
  }
});

test('workflows list bounds are rejected before any request', async () => {
  const calls = [];
  const sdk = { listStrict: async (...args) => { calls.push(args); return []; } };
  await assert.rejects(listWorkflows(sdk, { limit: 0 }), /--limit/);
  await assert.rejects(listWorkflows(sdk, { limit: 101 }), /--limit/);
  await assert.rejects(listWorkflows(sdk, { limit: 10, offset: -1 }), /--offset/);
  await assert.rejects(listWorkflows(sdk, { table: 'incident^NQactive=true' }), /--table/);
  assert.equal(calls.length, 0);
});

test('list reports an inaccessible version read instead of an empty version set', async () => {
  const fixture = await startFixture({
    wf_workflow_version: () => ({ status: 403 }),
  });
  try {
    const data = await listWorkflows(fixture.sdk, { limit: 5 });
    assertOnlyReads(fixture.requests);
    assert.equal(data.records.length, 3);
    assert.equal(data.coverage.complete, false);
    assert.equal(data.coverage.components.versions, 'inaccessible');
    assert.equal(data.records[0].published_version, null);
    assert.equal(data.records[0].version_state, 'inaccessible');
    assert.equal(data.records[0].version_http_status, 403);
  } finally {
    await fixture.close();
  }
});

test('workflows show selects the published version and preserves every link and ID', async () => {
  const fixture = await startFixture();
  try {
    const data = await inspectWorkflow(fixture.sdk, { identifier: 'Incident approval' });
    assertOnlyReads(fixture.requests);
    assert.equal(data.matched_by, 'name');
    assert.equal(data.workflow.sys_id, WF);
    assert.equal(data.selection.reason, 'latest_published');
    assert.equal(data.version.sys_id, V_PUBLISHED);
    assert.equal(data.versions.length, 3);
    assert.match(data.definition_scope, /not evidence that this version executed/);

    const scriptActivity = data.activities.find(activity => activity.sys_id === ACT_SCRIPT);
    assert.equal(scriptActivity.definition_name, 'Run Script');
    assert.equal(scriptActivity.configuration.script.startsWith('var gr'), true);
    assert.equal(scriptActivity.configuration.table, 'incident');

    const approval = data.activities.find(activity => activity.sys_id === ACT_APPROVAL);
    assert.equal(approval.conditions.length, 2);
    assert.equal(approval.conditions[0].sys_id, COND_APPROVED);
    assert.equal(approval.conditions[1].else_flag, true);

    const loop = data.transitions.find(transition => transition.sys_id === 'a'.repeat(31) + '3');
    assert.equal(loop.from_id, ACT_APPROVAL);
    assert.equal(loop.to_id, ACT_SCRIPT);
    assert.equal(loop.condition_id, COND_APPROVED);
    assert.equal(loop.condition_name, 'approved');
    assert.equal(loop.condition_status, 'ok');
    assert.equal(loop.status, 'ok');

    // Activity reads are scoped to the selected version, not the whole table.
    assert.ok(fixture.requests.some(request => request.path.endsWith('/wf_activity')
      && request.query.includes(`workflow_version=${V_PUBLISHED}`)));
  } finally {
    await fixture.close();
  }
});

test('workflows show reports missing definitions, dangling links and unreadable conditions explicitly', async () => {
  const fixture = await startFixture();
  try {
    const data = await inspectWorkflow(fixture.sdk, { identifier: WF });
    assertOnlyReads(fixture.requests);
    assert.equal(data.matched_by, 'sys_id');

    const approval = data.activities.find(activity => activity.sys_id === ACT_APPROVAL);
    assert.equal(approval.definition_status, 'missing');
    assert.deepEqual(data.integrity.missing_activity_definitions, [{
      activity_id: ACT_APPROVAL, activity_name: 'Approval', definition_id: DEF_MISSING,
    }]);

    assert.deepEqual(data.integrity.dangling_transitions, [{
      transition_id: 'a'.repeat(31) + '4',
      from_id: ACT_APPROVAL,
      to_id: ACT_MISSING,
      missing_endpoints: [ACT_MISSING],
    }]);
    assert.deepEqual(data.integrity.unresolved_transition_conditions, [{
      transition_id: 'a'.repeat(31) + '4',
      condition_id: COND_UNREADABLE,
    }]);
    const dangling = data.transitions.find(transition => transition.sys_id === 'a'.repeat(31) + '4');
    assert.equal(dangling.status, 'dangling');
    assert.equal(dangling.condition_status, 'missing');
    // Reads covered every requested component; the integrity warnings are
    // about the definition's links, not about missing coverage.
    assert.equal(data.coverage.complete, true);
  } finally {
    await fixture.close();
  }
});

test('workflows show keeps a readable partial definition when conditions are denied', async () => {
  const fixture = await startFixture({
    wf_condition: () => ({ status: 403 }),
  });
  try {
    const data = await inspectWorkflow(fixture.sdk, { identifier: WF });
    assertOnlyReads(fixture.requests);
    assert.equal(data.activities.length, 3);
    assert.equal(data.coverage.components.conditions, 'inaccessible');
    assert.deepEqual(data.integrity.inaccessible.find(item => item.component === 'conditions'), {
      component: 'conditions', state: 'inaccessible', http_status: 403, code: 'forbidden',
    });
    assert.equal(data.coverage.complete, false);
    assert.equal(data.transitions.length, 4);
  } finally {
    await fixture.close();
  }
});

test('workflows show can select a draft version and refuses a foreign version', async () => {
  const fixture = await startFixture();
  try {
    const data = await inspectWorkflow(fixture.sdk, { identifier: WF, versionId: V_DRAFT });
    assert.equal(data.selection.reason, 'requested');
    assert.equal(data.version.sys_id, V_DRAFT);
    assert.equal(data.version.checked_out_by_name, 'Ada');
    await assert.rejects(
      inspectWorkflow(fixture.sdk, { identifier: WF, versionId: '9'.repeat(31) + '1' }),
      /not one of this workflow's versions/,
    );
    await assert.rejects(
      inspectWorkflow(fixture.sdk, { identifier: WF, versionId: 'not-a-sys-id' }),
      /--version must be/,
    );
  } finally {
    await fixture.close();
  }
});

test('workflows show distinguishes a missing workflow from one with no activities', async () => {
  const fixture = await startFixture();
  try {
    await assert.rejects(inspectWorkflow(fixture.sdk, { identifier: 'No such workflow' }), /not found/i);
    const empty = await inspectWorkflow(fixture.sdk, { identifier: 'Change gate' });
    assert.equal(empty.version.sys_id, '9'.repeat(31) + '1');
    assert.equal(empty.activities.length, 0);
  } finally {
    await fixture.close();
  }
});

test('published workflow versions for a table are reusable without claiming script-started discovery', async () => {
  const fixture = await startFixture();
  try {
    const data = await listPublishedWorkflowVersionsForTable(fixture.sdk, 'incident');
    assertOnlyReads(fixture.requests);
    assert.equal(data.table, 'incident');
    assert.equal(data.state, 'ok');
    assert.equal(data.versions.length, 2);
    assert.ok(data.versions.every(version => version.published === true));
    assert.match(data.coverage.note, /not discovered/);
    assert.ok(fixture.requests.every(request => request.query.includes('table=incident')));
  } finally {
    await fixture.close();
  }
});

test('activity bounds are explicit and links outside the sample are not called dangling', async () => {
  const fixture = await startFixture();
  try {
    const data = await inspectWorkflow(fixture.sdk, { identifier: WF, limit: 2 });
    assertOnlyReads(fixture.requests);
    assert.equal(data.activities.length, 2);
    assert.deepEqual(data.coverage.activity_sample, { limit: 2, returned: 2, truncated: true });
    assert.equal(data.coverage.complete, false);
    assert.equal(data.integrity.activity_sample_truncated, true);
    const crossing = data.transitions.find(transition => transition.sys_id === 'a'.repeat(31) + '2');
    assert.equal(crossing.status, 'outside_sample');
    assert.equal(data.integrity.dangling_transitions.length, 0);
  } finally {
    await fixture.close();
  }
});

test('skipping configuration is reported as skipped and keeps coverage complete', async () => {
  const fixture = await startFixture();
  try {
    const data = await inspectWorkflow(fixture.sdk, { identifier: WF, includeConfiguration: false });
    assertOnlyReads(fixture.requests);
    assert.equal(data.coverage.components.configuration, 'skipped');
    assert.equal(data.coverage.complete, true);
    assert.ok(data.activities.every(activity => activity.configuration_status === 'skipped'));
    assert.ok(fixture.requests.every(request => request.path !== '/api/now/table/sys_variable_value'));
  } finally {
    await fixture.close();
  }
});

test('HTTP workflow inspection follows approval success, numbers End after rollback, and omits redundant end label', async () => {
  const names = ['Begin', 'Approval', 'A rejected', 'B skipped', 'Validate', 'End', 'Rollback'];
  const activityId = n => String(n).repeat(32);
  const edges = [[1, 2, 'Always'], [2, 3, 'Rejected'], [2, 4, 'Skipped'], [2, 5, 'Approved'],
    [5, 6, 'Always'], [5, 7, 'Failure'], [7, 2, 'Always'], [3, 6, 'Always'], [4, 6, 'Always']];
  const fixture = await startFixture({
    wf_activity: () => names.map((name, i) => ({ sys_id: activityId(i + 1), name })),
    wf_condition: () => edges.map(([from, , name], i) => ({ sys_id: `c${i}`.padEnd(32, '0'), activity: activityId(from), name })),
    wf_transition: () => edges.map(([from, to], i) => ({ sys_id: `d${i}`.padEnd(32, '0'),
      from: activityId(from), to: activityId(to), condition: `c${i}`.padEnd(32, '0') })),
    sys_variable_value: () => [],
  });
  try {
    const data = await inspectWorkflow(fixture.sdk, { identifier: WF });
    const text = formatWorkflowOutline(data);
    assert.deepEqual(text.split(`▶ STEPS\n${'─'.repeat(50)}\n`)[1].split('\n\n')[0].split('\n'), [
      '  1. Begin', '  2. Approval', '       → step 5 A rejected [Rejected]', '       → step 6 B skipped [Skipped]',
      '  3. Validate', '       → step 7 End [Always]', '       → step 4 Rollback [Failure]',
      '  4. Rollback', '       ↺ → step 2 Approval [Always]', '  5. A rejected', '       → step 7 End [Always]',
      '  6. B skipped', '  7. End',
    ]);
    assert.equal(data.transitions.find(edge => edge.condition_name === 'Approved').is_sequential, true);
    assert.ok(data.transitions.filter(edge => ['Rejected', 'Skipped'].includes(edge.condition_name)).every(edge => !edge.is_sequential));
    assert.equal(data.steps.at(-1).name, 'End');
    assert.equal(data.coverage.loop_detection_complete, true);
    assert.equal(data.coverage.loops_found, 1);
    assertOnlyReads(fixture.requests);
    assert.doesNotMatch(text, /\b[0-9a-f]{32}\b/i);
  } finally {
    await fixture.close();
  }
});

test('workflows command is registered as a read-only command', () => {
  const commands = [];
  const mockYargs = { command: (definition) => { commands.push(definition); return mockYargs; } };
  const cmd = workflowsCmd(fn => fn);
  cmd.builder(mockYargs);
  assert.equal(cmd.command, 'workflows [subcommand]');
  assert.deepEqual(cmd.aliases, ['workflow']);
  assert.deepEqual(commands.map(definition => definition.command), ['list', 'show <identifier>']);
  assert.ok(commands.every(definition => definition.handler));
});

test('configuration renders every nonempty element sorted and aligned under its step', async () => {
  const values = { subject: 'Hello', email_to: 'manager', email: 'Body', duration: '2 days', advanced: 'false', empty: '', blank: ' \t\n' };
  const fixture = await startFixture({ sys_variable_value: () => Object.entries(values).map(([element, value]) => ({
    document_key: ACT_SCRIPT, 'variable.element': element, value,
  })) });
  try {
    const data = await inspectWorkflow(fixture.sdk, { identifier: WF });
    const text = formatWorkflowOutline(data, { includeConfiguration: true });
    const stepLines = text.split('\n').filter(line => /^ {2}\d+\.|^ {7}(?!→|↺)/.test(line));
    assert.deepEqual(stepLines, [
      '  1. Begin  (Begin)',
      '  2. Tag record  (Run Script)',
      '       advanced: false',
      '       duration: 2 days',
      '       email:    Body',
      '       email_to: manager',
      '       subject:  Hello',
      '  3. Approval',
    ]);
    assert.doesNotMatch(text, /▶ CONFIGURATION|▶ LOOPS|empty:|blank:/);
    assert.doesNotMatch(formatWorkflowOutline(data), /advanced:|subject:|\(Run Script\)/);
  } finally { await fixture.close(); }
});

test('full configuration previews long values explicitly while one step renders complete content and all edges', async () => {
  const script = Array.from({ length: 17 }, (_, i) => `line${i + 1}();`).join('\n');
  const fixture = await startFixture({ sys_variable_value: () => [
    { document_key: ACT_SCRIPT, 'variable.element': 'script', value: script },
    { document_key: ACT_SCRIPT, 'variable.element': 'other_script', value: '// only a comment' },
  ] });
  try {
    const data = await inspectWorkflow(fixture.sdk, { identifier: WF });
    const preview = formatWorkflowOutline(data, { includeConfiguration: true });
    assert.deepEqual(preview.split('\n').filter(line => /^ {7}(script:| {8})/.test(line)), [
      '       script: line1();',
      ...Array.from({ length: 4 }, (_, i) => `               line${i + 2}();`),
      '               … (12 more lines, use --json for the full value)',
    ]);
    assert.ok(preview.includes('\n       omitted other_script: comment-only script (no executable code)\n'));
    const full = formatWorkflowOutline(data, { step: 2 });
    assert.deepEqual(full.split('\n').filter(line => /^ {2}\d+\.|^ {7}/.test(line)), [
      '  2. Tag record  (Run Script)', '       script: line1();',
      ...Array.from({ length: 16 }, (_, i) => `               line${i + 2}();`),
      '       omitted other_script: comment-only script (no executable code)',
      '       Loop 1: back to step 2 (observed; detection incomplete)',
      '       → step 3 Approval [unconditional]',
    ]);
    assert.doesNotMatch(full, /more lines|▶ CONFIGURATION|▶ LOOPS/);
    const selected = selectWorkflowStep(data, 2);
    assert.deepEqual(selected.activities.map(a => a.sys_id), [ACT_SCRIPT]);
    assert.deepEqual(selected.steps.map(s => s.number), [2]);
    assert.deepEqual(selected.transitions, data.transitions.filter(t => t.from_id === ACT_SCRIPT));
    assert.equal(selected.activities[0].configuration.script, script);
    assert.deepEqual(selected.loops, data.loops);
    assert.deepEqual(selected.coverage, data.coverage);
    assertOnlyReads(fixture.requests);
  } finally { await fixture.close(); }
});

test('step selector rejects non-positive integers and reports valid range and count', () => {
  for (const value of ['0', '-1', '1.5', 'nope', '', '1e2', 'Infinity', ' 1', '01', '9007199254740992']) {
    assert.throws(() => parseWorkflowStep(value), /--step must be a positive integer/);
  }
  assert.equal(parseWorkflowStep('5'), 5);
  assert.equal(parseWorkflowStep(undefined), undefined);
  assert.throws(() => selectWorkflowStep({ steps: [{ number: 1 }] }, 2), /2 is out of range: 1 steps; valid range 1–1/);
  assert.throws(() => selectWorkflowStep({ steps: [] }, 1), /0 steps; valid range none/);
});

const baseEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SN_|SERVICENOW_)/i.test(key))),
  JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1',
  SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret',
};

function writeConfig(dir, instance) {
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow', 'config.json'), JSON.stringify({
    default_profile: 'fixture',
    profiles: { fixture: { instance_url: instance, auth_method: 'basic' } },
  }));
}

test('real binary lists and shows legacy workflows over read-only HTTP', async () => {
  const fixture = await startFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-legacy-workflow-'));
  writeConfig(dir, fixture.instance);
  const env = { ...baseEnv, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir };
  // Async exec: the fixture server shares this process's event loop, so a
  // synchronous spawn would deadlock before the fixture could answer.
  const run = async (args) => {
    try {
      const result = await execute(process.execPath, [CLI, ...args], { encoding: 'utf8', env, timeout: 20000 });
      return { status: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      return { status: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout || '', stderr: error.stderr || '' };
    }
  };
  try {
    const list = await run(['workflows', 'list', '--limit', '2', '--json']);
    assert.equal(list.status, 0, list.stderr);
    const listed = JSON.parse(list.stdout);
    assert.equal(listed.ok, true);
    assert.equal(listed.data.records.length, 2);
    assert.equal(listed.data.pagination.has_more, true);
    assert.equal(listed.data.records[0].published_version.sys_id, V_PUBLISHED);

    const shown = await run(['workflows', 'show', 'Incident approval', '--json']);
    assert.equal(shown.status, 0, shown.stderr);
    const envelope = JSON.parse(shown.stdout);
    assert.equal(envelope.data.workflow.sys_id, WF);
    assert.equal(envelope.data.activities.length, 3);
    assert.equal(envelope.data.transitions.length, 4);
    assert.ok(envelope.data.activities.some(activity => activity.configuration.script));
    assert.deepEqual(envelope.data.steps, [
      { number: 1, sys_id: ACT_START, name: 'Begin', reached_from_start: true },
      { number: 2, sys_id: ACT_SCRIPT, name: 'Tag record', reached_from_start: true },
      { number: 3, sys_id: ACT_APPROVAL, name: 'Approval', reached_from_start: true },
    ]);
    assert.deepEqual(envelope.data.transitions.filter(edge => edge.is_sequential).map(edge => edge.sys_id),
      ['a'.repeat(31) + '1', 'a'.repeat(31) + '2']);

    const single = await run(['workflows', 'show', WF, '--step', '2', '--json']);
    assert.equal(single.status, 0, single.stderr);
    const narrowed = JSON.parse(single.stdout);
    assert.equal(narrowed.ok, true);
    assert.deepEqual(narrowed.data.activities.map(a => a.sys_id), [ACT_SCRIPT]);
    assert.deepEqual(narrowed.data.steps, [envelope.data.steps[1]]);
    assert.deepEqual(narrowed.data.transitions, envelope.data.transitions.filter(t => t.from_id === ACT_SCRIPT));
    assert.deepEqual(narrowed.data.loops, envelope.data.loops);
    assert.deepEqual(narrowed.data.coverage, envelope.data.coverage);
    const singleHuman = await run(['workflows', 'show', WF, '--step', '2', '--no-config', '--styled']);
    assert.equal(singleHuman.status, 0, singleHuman.stderr);
    assert.deepEqual(singleHuman.stdout.split('\n').filter(line => /^ {2}\d+\.|^ {7}/.test(line)), [
      '  2. Tag record  (Run Script)',
      '       script: var gr = new GlideRecord("incident");',
      '               gr.get(current.sys_id);',
      '               gr.update();',
      '       table:  incident',
      '       Loop 1: back to step 2 (observed; detection incomplete)',
      '       → step 3 Approval [unconditional]',
    ]);
    for (const value of ['0', '-1', '2.5', 'five', '1e2', '99']) {
      const invalid = await run(['workflows', 'show', WF, '--step', value, '--json']);
      assert.equal(invalid.status, 2, invalid.stderr);
      const error = JSON.parse(invalid.stdout);
      assert.equal(error.code, 'usage_error');
      assert.match(JSON.stringify(error), value === '99' ? /3 steps; valid range 1–3/ : /positive integer/);
    }

    const extracted = await run(['workflow', 'show', WF, '--json', '--get', 'data.version.sys_id']);
    assert.equal(extracted.status, 0, extracted.stderr);
    assert.equal(JSON.parse(extracted.stdout), V_PUBLISHED);

    const human = await run(['workflows', 'show', WF, '--styled']);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /Legacy workflow: Incident approval/);
    assert.match(human.stdout, /▶ STEPS/);
    assert.ok(human.stdout.includes('  1. Begin\n  2. Tag record\n  3. Approval\n       → (activity not in the readable steps) [unreadable condition] ⚠ missing activity\n       ↺ → step 2 Tag record [approved]\n'), human.stdout);
    assert.doesNotMatch(human.stdout, /\b[0-9a-f]{32}\b/i);
    assert.doesNotMatch(human.stdout, /▶ TRANSITIONS/);
    assert.match(human.stdout, /design-time configuration/i);

    const usage = await run(['workflows', 'list', '--limit', '0', '--json']);
    assert.equal(usage.status, 2, usage.stderr);
    assert.equal(JSON.parse(usage.stdout).code, 'usage_error');

    const badVersion = await run(['workflows', 'show', WF, '--version', 'nope', '--json']);
    assert.equal(badVersion.status, 2, badVersion.stderr);
    assert.equal(JSON.parse(badVersion.stdout).code, 'usage_error');

    assertOnlyReads(fixture.requests, { allowAuth: true });
    assert.ok(!(list.stdout + shown.stdout + human.stdout).includes('fixture-secret'));
  } finally {
    await fixture.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
