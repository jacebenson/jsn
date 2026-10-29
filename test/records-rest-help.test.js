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

test('records help exposes table examples and the actual picker search field', () => {
  const list = help('records', 'list');
  assert.match(list, /records list --table incident --query "active=true" --limit 5 --json/);
  assert.match(list, /type to search sys_id on the server/);
  assert.match(list, /--sys-id skips the picker/);
  assert.match(list, /--json for noninteractive structured output/);
  assert.match(help('records', 'get'), /records get --table incident --sys-id <sys_id> --json/);
});

test('rest help exposes both endpoint and table shorthand without weakening read-only policy', () => {
  const output = help('rest');
  assert.match(output, /rest "\/api\/now\/table\/incident\?sysparm_limit=3" --json/);
  assert.match(output, /rest --table incident --query "sysparm_limit=3" --json/);
  assert.match(output, /blocked on read-only profiles for every method, including GET/);
  assert.match(output, /Prefer a specific jsn command or records/);
});
