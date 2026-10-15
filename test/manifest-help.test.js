import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const CLI = path.resolve('bin/jsn.js');
const env = { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' };
function help(...args) {
  const result = spawnSync(process.execPath, [CLI, ...args, '--help'], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout + result.stderr;
}

test('flows create/update help point to dynamic schemas without fixture-like values', () => {
  const create = help('flows', 'create');
  const update = help('flows', 'update');
  for (const text of ['flows schemas', 'action-type-schema', 'code-owned']) assert.ok(create.includes(text), `create help missing ${text}`);
  for (const text of ['flows schemas', 'action-type-schema', 'omitted values are preserved']) assert.ok(update.includes(text), `update help missing ${text}`);
  for (const output of [create, update]) for (const misleading of ['incident', 'active=true', '<actionTypeSysId>']) assert.ok(!output.includes(misleading));
});

test('actions create help points to live provider schemas and preserves code-owned structure caveat', () => {
  const output = help('actions', 'create');
  for (const text of ['actions step-types', 'provider schemas', 'code-owned']) assert.ok(output.includes(text), `actions create help missing ${text}`);
  assert.ok(!output.includes('<stepTypeFromSchema>'));
});
