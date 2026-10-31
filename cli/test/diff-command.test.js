import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { diffCmd } from '../src/commands/diff.js';
import { FormatJSON, OutputWriter } from '../src/output.js';
import { collectCapabilities, mutationPaths } from '../src/capabilities.js';

function commandTree() {
  const commands = [];
  const yargs = {
    command(definition) { commands.push(definition); return this; },
    option() { return this; },
  };
  diffCmd(fn => fn).builder(yargs);
  return commands;
}

function recordCommand() {
  const command = commandTree().find(item => item.command === 'record');
  assert.ok(command, 'missing diff record command');
  return command;
}

function profileApp(records) {
  let serialized = '';
  const writer = new Writable({ write(chunk, _encoding, callback) { serialized += chunk.toString(); callback(); } });
  const output = new OutputWriter({ format: FormatJSON, writer });
  const profiles = {
    dev: { instance_url: 'https://dev.example', auth_method: 'oauth', username: 'dev-user' },
    prod: { instance_url: 'https://prod.example', auth_method: 'oauth', username: 'prod-user' },
  };
  const app = {
    config: { profiles, activeProfile: 'dev', defaultProfile: 'dev' },
    output,
    getSDKForProfile(instance, options) {
      return records[options.profileName] || records[instance];
    },
    ok(data, opts) { this.output.ok(data, opts); },
  };
  return { app, envelope: () => JSON.parse(serialized) };
}

const found = record => ({ async list() { return [record]; } });

 test('diff record reports equal raw reference values and profile metadata', async () => {
  const command = recordCommand();
  const { app, envelope } = profileApp({
    dev: found({ sys_id: '1', caller_id: { value: 'u1', display_value: 'Alice' }, name: 'same' }),
    prod: found({ sys_id: '1', caller_id: { value: 'u1', display_value: 'Alicia' }, name: 'same' }),
  });
  await command.handler({ table: 'incident', 'sys-id': '1', 'profile-a': 'dev', 'profile-b': 'prod' }, app);
  const result = envelope();
  assert.equal(result.ok, true);
  assert.equal(result.data.status, 'equal');
  assert.deepEqual(result.data.profiles.a, { name: 'dev', instance: 'https://dev.example' });
  assert.deepEqual(result.data.profiles.b, { name: 'prod', instance: 'https://prod.example' });
  assert.deepEqual(result.data.differences, []);
});

test('diff record reports changed, added, missing, and ignored fields', async () => {
  const command = recordCommand();
  const { app, envelope } = profileApp({
    dev: found({ sys_id: '1', state: '1', only_a: 'x', sys_updated_on: 'old' }),
    prod: found({ sys_id: '1', state: '2', only_b: 'y', sys_updated_on: 'new' }),
  });
  await command.handler({ table: 'incident', 'sys-id': '1', 'profile-a': 'dev', 'profile-b': 'prod', ignore: ['state'] }, app);
  const result = envelope();
  assert.equal(result.data.status, 'different');
  assert.deepEqual(result.data.ignored_fields, ['state', 'sys_created_by', 'sys_created_on', 'sys_mod_count', 'sys_updated_by', 'sys_updated_on']);
  assert.deepEqual(result.data.differences.map(item => item.status), ['missing', 'added']);
  assert.deepEqual(result.data.differences.map(item => item.field), ['only_a', 'only_b']);

  const second = profileApp({
    dev: found({ sys_id: '1', state: '1', sys_updated_on: 'old' }),
    prod: found({ sys_id: '1', state: '2', sys_updated_on: 'new' }),
  });
  await command.handler({ table: 'incident', 'sys-id': '1', 'profile-a': 'dev', 'profile-b': 'prod', 'no-ignore': true }, second.app);
  assert.equal(second.envelope().data.differences.some(item => item.field === 'state'), true);
  assert.equal(second.envelope().data.differences.some(item => item.field === 'sys_updated_on'), true);
});

test('diff record keeps a missing record distinct from an equal empty record', async () => {
  const command = recordCommand();
  const { app, envelope } = profileApp({
    dev: { async list() { return []; } },
    prod: found({ sys_id: '1', name: 'present' }),
  });
  await command.handler({ table: 'task', 'sys-id': '1', 'profile-a': 'dev', 'profile-b': 'prod' }, app);
  const data = envelope().data;
  assert.equal(data.status, 'missing');
  assert.equal(data.existence.a, 'missing');
  assert.equal(data.existence.b, 'found');
  assert.deepEqual(data.differences, []);
});

test('diff record preserves permission/error state instead of treating it as empty', async () => {
  const command = recordCommand();
  const { app, envelope } = profileApp({
    dev: { async list() { const error = new Error('forbidden'); error.code = 'forbidden'; throw error; } },
    prod: found({ sys_id: '1' }),
  });
  await command.handler({ table: 'task', 'sys-id': '1', 'profile-a': 'dev', 'profile-b': 'prod' }, app);
  const data = envelope().data;
  assert.equal(data.status, 'forbidden');
  assert.equal(data.existence.a, 'forbidden');
  assert.equal(data.differences.length, 0);
});

test('diff is read-only and does not register mutation paths', () => {
  const names = [...collectCapabilities().keys()];
  assert.ok(names.includes('diff'));
  assert.equal(mutationPaths().some(path => path[0] === 'diff'), false);
});
