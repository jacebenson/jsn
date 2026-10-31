import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as helpers from '../src/helpers.js';
import * as installer from '../src/midserver-install.js';

const trace = [];
let passwordPrompts = 0;
function operations(prefix, suffix) {
  return Object.fromEntries(['prepare', 'install', 'start', 'stop', 'logs', 'remove'].map(action => [`${action}${suffix}`, options => {
    trace.push({ runtime: prefix, action, options });
    return action === 'logs' ? `${prefix} fixture log` : { state: action === 'remove' ? 'removed' : 'running' };
  }]));
}
mock.module('../src/helpers.js', { namedExports: { ...helpers, canPrompt: () => true } });
mock.module('../src/prompts.js', { namedExports: {
  input: async () => assert.fail('unexpected input prompt'), password: async () => { passwordPrompts++; return 'fixture-password'; },
  select: async () => assert.fail('unexpected picker'), confirm: async () => assert.fail('unexpected confirmation prompt'),
} });
mock.module('../src/midserver-install.js', { namedExports: { ...installer, validateMidCredentials: async () => ({ releaseName: 'fixture-10-06-2026' }) } });
mock.module('../src/midserver-remote.js', { namedExports: { ...operations('docker', 'RemoteMidServer'), followRemoteMidServer: () => assert.fail('unexpected follow') } });
mock.module('../src/midserver-windows-remote.js', { namedExports: operations('windows', 'WindowsRemoteMidServer') });
mock.module('../src/midserver-linux-remote.js', { namedExports: operations('linux', 'LinuxRemoteMidServer') });
mock.module('../src/midserver-remote-recipe.js', { namedExports: { downloadRemoteMidRecipe: async () => Buffer.from('fixture-tar') } });
const { midserversCmd } = await import('../src/commands/midservers.js');
const root = fileURLToPath(new URL('../', import.meta.url));

function commands() {
  const result = [];
  const builder = { command(value) { result.push(value); return builder; } };
  midserversCmd(handler => handler).builder(builder);
  return result;
}
function command(prefix) { return commands().find(value => value.command.split(' ')[0] === prefix); }
function fixture(t) {
  trace.length = 0; passwordPrompts = 0;
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-remote-cli-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const directory = path.join(parent, 'deployment'); const results = []; const writes = [];
  const app = {
    requireInstance() {}, getEffectiveInstance: () => 'https://example.service-now.com',
    config: { profiles: {} }, output: { getFormat: () => 'json' },
    ok: value => { results.push(value); return value; },
    sdk: { list: async () => [], delete: async (...args) => { writes.push(args); } },
  };
  return { directory, app, results, writes };
}
function metadata(directory, kind, overrides = {}) {
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, `.jsn-mid-${kind === 'docker' ? '' : `${kind}-`}remote.json`), JSON.stringify({ target: 'test-target', instanceURL: 'https://example.service-now.com', name: 'owned-mid', ...overrides }));
}

test('remote add refuses omitted name and existing instance record before credentials or transport', async t => {
  const f = fixture(t); const add = command('add');
  f.app.sdk.list = async () => assert.fail('missing name must fail before instance lookup');
  await assert.rejects(add.handler({ ssh: 'test-target' }, f.app), /requires --name/);
  f.app.sdk.list = async () => [{ sys_id: 'existing' }];
  await assert.rejects(add.handler({ ssh: 'test-target', name: 'owned-mid', directory: f.directory }, f.app), /already exists/);
  assert.deepEqual(trace, []); assert.equal(passwordPrompts, 0); assert.equal(fs.existsSync(f.directory), false);
});

test('remote direct dispatch defaults to Windows and selects Linux only explicitly', async t => {
  for (const nativePlatform of [undefined, 'linux']) {
    const f = fixture(t); let calls = 0;
    f.app.sdk.list = async () => ++calls === 1 ? [] : [{ name: 'owned-mid', status: 'Up', validated: 'false' }];
    await command('add').handler({ ssh: 'test-target', name: 'owned-mid', username: 'fixture-user', installMethod: 'direct', nativePlatform, directory: f.directory, waitTimeout: 10, waitInterval: 500 }, f.app);
    assert.deepEqual(trace.map(value => [value.runtime, value.action]), ['prepare', 'install', 'start'].map(action => [nativePlatform || 'windows', action]));
    assert.equal(f.results[0].registration, 'up');
    assert.equal(f.results[0].validated, false);
    assert.equal(f.results[0].installation, nativePlatform === 'linux' ? 'remote-linux-background' : 'remote-windows-service');
    assert.equal(f.writes.length, 0);
  }
});

test('remote start stop logs remove dispatch from owned metadata rather than platform guessing', async t => {
  for (const kind of ['windows', 'linux', 'docker']) {
    const f = fixture(t); metadata(f.directory, kind);
    for (const action of ['start', 'stop', 'logs', 'remove']) await command(action).handler({ ssh: 'test-target', identifier: 'owned-mid', directory: f.directory, force: true, tail: 10 }, f.app);
    assert.deepEqual(trace.map(value => [value.runtime, value.action]), ['start', 'stop', 'logs', 'remove'].map(action => [kind, action]));
    assert.equal(f.results.at(-1).remote_runtime_removed, true);
    assert.equal(f.results.at(-1).record_deleted, false);
  }
});

test('target instance and name mismatches block all remote lifecycle and instance deletion', async t => {
  for (const overrides of [{ target: 'other-target' }, { instanceURL: 'https://other.service-now.com' }, { name: 'other-mid' }]) {
    const f = fixture(t); metadata(f.directory, 'windows', overrides);
    f.app.sdk.list = async () => assert.fail('must not query/delete record after identity mismatch');
    for (const action of ['start', 'stop', 'logs', 'remove']) await assert.rejects(command(action).handler({ ssh: 'test-target', identifier: 'owned-mid', directory: f.directory, force: true }, f.app), /does not match/);
    assert.deepEqual(trace, []); assert.deepEqual(f.writes, []);
  }
});

test('remote removal requires explicit owned name and native follow refuses unsupported viewer', async t => {
  const f = fixture(t);
  await assert.rejects(command('remove').handler({ ssh: 'test-target', directory: f.directory, force: true }, f.app), /requires the owned MID name/);
  metadata(f.directory, 'windows');
  await assert.rejects(command('logs').handler({ ssh: 'test-target', identifier: 'owned-mid', directory: f.directory, follow: true }, f.app), /bounded --tail only/);
  assert.deepEqual(trace, []);
});

test('validate rejects Down and invokes platform validation action instead of flag mutation', async t => {
  const f = fixture(t); let actions = 0; let reads = 0;
  f.app.sdk.list = async () => [{ sys_id: 'mid-id', name: 'owned-mid', status: 'Down', validated: 'false' }];
  f.app.sdk.rawRequest = async () => { actions++; };
  await assert.rejects(command('validate').handler({ identifier: 'owned-mid', force: true }, f.app), { code: 'midserver_not_up' });
  assert.equal(actions, 0);
  f.app.sdk.list = async () => [{ sys_id: 'mid-id', name: 'owned-mid', status: 'Up', validated: ++reads > 1 ? 'true' : 'false' }];
  f.app.sdk.baseURL = 'https://example.service-now.com';
  f.app.sdk._warmSession = async () => 'fixture-cookie';
  f.app.sdk._getScriptsPageCSRF = async () => 'fixture-csrf';
  f.app.sdk.update = async () => assert.fail('must never write validated directly');
  f.app.sdk.rawRequest = async (url, options) => {
    actions++;
    assert.equal(url, 'https://example.service-now.com/xmlhttp.do'); assert.equal(options.method, 'POST');
    const params = new URLSearchParams(options.body);
    assert.equal(params.get('sysparm_processor'), 'MIDServerAjax');
    assert.equal(params.get('sysparm_name'), 'validateMID'); assert.equal(params.get('sysparm_agent'), 'mid-id');
  };
  await command('validate').handler({ identifier: 'owned-mid', force: true, timeout: 100 }, f.app);
  assert.equal(actions, 1); assert.equal(f.results.at(-1).validated, true);
});

test('actual CLI help exposes SSH direct platform choice and bounded remote lifecycle options', () => {
  const env = { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' };
  for (const [action, flags] of [['add', ['--ssh', '--native-platform', '--install-method', '--password-stdin']], ['logs', ['--ssh', '--tail', '--follow']], ['start', ['--ssh', '--directory']], ['remove', ['--ssh', '--directory']], ['validate', ['--timeout']]]) {
    const result = spawnSync(process.execPath, ['bin/jsn.js', 'midservers', action, '--help'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    for (const flag of flags) assert.ok(result.stdout.includes(flag), `${action} lacks ${flag}`);
    if (action === 'add') { assert.match(result.stdout, /windows/i); assert.match(result.stdout, /linux/i); }
  }
});


test('remote platform declaration defaults Windows and restricts explicit platform choices', () => {
  const options = {};
  const builder = { option(name, value) { options[name] = value; return builder; } };
  command('add').builder(builder);
  assert.deepEqual(options['native-platform'].choices, ['windows', 'linux']);
  assert.equal(options['native-platform'].default, 'windows');
  assert.deepEqual(options['install-method'].choices, ['docker', 'direct']);
});

test('platform trust validation requires approval before warming session or issuing platform action', async t => {
  const f = fixture(t);
  f.app.sdk.list = async () => [{ sys_id: 'mid-id', name: 'owned-mid', status: 'Up', validated: 'false' }];
  f.app.sdk._warmSession = async () => assert.fail('approval required before session warming');
  f.app.sdk.rawRequest = async () => assert.fail('approval required before platform action');
  await assert.rejects(command('validate').handler({ identifier: 'owned-mid', timeout: 100 }, f.app), { code: 'confirmation_required' });
});
