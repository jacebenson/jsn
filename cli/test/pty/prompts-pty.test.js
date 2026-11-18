// Real-PTY tests for the local prompt engine.
//
// Each case spawns test/pty/prompt-harness.mjs through test/pty/pty_driver.py,
// which allocates a genuine pseudo-terminal (not a PassThrough), feeds
// keystrokes and reports the exit status. The harness runs inside a shell that
// samples `stty -g` before and after Node, so TERMIOS_OK proves the terminal
// settings were restored after success, Escape, Ctrl+C and errors.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const driver = path.join(cliRoot, 'test', 'pty', 'pty_driver.py');
const DOWN = '\u001b[B';
const ESC = '\u001b';
const ENTER = '\r';

function runPty(scenario, steps) {
  const result = spawnSync('python3', [driver, '--scenario', scenario, '--keys', JSON.stringify(steps), '--cwd', cliRoot], {
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.status, 0, `driver failed: ${result.stderr}`);
  const report = JSON.parse(result.stdout);
  report.mark = (name) => {
    const match = report.output.match(new RegExp(`MARK:${name}:(.*)`));
    if (!match) return undefined;
    try { return JSON.parse(match[1]); } catch { return match[1]; }
  };
  return report;
}

function assertTermios(report) {
  assert.equal(report.termios_mismatch, false, `terminal settings changed: ${report.output.slice(-300)}`);
  assert.equal(report.termios_ok, true, `TERMIOS_OK missing: ${report.output.slice(-300)}`);
}

test('PTY: typing filters, arrows move, Enter returns the highlighted value', () => {
  const report = runPty('filter-pick', [[600, 'database'], [300, DOWN], [120, ENTER]]);
  assertTermios(report);
  assert.equal(report.exit, 0);
  assert.equal(report.mark('picked'), 4); // server-04 database
  assert.equal(report.mark('lastQuery').term, 'database');
});

test('PTY: down past the loaded page triggers incremental load-more at the right offset', () => {
  const steps = [[600, DOWN.repeat(9)], [200, DOWN], [200, DOWN], [150, ENTER]];
  const report = runPty('load-more', steps);
  assertTermios(report);
  assert.equal(report.exit, 0);
  assert.equal(report.mark('picked'), 12);
  assert.deepEqual(report.mark('offsets'), [0, 10]);
});

test('PTY: Escape cancels an ordinary prompt with PromptCancelled and exit 0', () => {
  const report = runPty('escape', [[600, ESC]]);
  assertTermios(report);
  assert.equal(report.exit, 0);
  assert.equal(report.mark('cancelled'), true);
});

test('PTY: Escape on the record picker resolves undefined (no cancel error)', () => {
  const report = runPty('picker-escape', [[700, ESC]]);
  assertTermios(report);
  assert.equal(report.exit, 0);
  assert.equal(report.mark('answer'), null);
  assert.equal(report.mark('done'), true);
});

test('PTY: Ctrl+C cancels cleanly, exits 0 and restores the terminal', () => {
  const report = runPty('ctrl-c', [[600, '\u0003']]);
  assertTermios(report);
  assert.equal(report.exit, 0);
  assert.equal(report.mark('cancelled'), 'PromptCancelled');
});

test('PTY: a stale slow search response never wins over the newer term', () => {
  const report = runPty('stale-source', [[600, 'a'], [40, 'b'], [900, ENTER]]);
  assertTermios(report);
  assert.equal(report.exit, 0);
  assert.equal(report.mark('picked'), 'fresh-ab');
});

test('PTY: two prompts in sequence both work and both clean up', () => {
  const report = runPty('sequential', [[600, 'oct12\r'], [300, 'y']]);
  assertTermios(report);
  assert.equal(report.exit, 0);
  assert.equal(report.mark('name'), 'oct12');
  assert.equal(report.mark('confirmed'), true);
});

test('PTY: empty list, source failure and no-match search stay usable', () => {
  const steps = [[700, ENTER], [800, ESC], [800, ESC], [700, 'zzz'], [600, '\u007f\u007f\u007f'], [600, ENTER]];
  const report = runPty('empty-and-failure', steps);
  assertTermios(report);
  assert.equal(report.exit, 0);
  assert.equal(report.mark('empty'), null);
  assert.equal(report.mark('failure'), null);
  assert.equal(report.mark('search'), 1); // cleared the no-match term, picked the first row
});

test('PTY: password and MFA never echo the typed value', () => {
  const report = runPty('password', [[600, 'hunter2\r'], [250, '123456\r']]);
  assertTermios(report);
  assert.equal(report.exit, 0);
  assert.equal(report.mark('secretIsExpected'), true);
  assert.equal(report.mark('code'), '123456');
  assert.match(report.output, /\*+/); // fixed-width placeholder is written
  const chrome = report.output.replace(/^MARK:.*$/gm, '');
  assert.doesNotMatch(chrome, /hunter2/);
  assert.doesNotMatch(chrome, /123456/);
});

test('PTY: confirm honors the default and explicit no', () => {
  const yes = runPty('confirm-yes', [[600, ENTER]]);
  assertTermios(yes);
  assert.equal(yes.mark('confirmed'), true);
  const no = runPty('confirm-no', [[600, ENTER]]);
  assertTermios(no);
  assert.equal(no.mark('confirmed'), false);
});

test('PTY: checkbox multi-select returns every toggled value', () => {
  const report = runPty('checkbox', [[600, ' '], [120, DOWN], [120, ' '], [120, ENTER]]);
  assertTermios(report);
  assert.equal(report.exit, 0);
  assert.deepEqual(report.mark('picked'), ['one', 'two']);
});

test('PTY: editor runs the fake $EDITOR and returns its content', () => {
  const report = runPty('editor', []);
  assertTermios(report);
  assert.equal(report.exit, 0);
  assert.equal(report.mark('content'), 'fixed editor content');
});

test('PTY: setup hub q and Escape resolve undefined without dispatching', () => {
  const quit = runPty('setup-hub', [[600, 'q']]);
  assertTermios(quit);
  assert.equal(quit.mark('action'), null);
  const escaped = runPty('setup-hub', [[600, ESC]]);
  assertTermios(escaped);
  assert.equal(escaped.mark('action'), null);
});

test('PTY: setup hub Enter dispatches the highlighted choice', () => {
  const report = runPty('setup-hub', [[600, DOWN], [120, ENTER]]);
  assertTermios(report);
  assert.equal(report.mark('action'), 'add');
});

test('PTY: pending source cancellation aborts the source and restores raw mode', () => {
  const report = runPty('pending-cancel', [[600, 'a'], [100, ESC]]);
  assertTermios(report);
  assert.equal(report.exit, 0);
  assert.equal(report.mark('sourceAborted'), true);
});

test('PTY: Ctrl+D acts as EOF and restores the terminal', () => {
  const report = runPty('eof', [[600, '\u0004']]);
  assertTermios(report);
  assert.equal(report.exit, 0);
  assert.equal(report.mark('cancelled'), 'PromptCancelled');
});

test('PTY: mixed text and invalid MFA validation survive real terminal input', () => {
  const report = runPty('text-validation', [[600, '\r'], [150, 'A+é@x.test!\r'], [200, '12\r'], [200, '\u007f\u007f654321\r']]);
  assertTermios(report);
  assert.equal(report.exit, 0);
  assert.equal(report.mark('exactText'), true);
  assert.equal(report.mark('validCode'), true);
  assert.match(report.output, /Try again/);
  assert.match(report.output, /6-digit code/);
  assert.doesNotMatch(report.output, /654321/);
});

test('PTY: the human demo filters and returns the actual selected server', () => {
  const report = runPty('demo', [[600, ENTER], [200, 'database'], [200, DOWN], [100, ENTER]]);
  assertTermios(report);
  assert.equal(report.exit, 0);
  assert.match(report.output, /Picked srv-04 \(synthetic-4\)/);
});

test('PTY: the human demo cancels without a stack trace', () => {
  const report = runPty('demo', [[600, ESC]]);
  assertTermios(report);
  assert.equal(report.exit, 0);
  assert.match(report.output, /Cancelled\./);
  assert.doesNotMatch(report.output, /at file:/);
});

