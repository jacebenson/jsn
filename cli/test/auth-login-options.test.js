import { it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as helpers from '../src/helpers.js';

let questions = [];
let answers = [];
mock.module('../src/helpers.js', { namedExports: {
  ...helpers, canUsePicker: app => app.isInteractive(),
} });
mock.module('@inquirer/prompts', { namedExports: {
  confirm: async question => { questions.push(question); return answers.shift(); },
  search: async config => { assert.ok((await config.source('limited')).some(choice => choice.name.includes('limited'))); return 'second'; },
} });
const { authCmd } = await import('../src/commands/auth.js');
let previousXdg, previousCwd, directory;
before(() => {
  previousXdg = process.env.XDG_CONFIG_HOME; previousCwd = process.cwd();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-login-options-'));
  process.env.XDG_CONFIG_HOME = directory; process.chdir(directory);
});
after(() => {
  process.chdir(previousCwd);
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  fs.rmSync(directory, { recursive: true, force: true });
});
beforeEach(() => { questions = []; answers = [false, true, true, false, false]; });

function fixture(profiles = {}, interactive = true) {
  const outputs = [];
  const app = {
    config: { profiles }, isInteractive: () => interactive,
    auth: { loginWithPassword: async () => ({ username: 'limited' }) },
    getSDKForProfile: () => ({ getCurrentUser: async () => ({ user_name: 'limited' }) }),
    ok: (data, options) => outputs.push({ data, options }),
  };
  const commands = [];
  const builder = { command: command => { commands.push(command); return builder; } };
  authCmd(fn => argv => fn(argv, app)).builder(builder);
  return { app, outputs, login: commands.find(command => command.command.startsWith('login')).handler };
}

it('offers setup settings when direct login creates a new profile', async () => {
  const { app, login, outputs } = fixture();
  await login({ instance: 'new-instance', basic: true });
  assert.deepEqual(questions.map(question => question.default), [true, false, true, true, true]);
  const profile = Object.values(app.config.profiles)[0];
  assert.equal(profile.read_only, true);
  assert.equal(profile.skip_confirmations, false);
  assert.equal(profile.include_counts, false);
  assert.match(outputs[0].options.breadcrumbs[1].description, /read-only; confirm deletes; counts off/);
});

it('honors explicit login settings without asking those questions again', async () => {
  const { app, login } = fixture();
  await login({ instance: 'new-instance', basic: true, 'read-only': true, 'skip-confirmations': false, 'include-counts': false, makeDefault: false });
  assert.equal(questions.length, 0);
  assert.equal(Object.values(app.config.profiles)[0].read_only, true);
  assert.equal(Object.values(app.config.profiles)[0].include_counts, false);
});

it('noninteractive login provides setting hints without prompting', async () => {
  const { login, outputs } = fixture({}, false);
  await login({ instance: 'new-instance', basic: true });
  assert.equal(questions.length, 0);
  assert.match(outputs[0].options.breadcrumbs[1].cmd, /auth modify/);
  assert.match(outputs[0].options.breadcrumbs[2].cmd, /--read-only --no-include-counts/);
});

it('reauthentication preserves settings and does not repeat onboarding', async () => {
  const { app, login } = fixture({ existing: { instance_url: 'https://existing.service-now.com', auth_method: 'basic', username: 'limited', read_only: true, include_counts: false } });
  await login({ instance: 'existing', basic: true });
  assert.equal(questions.length, 0);
  assert.equal(app.config.profiles.existing.read_only, true);
  assert.equal(app.config.profiles.existing.include_counts, false);
});

it('picker selection keeps the chosen identity when profiles share an instance', async () => {
  const instance = 'https://shared.service-now.com';
  const { app, login } = fixture({
    first: { instance_url: instance, username: 'admin', auth_method: 'basic' },
    second: { instance_url: instance, username: 'limited', auth_method: 'basic' },
  });
  let target;
  app.auth.loginWithPassword = async (_instance, username) => { target = username; return { username }; };
  await login({});
  assert.equal(target, 'limited');
  assert.equal(app.config.profiles.first.username, 'admin');
});

it('positional profile names select that profile rather than the first account on the instance', async () => {
  const instance = 'https://shared.service-now.com';
  const { app, login } = fixture({
    first: { instance_url: instance, username: 'admin', auth_method: 'basic' },
    second: { instance_url: instance, username: 'limited', auth_method: 'basic' },
  }, false);
  let target;
  app.auth.loginWithPassword = async (_instance, username) => { target = username; return { username }; };
  await login({ instance: 'second' });
  assert.equal(target, 'limited');
  await assert.rejects(login({ instance }), /Multiple profiles use this instance/);
});
