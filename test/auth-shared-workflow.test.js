import { it, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as helpers from '../src/helpers.js';

let inputs = [], confirmations = [], method = 'basic', prompted = [];
mock.module('../src/helpers.js', { namedExports: { ...helpers, canUsePicker: app => app.isInteractive() } });
mock.module('@inquirer/prompts', { namedExports: {
  input: async question => { prompted.push(question.message); return inputs.shift(); },
  select: async () => method,
  search: async question => {
    const choices = await question.source('');
    assert.deepEqual(choices, [{ name: 'old', value: 'old' }, { name: 'another', value: 'another' }]);
    assert.deepEqual(await question.source('ANOTHER'), [{ name: 'another', value: 'another' }]);
    return 'another';
  },
  confirm: async question => { prompted.push(question.message); return confirmations.shift(); },
  password: async () => 'fixture-password',
} });
const { loginWizard, loginProfile, modifyProfile, pickProfile, refreshProfile, switchProfile } = await import('../src/commands/auth.js');
const { dispatchSetupAction } = await import('../src/commands/setup.js');
const { AuthManager } = await import('../src/auth.js');
let directory, previousXdg, previousCwd;
before(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-shared-auth-'));
  previousXdg = process.env.XDG_CONFIG_HOME; previousCwd = process.cwd();
  process.env.XDG_CONFIG_HOME = directory; process.chdir(directory);
});
after(() => {
  process.chdir(previousCwd);
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previousXdg;
  fs.rmSync(directory, { recursive: true, force: true });
});
beforeEach(() => { inputs = []; confirmations = []; prompted = []; method = 'basic'; });

function fixture(interactive = true) {
  const writes = [], output = [], logins = [];
  const config = {
    defaultProfile: 'old', activeProfile: 'old', instanceURL: 'https://old.example.com',
    profiles: { old: { instance_url: 'https://old.example.com', username: 'old-admin', auth_method: 'oauth' } },
  };
  const auth = new AuthManager({ getUsername: () => 'old-admin', getEffectiveInstance: () => config.instanceURL }, {
    credentialStore: {
      load: () => null, save: (...args) => writes.push(args), delete() {},
    },
  });
  auth.login = async (...args) => { logins.push(args); return {}; };
  auth.loginWithBrowser = async (...args) => { logins.push(args); return { username: 'limited' }; };
  const app = {
    config, auth, isInteractive: () => interactive,
    getSDKForProfile: () => ({ getCurrentUser: async () => ({ user_name: 'limited' }) }),
    ok: data => output.push(data),
  };
  return { app, writes, output, logins };
}

it('guided Basic login and direct login use the same verification, settings, and persistence', async () => {
  const guided = fixture();
  inputs = ['https://new.example.com', 'limited', 'limited'];
  confirmations = [true, true, false, false];
  await loginWizard(guided.app);
  assert.equal(guided.writes.length, 1);
  assert.equal(guided.writes[0][2], 'limited');
  const direct = fixture(false);
  await loginProfile({ instance: 'https://new.example.com', name: 'limited', basic: true,
    _basicCredentials: { username: 'limited', password: 'fixture-password' },
    'read-only': true, 'confirm-deletes': true, 'include-counts': false, makeDefault: false }, direct.app);
  const { domain_separation: _capability, ...guidedProfile } = guided.app.config.profiles.limited;
  assert.deepEqual(guidedProfile, direct.app.config.profiles.limited);
  assert.equal(guided.app.config.defaultProfile, 'old');
  assert.equal(direct.app.config.defaultProfile, 'old');
});

it('guided OAuth login uses a new identity without inheriting the old active username', async () => {
  const { app, logins } = fixture();
  method = 'oauth'; inputs = ['https://new.example.com', 'oauth-new'];
  confirmations = [true, true, false, true];
  await loginWizard(app);
  assert.deepEqual(logins[0], ['https://new.example.com', null]);
  assert.equal(app.config.profiles['oauth-new'].auth_method, 'oauth');
  assert.equal(app.config.profiles['oauth-new'].username, 'limited');
  assert.equal(app.config.defaultProfile, 'oauth-new');
});

it('bot settings and setup settings persist identical explicit values and are idempotent', async () => {
  const direct = fixture(false), guided = fixture(false);
  const values = { name: 'old', 'read-only': true, 'confirm-deletes': true, 'include-counts': false };
  await modifyProfile(direct.app, values);
  await modifyProfile(direct.app, values);
  await dispatchSetupAction(guided.app, values, 'modify');
  assert.deepEqual(direct.app.config, guided.app.config);
  assert.equal(direct.app.config.profiles.old.skip_confirmations, false);
  assert.equal(prompted.length, 0);
  await assert.rejects(modifyProfile(direct.app, { name: 'old' }), /Specify the settings/);
  await assert.rejects(modifyProfile(direct.app, { name: 'old', 'confirm-deletes': true, 'skip-confirmations': true }), /conflicting/);
});

it('noninteractive browser and OAuth login never open implicit human prompts', async () => {
  const { app, logins } = fixture(false);
  await assert.rejects(loginProfile({ profile: 'old' }, app), /OAuth login requires/);
  app.config.profiles.old.auth_method = 'gck';
  await assert.rejects(loginProfile({ profile: 'old' }, app), /Pass --browser/);
  assert.equal(logins.length, 0);
  assert.equal(prompted.length, 0);
});

it('ambiguous bot profile selection fails without changing the default', async () => {
  const { app } = fixture(false);
  app.config.profiles.another = { instance_url: 'https://other.example.com' };
  await assert.rejects(pickProfile(app, 'Choose'), /Which profile\? 2 profiles are configured:/);
  assert.equal(app.config.defaultProfile, 'old');
});

it('explicit OAuth refresh refreshes once even when the access token is expired', async () => {
  const { app } = fixture(false);
  const credentials = { auth_method: 'oauth', access_token: 'expired-fixture', refresh_token: 'refresh-fixture', expires_at: 1 };
  let refreshes = 0;
  app.auth.credentialStore.load = () => credentials;
  app.auth.refreshToken = async () => { refreshes++; return { auth_method: 'oauth', access_token: 'refreshed-fixture' }; };
  await refreshProfile({ profile: 'old' }, app);
  assert.equal(refreshes, 1);
});

it('browser refresh reuses login and preserves the selected profile settings', async () => {
  const { app, logins } = fixture();
  app.config.profiles.old = { ...app.config.profiles.old, auth_method: 'gck', username: 'limited', read_only: true, include_counts: false };
  await refreshProfile({ profile: 'old', browserUrl: 'http://127.0.0.1:9222' }, app);
  assert.equal(logins.length, 1);
  assert.deepEqual(logins[0], ['https://old.example.com', { browserUrl: 'http://127.0.0.1:9222' }, 'limited']);
  assert.equal(app.config.profiles.old.read_only, true);
  assert.equal(app.config.profiles.old.include_counts, false);
  assert.equal(app.config.defaultProfile, 'old');
});

it('browser refresh never implicitly opens a browser for bots', async () => {
  const { app, logins } = fixture(false);
  app.config.profiles.old.auth_method = 'gck';
  await assert.rejects(refreshProfile({ profile: 'old' }, app), /Pass --browser/);
  assert.equal(logins.length, 0);
});

it('switch picker shows only profile names, without users or URLs', async () => {
  const { app } = fixture();
  app.config.profiles.another = { instance_url: 'https://private.example.com', username: 'private-user', auth_method: 'gck' };
  await switchProfile({}, app);
  assert.equal(app.config.defaultProfile, 'another');
});
