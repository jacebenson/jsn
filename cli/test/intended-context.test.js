import { it } from 'node:test';
import assert from 'node:assert/strict';
import { declareCapabilities } from '../src/capabilities.js';
import { guardMutationContext } from '../src/mutation-context.js';
import { readWriteContext } from '../src/intended-context.js';
declareCapabilities('contextfixture', { mutationSubcommands: ['create'] });
const argv = { _: ['contextfixture', 'create'], force: true };
it('force cannot authorize missing bot intent before any context request', async () => {
  let calls = 0;
  const app = { config: {}, session: {}, sdk: { list: async () => { calls++; return []; } } };
  await assert.rejects(guardMutationContext(app, argv), { code: 'usage_error' });
  assert.equal(calls, 0);
});

// A fresh instance has no persisted capture selection at all. The failure has
// to name what is missing and the command that creates it; the preference key
// and a generic --expect-* hint sent agents back into the same dead end.
const userRow = { sys_id: { value: 'user1' }, user_name: { value: 'admin' }, name: { value: 'Admin' } };
const SESSION_SET = { current: { sysId: 'sessionset1', name: 'Session Set', displayValue: 'Session Set' } };

function fakeSdk({ appsCurrentApp = [], updateSet = [], failPreferences = null, session = SESSION_SET } = {}) {
  return {
    baseURL: 'https://example.service-now.com',
    list: async (table, params) => {
      if (table === 'sys_user') return [userRow];
      if (table !== 'sys_user_preference') throw new Error(`unexpected table ${table}`);
      if (failPreferences) throw failPreferences;
      const query = String(params);
      return query.includes('apps.current_app') ? appsCurrentApp : updateSet;
    },
    get: async () => ({}),
    request: async () => ({ result: session }),
  };
}

const rejectsWith = (promise, messagePattern, hintPattern) => assert.rejects(promise, (error) => {
  assert.equal(error.code, 'usage_error');
  assert.match(error.message, messagePattern);
  assert.match(error.hint, hintPattern);
  return true;
});

it('a missing update set selection names the user, the command and the session divergence', async () => {
  await rejectsWith(
    readWriteContext(fakeSdk({ appsCurrentApp: [{ value: 'scope1' }] })),
    /No update set is selected for admin, so there is no capture context/,
    /jsn updatesets set/,
  );
});

it('a missing update set selection reports a session picker that is not persisted', async () => {
  await assert.rejects(readWriteContext(fakeSdk({ appsCurrentApp: [{ value: 'scope1' }] })), (error) => {
    assert.match(error.message, /The session picker reports "Session Set" \(sessionset1\)/);
    assert.match(error.message, /not persisted for this user/);
    return true;
  });
});

it('a missing scope selection names the scope command', async () => {
  await rejectsWith(
    readWriteContext(fakeSdk({ updateSet: [{ value: 'set1' }] })),
    /No application scope is selected for admin/,
    /jsn scopes set/,
  );
});

it('duplicate preference rows are reported as ambiguous, not unknown', async () => {
  await rejectsWith(
    readWriteContext(fakeSdk({ appsCurrentApp: [{ value: 'scope1' }], updateSet: [{ value: 'a' }, { value: 'b' }] })),
    /2 persisted update set preferences exist for admin/,
    /jsn updatesets set/,
  );
});

it('an unreadable preference read says so instead of claiming the selection is unknown', async () => {
  await rejectsWith(
    readWriteContext(fakeSdk({ failPreferences: new Error('socket hang up') })),
    /Could not read the persisted application scope for admin: socket hang up/,
    /Do not retry the write/,
  );
});
