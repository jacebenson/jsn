import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const run = args => spawnSync(process.execPath, [path.resolve('bin/jsn.js'), ...args], {
  encoding: 'utf8', env: { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1' },
});
test('retired shell completion commands and generator flag are rejected', () => {
  for (const args of [['completion'], ['__completion'], ['--get-yargs-completions', 'jsn', 'r']]) {
    const result = run(args);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.match(result.stdout + result.stderr, /unknown|unrecognized/i);
    assert.doesNotMatch(result.stdout, /###-begin|COMPREPLY|compgen/);
  }
});
test('help, aliases and machine discovery remain available without shell completion', () => {
  for (const args of [['--help'], ['records', 'list', '--help'], ['inc', '--help']]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:|jsn/);
    assert.doesNotMatch(result.stdout, /\bcompletion\b/);
  }
  const result = run(['discover', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const commands = JSON.parse(result.stdout).data.commands;
  assert.ok(commands.some(command => command.name === 'records'));
  assert.ok(!commands.some(command => ['completion', '__completion'].includes(command.name)));
});
