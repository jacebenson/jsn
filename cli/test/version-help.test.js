import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('version help points to upgrades and stable/dev channel switching', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/jsn.js', import.meta.url)), 'version', '--help'], {
    encoding: 'utf8',
    env: { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /jsn upgrade\s+Update within the current channel/);
  assert.match(result.stdout, /jsn upgrade --channel latest\s+Switch to stable/);
  assert.match(result.stdout, /jsn upgrade --channel dev\s+Switch to dev/);
  assert.match(result.stdout, /--check/);
});
