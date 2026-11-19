import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionsCmd } from '../src/commands/actions.js';
const intended = 'a'.repeat(32), foreign = 'c'.repeat(32), id = 'd'.repeat(32);
function commands() {
  const list = [];
  actionsCmd(fn => fn).builder({ command(c) { list.push(c); return this; } });
  return new Map(list.map(c => [c.command.split(' ')[0], c]));
}
for (const verb of ['update', 'delete']) {
  test(`actual actions ${verb} binds a matching target to verified scope`, async () => {
    const writes = [];
    const app = { mutationContext: { verified: true, application_id: intended }, config: {}, requireInstance() {}, ok() {},
      sdk: { baseURL: 'https://fixture.invalid',
        list: async () => [{ sys_id: id, sys_scope: intended }],
        get: async table => table === 'sys_scope' ? { sys_id: intended } : { sys_id: id, sys_scope: intended },
        updateProcessFlowAction: async (target, scope) => { writes.push([target, scope]); return {}; },
        delete: async (table, target) => writes.push([table, target]), request: async () => ({ result: [] }),
      } };
    await commands().get(verb).handler({ identifier: id, force: true, data: '{}' }, app);
    assert.equal(writes.length, 1);
    if (verb === 'update') assert.deepEqual(writes[0], [id, intended]);
  });
  test(`actual actions ${verb} refuses an inferred target outside verified scope before any write`, async () => {
    const writes = [];
    const app = { mutationContext: { verified: true, application_id: intended }, config: {}, requireInstance() {}, ok() {},
      sdk: {
        baseURL: 'https://fixture.invalid',
        list: async () => [{ sys_id: id, sys_scope: { value: foreign }, name: 'Foreign action' }],
        get: async table => table === 'sys_scope' ? { sys_id: foreign } : { sys_id: id, sys_scope: foreign },
        delete: async () => writes.push('delete'),
        updateProcessFlowAction: async () => { writes.push('update'); return {}; },
        request: async () => ({ result: [] }),
      } };
    await assert.rejects(commands().get(verb).handler({ identifier: id, force: true, data: '{}' }, app), /scope/i);
    assert.deepEqual(writes, []);
  });
}
