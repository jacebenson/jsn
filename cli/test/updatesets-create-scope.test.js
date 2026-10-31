import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { updateSetsCmd } from '../src/commands/updatesets.js';

function fixture({ missing = false, denied = false, ineffective = false, selectionDenied = false } = {}) {
  const calls = [];
  let currentScope = 'global';
  let output;
  const app = {
    sdk: {
      baseURL: 'https://example.invalid',
      async list(table, params) {
        calls.push({ table, query: params.get('sysparm_query') });
        if (table === 'sys_user') return [{ sys_id: 'user' }];
        if (table === 'sys_scope' && !missing) {
          return [{ sys_id: { value: 'scope-id', display_value: 'Workspace' }, scope: 'sn_sow' }];
        }
        return [];
      },
      async request(endpoint, options = {}) {
        const picker = new URL(endpoint).pathname.split('/').at(-1);
        calls.push({ picker, method: options.method, body: options.body && JSON.parse(options.body) });
        if (picker === 'application') {
          if (denied) throw new Error('scope denied');
          if (options.method === 'PUT' && !ineffective) currentScope = JSON.parse(options.body).app_id;
          return { result: { current: currentScope } };
        }
        if (selectionDenied) throw new Error('set denied');
        return { result: { current: { sysId: 'created-set' } } };
      },
      async create(table, data) {
        calls.push({ create: table, data });
        return { sys_id: 'created-set', ...data };
      },
    },
    ok(data, options) { output = { data, ...options }; },
  };
  const commands = [];
  const cli = { command(value) { commands.push(value); return cli; } };
  updateSetsCmd(fn => fn).builder(cli);
  return { app, calls, command: commands.find(value => value.command === 'create'), output: () => output };
}

it('advertises --scope through the executable help', () => {
  const result = spawnSync(process.execPath, ['bin/jsn.js', 'updatesets', 'create', '--help'], {
    encoding: 'utf8', env: { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--scope/);
});

it('resolves and verifies scope before creating, then selects the new set', async () => {
  const f = fixture();
  await f.command.handler({ name: 'Feature', scope: 'sn_sow' }, f.app);
  const operations = f.calls.filter(call => call.picker || call.create);
  assert.deepEqual(operations, [
    { picker: 'application', method: 'PUT', body: { app_id: 'scope-id' } },
    { picker: 'application', method: 'GET', body: undefined },
    { create: 'sys_update_set', data: { name: 'Feature', description: 'Feature', state: 'in progress', application: 'scope-id' } },
    { picker: 'updateset', method: 'PUT', body: { sysId: 'created-set' } },
    { picker: 'updateset', method: 'GET', body: undefined },
  ]);
  assert.equal(f.output().data.sys_id, 'created-set');
});

for (const [options, scope, message] of [
  [{ missing: true }, 'missing', /Scope not found/],
  [{ denied: true }, 'sn_sow', /scope denied/],
  [{ ineffective: true }, 'sn_sow', /selection was not applied/],
  [{}, '', /scope.*empty/i],
  [{}, '   ', /scope.*empty/i],
  [{}, 'sn_sow^ORactive=true', /unsafe|invalid|encoded/i],
]) {
  it(`refuses creation for scope ${JSON.stringify(scope)} with ${JSON.stringify(options)}`, async () => {
    const f = fixture(options);
    await assert.rejects(() => f.command.handler({ name: 'Feature', scope }, f.app), message);
    assert.equal(f.calls.some(call => call.create || call.picker === 'updateset'), false);
    assert.equal(f.output(), undefined);
  });
}

it('preserves creation without --scope and does not switch application', async () => {
  const f = fixture();
  await f.command.handler({ name: 'Feature' }, f.app);
  assert.equal(f.calls.some(call => call.table === 'sys_scope' || call.picker === 'application'), false);
  assert.deepEqual(f.calls.find(call => call.create).data, { name: 'Feature', description: 'Feature', state: 'in progress' });
});

it('reports successful creation separately from failed update-set selection', async () => {
  const f = fixture({ selectionDenied: true });
  await f.command.handler({ name: 'Feature', scope: 'sn_sow' }, f.app);
  assert.equal(f.output().data.sys_id, 'created-set');
  assert.match(f.output().summary, /not selected as current: set denied/);
});
