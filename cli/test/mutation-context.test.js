import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as helpers from '../src/helpers.js';
import { declareCapabilities } from '../src/capabilities.js';
mock.module('../src/helpers.js', { namedExports: { ...helpers, canUsePicker: app => !!app.interactive } });
const { guardMutationContext, needsMutationContext } = await import('../src/mutation-context.js');
declareCapabilities('fixture', { mutationSubcommands: ['create', 'delete'] });
const scopeId = 'a'.repeat(32), setId = 'b'.repeat(32);
function fixture({ scope = 'global', name = 'Default', application = scopeId, state = 'in progress', missingScope = false } = {}) {
  const calls = [];
  const app = { config: {}, session: { profileName: 'p' }, sdk: {
    baseURL: 'https://fixture.invalid',
    list: async (table, params) => {
      calls.push(table);
      if (table === 'sys_user') return [{ sys_id: 'user', user_name: 'fixture' }];
      if (table === 'sys_scope') return [{ sys_id: scopeId, scope }];
      if (table === 'sys_update_set') return [{ sys_id: setId, name }];
      if (params.get('sysparm_query').includes('apps.current_app')) return missingScope ? [] : [{ value: scopeId }];
      return [{ value: setId }];
    },
    get: async table => table === 'sys_scope' ? { scope } : { name, application, state },
    request: async endpoint => ({ result: { current: endpoint.endsWith('/application') ? scopeId : { sysId: setId } } }),
  } };
  return { app, calls };
}
const argv = { _: ['fixture', 'create'], expectScope: scopeId, expectUpdateSet: setId };
it('requires informed Global+Default approval even with independent expectations', async () => {
  const { app } = fixture();
  await assert.rejects(guardMutationContext(app, argv), error => {
    assert.equal(error.code, 'confirmation_required'); assert.equal(error.context.approval_required, true); return true;
  });
});
it('interactive Global+Default approval continues; declining refuses', async () => {
  const { app } = fixture(); app.interactive = true;
  await assert.rejects(guardMutationContext(app, argv, { ask: async () => false }), { code: 'confirmation_required' });
  assert.equal((await guardMutationContext(app, argv, { ask: async () => true })).approved, true);
});
it('force approves only verified Global+Default with supplied intent', async () => {
  const { app } = fixture();
  assert.equal((await guardMutationContext(app, { ...argv, force: true })).approved, true);
  await assert.rejects(guardMutationContext(app, { _: argv._, force: true }), /require intended/);
});
it('interactive missing intent requires confirmation of fresh named context', async () => {
  const { app } = fixture({ name: 'Feature' }); app.interactive = true;
  let asked = false;
  const context = await guardMutationContext(app, { _: argv._ }, { ask: async question => { asked = true; assert.equal(question.default, false); return true; } });
  assert.equal(asked, true); assert.equal(context.verified, true);
});
it('named context with explicit intent does not ask an unnecessary question', async () => {
  const { app } = fixture({ name: 'Feature' }); app.interactive = true;
  assert.equal((await guardMutationContext(app, argv, { ask: async () => assert.fail('unnecessary prompt') })).approval_required, false);
});
for (const settings of [{ missingScope: true }, { application: 'other' }, { state: 'complete' }, { state: '' }]) {
  it(`refuses unknown, mismatched or incomplete context with force: ${JSON.stringify(settings)}`, async () => {
    const { app } = fixture(settings);
    await assert.rejects(guardMutationContext(app, { ...argv, force: true }), { code: 'usage_error' });
  });
}
it('context management and runtime operation metadata exemptions are deliberate', async () => {
  await import('../src/commands/updatesets.js'); await import('../src/commands/scopes.js'); await import('../src/commands/rest.js');
  for (const path of [['updatesets', 'create'], ['updatesets', 'set'], ['scopes', 'set']]) assert.equal(needsMutationContext({ _: path }), false);
  assert.equal(needsMutationContext({ _: ['scopes', 'create'] }), true);
  assert.equal(needsMutationContext({ _: ['rest'], method: 'GET' }), false);
  assert.equal(needsMutationContext({ _: ['rest'], method: 'POST' }), true);
});
