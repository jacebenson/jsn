import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const cli = path.resolve('bin/jsn.js');

function help(...args) {
  const result = spawnSync(process.execPath, [cli, ...args, '--help'], {
    encoding: 'utf8',
    env: { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('scan run help names the global flags the command requires and its side effect', () => {
  const output = help('scan', 'run');
  // These are global options, so they never render in the command's own
  // option list; an unattended caller has to be told about them here.
  assert.match(output, /--expect-scope/);
  assert.match(output, /--expect-update-set/);
  assert.match(output, /--force/);
  assert.match(output, /writes findings/);
  assert.match(output, /changes no business records/);
  assert.match(output, /--record <sys_id> --table incident/);
});
