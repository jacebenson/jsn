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

test('flows create help documents supported manifest fields and example', () => {
  const output = help('flows', 'create');
  for (const text of ['name (required)', 'scope (required)', 'trigger', 'actions', '"type":"record_create_or_update"', '"table":"incident"', '"type":"<actionTypeSysId>"', 'Flow Logic', 'unsupported']) {
    assert.ok(output.includes(text), `flows create help missing ${text}`);
  }
  for (const unsupported of ['subflows:', 'errorHandling:', 'flowVariables:']) assert.ok(!output.includes(unsupported));
});

test('flows update help documents only supported partial updates and example', () => {
  const output = help('flows', 'update');
  for (const text of ['scope', 'table and/or condition', 'order (positive integer)', 'non-empty object', '"table":"incident"', '"condition":"active=true"', 'omitted values are preserved']) {
    assert.ok(output.includes(text), `flows update help missing ${text}`);
  }
  for (const unsupported of ['name:', 'description:', 'trigger inputs', 'delete actions']) assert.ok(!output.includes(unsupported));
});

test('actions create help documents the validated full definition structure', () => {
  const output = help('actions', 'create');
  for (const text of ['inputs, outputs, and steps arrays', 'name and type', 'cid', 'step_type', 'extended_inputs', 'extended_outputs', 'step_types', '"name":"record_id"', '"step_type":"<stepTypeFromSchema>"']) {
    assert.ok(output.includes(text), `actions create help missing ${text}`);
  }
});
