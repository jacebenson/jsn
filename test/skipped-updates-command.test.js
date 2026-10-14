import test from 'node:test';
import assert from 'node:assert/strict';
import { skippedUpdatesCmd } from '../src/commands/skipped-updates.js';
import { isMutationCommand } from '../src/mutations.js';
import { OutputWriter, FormatJSON } from '../src/output.js';

function children(cmd) {
  const list = [];
  const y = new Proxy({}, { get: (_obj, key) => key === 'command' ? child => { list.push(child); return y; } : () => y });
  cmd.builder(y); return list;
}
const id = 'a'.repeat(32);
function appFor(sdk) {
  let stdout = '';
  const output = new OutputWriter({ format: FormatJSON, writer: { write: text => { stdout += text; } } });
  return { sdk, output, getEffectiveInstance: () => 'https://example.service-now.com',
    requireInstance() {}, ok: (data, opts) => output.ok(data, opts), stdout: () => stdout };
}
test('CLI registers review, preview and guarded process; list JSON stays one extractable envelope', async () => {
  const commands = children(skippedUpdatesCmd(fn => fn));
  assert.deepEqual(commands.map(c => c.command), ['list', 'review <sys-id>', 'preview', 'process']);
  assert.equal(isMutationCommand({ _: ['skipped-updates', 'process'] }), true);
  assert.equal(isMutationCommand({ _: ['skipped-updates', 'preview'] }), false);
  const app = appFor({ list: async () => [{ sys_id: id, disposition: '4', resolution_status: '' }] });
  await commands[0].handler({ limit: 10, offset: 0 }, app);
  assert.equal(JSON.parse(app.stdout()).data.findings[0].sys_id, id);
});
test('shared interactive list selection renders readable impact instead of hiding nested data', async () => {
  const artifact = 'c'.repeat(32);
  const commands = children(skippedUpdatesCmd(fn => fn, { canUsePicker: () => true,
    interactiveList: async () => ({ sys_id: id }) }));
  const app = appFor({ list: async () => [], get: async (table, sysID) => table === 'sys_upgrade_history_log'
    ? { sys_id: sysID, disposition: '4', resolution_status: '', file_name: `sys_script_include_${artifact}` }
    : { sys_id: artifact }, getSkippedUpdateBaseline: async () => null });
  await commands[0].handler({}, app);
  assert.match(JSON.parse(app.stdout()).data._formatted, /Read-only review/);
});

test('guided multi-selection renders exact preview before one refused confirmation and never writes', async () => {
  const second = 'b'.repeat(32), artifact = 'c'.repeat(32);
  const commands = children(skippedUpdatesCmd(fn => fn, { canUsePicker: () => true,
    checkbox: async options => { assert.equal(options.choices.length, 2); return [id, second]; },
    select: async () => 'retain', confirm: async () => {
      const output = JSON.parse(app.stdout());
      assert.deepEqual(output.data.selected.map(row => row.sys_id), [id, second]);
      assert.equal(output.data.selected.every(row => row.action === 'retain'), true);
      assert.match(output.data._formatted, /Exact selected batch: 2/);
      return false;
    } }));
  const sdk = { list: async table => table === 'sys_upgrade_history_log'
    ? [id, second].map(sys_id => ({ sys_id, disposition: '4', resolution_status: '' })) : [],
  get: async (table, sysID) => table === 'sys_upgrade_history_log'
    ? { sys_id: sysID, disposition: '4', resolution_status: '', file_name: `sys_script_include_${artifact}` }
    : { sys_id: artifact, script: 'custom()' },
  getSkippedUpdateBaseline: async () => null,
  update: () => assert.fail('unexpected write') };
  const app = appFor(sdk);
  app.config = { profiles: { test: { skip_confirmations: true } }, activeProfile: 'test' };
  await commands.find(c => c.command === 'process').handler({ force: true }, app);
  // Guided output intentionally has two envelopes: exact preview, then outcome.
  const documents = app.stdout().trim().split(/\n(?=\{)/).map(text => JSON.parse(text));
  assert.equal(documents.length, 2); assert.equal(documents[1].data.cancelled, true);
});

test('--get extraction uses the same list output envelope', async () => {
  const commands = children(skippedUpdatesCmd(fn => fn));
  const app = appFor({ list: async () => [{ sys_id: id, disposition: '4', resolution_status: '' }] });
  app.output.setJqFilter('data.findings.0.sys_id');
  await commands[0].handler({ limit: 10, offset: 0, get: 'data.findings.0.sys_id' }, app);
  assert.equal(JSON.parse(app.stdout()), id);
});

test('automation does not prompt or pick targets when ids/action are omitted', async () => {
  const commands = children(skippedUpdatesCmd(fn => fn, { canUsePicker: () => false,
    checkbox: () => assert.fail('unexpected picker'), select: () => assert.fail('unexpected action picker'),
    confirm: () => assert.fail('unexpected confirmation') }));
  const app = appFor({ get: () => assert.fail('unexpected read') });
  await assert.rejects(commands.find(c => c.command === 'process').handler({}, app), /ids|Select/);
});
