import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as helpers from '../src/helpers.js';
import { declareCapabilities } from '../src/capabilities.js';
mock.module('../src/helpers.js', { namedExports: { ...helpers, canUsePicker: app => !!app.interactive } });
const { guardMutationContext, needsMutationContext } = await import('../src/mutation-context.js');
declareCapabilities('fixture', { mutationSubcommands: ['create', 'delete'] });
function fixture({ scope = 'global', name = 'Default', application = 'global', state = 'in progress', missingScope = false } = {}) {
  const calls = [];
  const app = { config: { profiles: { p: { skip_confirmations: true } }, activeProfile: 'p' }, session: { profileName: 'p' }, sdk: {
    list: async (table, params) => {
      calls.push(table);
      if (table === 'sys_user') return [{ sys_id: 'user' }];
      if (params.get('sysparm_query').includes('apps.current_app')) return missingScope ? [] : [{ value: scope }];
      return [{ value: 'set' }];
    },
    get: async (table) => table === 'sys_scope' ? { scope } : { name, application, state },
  } };
  return { app, calls };
}
const argv = { _: ['fixture', 'create'] };
it('requires informed noninteractive approval independent of skip-delete preference', async () => {
  const { app } = fixture();
  await assert.rejects(guardMutationContext(app, argv, { rawArgs: ['fixture', 'create', '--data', '{"name":"x"}'] }), error => {
    assert.equal(error.code, 'confirmation_required');
    assert.equal(error.context.approval_required, true);
    assert.equal(error.context.scope, 'global');
    assert.equal(error.context.diagnostics[0].code, 'global_default_update_set');
    assert.match(error.hint, /--data.*name.*--profile p --force/);
    return true;
  });
});
it('interactive approval continues intentionally in Global; declining prevents mutation', async () => {
  const { app } = fixture(); app.interactive = true; let questions = [];
  await assert.rejects(guardMutationContext(app, argv, { ask: async question => { questions.push(question); return false; } }), { code: 'confirmation_required' });
  assert.equal(questions[0].default, false); assert.match(questions[0].message, /Scope: Global; update set: Default/);
  const approvedArgv = { ...argv };
  const context = await guardMutationContext(app, approvedArgv, { ask: async () => true });
  assert.equal(context.approved, true);
});
it('explicit force approval permits intentional Global work', async () => {
  const { app } = fixture();
  const context = await guardMutationContext(app, { ...argv, force: true });
  assert.equal(context.approved, true);
});
for (const settings of [{ scope: 'x_feature', application: 'x_feature' }, { name: 'My Feature' }, { name: 'Default cleanup' }]) {
  it(`does not require approval for ${JSON.stringify(settings)}`, async () => {
    const { app } = fixture(settings); app.interactive = true;
    const context = await guardMutationContext(app, argv, { ask: async () => assert.fail('unnecessary prompt') });
    assert.equal(context.approval_required, false);
  });
}
it('unknown scope stays unknown even with Default selected', async () => {
  const { app } = fixture({ missingScope: true });
  const context = await guardMutationContext(app, argv);
  assert.equal(context.scope, null); assert.equal(context.approval_required, false);
  assert.equal(context.diagnostics[0].code, 'capture_context_unknown');
});
it('scope mismatch is an actionable warning without confirmation', async () => {
  const { app } = fixture({ scope: 'x_feature', application: { value: 'other-id', display_value: 'Other App' }, name: 'Feature' });
  const context = await guardMutationContext(app, argv);
  assert.equal(context.diagnostics[0].code, 'update_set_scope_mismatch');
  assert.equal(context.diagnostics[0].severity, 'warning');
  assert.equal(context.diagnostics[0].remediation.command, 'jsn scopes set other-id');
  assert.equal(context.approval_required, false);
});
it('completed capture sets fail even with force and explain remediation', async () => {
  const { app } = fixture({ state: 'complete' });
  await assert.rejects(guardMutationContext(app, { ...argv, force: true }), error => {
    assert.equal(error.context.diagnostics[0].severity, 'error'); assert.match(error.hint, /updatesets set/); return true;
  });
});
it('declared remediation commands and REST reads bypass context only', async () => {
  await import('../src/commands/updatesets.js'); await import('../src/commands/scopes.js'); await import('../src/commands/rest.js');
  for (const path of [['updatesets', 'create'], ['updatesets', 'set'], ['scopes', 'set'], ['scopes', 'create']]) {
    assert.equal(needsMutationContext({ _: path }), false);
  }
  assert.equal(needsMutationContext({ _: ['rest'], method: 'GET' }), false);
  assert.equal(needsMutationContext({ _: ['rest'], method: 'POST' }), true);
  assert.equal(needsMutationContext({ _: ['fixture', 'delete'] }), true);
});
