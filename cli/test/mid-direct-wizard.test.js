import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as helpers from '../src/helpers.js';
import * as prompts from '@inquirer/prompts';
import * as docker from '../src/midserver-install.js';
import * as direct from '../src/midserver-direct.js';

let events, choices, native, state, installed;
mock.module('../src/helpers.js', { namedExports: { ...helpers, canPrompt: () => true } });
mock.module('@inquirer/prompts', { namedExports: { ...prompts,
  input: async () => { events.push('name'); return 'oct12'; },
  password: async opts => { assert.equal(opts.mask, '*'); events.push('password'); return 'disposable-only'; },
  select: async opts => { events.push('decision'); choices = opts.choices; return state === 'cancel' ? 'cancel' : state === 'prepared' ? 'prepare' : 'start'; },
} });
mock.module('../src/midserver-install.js', { namedExports: { ...docker,
  validateMidCredentials: async (_url, username, password) => { assert.equal(username, 'test-user'); assert.equal(password, 'disposable-only'); events.push('credentials-validated'); return { releaseName: 'runtime-06-12-2026' }; },
  detectDocker: () => ({ available: false }),
  installDockerMidServer: () => assert.fail('Direct path must not download Docker recipe'),
} });
mock.module('../src/midserver-direct.js', { namedExports: { ...direct,
  detectDirectPlatform: () => native,
  installDirectMidServer: async opts => { installed = opts; events.push('install'); return { name: opts.name, installDir: '/isolated/mid', state, platform: native }; },
} });
const { midserversCmd } = await import('../src/commands/midservers.js');
const children = [], builder = { command(c) { children.push(c); return builder; } };
midserversCmd(handler => handler).builder(builder);
const add = children.find(c => c.command === 'add');

test('existing instance MID collision blocks direct preparation before any download', async () => {
  events = []; installed = null; native = 'linux'; state = 'prepared';
  await assert.rejects(add.handler({ name: 'oct12', username: 'test-user', 'install-method': 'direct' }, {
    requireInstance: () => {}, getEffectiveInstance: () => 'https://example.service-now.com',
    sdk: { list: async () => [{ sys_id: 'existing', name: 'oct12' }] },
  }), /already exists in ServiceNow/);
  assert.equal(installed, null);
});

test('direct wizard validates masked credentials before name and explicit runtime decision; no instance writes', async t => {
  for (const scenario of ['cancel', 'prepared', 'started', 'pending']) await t.test(scenario, async () => {
    events = []; installed = null; native = scenario === 'prepared' ? 'windows' : 'linux'; state = scenario === 'pending' ? 'started' : scenario;
    let result, summary;
    const app = {
      requireInstance: () => {}, getEffectiveInstance: () => 'https://example.service-now.com',
      ok: (data, opts) => { result = data; summary = opts.summary; },
      sdk: { list: async (_table, params) => params.get('sysparm_fields') === 'sys_id,name' || scenario === 'pending' ? [] : [{ sys_id: 'abc', name: 'oct12', status: 'Up', validated: { value: 'false', display_value: 'Yes' } }],
        create: () => assert.fail('must not fabricate ECC agents'), update: () => assert.fail('must not validate'), delete: () => assert.fail('must not delete'),
      },
    };
    await add.handler({ username: 'test-user', 'install-method': 'direct', 'wait-timeout': 1, 'wait-interval': 1 }, app);
    assert.deepEqual(events.slice(0, 4), ['password', 'credentials-validated', 'name', 'decision']);
    if (scenario === 'cancel') { assert.equal(installed, null); return; }
    assert.equal(installed.releaseName, 'runtime-06-12-2026');
    if (scenario === 'prepared') {
      assert.equal(installed.runNow, false);
      assert.deepEqual(choices.map(c => c.value), ['prepare', 'cancel']);
      assert.match(summary, /not started or registered/);
    } else if (scenario === 'pending') {
      assert.equal(result.registration, 'pending'); assert.equal(result.validated, false);
      assert.match(summary, /no forced teardown/);
    } else {
      assert.equal(result.registration, 'up'); assert.equal(result.validated, false);
      assert.match(summary, /pending manual validation.*ecc_agent.do/);
    }
  });
});
