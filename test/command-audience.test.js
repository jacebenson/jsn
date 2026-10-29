import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { detectCommandAudience, visibleCommandRegistry } from '../src/command-audience.js';

const cli = path.resolve('bin/jsn.js');
const registry = { commands: [{ name: 'incidents' }, { name: 'eval' }] };
const profile = mode => ({ username: 'limited', instance_url: 'https://example.invalid', command_audience: { username: 'limited', instance_url: 'https://example.invalid', mode } });

test('detects inherited admin role, non-admin, malformed/unavailable and missing identity', async () => {
  let params;
  const sdk = { listStrict: async (table, query, options) => {
    assert.equal(table, 'sys_user_has_role'); params = query;
    assert.equal(options.touchLastSeen, false); return [{ sys_id: 'role' }];
  } };
  assert.equal((await detectCommandAudience(sdk, 'limited')).mode, 'admin');
  assert.equal(params.sysparm_query, 'user=javascript:gs.getUserID()^role.name=admin');
  assert.equal((await detectCommandAudience({ listStrict: async () => [] }, 'limited')).mode, 'basic');
  assert.equal((await detectCommandAudience({ listStrict: async () => { throw new Error('403'); } }, 'limited')).role_check, 'unavailable');
  assert.equal(await detectCommandAudience(sdk, ''), undefined);
});

test('audience is account scoped; legacy, admin, explicit instance and override keep full surface', () => {
  const config = { activeProfile: 'limited', profiles: { limited: profile('basic') } };
  assert.deepEqual(visibleCommandRegistry(registry, config).commands.map(c => c.name), ['incidents']);
  for (const options of [{ allCommands: true }, { instance: 'other' }]) assert.equal(visibleCommandRegistry(registry, config, options), registry);
  config.profiles.limited.username = 'other';
  assert.equal(visibleCommandRegistry(registry, config), registry);
  config.profiles.limited = profile('admin');
  assert.equal(visibleCommandRegistry(registry, config), registry);
  assert.equal(visibleCommandRegistry(registry, {}), registry);
});

test('selected profiles filter help, JSON, discover and completion without removing explicit commands', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'jsn-audience-'));
  mkdirSync(path.join(home, 'servicenow'));
  writeFileSync(path.join(home, 'servicenow/config.json'), JSON.stringify({ default_profile: 'limited', profiles: {
    admin: { ...profile('admin'), instance_url: 'https://example.invalid' },
    limited: { ...profile('basic'), instance_url: 'https://example.invalid' },
  } }));
  const run = args => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: home, encoding: 'utf8', env: {
      ...process.env, XDG_CONFIG_HOME: home, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1',
    } });
    assert.equal(result.status, 0, result.stderr); return result.stdout;
  };
  try {
    for (const args of [[], ['--help']]) {
      const text = run(['--profile', 'limited', ...args]);
      assert.match(text, /jsn incidents/); assert.doesNotMatch(text, /jsn eval\s/);
    }
    assert.doesNotMatch(run(['help']), /jsn eval\s/);
    const names = args => JSON.parse(run(args)).data.commands.map(command => command.name);
    assert(!names(['--profile', 'limited', '--json']).includes('eval'));
    assert(names(['--profile', 'admin', '--json']).includes('eval'));
    assert(names(['--profile', 'limited', '--all-commands', '--json']).includes('eval'));
    assert(!names(['--profile', 'limited', 'discover', '--json']).includes('eval'));
    assert(names(['--profile', 'limited', 'discover', '--all-commands', '--json']).includes('eval'));
    assert.match(run(['--profile', 'limited', 'eval', '--help']), /Execute background/);
    assert.doesNotMatch(run(['--profile', 'limited', '--get-yargs-completions', '']), /^eval$/m);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
