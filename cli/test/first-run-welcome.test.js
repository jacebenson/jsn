// First-run welcome (issue #387).
//
// Contract: bare `jsn` on a fresh installation with a human at the terminal
// gets a short orientation above the unchanged grouped help, exactly once.
// It must never appear in machine-readable output, piped output, `--help`, or
// an already-configured installation, and it must never itself touch an
// instance or credentials.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  WELCOME_MARKER,
  welcomeText,
  shouldShowWelcome,
  maybeShowWelcome,
  markWelcomeSeen,
} from '../src/welcome.js';

const CLI = path.resolve('bin/jsn.js');
const DRIVER = path.resolve('test/support/welcome-pty.py');

const BASE_ENV = {
  ...process.env,
  JSN_NO_VERSION_CHECK: '1',
  JSN_NO_SKILL_CHECK: '1',
};

const WELCOME_MARKER_TEXT = 'Welcome to jsn';

/** Isolated XDG config home — no personal profiles can leak into the run. */
function freshConfigHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-welcome-'));
  // XDG_CONFIG_HOME for spawned runs; the `servicenow` dir is what the
  // welcome module writes its marker into.
  const configDir = path.join(dir, 'servicenow');
  return { dir, configDir, marker: path.join(configDir, WELCOME_MARKER) };
}

function runCli(args, configHome, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8',
    cwd: path.resolve('.'),
    env: { ...BASE_ENV, XDG_CONFIG_HOME: configHome, ...extraEnv },
    timeout: 20000,
  });
}

const python3 = spawnSync('python3', ['--version'], { encoding: 'utf-8' });
const PTY_SKIP = process.platform === 'win32' || python3.status !== 0;

function runPty(configHome, args = []) {
  const result = spawnSync('python3', [DRIVER, JSON.stringify({
    command: [process.execPath, CLI, ...args],
    cwd: path.resolve('.'),
    env: { ...BASE_ENV, XDG_CONFIG_HOME: configHome },
  })], { encoding: 'utf-8', timeout: 40000 });
  assert.strictEqual(result.status, 0, `PTY driver failed: ${result.stderr}${result.stdout}`);
  const parsed = JSON.parse(result.stdout);
  return { status: parsed.status, output: parsed.output.replace(/\r\n/g, '\n') };
}

/** Capture process.stdout.write for the duration of one synchronous call. */
function captureStdout(fn) {
  const original = process.stdout.write;
  let written = '';
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk === 'string') written += chunk;
    else written += Buffer.from(chunk).toString('utf-8');
    const maybeCallback = rest.find((arg) => typeof arg === 'function');
    if (maybeCallback) maybeCallback();
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return written;
}

describe('first-run welcome decision', () => {
  const freshCfg = { profiles: {}, defaultProfile: '', instanceURL: '' };

  it('is shown for a first bare run on a human terminal', () => {
    const { configDir } = freshConfigHome();
    assert.strictEqual(shouldShowWelcome({
      cfg: freshCfg, env: {}, configDir, interactive: true,
    }), true);
  });

  it('is never shown again once the marker exists', () => {
    const { configDir } = freshConfigHome();
    markWelcomeSeen(configDir);
    assert.strictEqual(shouldShowWelcome({
      cfg: freshCfg, env: {}, configDir, interactive: true,
    }), false);
  });

  it('stays out of machine-readable and piped output', () => {
    const { configDir } = freshConfigHome();
    for (const requestedFormat of ['json', 'quiet', 'csv', 'markdown']) {
      assert.strictEqual(shouldShowWelcome({
        cfg: freshCfg, requestedFormat, env: {}, configDir, interactive: true,
      }), false, `${requestedFormat} must not receive the welcome`);
    }
    assert.strictEqual(shouldShowWelcome({
      cfg: freshCfg, argv: { get: 'commands' }, env: {}, configDir, interactive: true,
    }), false, '--get must not receive the welcome');
  });

  it('requires an interactive terminal, not just a fresh config dir', () => {
    const { configDir } = freshConfigHome();
    assert.strictEqual(shouldShowWelcome({
      cfg: freshCfg, env: {}, configDir, interactive: false,
    }), false);
  });

  it('respects JSN_NO_WELCOME and an existing connection', () => {
    const { configDir } = freshConfigHome();
    assert.strictEqual(shouldShowWelcome({
      cfg: freshCfg, env: { JSN_NO_WELCOME: '1' }, configDir, interactive: true,
    }), false);
    assert.strictEqual(shouldShowWelcome({
      cfg: { profiles: { prod: { instance_url: 'https://acme.service-now.com' } } },
      env: {}, configDir, interactive: true,
    }), false);
  });

  it('points at setup, help and docs without promising an instance', () => {
    const text = welcomeText();
    assert.match(text, /jsn setup/);
    assert.match(text, /jsn --help/);
    assert.match(text, /jsn docs search/);
    assert.match(text, /appears once/);
  });

  it('writes the marker when it shows and stays silent afterwards', () => {
    const { configDir, marker } = freshConfigHome();
    const shown = captureStdout(() => maybeShowWelcome({
      cfg: freshCfg, env: {}, configDir, interactive: true,
    }));
    assert.match(shown, /Welcome to jsn/);
    assert.ok(fs.existsSync(marker), 'marker must persist the shown state');
    const second = captureStdout(() => maybeShowWelcome({
      cfg: freshCfg, env: {}, configDir, interactive: true,
    }));
    assert.strictEqual(second, '');
  });
});

describe('bare `jsn` first run', () => {
  it('prints unchanged help and no welcome for piped output, and does not burn the once-only marker', () => {
    const { dir, marker } = freshConfigHome();
    const result = runCli([], dir);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: jsn <command> \[options\]/);
    assert.doesNotMatch(result.stdout, new RegExp(WELCOME_MARKER_TEXT));
    assert.ok(!fs.existsSync(marker), 'a non-TTY run must not consume the welcome');
  });

  it('keeps `--help`, `--json` and docs commands free of the welcome', () => {
    const { dir } = freshConfigHome();
    const help = runCli(['--help'], dir);
    assert.strictEqual(help.status, 0, help.stderr);
    assert.doesNotMatch(help.stdout, new RegExp(WELCOME_MARKER_TEXT));
    assert.match(help.stdout, /Usage: jsn <command>/);

    const json = runCli(['--json'], dir);
    assert.strictEqual(json.status, 0, json.stderr);
    assert.doesNotMatch(json.stdout, new RegExp(WELCOME_MARKER_TEXT));
    assert.doesNotThrow(() => JSON.parse(json.stdout), '--json must stay parseable');

    const docs = runCli(['docs', '--help'], dir);
    assert.strictEqual(docs.status, 0, docs.stderr);
    assert.doesNotMatch(docs.stdout, new RegExp(WELCOME_MARKER_TEXT));
  });

  it('shows the orientation above full help exactly once on a real terminal', { skip: PTY_SKIP }, () => {
    const { dir, marker } = freshConfigHome();

    const first = runPty(dir);
    assert.strictEqual(first.status, 0, first.output);
    assert.match(first.output, /Welcome to jsn/);
    assert.match(first.output, /jsn setup/);
    // Help is not replaced, only preceded.
    assert.match(first.output, /Usage: jsn <command> \[options\]/);
    assert.match(first.output, /jsn incidents/);
    assert.ok(fs.existsSync(marker), 'first PTY run must persist the marker');

    const second = runPty(dir);
    assert.strictEqual(second.status, 0, second.output);
    assert.doesNotMatch(second.output, new RegExp(WELCOME_MARKER_TEXT));
    assert.match(second.output, /Usage: jsn <command> \[options\]/);
  });
});
