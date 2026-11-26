import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAccessRun, parseRunOptions, runAccessAnalysis } from '../src/access-analyzer-run.js';

const id = n => n.toString(16).padStart(32, '0');
const USER = id(2), RECORD = id(9), ACL = id(40), BR = id(41);
const acl = (overrides = {}) => ({
  kind: 'ACL', sys_id: ACL, path: 'record/incident/read', decision_type: 'ALLOW_IF', status: 'passed',
  return_code: 'TRUE', return_code_display_value: 'passed', roles: 'itil', roles_result: 'TRUE',
  condition_result: 'NOT_EVALUATED', script_result: 'NOT_EVALUATED', security_attribute: 'TRUE',
  applies_to_condition_result: 'TRUE', controlled_by_references_result: 'NOT_EVALUATED', ...overrides,
});
const businessRule = { kind: 'Business Rule', sys_id: BR, path: 'incident query', status: 'passed', return_code: 'TRUE', return_code_display_value: 'passed' };
// The reduced shape the background script prints: the provider envelope plus the
// per-operation debug logs, already flattened to presentation fields.
const evaluation = ({ read = true, write = false, readChecks = null, writeChecks = null } = {}) => ({
  api: 'getDebugLogs', missing: undefined, thrown: undefined, unreadable: undefined,
  response: {
    error: 0, errorMessage: '', pass: read, detail: { isRecordAvailable: 'true' },
    securityDebug: {
      read: { status: read, acl_result: read ? 'passed' : 'blocked', access_handler_result: 'passed', data_filtration_result: 'skipped', overall_access: read ? 'passed' : 'blocked', insights: '', checks: readChecks || [businessRule, acl(read ? {} : { status: 'blocked', roles_result: 'FALSE' })], checks_total: 2, checks_truncated: false },
      write: { status: write, acl_result: write ? 'passed' : 'blocked', access_handler_result: 'skipped', data_filtration_result: 'skipped', overall_access: write ? 'passed' : 'blocked', insights: '', checks: writeChecks || [acl({ path: 'record/incident/write', status: write ? 'passed' : 'blocked', roles_result: write ? 'TRUE' : 'FALSE' })], checks_total: 1, checks_truncated: false },
      delete: { status: write, acl_result: write ? 'passed' : 'blocked', access_handler_result: 'skipped', data_filtration_result: 'skipped', overall_access: write ? 'passed' : 'blocked', insights: '', checks: [], checks_total: 0, checks_truncated: false },
    },
  },
});
const printed = body => `*** Script: JSN_ACCESS_RUN:${JSON.stringify(body)}`;

function fixture({ output = evaluation(), users = [{ sys_id: USER, user_name: 'abel.tuter' }], before = [], after = before } = {}) {
  const calls = [], reads = [];
  let requestReads = 0;
  const sdk = {
    authProvider: { getCredentials: async () => ({ auth_method: 'basic' }) },
    async listStrict(table, params) {
      reads.push({ table, params });
      if (table === 'sys_user') return users;
      if (table === 'sn_access_analyzer_request') return requestReads++ === 0 ? before : after;
      return [];
    },
    async executeScript(script, scope, opts) {
      calls.push({ script, scope, opts });
      return typeof output === 'function' ? output() : printed(output);
    },
  };
  return { sdk, calls, reads };
}
const input = (overrides = {}) => ({ user: 'abel.tuter', table: 'incident', record: RECORD, ...overrides });

test('evaluates live and prints every ACL and business rule with its return code and verdict', async () => {
  const f = fixture();
  const data = await runAccessAnalysis(f.sdk, input());
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].scope, 'global');
  assert.equal(f.calls[0].opts.rollback, false, 'no rollback context is recorded');
  for (const part of [
    `new GlideRecord('incident')`, `gr.get('${RECORD}')`, `entitySysId: '${USER}'`, `entityType: 'User'`,
    `targetResource: 'record'`, `targetName: 'incident'`, 'targetField: ""', `targetRecord: '${RECORD}'`,
    'targetOperations: ["read","write","delete"]', 'shouldPersistResult: false',
    'sn_access_analyzer.CrossScopeGetDebugLogsAPI', 'sn_access_analyzer.CrossScopeEvaluateAccessAPI',
    'api.getDebugLogs(request)', 'api.evaluateAccess(request)',
  ]) assert.ok(f.calls[0].script.includes(part), part);
  assert.deepEqual(data.operations.map(op => [op.operation, op.decision, op.allowed]), [['read', 'allowed', true], ['write', 'blocked', false], ['delete', 'blocked', false]]);
  assert.equal(data.operations[1].acl_result, 'blocked');
  assert.deepEqual(data.operations[1].checks[0].failed_checks, ['roles']);
  assert.equal(data.saved, false);
  assert.equal(f.reads.length, 1, 'only the user lookup is read; no saved-request reads without --save');
  const human = formatAccessRun(data);
  assert.match(human, new RegExp(`^Live access evaluation for abel\\.tuter on incident ${RECORD} \\(nothing saved\\)`));
  assert.match(human, /^read: allowed$/m);
  assert.match(human, /^write: blocked by ACL$/m);
  assert.match(human, new RegExp(`Business Rule incident query: passed \\[${BR}\\] \\(return code TRUE = passed\\)`));
  assert.match(human, new RegExp(`ACL record/incident/write: blocked \\[${ACL}\\].*failed on roles`));
  assert.match(human, /Roles: itil \(FALSE\); condition: NOT_EVALUATED/);
  assert.match(human, /An evaluation is evidence, not a guarantee/);
});

test('a field evaluation asks the provider for that field and names it in the output', async () => {
  const f = fixture();
  const data = await runAccessAnalysis(f.sdk, input({ field: 'state', operations: 'read' }));
  assert.ok(f.calls[0].script.includes('targetField: "state"'));
  assert.ok(f.calls[0].script.includes('targetOperations: ["read"]'));
  assert.equal(data.field, 'state');
  assert.match(formatAccessRun(data), new RegExp(`on incident\\.state ${RECORD}`));
});

test('the generated background script is valid JavaScript for every option set', async () => {
  for (const overrides of [{}, { field: 'state' }, { save: true }, { operations: 'write' }]) {
    const f = fixture();
    await runAccessAnalysis(f.sdk, input(overrides)).catch(() => {});
    assert.doesNotThrow(() => new Function(f.calls[0].script), JSON.stringify(overrides));
  }
});

test('skipped, undefined and missing verdicts are never reported as allowed', async () => {
  for (const [status, expected] of [['Skipped', 'skipped'], ['undefined', 'undefined'], [undefined, 'undefined'], ['', 'undefined']]) {
    const body = evaluation();
    body.response.securityDebug.read.status = status;
    body.response.securityDebug.read.acl_result = '';
    const data = await runAccessAnalysis(fixture({ output: body }).sdk, input({ operations: 'read' }));
    assert.equal(data.operations[0].decision, expected, String(status));
    assert.equal(data.operations[0].allowed, false);
  }
  const human = formatAccessRun(await runAccessAnalysis(fixture({ output: (() => { const b = evaluation(); b.response.securityDebug.read.status = 'Skipped'; return b; })() }).sdk, input({ operations: 'read' })));
  assert.match(human, /read: skipped by the analyzer, so access is undecided/);
  const denied = evaluation({ read: false });
  denied.response.securityDebug.read.acl_result = '';
  const byAnalyzer = await runAccessAnalysis(fixture({ output: denied }).sdk, input({ operations: 'read' }));
  assert.equal(byAnalyzer.operations[0].decision, 'blocked');
  assert.match(formatAccessRun(byAnalyzer), /read: denied by the analyzer, though no ACL is reported blocked/);
});

test('more checks than the script prints are reported as truncated, never silently dropped', async () => {
  const body = evaluation();
  body.response.securityDebug.read.checks = Array.from({ length: 100 }, (_, index) => acl({ sys_id: id(1000 + index) }));
  body.response.securityDebug.read.checks_total = 150;
  body.response.securityDebug.read.checks_truncated = true;
  const f = fixture({ output: body });
  const data = await runAccessAnalysis(f.sdk, input({ operations: 'read' }));
  assert.match(formatAccessRun(data), /150 checks ran; the first 100 are listed/);
  assert.ok(f.calls[0].script.includes('checks.length < 100'), 'the script caps what it prints');
});

test('a provider refusal, a thrown API, unreadable output or a missing operation is a failure, never an empty result', async () => {
  const cases = [
    [{ api: 'evaluateAccess', response: { error: 99, errorMessage: 'Invalid extension point API name provided', detail: {}, pass: false, securityDebug: {} } }, /could not evaluate access: Invalid extension point API name provided/],
    [{ response: { error: true, errorMessage: 'Error evaluating access: boom' } }, /could not evaluate access: Error evaluating access: boom/],
    [{ thrown: 'JavaException: java.lang.SecurityException: Unsupported caller scope: global' }, /threw while evaluating access: JavaException/],
    [{ unreadable: '<html>denied</html>' }, /unreadable response: <html>denied<\/html>/],
    [{ response: { error: 0, errorMessage: '', securityDebug: {} } }, /no result for read \(returned: none\)|returned no result for read/],
    [{ missing: 'analyzer' }, /Access Analyzer API not found[\s\S]*does not substitute a weaker local check/],
    [{ missing: 'table' }, /table not found: incident/],
    [{ missing: 'record' }, /incident record not found/],
  ];
  for (const [overrides, message] of cases) {
    const f = fixture({ output: { api: 'getDebugLogs', ...overrides } });
    await assert.rejects(runAccessAnalysis(f.sdk, input({ operations: 'read' })), message, JSON.stringify(overrides).slice(0, 90));
  }
  for (const body of [
    { response: { error: 0, securityDebug: { read: { status: 'unexpected', acl_result: '', checks: [] } } } },
    { response: { error: 0, securityDebug: { read: { status: true, acl_result: 'unknown', checks: [] } } } },
    { response: { error: 0, securityDebug: { read: { status: true, acl_result: '', checks: [{ kind: 'ACL', sys_id: 'bad' }] } } } },
    { response: { error: 0, securityDebug: { read: { status: true, acl_result: '', checks: 'no' } } } },
    { response: { error: 0, securityDebug: [] } },
    { response: 'no' },
    {},
  ]) {
    await assert.rejects(runAccessAnalysis(fixture({ output: { api: 'getDebugLogs', ...body } }).sdk, input({ operations: 'read' })), /no readable result/, JSON.stringify(body).slice(0, 90));
  }
  await assert.rejects(runAccessAnalysis(fixture({ output: 'not a marker' }).sdk, input()), /no readable result/);
});

test('every invalid input rejects before any request', async () => {
  const f = fixture();
  for (const bad of [
    { user: '' }, { user: '-x' }, { user: 'a^NQb' }, { user: 'a\nb' },
    { table: 'Incident' }, { table: "incident'" }, { table: '' },
    { record: 'bad' }, { record: `${RECORD.slice(1)}'` },
    { operations: 'create' }, { operations: 'read,' },
    { field: 'State' }, { field: 'state^x' }, { field: 'field name' },
  ]) {
    await assert.rejects(runAccessAnalysis(f.sdk, input(bad)), { code: 'usage_error' }, JSON.stringify(bad));
  }
  assert.equal(f.calls.length + f.reads.length, 0);
  const browser = fixture();
  browser.sdk.authProvider = { getCredentials: async () => ({ auth_method: 'gck' }) };
  await assert.rejects(runAccessAnalysis(browser.sdk, input()), { code: 'usage_error', message: /browser-session profile/ });
  assert.equal(browser.calls.length + browser.reads.length, 0, 'a browser-session profile is refused before any request');
  assert.equal(parseRunOptions(input({ field: '' })).field, '');
});

test('--save persists through the provider and reads back only the request this run created', async () => {
  const old = { sys_id: id(50), last_run: '2026-01-01 10:00:00', target_table: 'incident', target_record: RECORD };
  const created = { sys_id: id(51), last_run: '2026-02-01 10:00:00', target_table: 'incident', target_record: RECORD };
  const f = fixture({ before: [old], after: [created, old] });
  const data = await runAccessAnalysis(f.sdk, input({ save: true, operations: 'read' }));
  assert.ok(f.calls[0].script.includes('shouldPersistResult: true'));
  assert.equal(data.saved, true);
  assert.equal(data.analysis_request.sys_id, id(51));
  const requestReads = f.reads.filter(read => read.table === 'sn_access_analyzer_request');
  assert.equal(requestReads.length, 2, 'one read before and one after the evaluation');
  assert.equal(requestReads[0].params.get('sysparm_query'), `user=${USER}^target_table=incident^target_record=${RECORD}^ORDERBYDESClast_run^ORDERBYDESCsys_id`);
  assert.match(data.summary, new RegExp(`saved ${id(51)}`));
  assert.match(formatAccessRun(data), new RegExp(`\\(saved ${id(51)}\\)`));

  const none = fixture({ before: [old], after: [old] });
  await assert.rejects(runAccessAnalysis(none.sdk, input({ save: true, operations: 'read' })), /no new analysis request is visible.*Do not assume nothing was saved/);
  const two = fixture({ before: [], after: [{ ...created, sys_id: id(52) }, created] });
  await assert.rejects(runAccessAnalysis(two.sdk, input({ save: true, operations: 'read' })), /refuse to guess/);
});

test('no saved-request read happens when the evaluation itself fails', async () => {
  const f = fixture({ output: { api: 'evaluateAccess', response: { error: 99, errorMessage: 'refused', securityDebug: {} } } });
  await assert.rejects(runAccessAnalysis(f.sdk, input({ save: true })), /could not evaluate access: refused/);
  assert.equal(f.reads.filter(read => read.table === 'sn_access_analyzer_request').length, 1, 'only the pre-run snapshot');
});
