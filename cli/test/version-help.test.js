import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
const TEST_ENV = { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' };

/**
 * `jsn --version` must answer with the version and nothing else. It used to
 * print the 2 KB root help page, so a script or benchmark adapter reading the
 * installed version got help text instead, and every token of it counted.
 */
test('root --version prints only the package version', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const flag of ['--version', '-V']) {
    const result = spawnSync(process.execPath, [BIN, flag], { encoding: 'utf8', env: TEST_ENV });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), pkg.version, `${flag} stdout`);
    assert.doesNotMatch(result.stdout, /Usage:/, `${flag} must not print help`);
  }
});

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
