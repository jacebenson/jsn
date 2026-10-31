import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as helpers from '../src/helpers.js';
import { AuthManager } from '../src/auth.js';

let answer = false, questions = [];
mock.module('../src/helpers.js', { namedExports: { ...helpers, canUsePicker: app => !!app.interactive } });
mock.module('../src/prompts.js', { namedExports: { confirm: async question => { questions.push(question); return answer; } } });
const { logoutProfile } = await import('../src/commands/auth.js');
const instance = 'https://fixture.example.com';
function fixture(method = 'oauth') {
  const records = new Map([['alice', { auth_method: method }], ['bob', { auth_method: method }]]);
  const app = {
    config: { activeProfile: 'first', profiles: {
      first: { instance_url: instance, username: 'alice', auth_method: method, skip_confirmations: true },
      second: { instance_url: instance, username: 'bob', auth_method: method },
    } },
    auth: new AuthManager({}, { credentialStore: {
      load: (url, username) => records.get(username), delete: (url, username) => records.delete(username),
    } }),
    ok: (data, options) => { app.result = data; app.options = options; },
  };
  return { app, records };
}
it('noninteractive logout requires exact approval even when delete prompts are disabled', async () => {
  const { app, records } = fixture();
  await assert.rejects(logoutProfile({ profile: 'first' }, app), error => {
    assert.equal(error.code, 'confirmation_required');
    assert.match(error.hint, /jsn auth logout --profile first --force/);
    assert.match(error.message, /environment credentials.*unaffected/);
    return true;
  });
  assert.equal(records.size, 2);
});
it('interactive decline retains credentials and approval identifies the identity being cleared', async () => {
  const { app, records } = fixture(); app.interactive = true; answer = false; questions = [];
  await logoutProfile({ profile: 'second' }, app);
  assert.equal(records.size, 2); assert.equal(app.result.credentials_cleared, false);
  assert.equal(questions[0].default, false); assert.match(questions[0].message, /second.*bob/);
  answer = true;
  await logoutProfile({ profile: 'second' }, app);
  assert.equal(records.has('alice'), true); assert.equal(records.has('bob'), false);
  assert.equal(app.result.credentials_cleared, true);
});
for (const method of ['oauth', 'basic', 'gck']) {
  it(`approved logout clears only selected ${method} credentials and retains profile`, async () => {
    const { app, records } = fixture(method);
    await logoutProfile({ profile: 'second', force: true }, app);
    assert.equal(records.has('alice'), true); assert.equal(records.has('bob'), false);
    assert.equal(app.result.profile, 'second'); assert.equal(app.result.profile_retained, true);
    assert.equal(app.result.remote_session_terminated, false);
    assert.equal(app.result.environment_credentials_affected, false);
    assert.equal(app.result.next_actions[1].cmd, 'jsn auth remove second');
    assert.ok(app.config.profiles.second);
    await logoutProfile({ profile: 'second', force: true }, app);
    assert.equal(app.result.credentials_cleared, false); assert.deepEqual(app.result.next_actions, []);
  });
}
it('ambiguous instance and bare identities fail before clearing', async () => {
  const { app, records } = fixture();
  await assert.rejects(logoutProfile({ instance, force: true }, app), /Multiple profiles/);
  delete app.config.profiles.first.username; delete app.config.profiles.second.username;
  await assert.rejects(logoutProfile({ profile: 'first', force: true }, app), /Cannot identify/);
  assert.equal(records.size, 2);
});
it('failed backend deletion cannot produce a success hint', async () => {
  const { app } = fixture(); app.auth.credentialStore.delete = () => {};
  await logoutProfile({ profile: 'first', force: true }, app);
  assert.equal(app.result.logged_out, false); assert.deepEqual(app.result.next_actions, []);
});
