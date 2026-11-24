import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { recordsCmd } from '../src/commands/records.js';
import { isMutationCommand } from '../src/mutations.js';

const ID = 'e59ae049c33c571068353eec0501318b';
const AUDIT = 'c5eaec49c33c571068353eec05013186';
const entry = (extra = {}) => ({ sys_id: AUDIT, tablename: 'incident', documentkey: ID, display_value: 'INC0010315',
  sys_created_on: '2026-11-24 13:51:52', sys_created_by: 'admin', delete_recovery: '', payload: '<incident><number>INC0010315</number></incident>', ...extra });

function fixture({ entries = [entry()], exists = false, after = true, output = 'JSN_UNDELETE:dispatched' } = {}) {
  const commands = [];
  const builder = { command(c) { commands.push(c); return this; } };
  recordsCmd(fn => fn).builder(builder);
  const handler = commands.find(c => c.command === 'undelete').handler;
  const reads = [];
  const scripts = [];
  let data;
  const app = {
    config: {},
    sdk: {
      listStrict: async (table, params) => {
        reads.push({ table, ...Object.fromEntries(params) });
        if (table === 'sys_audit_delete') return entries;
        return (scripts.length ? after : exists) ? [{ sys_id: ID }] : [];
      },
      executeScript: async (script, scope) => { scripts.push({ script, scope }); return output; },
    },
    ok(value) { data = value; },
  };
  return { app, reads, scripts, get data() { return data; },
    run: (args = {}) => handler({ _: ['records', 'undelete'], table: 'incident', 'sys-id': ID, force: true, ...args }, app) };
}

test('undelete refuses a malformed table or sys_id before any request', async () => {
  for (const args of [{ table: 'incident^ORactive=true' }, { table: '' }, { 'sys-id': 'INC0010315' }, { 'sys-id': `${ID}0` }, { 'sys-id': undefined }]) {
    const f = fixture();
    await assert.rejects(f.run(args), /--table|--sys-id/);
    assert.deepEqual(f.reads, []);
    assert.deepEqual(f.scripts, []);
  }
});

test('undelete reads the newest deleted-record entry for exactly that table and sys_id', async () => {
  const f = fixture();
  await f.run();
  assert.equal(f.reads[0].table, 'sys_audit_delete');
  assert.equal(f.reads[0].sysparm_query, `tablename=incident^documentkey=${ID}^ORDERBYDESCsys_created_on`);
  assert.equal(f.reads[0].sysparm_limit, '1');
  assert.equal(f.reads[0].sysparm_display_value, 'false');
});

test('undelete refuses when no deletion is recorded, without running a script', async () => {
  const f = fixture({ entries: [] });
  await assert.rejects(f.run(), /No deleted record .*incident.*sys_audit_delete/s);
  assert.deepEqual(f.scripts, []);
});

test('undelete refuses an entry that does not match the table and sys_id asked for', async () => {
  for (const wrong of [{ tablename: 'task' }, { documentkey: 'f'.repeat(32) }, { sys_id: 'not-an-id' }]) {
    const f = fixture({ entries: [entry(wrong)] });
    await assert.rejects(f.run(), /does not match/);
    assert.deepEqual(f.scripts, []);
  }
});

test('undelete refuses when the record exists again, without running a script', async () => {
  const f = fixture({ exists: true });
  await assert.rejects(f.run(), /already exists/);
  assert.deepEqual(f.scripts, []);
});

test('undelete without --force and no terminal asks for confirmation and writes nothing', async () => {
  const previous = process.env.JSN_NO_PROMPTS;
  process.env.JSN_NO_PROMPTS = '1';
  try {
    const f = fixture();
    await assert.rejects(f.run({ force: false }), (error) => {
      assert.equal(error.code, 'confirmation_required');
      assert.match(error.message, /Restore incident INC0010315/);
      assert.match(error.hint, /jsn records undelete --table incident --sys-id e59ae049c33c571068353eec0501318b --force/);
      return true;
    });
    assert.deepEqual(f.scripts, []);
  } finally {
    if (previous === undefined) delete process.env.JSN_NO_PROMPTS; else process.env.JSN_NO_PROMPTS = previous;
  }
});

test('undelete runs one guarded global script and verifies the record is back', async () => {
  const f = fixture();
  await f.run();
  assert.equal(f.scripts.length, 1);
  const { script, scope } = f.scripts[0];
  assert.equal(scope, 'global');
  assert.match(script, /gs\.hasRole\('admin'\)/);
  assert.match(script, new RegExp(`entry\\.get\\('${AUDIT}'\\)`));
  assert.match(script, /getValue\('tablename'\) !== 'incident'/);
  assert.match(script, new RegExp(`getValue\\('documentkey'\\) !== '${ID}'`));
  assert.match(script, new RegExp(`record\\.get\\('${ID}'\\)`));
  assert.match(script, new RegExp(`new GlideAuditDelete\\(\\)\\.undelete\\('${AUDIT}'\\)`));
  assert.deepEqual(f.reads.at(-1), { table: 'incident', sysparm_query: `sys_id=${ID}`, sysparm_fields: 'sys_id', sysparm_limit: '1' });
  assert.equal(f.data.restored, true);
  assert.equal(f.data.sys_id, ID);
  assert.equal(f.data.display_value, 'INC0010315');
  assert.equal(f.data.audit_delete, AUDIT);
  assert.equal(f.data.deleted_by, 'admin');
});

test('undelete reports an unknown outcome when the script prints no marker', async () => {
  const f = fixture({ output: '*** Script: Admin role required' });
  await assert.rejects(f.run(), /outcome is unknown.*Admin role required/s);
  assert.equal(f.data, undefined);
});

test('undelete never reports success when the record cannot be read back', async () => {
  const f = fixture({ after: false });
  await assert.rejects(f.run(), /not readable after the undelete/);
  assert.equal(f.data, undefined);
  const denied = fixture();
  const list = denied.app.sdk.listStrict;
  denied.app.sdk.listStrict = async (table, params) => {
    if (denied.scripts.length) throw Object.assign(new Error('Forbidden'), { status: 403 });
    return list(table, params);
  };
  await assert.rejects(denied.run(), /Forbidden/);
  assert.equal(denied.data, undefined);
});

test('undelete holds a verified capture context to the deleted record\'s own scope', async () => {
  const scoped = (payload, applicationId) => {
    const f = fixture({ entries: [entry({ payload })] });
    f.app.mutationContext = { verified: true, application_id: applicationId };
    return f;
  };
  const other = scoped('<sys_script_include><sys_scope display_value="Global">global</sys_scope></sys_script_include>', 'a'.repeat(32));
  await assert.rejects(other.run(), /scope is unknown or differs/);
  assert.deepEqual(other.scripts, []);
  const missing = scoped('<sys_script_include><name>x</name></sys_script_include>', 'global');
  await assert.rejects(missing.run(), /scope is unknown or differs/);
  assert.deepEqual(missing.scripts, []);
  const same = scoped('<sys_script_include><sys_scope display_value="Global">global</sys_scope></sys_script_include>', 'global');
  await same.run();
  assert.equal(same.scripts.length, 1);
});

test('undelete is registered as a mutation and its help lists its flags', () => {
  assert.equal(isMutationCommand({ _: ['records', 'undelete'] }), true);
  const result = spawnSync(process.execPath, ['cli/bin/jsn.js', 'records', 'undelete', '--help'], {
    cwd: new URL('../../', import.meta.url), encoding: 'utf8',
    env: { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  for (const flag of ['--table', '--sys-id', '--force']) assert.ok(result.stdout.includes(flag));
  assert.match(result.stdout, /Attachments/);
});
