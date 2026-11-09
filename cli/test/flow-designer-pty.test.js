import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const fixture = new URL('./support/flow-designer-pty.js', import.meta.url).pathname;
const driver = new URL('./support/flow-designer-pty-driver.py', import.meta.url).pathname;
const script = new URL('./fixtures/interactive-action-script.js', import.meta.url).pathname;
const cli = new URL('../bin/jsn.js', import.meta.url).pathname;
const SCOPE = 'b'.repeat(32);
function run(args, steps, options = {}) {
  const result = spawnSync('python3', [driver, JSON.stringify({ command: [process.execPath, fixture, ...args], steps, ...options })], { encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, 0);
  return parsed.result;
}
const skip = process.platform === 'win32' || python.status !== 0;
const actionSteps = [
  ['Action name', 'PTY disposable action\r'], ['Description', '\r'], ['Add an action input?', 'n\r'],
  ['Select executable step schema', '\r'], ['script source', '\r'], ['Script file path', `${script}\r`],
  ['Declare a script step output?', 'n\r'], ['Add another step?', 'n\r'], ['Map a step output', 'n\r'],
];
// Category first, then the trigger inside it, then the trigger's declared inputs.
const flowCreateSteps = [
  ['Flow name', 'PTY disposable flow\r'], ['Description', '\r'], ['Select a scope', '\r'],
  ['Select a trigger category', '\r'], ['Select a Record trigger', '\r'], ['Select a trigger table', '\r'],
  ['Trigger condition', 'short_descriptionSTARTSWITHjacetest\r'],
  ['Change optional trigger inputs', 'n\r'],
  ['Add a published action?', 'y\r'], ['Select a published action', '\u001b[B\r'],
  ['Action input: Level', '\r'], ['Action input: Message', 'nice!\r'],
  ['Add a published action?', 'n\r'],
];
test('real PTY action wizard saves only after confirmation through fresh SDK parent and full-definition PUT', { skip }, () => {
  const result = run(['actions', 'create', '--scope', SCOPE], [...actionSteps, ['Create inactive draft action', 'y\r']]);
  assert.deepEqual(result.mutations.map(mutation => mutation.method), ['POST', 'PUT']);
  assert.equal(result.action.name, 'PTY disposable action');
  assert.match(result.action.steps[0].inputs[0].value, /outputs.response/);
  assert.equal(result.action.state, 'draft');
});
test('real PTY flow create goes category -> trigger -> declared inputs and persists trigger, action values and version', { skip }, () => {
  const result = run(['flows', 'create'], [...flowCreateSteps, ['Create inactive draft flow', 'y\r']]);
  // POST parent (no trigger), one snFlowDesigner patch inserting trigger+action, Autosave.
  assert.deepEqual(result.mutations.map(mutation => mutation.path), [
    '/api/now/processflow/flow', '/api/now/graphql', '/api/now/processflow/versioning/create_version',
  ]);
  assert.equal(result.mutations[0].body.active, false);
  assert.equal(result.mutations[0].body.status, 'draft');
  assert.equal(result.mutations[2].body.type, 'Autosave');
  // The trigger is INSERTED, never patched onto a trigger that does not exist.
  assert.match(result.mutations[1].body.query, /triggerInstances: \{insert:/);
  assert.doesNotMatch(result.mutations[1].body.query, /triggerInstances: \{update:/);
  // Persisted trigger read-back: the chosen family, its definition, its inputs.
  assert.equal(result.flow.triggerInstances[0].type, 'record_create_or_update');
  assert.equal(result.flow.triggerInstances[0].triggerType, 'Record');
  assert.equal(result.flow.triggerInstances[0].triggerDefinitionId, '1'.repeat(32));
  const triggerInputs = Object.fromEntries(result.flow.triggerInstances[0].inputs.map(input => [input.name, input.value.value]));
  assert.equal(triggerInputs.table, 'incident');
  assert.equal(triggerInputs.condition, 'short_descriptionSTARTSWITHjacetest');
  // The instance derived the predicate metadata; the CLI verified it by read-back.
  assert.match(JSON.stringify(result.flow.triggerInstances[0].metadata), /short_descriptionSTARTSWITHjacetest/);
  // Persisted action read-back with the values typed at the prompt.
  assert.equal(result.flow.actionInstances.length, 1);
  assert.equal(result.flow.actionInstances[0].order, '1');
  const actionInputs = Object.fromEntries(result.flow.actionInstances[0].inputs.map(input => [input.name, input.value.value]));
  assert.deepEqual(actionInputs, { log_level: 'info', log_message: 'nice!' });
  assert.equal(result.version.type, 'Autosave');
  assert.equal(result.version.flow, 'e'.repeat(32));
});
test('real PTY flow create can pick the Scheduled family and only prompts its declared inputs', { skip }, () => {
  const result = run(['flows', 'create'], [
    ['Flow name', 'PTY daily flow\r'], ['Description', '\r'], ['Select a scope', '\r'],
    ['Select a trigger category', '\u001b[B\r'],   // second category: Scheduled
    ['Select a Scheduled trigger', '\r'],           // Daily
    ['Trigger input: Time', '1970-01-01 00:00:00\r'],
    ['Add a published action?', 'n\r'],
    ['Create inactive draft flow', 'y\r'],
  ]);
  assert.equal(result.flow.triggerInstances[0].type, 'daily');
  assert.equal(result.flow.triggerInstances[0].triggerType, 'Scheduled');
  // A scheduled trigger has no table/condition prompt at all.
  assert.deepEqual(result.flow.triggerInstances[0].inputs.map(input => input.name), ['time']);
  assert.doesNotMatch(result.mutations[1].body.query, /name: "condition"/);
});
test('real PTY flow create refusal and Ctrl+C write nothing', { skip }, () => {
  assert.equal(run(['flows', 'create'], [...flowCreateSteps, ['Create inactive draft flow', 'n\r']]).mutations.length, 0);
  assert.equal(run(['flows', 'create'], [['Flow name', '\u0003']]).mutations.length, 0);
  // Cancelling at the trigger category leaves no flow behind either.
  assert.equal(run(['flows', 'create'], [
    ['Flow name', 'PTY cancelled flow\r'], ['Description', '\r'], ['Select a scope', '\r'],
    ['Select a trigger category', '\u0003'],
  ]).mutations.length, 0);
});
test('real PTY action creation refusal and Ctrl+C produce no writes', { skip }, () => {
  assert.equal(run(['actions', 'create', '--scope', SCOPE], [...actionSteps, ['Create inactive draft action', 'n\r']]).mutations.length, 0);
  assert.equal(run(['actions', 'create', '--scope', SCOPE], [['Action name', '\u0003']]).mutations.length, 0);
});
test('real PTY action omitted-identifier picker Escape cancels without reads that mutate', { skip }, () => {
  const result = run(['actions', 'definition'], [['Select a action', '\u001b']]);
  assert.equal(result.mutations.length, 0);
});
test('real PTY action edit loads saved script, accepts script file, and saves only after confirmation', { skip }, () => {
  const result = run(['action', 'edit'], [
    ['Select a action', '\r'], ['Edit action', '\u001b[B\u001b[B\u001b[B\r'], ['Select saved step', '\r'],
    ['change script?', 'y\r'], ['script source', '\r'], ['Script file path', `${script}\r`], ['Save action', 'y\r'],
  ]);
  assert.deepEqual(result.mutations.map(mutation => mutation.method), ['PUT']);
  assert.equal(result.action.action_status_metadata.actionTypeId, 'a'.repeat(32));
  assert.match(result.action.steps[0].inputs[0].value, /outputs.response/);
});
test('real PTY test, publish and deletion refusals never dispatch or mutate', { skip }, () => {
  const cases = [
    [['actions', 'test'], [['Select a action', '\r'], ['Test input: request', 'required input\r'], ['Execute action', 'n\r']]],
    [['flows', 'test'], [['Select a flow', '\r'], ['Select a test record in incident', '\r'], ['Execute flow test', 'n\r']]],
    [['flows', 'publish'], [['Select a flow', '\r'], ['Publish and activate', 'n\r']]],
    [['actions', 'delete'], [['Select a action', '\r'], ['Delete action', 'n\r']]],
    [['actions', 'step-types'], [['Select a scope', '\r']]],
  ];
  for (const [args, steps] of cases) assert.equal(run(args, steps).mutations.length, 0, args.join(' '));
});

test('real PTY flow edit picks an inactive draft, reads its condition and confirms the supported update', { skip }, () => {
  const result = run(['flow', 'edit'], [
    ['Select a flow', '\r'], ['Edit supported flow fields', '\r'], ['Trigger condition', '\r'], ['Update flow', 'y\r'],
  ]);
  assert.deepEqual(result.mutations.map(mutation => mutation.path), ['/api/now/graphql', '/api/now/graphql', '/api/now/graphql', '/api/now/processflow/versioning/create_version', '/api/now/graphql', '/api/now/graphql']);
  assert.match(result.mutations[0].body.query, /safeEdit.*read:/);
  assert.match(result.mutations[1].body.query, /safeEdit.*upsert:/);
  assert.equal(result.mutations[3].body.type, 'Autosave');
  assert.match(result.mutations[4].body.query, /safeEdit.*delete:/);
  assert.match(result.mutations[5].body.query, /safeEdit.*read:/);
  assert.equal(result.flow.triggerInstances[0].id, 'f'.repeat(32));
});

function isolated(readOnly, instance = 'https://example.invalid') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-pty-actual-'));
  const config = path.join(root, 'config');
  fs.mkdirSync(path.join(config, 'servicenow'), { recursive: true });
  fs.writeFileSync(path.join(config, 'servicenow', 'config.json'), JSON.stringify({
    default_profile: 'fixture',
    profiles: { fixture: { instance_url: instance, auth_method: 'basic', username: 'fixture', read_only: readOnly, skip_confirmations: false } },
  }));
  return { root, env: { HOME: path.join(root, 'home'), XDG_CONFIG_HOME: config, PATH: process.env.PATH, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' } };
}
function runActual(args, env, options = {}) {
  const result = spawnSync('python3', [driver, JSON.stringify({ command: [process.execPath, cli, ...args], steps: [], env, ...options })], { encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return JSON.parse(result.stdout);
}
test('actual binary read-only profile blocks guided flow creation under a TTY before any provider write', { skip }, t => {
  const { root, env } = isolated(true);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = runActual(['flows', 'create', '--profile', 'fixture', '--json'], env, { expectResult: false });
  assert.notEqual(result.status, 0);
  assert.match(result.result.stdout, /read_only|read-only/i);
  assert.doesNotMatch(result.result.stdout, /FAKE_WRITE|api\/now/i);
});
test('actual binary non-TTY JSON flow creation fails fast with a JSON error and no record mutation', { skip }, async t => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: new URL(req.url, 'http://fixture.invalid').pathname });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ result: [] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { root, env } = isolated(false, `http://127.0.0.1:${server.address().port}`);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const result = spawnSync(process.execPath, [cli, 'flows', 'create', '--profile', 'fixture', '--json'], { encoding: 'utf8', env, timeout: 20000 });
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.ok(['usage_error', 'confirmation_required'].includes(payload.code), payload.code);
  const recordWrites = requests.filter(request => request.path.startsWith('/api/now/table/') && request.method !== 'GET');
  assert.deepEqual(recordWrites, [], 'non-TTY fail-fast must not dispatch a record mutation');
});
