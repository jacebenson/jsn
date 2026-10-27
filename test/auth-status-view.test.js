import { it } from 'node:test';
import assert from 'node:assert/strict';
import { authCmd, renderAuthStatus } from '../src/commands/auth.js';
import { AuthManager } from '../src/auth.js';

function fixture() {
  const instance = 'https://fixture.service-now.com';
  const auth = new AuthManager({ getUsername: () => 'limited', getEffectiveInstance: () => instance, getAuthMethod: () => 'gck' }, {
    credentialStore: {
      load: () => ({ auth_method: 'gck', access_token: 'fixture-token', cookies: 'sid=fixture-cookie', auth_source: 'gck' }),
      save: () => assert.fail('status must not save'), delete: () => assert.fail('status must not delete'),
    },
  });
  const output = [];
  let requests = 0;
  let constructions = 0;
  let verifiedUser = 'limited';
  const app = {
    auth, session: { profileName: 'sandbox' },
    config: { defaultProfile: 'sandbox', profiles: { sandbox: { instance_url: instance, username: 'limited', auth_method: 'gck', read_only: true, include_counts: false } } },
    getSDKForProfile: (_instance, options) => {
      constructions++;
      assert.equal(options.username, 'limited');
      return { getCurrentUser: async options => { requests++; assert.equal(options.touchLastSeen, false); return { user_name: verifiedUser }; } };
    },
    ok: data => output.push(data),
  };
  const commands = [];
  const builder = { command: command => { commands.push(command); return builder; } };
  authCmd(fn => argv => fn(argv, app)).builder(builder);
  return { status: commands.find(command => command.command === 'status').handler, output, counts: () => ({ requests, constructions }), setUser: user => { verifiedUser = user; } };
}

it('local status hides identity and shows saved state without constructing an SDK or probing', async () => {
  const { status, output, counts } = fixture();
  await status({ local: true });
  assert.deepEqual(counts(), { requests: 0, constructions: 0 });
  assert.equal(output[0].profiles[0].username, undefined);
  assert.equal(output[0].profiles[0].active, true);
  assert.equal(output[0].profiles[0].verified, null);
  assert.match(output[0]._formatted, /PROFILE\s+AUTH\s+CREDENTIALS/);
  assert.doesNotMatch(JSON.stringify(output), /fixture\.service-now\.com|limited/);
  assert.match(output[0]._formatted, /Connection not checked \(--local\)/);
  assert.match(output[0]._formatted, /Read-only\s+Confirm\s+Off/);
  assert.doesNotMatch(JSON.stringify(output), /fixture-token|fixture-cookie/);
});

it('status distinguishes a verified session from merely available credentials', async () => {
  const { status, output, counts } = fixture();
  await status({});
  assert.deepEqual(counts(), { requests: 1, constructions: 1 });
  assert.match(output[0]._formatted, /Available\s+Verified/);
  assert.doesNotMatch(JSON.stringify(output), /fixture\.service-now\.com|limited/);
});

it('status identifies a different account in the session instead of marking the profile verified', async () => {
  const { status, output, setUser } = fixture();
  setUser('different-account');
  await status({});
  assert.equal(output[0].profiles[0].verified, false);
  assert.equal(output[0].profiles[0].diagnostics.probe.code, 'account_mismatch');
  assert.match(output[0]._formatted, /User mismatch/);
  assert.doesNotMatch(JSON.stringify(output), /limited|different-account|fixture\.service-now\.com/);
  assert.match(output[0]._formatted, /jsn auth login --profile sandbox/);
});

it('empty status gives a concrete login entry point', () => {
  assert.equal(renderAuthStatus({ profiles: [] }), 'No profiles configured.\nRun: jsn auth login <instance> --browser\n');
});

it('details explicitly reveals users and URLs in both the table and JSON fields', async () => {
  const { status, output } = fixture();
  await status({ details: true });
  assert.equal(output[0].profiles[0].username, 'limited');
  assert.equal(output[0].profiles[0].verified_as, 'limited');
  assert.equal(output[0].profiles[0].instance, 'https://fixture.service-now.com');
  assert.equal(output[0].default_instance, 'https://fixture.service-now.com');
  assert.match(output[0]._formatted, /USER\s+INSTANCE/);
  assert.match(output[0]._formatted, /limited\s+https:\/\/fixture\.service-now\.com/);
  assert.doesNotMatch(output[0]._formatted, /ACCOUNT/);
});
