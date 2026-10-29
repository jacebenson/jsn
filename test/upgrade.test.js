import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { upgradeCmd } from '../src/commands/upgrade.js';

function fixture(current, latest, installError) {
  const installs = [], checks = [], output = [];
  const cmd = upgradeCmd(fn => fn, {
    version: () => current,
    check: async (options) => { checks.push(options); return latest; },
    install: async (args) => { if (installError) throw installError; installs.push(args); },
  });
  return { run: (argv = {}) => cmd.handler(argv, { ok: data => output.push(data) }), installs, checks, output };
}

for (const [current, latest, channel] of [
  ['4.3.13', '4.3.14', 'latest'],
  ['4.3.14-dev.9', '4.3.14-dev.10', 'dev'],
]) {
  test(`upgrade preserves ${channel} channel`, async () => {
    const f = fixture(current, latest);
    await f.run();
    assert.equal(f.checks[0].channel, channel);
    assert.deepEqual(f.installs, [['install', '-g', `@jacebenson/jsn@${channel}`]]);
    assert.equal(f.output[0].upgraded, true);
  });
}

for (const latest of ['4.3.13', '4.3.12', '4.3.13-dev.1']) {
  test(`does not install non-newer ${latest} without force`, async () => {
    const f = fixture('4.3.13', latest);
    await f.run();
    assert.deepEqual(f.installs, []);
    assert.equal(f.output[0].upToDate, true);
    await f.run({ force: true });
    assert.equal(f.installs.length, 1);
  });
}

test('explicit channel switch can move from dev to stable', async () => {
  const f = fixture('4.3.14-dev.10', '4.3.13');
  await f.run({ channel: 'latest' });
  assert.equal(f.checks[0].channel, 'latest');
  assert.equal(f.installs.length, 1);
});

test('dry run never checks the registry or runs npm', async () => {
  const f = fixture('4.3.13', null);
  await f.run({ dryRun: true, channel: 'dev' });
  assert.deepEqual(f.checks, []);
  assert.deepEqual(f.installs, []);
  assert.equal(f.output[0].installCmd, 'npm install -g @jacebenson/jsn@dev');
});

test('registry and installation failures cannot report success', async () => {
  const offline = fixture('4.3.13', null);
  await assert.rejects(offline.run(), /Could not check/);
  assert.deepEqual(offline.installs, []);
  const broken = fixture('4.3.13', '4.3.14', new Error('install failed'));
  await assert.rejects(broken.run(), /install failed/);
  assert.deepEqual(broken.output, []);
});

for (const command of ['upgrade', 'update']) {
  test(`real CLI ${command} dry-run works without an instance`, () => {
    const result = spawnSync(process.execPath, ['bin/jsn.js', command, '--dry-run', '--channel', 'dev', '--json'], {
      encoding: 'utf8', env: { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout, JSON.stringify(result));
    assert.equal(JSON.parse(result.stdout).data.installCmd, 'npm install -g @jacebenson/jsn@dev');
  });
}
