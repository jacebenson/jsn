import { it } from 'node:test';
import assert from 'node:assert/strict';
import { declareCapabilities } from '../src/capabilities.js';
import { guardMutationContext } from '../src/mutation-context.js';
declareCapabilities('contextfixture', { mutationSubcommands: ['create'] });
const argv = { _: ['contextfixture', 'create'], force: true };
it('force cannot authorize missing bot intent before any context request', async () => {
  let calls = 0;
  const app = { config: {}, session: {}, sdk: { list: async () => { calls++; return []; } } };
  await assert.rejects(guardMutationContext(app, argv), { code: 'usage_error' });
  assert.equal(calls, 0);
});
