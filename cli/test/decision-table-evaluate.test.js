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
import { evaluateDecisionTable, parseDecisionInputs, EVALUATE_PATH } from '../src/decision-table-evaluate.js';
import { decisiontablesCmd } from '../src/commands/decisiontables.js';
import { isMutationCommand } from '../src/mutations.js';
import { mutationPaths } from '../src/capabilities.js';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';

const id = (n) => n.toString(16).padStart(32, '0');
const [T, C, D1, D2, A1, M, MD] = [1, 2, 3, 4, 5, 6, 7].map(id);
const inputName = (table) => `var__m_sys_decision_input_${table}`;
const input = (n, element, internal_type, extra = {}) => ({ sys_id: id(n), model: T, name: inputName(T), element, label: element, internal_type, reference: '', mandatory: 'false', active: 'true', ...extra });

function tables() {
  return {
    sys_decision: [{ sys_id: T, name: 'Normal Change Policy', answer_table: 'chg_approval_def' }, { sys_id: M, name: 'Migration', answer_table: 'sys_decision_multi_result' }],
    sys_decision_input: [
      input(10, 'change_request', 'reference', { reference: 'change_request' }),
      input(11, 'manager_approved', 'boolean'),
      input(12, 'instance_type', 'choice'),
      input(13, 'reason', 'string', { mandatory: 'true' }),
      input(14, 'retired', 'string', { mandatory: 'true', active: 'false' }),
      input(15, 'plugin_active', 'boolean', { model: M, name: inputName(M), mandatory: 'true' }),
    ],
    sys_choice: [{ name: inputName(T), element: 'instance_type', value: 'test', label: 'Testing' }, { name: inputName(T), element: 'instance_type', value: 'prod', label: 'Production' }],
    change_request: [{ sys_id: C, number: 'CHG0000008' }],
    sys_decision_question: [
      { sys_id: D1, decision_table: T, label: 'Manager approved', order: '100', active: 'true', default_answer: 'false' },
      { sys_id: D2, decision_table: T, label: 'Fallback', order: '200', active: 'true', default_answer: 'true' },
      { sys_id: MD, decision_table: M, label: 'Use it', order: '100', active: 'true', default_answer: 'false' },
    ],
    sys_decision_multi_result_element: [{ sys_id: id(20), model: M, element: 'use_releaseops', label: 'Use ReleaseOps' }],
  };
}

// Equality terms only: enough for the reads under test, and an unsupported operator matches nothing.
const matches = (row, query) => String(query || '').split('^').filter((term) => term && !term.startsWith('ORDERBY')).every((term) => {
  const at = term.indexOf('=');
  return at > 0 && !/STARTSWITH|ENDSWITH/.test(term) && String(row[term.slice(0, at)] ?? '') === term.slice(at + 1);
});
const readRows = (data, table, params) => (data[table] || []).filter((row) => matches(row, params.get('sysparm_query'))).slice(0, Number(params.get('sysparm_limit') || 10000));
const fallbackAnswer = () => ({ result: { [D2]: [{ value: A1, displayValue: 'Manager approval' }] } });

function fixtureSdk({ data = tables(), evaluate = fallbackAnswer } = {}) {
  const calls = [];
  const read = async (table, params) => { calls.push({ method: 'GET', table, query: params.get('sysparm_query') }); return readRows(data, table, params); };
  return {
    calls, baseURL: 'https://fixture.service-now.com', list: read, listStrict: read,
    request: async (url, opts) => { calls.push({ method: opts.method, url, body: JSON.parse(opts.body) }); return evaluate(url, opts); },
  };
}
const posts = (sdk) => sdk.calls.filter((call) => call.method === 'POST');
const valid = ['reason=x'];

test('parses repeatable name=value inputs and refuses malformed ones before any request', () => {
  assert.deepEqual([...parseDecisionInputs(['a=1', 'q=b=c', 'empty='])], [['a', '1'], ['q', 'b=c'], ['empty', '']]);
  assert.deepEqual([...parseDecisionInputs(undefined)], []);
  for (const bad of [['novalue'], ['=v'], ['a=1', 'a=2']]) assert.throws(() => parseDecisionInputs(bad), { code: 'usage_error' }, JSON.stringify(bad));
});

test('evaluates by name, resolves a reference number and reports the default decision with value and display value', async () => {
  const sdk = fixtureSdk();
  const data = await evaluateDecisionTable(sdk, 'Normal Change Policy', { inputs: ['change_request=CHG0000008', 'manager_approved=false', 'instance_type=test', 'reason='] });
  const [post] = posts(sdk);
  assert.equal(post.url, `${sdk.baseURL}${EVALUATE_PATH}?decisionTableId=${T}`);
  assert.deepEqual(post.body, { testInputs: { change_request: C, manager_approved: 'false', instance_type: 'test', reason: '' }, isFirstMatch: true, includeDelta: false, isMultiResultTable: false });
  assert.deepEqual(JSON.parse(JSON.stringify(data)), {
    decision_table: { sys_id: T, name: 'Normal Change Policy' },
    inputs: { change_request: C, manager_approved: 'false', instance_type: 'test', reason: '' },
    resolved_from: { change_request: 'CHG0000008' },
    all_matches: false,
    matches: [{ sys_id: D2, label: 'Fallback', order: '200', default: true, answer: { value: A1, display_value: 'Manager approval' } }],
  });
  assert.match(data._formatted, /change_request = 0+2 \(from CHG0000008\)/);
  assert.match(data._formatted, /Fallback \(default\): Manager approval \(0+5\)/);
  assert.ok(sdk.calls.some((call) => call.table === 'change_request' && call.query === 'number=CHG0000008'));
});

test('--all-matches asks for every match and lists them in the table order', async () => {
  const sdk = fixtureSdk({ evaluate: () => ({ result: { [D2]: [{ value: A1, displayValue: 'B' }], [D1]: [{ value: C, displayValue: 'A' }] } }) });
  const data = await evaluateDecisionTable(sdk, T, { inputs: valid, allMatches: true });
  assert.equal(posts(sdk)[0].body.isFirstMatch, false);
  assert.deepEqual(data.matches.map((match) => [match.sys_id, match.default]), [[D1, false], [D2, true]]);
  assert.equal(data.all_matches, true);
});

test('a multi-result table sends its answer element names and reports each element', async () => {
  const sdk = fixtureSdk({ evaluate: () => ({ result: { [MD]: [{ name: 'use_releaseops', value: 'true', displayValue: 'true' }] } }) });
  const data = await evaluateDecisionTable(sdk, 'Migration', { inputs: ['plugin_active=true'] });
  assert.deepEqual(posts(sdk)[0].body, { testInputs: { plugin_active: 'true' }, isFirstMatch: true, includeDelta: false, isMultiResultTable: true, answerElementNames: ['use_releaseops'] });
  assert.deepEqual(data.matches[0].answer, { elements: { use_releaseops: { value: 'true', display_value: 'true' } } });
  assert.match(data._formatted, /Use it: use_releaseops: true/);
});

test('every input the evaluator would silently answer with its default is refused before evaluating', async () => {
  const cases = [
    [['reasn=x'], /Unknown decision input\(s\): reasn\. This table's inputs: change_request, manager_approved, instance_type, reason, retired/],
    [['manager_approved=true'], /Missing mandatory decision input\(s\): reason/],
    [[...valid, 'instance_type=Testing'], /no choice "Testing" \("Testing" is the label of value "test"\)\. Choices: test, prod/],
    [[...valid, 'instance_type=qa'], /no choice "qa"\. Choices: test, prod/],
    [[...valid, 'manager_approved=yes'], /manager_approved is True\/False; pass true or false, not "yes"/],
    [[...valid, 'change_request=CHG9999999'], /not found/i],
    [[...valid, 'change_request=CHG1^ORactive=true'], /query characters/],
  ];
  for (const [inputs, message] of cases) {
    const sdk = fixtureSdk();
    await assert.rejects(evaluateDecisionTable(sdk, 'Normal Change Policy', { inputs }), message, JSON.stringify(inputs));
    assert.equal(posts(sdk).length, 0, JSON.stringify(inputs));
  }
  const sdk = fixtureSdk();
  await assert.rejects(evaluateDecisionTable(sdk, T, { inputs: ['bad'] }), { code: 'usage_error' });
  assert.equal(sdk.calls.length, 0);
});

test('a reference lookup that ignores the number term is refused, not evaluated against another record', async () => {
  const data = tables();
  data.change_request = [{ sys_id: C, number: 'CHG0000001' }];
  const sdk = fixtureSdk({ data });
  sdk.list = async (table, params) => { sdk.calls.push({ method: 'GET', table }); return table === 'change_request' ? data.change_request : readRows(data, table, params); };
  await assert.rejects(evaluateDecisionTable(sdk, T, { inputs: [...valid, 'change_request=CHG0000008'] }), /no change_request record numbered CHG0000008/);
  assert.equal(posts(sdk).length, 0);
});

test('child rows of another table mean the parent filter was dropped, so nothing is evaluated', async () => {
  const data = tables();
  data.sys_decision_input[0].model = M;
  const sdk = fixtureSdk({ data });
  sdk.listStrict = async (table, params) => (table === 'sys_decision_input' ? data.sys_decision_input : readRows(data, table, params));
  await assert.rejects(evaluateDecisionTable(sdk, T, { inputs: valid }), /does not belong to decision table/);
  assert.equal(posts(sdk).length, 0);
});

test('an empty answer is an access failure when the table has a default, and a real no-match otherwise', async () => {
  const empty = () => ({ result: {} });
  await assert.rejects(evaluateDecisionTable(fixtureSdk({ evaluate: empty }), T, { inputs: valid }), (error) => {
    assert.equal(error.code, 'forbidden');
    for (const name of ['sn_decision_table', 'decision_table_admin', 'decision_table_reader', 'change_manager']) assert.ok(error.message.includes(name), name);
    return true;
  });
  const data = tables();
  data.sys_decision_question = data.sys_decision_question.filter((row) => row.sys_id !== D2);
  const none = await evaluateDecisionTable(fixtureSdk({ data, evaluate: empty }), T, { inputs: valid });
  assert.deepEqual(none.matches, []);
  assert.match(none._formatted, /No decision matched, and the table has no default decision/);
  data.sys_decision_question = [];
  await assert.rejects(evaluateDecisionTable(fixtureSdk({ data, evaluate: empty }), T, { inputs: valid }), { code: 'forbidden' });
});

test('denied, missing-plugin and malformed evaluator responses are never reported as success', async () => {
  const fail = (status, message) => () => { const error = new Error(message); error.status = status; throw error; };
  await assert.rejects(evaluateDecisionTable(fixtureSdk({ evaluate: fail(403, 'Access forbidden (HTTP 403).') }), T, { inputs: valid }), /decision_table_reader/);
  await assert.rejects(evaluateDecisionTable(fixtureSdk({ evaluate: fail(400, 'Requested URI does not represent any resource') }), T, { inputs: valid }), /sn_decision_table/);
  await assert.rejects(evaluateDecisionTable(fixtureSdk({ evaluate: fail(500, 'boom') }), T, { inputs: valid }), /boom/);
  for (const body of [null, {}, { result: [] }, { result: { [D1]: 'x' } }, { result: { 'not-an-id': [] } }]) {
    await assert.rejects(evaluateDecisionTable(fixtureSdk({ evaluate: () => body }), T, { inputs: valid }), /Malformed decision table evaluation/, JSON.stringify(body));
  }
});

test('evaluate is registered as a read, so read-only profiles may run it', () => {
  const commands = [];
  const yargs = { command: (definition) => { commands.push(definition); return yargs; } };
  decisiontablesCmd((handler) => handler).builder(yargs);
  assert.ok(commands.some((command) => command.command === 'evaluate <identifier>'));
  assert.equal(isMutationCommand({ _: ['decisiontables', 'evaluate', T] }, mutationPaths()), false);
  assert.equal(isMutationCommand({ _: ['decisiontables', 'update', T] }, mutationPaths()), true);
});

test('real CLI evaluates on a read-only profile with JSON, --get, human output and strict validation', async () => {
  const calls = [];
  const data = tables();
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    calls.push({ method: req.method, pathname: url.pathname });
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname.startsWith('/api/now/table/')) return res.end(JSON.stringify({ result: readRows(data, url.pathname.split('/').pop(), url.searchParams) }));
    if (url.pathname === EVALUATE_PATH && req.method === 'POST') return res.end(JSON.stringify(fallbackAnswer()));
    res.end(JSON.stringify({ result: [] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-decision-evaluate-'));
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: true } } }));
  const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
  const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const run = (args) => promisify(execFile)(process.execPath, [...loopbackCredentialArgs, cli, 'decisiontables', 'evaluate', ...args], { env, cwd: dir, timeout: 20000 });
  const args = ['Normal Change Policy', '--input', 'change_request=CHG0000008', '--input', 'reason=x'];
  try {
    const envelope = JSON.parse((await run([...args, '--json'])).stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.matches[0].answer.display_value, 'Manager approval');
    assert.deepEqual(envelope.data.resolved_from, { change_request: 'CHG0000008' });
    assert.ok((await run([...args, '--get', 'data.matches[0].answer.value'])).stdout.includes(A1));
    assert.match((await run([...args, '--format', 'styled'])).stdout, /Fallback \(default\): Manager approval/);
    const before = calls.length;
    for (const bad of [[...args, '--typo'], [], ['Normal Change Policy', '--input', 'novalue']]) {
      await assert.rejects(run([...bad, '--json']), undefined, JSON.stringify(bad));
    }
    assert.equal(calls.length, before);
    assert.match((await run(['--help'])).stdout, /--all-matches/);
    assert.deepEqual(calls.filter((call) => call.method !== 'GET' && call.pathname !== '/angular.do').map((call) => call.pathname), [EVALUATE_PATH, EVALUATE_PATH, EVALUATE_PATH]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
