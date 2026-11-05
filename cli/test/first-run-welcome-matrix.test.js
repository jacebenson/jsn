// First-run welcome decision matrix (issue #387).
//
// One test per row of the hardening matrix. Each row is written to fail
// before the fix it covers and to name the row in its title, so a red build
// points straight at the behavior that regressed.
//
// Rows that need a real PTY skip cleanly on win32 (no Python `pty` module);
// row 11 is the test that pins that mechanism.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { globalConfigDir } from '../src/config.js';
import { WELCOME_MARKER, welcomeMarkerPath } from '../src/welcome.js';
import {
  BASE_ENV,
  CLI,
  RACE_CHILD,
  freshConfigHome,
  hasAnsi,
  hasWelcome,
  loadBaseFixture,
  ptySkipReason,
  readIfExists,
  runCli,
  runPty,
  runPtyAsync,
  runShell,
  sha256,
  welcomeBlock,
  writeGlobalConfig,
} from './support/welcome-harness.js';

const PTY_SKIP = ptySkipReason();
const POSIX_ONLY = process.platform === 'win32' ? 'POSIX file modes only' : false;
const ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z pid=\d+\n$/;

function assertNoStackTrace(output, where) {
  assert.ok(!/\b(EACCES|EPERM|ENOENT|EEXIST)\b[^\n]*\n\s+at /i.test(output),
    `${where} leaked a stack trace:\n${output}`);
  assert.ok(!/\n\s+at [A-Za-z][\w.]* \(/.test(output), `${where} leaked a stack trace:\n${output}`);
}

function assertMarkerComplete(marker, where) {
  const stamp = fs.readFileSync(marker, 'utf-8');
  assert.match(stamp, STAMP, `${where}: marker must be a complete stamp, got ${JSON.stringify(stamp)}`);
  const leftovers = fs.readdirSync(path.dirname(marker)).filter((name) => name.endsWith('.tmp'));
  assert.deepStrictEqual(leftovers, [], `${where}: no partially written temp files may remain`);
}

describe('first-run welcome matrix (issue #387)', () => {
  it('row 1: two first runs racing on one config dir produce at most one welcome and a valid marker', async () => {
    const { dir, marker } = freshConfigHome('jsn-race-');
    const [a, b] = await Promise.all([runPtyAsync(dir, [], { columns: 80 }), runPtyAsync(dir, [], { columns: 80 })]);
    const welcomes = [a, b].filter((run) => hasWelcome(run.output)).length;
    assert.strictEqual(welcomes, 1, `exactly one racing process may welcome:\nA:${welcomeBlock(a.output).slice(0, 2)}\nB:${welcomeBlock(b.output).slice(0, 2)}`);
    for (const run of [a, b]) {
      assert.strictEqual(run.status, 0, run.output.slice(0, 400));
      assert.match(run.output, /Usage: jsn <command> \[options\]/, 'both processes still print help');
    }
    assertMarkerComplete(marker, 'row 1');
    assert.strictEqual(fs.statSync(marker).mode & 0o777, 0o600);
  });

  it('row 1: the claim itself is exclusive across processes held at a barrier', async () => {
    for (let round = 0; round < 2; round += 1) {
      const { configDir, marker } = freshConfigHome('jsn-claim-');
      const barrierDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-barrier-'));
      const children = 4;
      const results = await Promise.all(Array.from({ length: children }, (_, id) => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [RACE_CHILD, configDir, barrierDir, String(id), String(children)], {
          encoding: 'utf-8',
          env: BASE_ENV,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', () => resolve({ stdout, stderr }));
      })));
      const claims = results.map((result) => {
        assert.ok(result.stdout.trim(), `race child produced no output: ${result.stderr}`);
        return JSON.parse(result.stdout.trim());
      });
      assert.strictEqual(claims.filter((claim) => claim.claim === 'claimed').length, 1,
        `exactly one child may claim the marker: ${JSON.stringify(claims)}`);
      assert.strictEqual(claims.filter((claim) => claim.claim === 'taken').length, children - 1);
      assertMarkerComplete(marker, `row 1 round ${round}`);
    }
  });

  it('row 2: an unwritable config dir still exits 0 and prints help, with no stack trace', { skip: ROOT || POSIX_ONLY }, () => {
    const { dir, configDir, marker } = freshConfigHome('jsn-ro-');
    fs.mkdirSync(configDir, { recursive: true });
    fs.chmodSync(configDir, 0o500);
    try {
      const first = runPty(dir, [], { columns: 80 });
      assert.strictEqual(first.status, 0, first.output);
      assert.match(first.output, /Usage: jsn <command> \[options\]/, 'help must still print');
      assert.ok(!fs.existsSync(marker), 'no marker can be written in a read-only dir');
      assertNoStackTrace(first.output, 'row 2');
      assert.ok(hasWelcome(first.output),
        'a read-only config dir must not swallow the note (it may simply appear again)');

      const second = runPty(dir, [], { columns: 80 });
      assert.strictEqual(second.status, 0, second.output);
      assert.match(second.output, /Usage: jsn <command> \[options\]/);
      assertNoStackTrace(second.output, 'row 2 (second run)');
    } finally {
      fs.chmodSync(configDir, 0o700);
    }
  });

  it('row 3: XDG_CONFIG_HOME wins with JSN_DATA_HOME set and HOME unset; the note is neither lost nor duplicated', { skip: PTY_SKIP }, () => {
    const { dir, configDir, marker } = freshConfigHome('jsn-xdg-');
    const dataHome = path.join(dir, 'data-home');
    fs.mkdirSync(dataHome, { recursive: true });
    const env = { JSN_DATA_HOME: dataHome };
    const first = runPty(dir, [], { columns: 80, env, unset: ['HOME'] });
    assert.strictEqual(first.status, 0, first.output);
    assert.ok(hasWelcome(first.output), 'first run must still welcome with HOME unset');
    assert.ok(fs.existsSync(marker), `marker must land in $XDG_CONFIG_HOME/servicenow (${configDir})`);
    assert.strictEqual(welcomeMarkerPath(configDir), marker);
    assert.deepStrictEqual(
      fs.readdirSync(dataHome).filter((name) => name.includes('welcom')),
      [],
      'JSN_DATA_HOME must not receive the welcome marker',
    );
    assertMarkerComplete(marker, 'row 3');

    const second = runPty(dir, [], { columns: 80, env, unset: ['HOME'] });
    assert.strictEqual(second.status, 0, second.output);
    assert.ok(!hasWelcome(second.output), 'the note must not be duplicated across runs');
    assert.match(second.output, /Usage: jsn <command> \[options\]/);
  });

  it('row 4: 40- and 60-column terminals keep every command intact and nothing overflows', { skip: PTY_SKIP }, () => {
    for (const columns of [40, 60]) {
      const { dir } = freshConfigHome('jsn-narrow-');
      const result = runPty(dir, [], { columns });
      assert.strictEqual(result.status, 0, result.output);
      const block = welcomeBlock(result.output);
      assert.ok(block.length > 0, `no welcome above help at ${columns} columns`);
      for (const line of block) {
        assert.ok(line.length <= columns, `${columns} columns, line is ${line.length}: ${JSON.stringify(line)}`);
      }
      const text = block.join('\n');
      for (const command of ['jsn setup', 'jsn auth login <instance>', 'jsn --help',
        'jsn docs search <query>', 'jsn skill install']) {
        assert.ok(text.includes(command), `${command} was damaged at ${columns} columns`);
      }
      assert.match(result.output, /Usage: jsn <command> \[options\]/, 'help still follows the note');
    }
  });

  it('row 5: NO_COLOR and TERM=dumb read the same, with no escape codes', { skip: PTY_SKIP }, () => {
    const { meta, help } = loadBaseFixture();

    const plain = runPty(freshConfigHome('jsn-color-a-').dir, [], { columns: 80 });
    const noColor = runPty(freshConfigHome('jsn-color-b-').dir, [], { columns: 80, env: { NO_COLOR: '1' } });
    assert.ok(!hasAnsi(plain.output), 'the note and help must not emit escapes on a TTY');
    assert.ok(!hasAnsi(noColor.output), 'NO_COLOR output must not contain escapes');
    assert.deepStrictEqual(welcomeBlock(noColor.output), welcomeBlock(plain.output),
      'NO_COLOR must not change the wording');
    assert.ok(hasWelcome(noColor.output), 'NO_COLOR must not hide the note');

    // TERM=dumb means no human terminal: no note, and the help is exactly the
    // base bytes, so nothing is lost by suppressing it.
    const dumb = runPty(freshConfigHome('jsn-color-c-').dir, [], { columns: 80, env: { TERM: 'dumb' } });
    assert.strictEqual(dumb.status, 0, dumb.output);
    assert.ok(!hasWelcome(dumb.output), 'TERM=dumb is not a human terminal');
    assert.ok(!hasAnsi(dumb.output), 'TERM=dumb output must not contain escapes');
    assert.strictEqual(dumb.output, help, 'TERM=dumb output must equal the base commit help byte for byte');
    assert.strictEqual(sha256(dumb.output), meta.sha256.help);
  });

  it('row 6: `jsn | cat` and `jsn > file` get help only, and burn nothing', () => {
    const { meta, help } = loadBaseFixture();
    const { dir, marker } = freshConfigHome('jsn-pipe-');
    const piped = runShell(`${process.execPath} ${JSON.stringify(CLI)} | cat`, dir);
    assert.strictEqual(piped.status, 0, piped.stderr);
    assert.strictEqual(piped.stdout, help, 'piped help must be byte-identical to the base commit');
    assert.strictEqual(sha256(piped.stdout), meta.sha256.help);

    const outFile = path.join(dir, 'redirect.out');
    const redirected = runShell(`${process.execPath} ${JSON.stringify(CLI)} > ${JSON.stringify(outFile)}`, dir);
    assert.strictEqual(redirected.status, 0, redirected.stderr);
    const written = fs.readFileSync(outFile, 'utf-8');
    assert.strictEqual(written, help, 'redirected help must be byte-identical to the base commit');
    assert.ok(!hasWelcome(written));
    assert.ok(!fs.existsSync(marker), 'piping or redirecting must not consume the welcome');
  });

  it('row 7: an already-configured profile gets no welcome and no marker', { skip: PTY_SKIP }, () => {
    const { dir, configDir, marker } = freshConfigHome('jsn-configured-');
    writeGlobalConfig(dir, {
      defaultProfile: 'prod',
      profiles: { prod: { instance_url: 'https://acme.service-now.com' } },
    });
    const result = runPty(dir, [], { columns: 80 });
    assert.strictEqual(result.status, 0, result.output);
    assert.ok(!hasWelcome(result.output), 'a configured installation is not a first run');
    assert.match(result.output, /Usage: jsn <command> \[options\]/);
    assert.ok(!fs.existsSync(marker), 'a skipped run must not create the marker as a side effect');
    assert.deepStrictEqual(fs.readdirSync(configDir).sort(), ['config.json'],
      'the run must not add files to a configured installation');
  });

  it('row 8: JSN_NO_WELCOME is suppressed only by the literal "1"', { skip: PTY_SKIP }, () => {
    const cases = [
      { value: '1', suppresses: true },
      { value: '0', suppresses: false },
      { value: '', suppresses: false },
      { value: undefined, suppresses: false },
    ];
    for (const { value, suppresses } of cases) {
      const { dir, marker } = freshConfigHome('jsn-env-');
      const env = value === undefined ? {} : { JSN_NO_WELCOME: value };
      const result = runPty(dir, [], { columns: 80, env });
      assert.strictEqual(result.status, 0, result.output);
      assert.strictEqual(hasWelcome(result.output), !suppresses,
        `JSN_NO_WELCOME=${JSON.stringify(value)} must ${suppresses ? '' : 'not '}suppress the note`);
      assert.strictEqual(fs.existsSync(marker), !suppresses,
        `JSN_NO_WELCOME=${JSON.stringify(value)} must ${suppresses ? 'not consume' : 'consume'} the marker`);
    }
  });

  it('row 9: machine formats carry no welcome and keep the base bytes', () => {
    const { meta, help } = loadBaseFixture();
    const { dir, marker } = freshConfigHome('jsn-formats-');
    const helpPrinting = [['--quiet'], ['--csv'], ['--markdown'], ['--get', 'data.version']];
    for (const args of helpPrinting) {
      const result = runCli(args, dir);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(!hasWelcome(result.stdout), `${args.join(' ')} must not receive the welcome`);
      assert.strictEqual(result.stdout, help, `${args.join(' ')} output must equal the base commit bytes`);
      assert.strictEqual(sha256(result.stdout), meta.sha256.help, `${args.join(' ')} hash must match the base commit`);
    }
    assert.ok(!fs.existsSync(marker), 'machine formats must not consume the welcome');

    // The discovery envelope is not pinned byte for byte (it changes whenever a
    // command is added), but it must be unchanged by this feature: the same
    // command with the welcome explicitly disabled has to produce the same bytes.
    const json = runCli(['--json'], dir);
    const jsonSuppressed = runCli(['--json'], dir, { env: { JSN_NO_WELCOME: '1' } });
    assert.strictEqual(json.status, 0, json.stderr);
    assert.ok(!hasWelcome(json.stdout));
    const parsed = JSON.parse(json.stdout);
    assert.ok(Array.isArray(parsed.data.commands) && parsed.data.commands.length > 0);
    assert.strictEqual(json.stdout, jsonSuppressed.stdout,
      '--json output must not change when the welcome path is disabled');
    assert.deepStrictEqual(json.stderr, '', '--json must not write to stderr');

    const version = runCli(['version', '--json'], dir);
    assert.strictEqual(version.status, 0, version.stderr);
    assert.ok(!hasWelcome(version.stdout));
    assert.strictEqual(JSON.parse(version.stdout).data.version,
      JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf-8')).version);
  });

  it('row 10: SIGINT during the first run never yields a welcome without a marker', { skip: PTY_SKIP }, () => {
    // Killed as early as possible: either the claim happened (then the note was
    // owed and the marker must exist) or it did not (then nothing was recorded
    // and the next run must still show the note exactly once).
    const early = freshConfigHome('jsn-sigint-a-');
    const earlyRun = runPty(early.dir, [], { columns: 80, signal: { name: 'SIGINT', after_ms: 0 } });
    assert.ok(earlyRun.signal === 2 || earlyRun.status === 0 || earlyRun.status === 130,
      `SIGINT must end the run by signal or clean exit, got status=${earlyRun.status} signal=${earlyRun.signal}`);
    assertNoStackTrace(earlyRun.output, 'row 10 (early SIGINT)');
    const earlyMarker = fs.existsSync(early.marker);
    if (hasWelcome(earlyRun.output)) {
      assert.ok(earlyMarker, 'a printed welcome must always be backed by a marker');
    }
    const earlyFollowUp = runPty(early.dir, [], { columns: 80 });
    assert.strictEqual(earlyFollowUp.status, 0, earlyFollowUp.output);
    assert.strictEqual(hasWelcome(earlyFollowUp.output), !earlyMarker,
      'the follow-up run shows the note exactly when the interrupted run did not record it');

    // Killed after the first output byte, i.e. after the marker was claimed and
    // while the note is on the wire: the marker is already complete and final.
    const late = freshConfigHome('jsn-sigint-b-');
    const lateRun = runPty(late.dir, [], { columns: 80, signal: { name: 'SIGINT', after_bytes: 1 } });
    assert.ok(lateRun.signalled, 'the driver must have delivered SIGINT');
    assert.ok(fs.existsSync(late.marker), 'the marker is claimed before anything is printed');
    assertMarkerComplete(late.marker, 'row 10 (late SIGINT)');
    assertNoStackTrace(lateRun.output, 'row 10 (late SIGINT)');
    const lateFollowUp = runPty(late.dir, [], { columns: 80 });
    assert.strictEqual(lateFollowUp.status, 0, lateFollowUp.output);
    assert.ok(!hasWelcome(lateFollowUp.output), 'an interrupted first run must not repeat the note');
    assert.match(lateFollowUp.output, /Usage: jsn <command> \[options\]/);
  });

  it('row 11: PTY assertions skip cleanly on Windows instead of failing', () => {
    assert.strictEqual(ptySkipReason('linux', 0), false, 'POSIX with python3 runs the PTY assertions');
    assert.match(ptySkipReason('win32', 0), /win32/, 'win32 must produce a skip reason, not a hard failure');
    assert.match(ptySkipReason('linux', 1), /python3/, 'a missing python3 must also skip, not fail');

    // The mechanism is Python's POSIX-only `pty` module, and CI does run a
    // windows-2022 job, so the skip has to be a real one.
    const driver = fs.readFileSync(path.resolve('test/support/welcome-pty.py'), 'utf-8');
    assert.match(driver, /^import pty$/m);
    assert.match(driver, /Windows has no pty module/);
    const workflow = fs.readFileSync(path.resolve('..', '.github', 'workflows', 'ci.yml'), 'utf-8');
    assert.match(workflow, /windows-2022/, 'CI must exercise the Windows path this row is about');
  });

  it('row 12: the marker is 0600 and sits with the daily-check markers', { skip: POSIX_ONLY }, () => {
    const { dir, configDir, marker } = freshConfigHome('jsn-mode-');
    const result = runPty(dir, [], { columns: 80 });
    assert.strictEqual(result.status, 0, result.output);
    assert.ok(fs.existsSync(marker));
    assert.strictEqual(fs.statSync(marker).mode & 0o777, 0o600, 'the marker must not be world readable');
    assert.strictEqual(fs.statSync(configDir).mode & 0o777, 0o750, 'the config dir must not be world readable');

    // Same directory as the daily checks: prove it with the CLI's own resolver,
    // not with a path this test invented.
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;
    try {
      assert.strictEqual(path.dirname(marker), globalConfigDir(),
        'the welcome marker must live in the XDG config dir the daily checks use');
      assert.strictEqual(globalConfigDir(), configDir);
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
    }

    // The daily markers are dot-files in that same directory.
    const dailyMarker = path.join(configDir, '.last-npm-check-latest');
    fs.writeFileSync(dailyMarker, '0');
    assert.deepStrictEqual(
      fs.readdirSync(configDir).filter((name) => name.startsWith('.')).sort(),
      ['.last-npm-check-latest', WELCOME_MARKER].sort(),
    );
    assert.ok(readIfExists(path.join(configDir, '.last-skill-check')) === null);
  });
});
