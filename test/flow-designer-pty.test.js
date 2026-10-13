import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const fixture = new URL('./support/flow-designer-pty.js', import.meta.url).pathname;
const driver = new URL('./support/flow-designer-pty-driver.py', import.meta.url).pathname;
const script = new URL('./fixtures/interactive-action-script.js', import.meta.url).pathname;
const SCOPE = 'b'.repeat(32);
function run(args, steps) {
  const result = spawnSync('python3', [driver, JSON.stringify({ command: [process.execPath, fixture, ...args], steps })], { encoding: 'utf8', timeout: 60000 });
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
test('real PTY action wizard saves only after confirmation through fresh SDK parent and full-definition PUT', { skip }, () => {
  const result = run(['actions', 'create', '--scope', SCOPE], [...actionSteps, ['Create inactive draft action', 'y\r']]);
  assert.deepEqual(result.mutations.map(mutation => mutation.method), ['POST', 'PUT']);
  assert.equal(result.action.name, 'PTY disposable action');
  assert.match(result.action.steps[0].inputs[0].value, /outputs.response/);
  assert.equal(result.action.state, 'draft');
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
    ['Select a flow', '\r'], ['Edit supported draft flow fields', '\r'], ['Trigger condition', '\r'], ['Update draft flow', 'y\r'],
  ]);
  assert.deepEqual(result.mutations.map(mutation => mutation.path), ['/api/now/graphql', '/api/now/processflow/versioning/create_version']);
  assert.equal(result.mutations[1].body.type, 'Autosave');
  assert.equal(result.flow.triggerInstances[0].sysId, 'c'.repeat(32));
});

test('real PTY flow create uses scope/table pickers, existing manifest lifecycle and inactive draft readback', { skip }, () => {
  const result = run(['flows', 'create'], [
    ['Flow name', 'PTY disposable flow\r'], ['Description', '\r'], ['Select a scope', '\r'],
    ['Select a trigger table', '\r'], ['Trigger condition', '\r'], ['Add a published action?', 'n\r'],
    ['Create inactive draft flow', 'y\r'],
  ]);
  assert.deepEqual(result.mutations.map(mutation => mutation.path), ['/api/now/processflow/flow', '/api/now/graphql', '/api/now/processflow/versioning/create_version']);
  assert.equal(result.mutations[0].body.active, false);
  assert.equal(result.mutations[0].body.status, 'draft');
  assert.equal(result.mutations[2].body.type, 'Autosave');
});
