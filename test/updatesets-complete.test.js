import test, { mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as helpers from '../src/helpers.js';
import * as prompts from '@inquirer/prompts';
import { yargs } from '../src/cli-adapter.js';

let interactive, answer, confirmed, promptCalls, currentID;
mock.module('../src/helpers.js', { namedExports: { ...helpers, canPrompt: () => interactive } });
mock.module('@inquirer/prompts', { namedExports: { ...prompts,
  editor: async () => { promptCalls.push('notes'); if (answer instanceof Error) throw answer; return answer; },
  confirm: async options => { promptCalls.push(options); if (confirmed instanceof Error) throw confirmed; return confirmed; },
} });
mock.module('../src/context.js', { namedExports: {
  requireCurrentUserSysId: async () => 'user',
  getCurrentUpdateSet: async () => currentID ? { sys_id: currentID, name: 'Current' } : null,
  getCurrentApplication: async () => ({ appSysId: 'scope' }),
  setCurrentApplication: async () => {}, setCurrentUpdateSet: async () => {},
} });
const { updateSetsCmd } = await import('../src/commands/updatesets.js');

beforeEach(() => { interactive = false; answer = 'Fixed validation'; confirmed = true; promptCalls = []; currentID = 'current'; });
function fixture(description = '') {
  const records = [
    { sys_id: 'current', name: 'Current', state: 'in progress', description: '' },
    { sys_id: 'selected', name: 'Feature', state: 'in progress', description },
    { sys_id: 'child', name: 'Child', parent: 'selected', state: 'in progress', description: 'Child notes' },
  ];
  const writes = [], reads = [], results = [];
  const app = { config: {}, output: { getFormat: () => 'auto' }, ok: data => results.push(data), sdk: {
    list: async (table, params) => {
      reads.push({ table, query: params.get('sysparm_query') });
      assert.equal(table, 'sys_update_set');
      const query = params.get('sysparm_query');
      const found = records.filter(r => query === `sys_id=${r.sys_id}` || query === `name=${r.name}`);
      return structuredClone(found);
    },
    update: async (table, id, data) => { writes.push({ table, id, data }); Object.assign(records.find(r => r.sys_id === id), data); },
  } };
  return { app, records, writes, reads, results };
}
async function run(args, app) {
  await yargs(['updatesets', 'complete', ...args]).strictCommands().strictOptions()
    .option('force', { type: 'boolean' }).option('json', { type: 'boolean' }).option('get', { type: 'string' })
    .command(updateSetsCmd(handler => argv => handler(argv, app)))
    .fail((message, error) => { throw error || new Error(message); }).parse();
}

test('registered complete parser saves supplied notes on the current set', async () => {
  const f = fixture();
  await run(['--notes', 'Fixed validation\n* Added tests'], f.app);
  assert.deepEqual(f.writes, [{ table: 'sys_update_set', id: 'current', data: { state: 'complete', description: '- Fixed validation\n- Added tests' } }]);
  assert.equal(f.results[0].sys_id, 'current');
  assert.equal(promptCalls.length, 0);
});

test('existing raw description is shown and preserved after append confirmation', async () => {
  interactive = true;
  const f = fixture();
  const existing = '  Original\r\n\r\n';
  f.records[0].description = { value: existing, display_value: 'NOT the stored description' };
  await run(['--notes', 'Fixed validation'], f.app);
  assert.equal(f.writes[0].data.description, `${existing}\n\n- Fixed validation`);
  assert.equal(promptCalls.length, 1);
  assert.match(promptCalls[0].message, /Original/);
  assert.match(promptCalls[0].message, /Fixed validation/);
  assert.equal(promptCalls[0].default, false);
});

test('declining append confirmation makes no write', async () => {
  interactive = true; confirmed = false;
  const f = fixture(); f.records[0].description = 'Keep this';
  await run(['--notes', 'New note'], f.app);
  assert.equal(f.writes.length, 0);
  assert.equal(f.results.length, 0);
});

test('notes are prompted when absent and prompt cancellation makes no write', async () => {
  interactive = true;
  const f = fixture();
  await run([], f.app);
  assert.equal(f.writes[0].data.description, '- Fixed validation');
  assert.deepEqual(promptCalls, ['notes']);
  answer = Object.assign(new Error('cancelled'), { name: 'ExitPromptError' });
  const cancelled = fixture();
  await run([], cancelled.app);
  assert.equal(cancelled.writes.length, 0);
  assert.equal(cancelled.results.length, 0);
});

test('missing or empty notes in noninteractive mode never writes', async () => {
  for (const args of [[], ['--notes', ' '], ['--notes', '-\n*\n•']]) {
    const f = fixture();
    await assert.rejects(run(args, f.app), /nonempty completion notes|--notes/);
    assert.equal(f.writes.length, 0);
    assert.equal(promptCalls.length, 0);
  }
});

test('JSON and extraction never open notes or confirmation prompts even on a TTY', async () => {
  interactive = true;
  for (const args of [['--json'], ['--get', 'description']]) {
    const missing = fixture();
    await assert.rejects(run(args, missing.app), /--notes/);
    assert.equal(missing.writes.length, 0);
    const existing = fixture(); existing.records[0].description = 'Existing';
    await assert.rejects(run([...args, '--notes', 'New'], existing.app), { code: 'confirmation_required' });
    assert.equal(existing.writes.length, 0);
    assert.equal(promptCalls.length, 0);
  }
});

test('existing descriptions require explicit force or profile confirmation policy in automation', async () => {
  const denied = fixture(); denied.records[0].description = 'Existing';
  await assert.rejects(run(['--notes', 'New'], denied.app), { code: 'confirmation_required' });
  assert.equal(denied.writes.length, 0);
  for (const policy of ['force', 'profile']) {
    const f = fixture(); f.records[0].description = 'Existing';
    if (policy === 'profile') f.app.config = { activeProfile: 'test', profiles: { test: { skip_confirmations: true } } };
    await run(['--notes', 'New', ...(policy === 'force' ? ['--force'] : [])], f.app);
    assert.equal(f.writes[0].data.description, 'Existing\n\n- New');
    assert.equal(promptCalls.length, 0);
  }
});

test('explicit name completes only the selected set, preserving its description and leaving children untouched', async () => {
  const f = fixture('Existing feature notes');
  const beforeCurrent = structuredClone(f.records[0]), beforeChild = structuredClone(f.records[2]);
  await run(['Feature', '--notes', 'Changed feature', '--force'], f.app);
  assert.deepEqual(f.writes, [{ table: 'sys_update_set', id: 'selected', data: { state: 'complete', description: 'Existing feature notes\n\n- Changed feature' } }]);
  assert.deepEqual(f.records[0], beforeCurrent);
  assert.deepEqual(f.records[2], beforeChild);
  assert.equal(f.results[0].update_set, 'Feature');
  assert.equal(f.reads.some(read => /parent=|update_set=/.test(read.query)), false);
});

test('missing, ambiguous, empty, or query-injected explicit names never write', async () => {
  for (const name of ['Missing', 'Feature', '', 'Feature^ORname=Current']) {
    const f = fixture();
    if (name === 'Feature') f.records.push({ sys_id: 'duplicate', name, application: 'scope', state: 'in progress' });
    await assert.rejects(run([name, '--notes', 'New'], f.app), /not found|Multiple update sets|empty|metacharacter|query|unsafe/i);
    assert.equal(f.writes.length, 0);
  }
});

test('no current set or unreadable selected record never writes', async () => {
  currentID = null;
  const f = fixture();
  await assert.rejects(run(['--notes', 'New'], f.app), /No current update set/);
  currentID = 'unreadable';
  await assert.rejects(run(['--notes', 'New'], f.app), /not found or unreadable/);
  assert.equal(f.writes.length, 0);
});

test('platform dropping state or description is detected by readback, never reported as success', async () => {
  for (const field of ['state', 'description']) {
    const f = fixture();
    f.app.sdk.update = async (table, id, data) => {
      f.writes.push({ table, id, data });
      const accepted = { ...data }; delete accepted[field];
      Object.assign(f.records.find(r => r.sys_id === id), accepted);
      return { ...data }; // An optimistic response is not persistence proof.
    };
    await assert.rejects(run(['--notes', 'New'], f.app), error => {
      assert.equal(error.code, 'api_error');
      assert.match(error.message, new RegExp(`verif.*${field}`, 'i'));
      assert.match(error.message, /current/);
      return true;
    });
    assert.equal(f.writes.length, 1);
    assert.equal(f.results.length, 0);
  }
});

test('readback failure is reported as uncertain completion, not success', async () => {
  const f = fixture();
  const read = f.app.sdk.list;
  f.app.sdk.list = async (...args) => {
    if (f.writes.length) throw new Error('Read ACL denied');
    return read(...args);
  };
  await assert.rejects(run(['--notes', 'New'], f.app), /verif.*current/i);
  assert.equal(f.writes.length, 1);
  assert.equal(f.results.length, 0);
});

test('update errors identify the selected update set and never report success', async () => {
  const f = fixture();
  f.app.sdk.update = async () => { throw new Error('Write ACL denied'); };
  await assert.rejects(run(['Feature', '--notes', 'New'], f.app), /Feature.*selected.*Write ACL denied/);
  assert.equal(f.results.length, 0);
});

test('unreadable Description fails before any write rather than replacing unknown text', async () => {
  for (const hidden of [undefined, { display_value: 'Display text, raw value hidden' }]) {
    const f = fixture();
    if (hidden === undefined) delete f.records[0].description;
    else f.records[0].description = hidden;
    await assert.rejects(run(['--notes', 'New'], f.app), /Description.*unreadable|unreadable.*Description/i);
    assert.equal(f.writes.length, 0);
  }
});

test('confirmation prompt cancellation makes no write', async () => {
  interactive = true;
  confirmed = Object.assign(new Error('cancelled'), { name: 'AbortPromptError' });
  const f = fixture(); f.records[0].description = 'Existing';
  await run(['--notes', 'New'], f.app);
  assert.equal(f.writes.length, 0);
  assert.equal(f.results.length, 0);
});
