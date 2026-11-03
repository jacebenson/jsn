// Tests for `jsn eval --repl` (issue #397).
//
// The line-handling state machine is unit-tested directly. The CLI surface
// (flag conflicts, non-TTY rejection, help discovery) is exercised through
// spawnSync, which is itself a non-TTY, so it also proves the guard fires.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import { createReplState, handleReplLine, REPL_HELP, REPL_COMMANDS } from '../src/eval-repl.js';

const CLI = path.resolve('bin/jsn.js');
const ENV = {
  ...process.env,
  JSN_NO_VERSION_CHECK: '1',
  JSN_NO_SKILL_CHECK: '1',
};

function run(args, input = '', env = {}) {
  return spawnSync('node', [CLI, ...args], {
    encoding: 'utf-8',
    env: { ...ENV, ...env },
    input,
  });
}

// The conflicts and TTY checks live in the handler, which only runs once the
// instance guard passes. Isolate config and supply a fake instance so the
// command reaches the handler; it then fails at the thing under test.
function isolatedEnv() {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-eval-repl-'));
  return {
    XDG_CONFIG_HOME: cfgDir,
    SERVICENOW_INSTANCE_URL: 'https://nonexistent.invalid',
    SERVICENOW_USERNAME: 'fake',
    SERVICENOW_PASSWORD: 'fake',
  };
}

describe('handleReplLine', () => {
  it('accumulates lines and does not run a blank line', () => {
    const state = createReplState();
    assert.strictEqual(handleReplLine(state, 'var x = 1;').action, 'continue');
    // A blank line keeps the buffer open rather than executing it.
    assert.strictEqual(handleReplLine(state, '').action, 'continue');
    assert.strictEqual(handleReplLine(state, 'gs.info(x);').action, 'continue');
    // The blank line is kept as a blank line in the script, and nothing ran.
    assert.strictEqual(state.script, 'var x = 1;\n\ngs.info(x);');
  });

  it('preserves newlines for multi-line scripts', () => {
    const state = createReplState();
    handleReplLine(state, 'if (true) {');
    handleReplLine(state, '  gs.info("hi");');
    const result = handleReplLine(state, '.exec');
    assert.strictEqual(result.action, 'exec');
    assert.strictEqual(result.script, 'if (true) {\n  gs.info("hi");');
  });

  it('clears the buffer after exec so scripts do not pile up', () => {
    const state = createReplState();
    handleReplLine(state, 'gs.info("one");');
    handleReplLine(state, '.exec');
    assert.strictEqual(state.script, '');
    handleReplLine(state, 'gs.info("two");');
    const result = handleReplLine(state, '.exec');
    assert.strictEqual(result.script, 'gs.info("two");');
  });

  it('reports .exec with an empty buffer as empty, not a run', () => {
    const state = createReplState();
    assert.strictEqual(handleReplLine(state, '.exec').action, 'empty');
    // Whitespace-only content is not a script.
    handleReplLine(state, '   ');
    assert.strictEqual(handleReplLine(state, '.exec').action, 'empty');
  });

  it('handles .clear, .help and .exit', () => {
    const state = createReplState();
    handleReplLine(state, 'gs.info("discard me");');
    assert.strictEqual(handleReplLine(state, '.clear').action, 'clear');
    assert.strictEqual(state.script, '');
    assert.strictEqual(handleReplLine(state, '.help').action, 'help');
    assert.strictEqual(handleReplLine(state, '.exit').action, 'exit');
  });

  it('tolerates surrounding whitespace on dot commands', () => {
    const state = createReplState();
    handleReplLine(state, 'gs.info(1);');
    assert.strictEqual(handleReplLine(state, '  .exec  ').action, 'exec');
  });

  it('documents every command in the help text', () => {
    for (const command of REPL_COMMANDS) {
      assert.ok(REPL_HELP.includes(command), `help should mention ${command}`);
    }
    assert.ok(/variables do not persist/i.test(REPL_HELP), 'help must state that state does not persist');
  });
});

describe('jsn eval --repl surface', () => {
  it('rejects --repl combined with --script', () => {
    const result = run(['eval', '--repl', '--script', 'gs.info(1)'], '', isolatedEnv());
    assert.notStrictEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /--repl cannot be combined with --script/);
  });

  it('rejects --repl combined with --stdin', () => {
    const result = run(['eval', '--repl', '--stdin'], '', isolatedEnv());
    assert.notStrictEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /--repl cannot be combined with --stdin/);
  });

  it('requires an interactive terminal', () => {
    const result = run(['eval', '--repl'], '', isolatedEnv());
    assert.notStrictEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /needs an interactive terminal/);
  });

  it('advertises --repl in eval help', () => {
    const result = run(['eval', '--help']);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /--repl/);
    assert.match(result.stdout, /interactive/i);
  });
});
