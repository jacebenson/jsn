// Shared harness for the first-run welcome tests (issue #387).
//
// Every helper here exists to make one property provable rather than
// plausible: a throwaway XDG config home per test, a real PTY when TTY-ness is
// the thing under test, and byte comparison helpers for "unchanged output".

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLI = path.resolve('bin/jsn.js');
export const REPO_ROOT = path.resolve('.');
export const PTY_DRIVER = path.resolve('test/support/welcome-pty.py');
export const RACE_CHILD = path.resolve('test/support/welcome-race-child.js');
export const FIXTURE_DIR = path.resolve('test/fixtures/first-run');

/**
 * Environment markers that make jsn decide "no human is here". A first-run test
 * must not inherit them from the machine that happens to be running the suite:
 * on GitHub Actions `CI` and `GITHUB_ACTIONS` are already set, so a PTY run
 * there would be a CI run, not a first run, and the note would never appear.
 * Tests that want these markers set them explicitly.
 */
const HUMAN_ONLY_SCRUB = [
  'CI', 'GITHUB_ACTIONS', 'NONINTERACTIVE', 'JSN_NO_PROMPTS', 'JSN_NO_WELCOME',
  'NO_COLOR', 'TERM',
  'CLAUDE_CODE', 'COPILOT_AGENT', 'VSCODE_AGENT', 'CURSOR_AGENT', 'CODEX_AGENT',
  'GITHUB_COPILOT_AGENT',
];

/**
 * Baseline environment for a spawned jsn: a human terminal with no inherited
 * suppression, and the daily npm/skill checks (real network calls) turned off.
 */
export const BASE_ENV = (() => {
  const env = { ...process.env };
  for (const key of HUMAN_ONLY_SCRUB) delete env[key];
  env.JSN_NO_VERSION_CHECK = '1';
  env.JSN_NO_SKILL_CHECK = '1';
  return env;
})();

export const WELCOME_HEADLINE = 'Welcome to jsn';

/** Isolated config home. Nothing personal can leak into a run. */
export function freshConfigHome(prefix = 'jsn-welcome-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configDir = path.join(dir, 'servicenow');
  return { dir, configDir, marker: path.join(configDir, '.welcomed') };
}

/** Drop a config.json into a fresh config home, creating the dir. */
export function writeGlobalConfig(configHome, config) {
  const dir = path.join(configHome, 'servicenow');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  return path.join(dir, 'config.json');
}

/**
 * Run the CLI with piped stdio (the non-TTY case) against a throwaway config
 * home.
 *
 * @param {string[]} args
 * @param {string} configHome — value for XDG_CONFIG_HOME
 * @param {object} [opts]
 * @param {object} [opts.env] — extra environment
 * @param {string[]} [opts.unset] — environment names to remove
 * @param {string} [opts.cwd]
 */
export function runCli(args = [], configHome, opts = {}) {
  const env = { ...BASE_ENV, XDG_CONFIG_HOME: configHome, ...(opts.env || {}) };
  for (const key of opts.unset || []) delete env[key];
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8',
    cwd: opts.cwd || REPO_ROOT,
    env,
    timeout: 30000,
  });
}

/** Run through a shell so `jsn | cat` and `jsn > file` are the real thing. */
export function runShell(command, configHome, opts = {}) {
  const env = { ...BASE_ENV, XDG_CONFIG_HOME: configHome, ...(opts.env || {}) };
  for (const key of opts.unset || []) delete env[key];
  return spawnSync('/bin/sh', ['-c', command], {
    encoding: 'utf-8',
    cwd: opts.cwd || REPO_ROOT,
    env,
    timeout: 30000,
  });
}

/**
 * Run the CLI under a real PTY.
 *
 * @param {string} configHome — value for XDG_CONFIG_HOME
 * @param {string[]} [args]
 * @param {object} [opts] — columns, rows, env, unset, signal, timeout
 * @returns {{status:number, signal:number|null, signalled:boolean, output:string}}
 */
export function runPty(configHome, args = [], opts = {}) {
  const spec = {
    command: [process.execPath, CLI, ...args],
    cwd: opts.cwd || REPO_ROOT,
    env: { ...BASE_ENV, XDG_CONFIG_HOME: configHome, ...(opts.env || {}) },
    unset: opts.unset || [],
    columns: opts.columns || 100,
    rows: opts.rows || 30,
    timeout: opts.timeout || 30,
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  const result = spawnSync('python3', [PTY_DRIVER, JSON.stringify(spec)], {
    encoding: 'utf-8',
    timeout: (spec.timeout + 20) * 1000,
  });
  if (result.status !== 0 || !result.stdout) {
    throw new Error(`PTY driver failed (status ${result.status}): ${result.stderr}${result.stdout}`);
  }
  const parsed = JSON.parse(result.stdout);
  return {
    status: parsed.status,
    signal: parsed.signal,
    signalled: parsed.signalled,
    output: parsed.output.replace(/\r\n/g, '\n'),
  };
}

/** Concurrent PTY run, for racing two first runs against one config home. */
export function runPtyAsync(configHome, args = [], opts = {}) {
  const spec = {
    command: [process.execPath, CLI, ...args],
    cwd: opts.cwd || REPO_ROOT,
    env: { ...BASE_ENV, XDG_CONFIG_HOME: configHome, ...(opts.env || {}) },
    unset: opts.unset || [],
    columns: opts.columns || 100,
    rows: opts.rows || 30,
    timeout: opts.timeout || 30,
  };
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [PTY_DRIVER, JSON.stringify(spec)], { encoding: 'utf-8' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 || !stdout) {
        reject(new Error(`PTY driver failed (status ${code}): ${stderr}${stdout}`));
        return;
      }
      const parsed = JSON.parse(stdout);
      resolve({
        status: parsed.status,
        signal: parsed.signal,
        signalled: parsed.signalled,
        output: parsed.output.replace(/\r\n/g, '\n'),
      });
    });
  });
}

/**
 * Why PTY-based assertions cannot run on this platform, or `false` when they
 * can. Windows has no `pty` module in Python, so those tests skip there while
 * the rest of the suite keeps running. Returns `false` rather than null
 * because node:test treats the mere presence of a `skip` key as "skip".
 *
 * @param {string} [platform]
 * @param {number|null} [pythonStatus] — exit status of `python3 --version`
 * @returns {string|false}
 */
export function ptySkipReason(platform = process.platform, pythonStatus = pythonAvailable()) {
  if (platform === 'win32') return 'PTY assertions need a POSIX pty; skipped on win32 (CI: windows-2022)';
  if (pythonStatus !== 0) return 'PTY assertions need python3 on PATH';
  return false;
}

let pythonStatusCache;
export function pythonAvailable() {
  if (pythonStatusCache === undefined) {
    pythonStatusCache = spawnSync('python3', ['--version'], { encoding: 'utf-8' }).status;
  }
  return pythonStatusCache;
}

// Built from code points so the source holds no control-character literal.
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
export function stripAnsi(text) {
  return String(text).replace(ANSI, '');
}

/**
 * The welcome block: everything printed above the grouped root help.
 *
 * @param {string} output — PTY or piped output
 * @returns {string[]} lines, ANSI stripped, trailing blank lines removed
 */
export function welcomeBlock(output) {
  const lines = stripAnsi(output).split('\n');
  const helpAt = lines.findIndex((line) => /^Usage: jsn <command>/.test(line));
  const block = helpAt === -1 ? lines : lines.slice(0, helpAt);
  while (block.length && block[block.length - 1].trim() === '') block.pop();
  return block;
}

/** Does this output contain the welcome at all? */
export function hasWelcome(output) {
  return stripAnsi(output).includes(WELCOME_HEADLINE);
}

/** Bytes of a file, or null when it does not exist. */
export function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

/** sha256 of a string or Buffer. */
export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** The base-commit fixture: recorded help bytes and output hashes. */
export function loadBaseFixture() {
  const meta = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'base-output.json'), 'utf-8'));
  const help = fs.readFileSync(path.join(FIXTURE_DIR, 'base-help.txt'), 'utf-8');
  return { meta, help };
}

/** True when an output contains ANSI escape sequences. */
export function hasAnsi(text) {
  return ANSI.test(String(text));
}
