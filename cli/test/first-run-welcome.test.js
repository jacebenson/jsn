// First-run welcome (issue #387).
//
// Contract: bare `jsn` on a fresh installation with a human at the terminal
// gets a short standalone orientation, exactly once; explicit help is unchanged.
// It must never appear in machine-readable output, piped output, `--help`, or
// an already-configured installation, and it must never itself touch an
// instance, the network, or credentials.
//
// The decision matrix (racing runs, unwritable config, narrow terminals, env
// overrides, signals) lives in first-run-welcome-matrix.test.js.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import {
  WELCOME_MARKER,
  WELCOME_MAX_LINES,
  welcomeLines,
  welcomeText,
  shouldShowWelcome,
  maybeShowWelcome,
  markWelcomeSeen,
  claimWelcome,
  welcomeMarkerPath,
} from '../src/welcome.js';
import { getVersion } from '../src/commands/version.js';
import {
  WELCOME_HEADLINE,
  freshConfigHome,
  hasAnsi,
  hasWelcome,
  loadBaseFixture,
  ptySkipReason,
  runCli,
  runPty,
  sha256,
  stripAnsi,
  welcomeBlock,
} from './support/welcome-harness.js';

const PTY_SKIP = ptySkipReason();
const CONTENT_CONFIG_DIR = path.join('/tmp', 'jsn-welcome-probe', 'servicenow');

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

function contentLines(overrides = {}) {
  return welcomeLines({ columns: 80, env: {}, configDir: CONTENT_CONFIG_DIR, ...overrides });
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

  it('points at setup and help without a command catalog', () => {
    const text = welcomeText({ columns: 80, env: {}, configDir: CONTENT_CONFIG_DIR });
    assert.match(text, /jsn setup/);
    assert.doesNotMatch(text, /jsn auth login/);
    assert.match(text, /jsn --help/);
    assert.doesNotMatch(text, /jsn docs search/);
  });

  it('writes the marker when it shows and stays silent afterwards', () => {
    const { configDir, marker } = freshConfigHome();
    const shown = captureStdout(() => maybeShowWelcome({
      cfg: freshCfg, env: {}, configDir, interactive: true, columns: 80,
    }));
    assert.match(shown, new RegExp(WELCOME_HEADLINE));
    assert.ok(fs.existsSync(marker), 'marker must persist the shown state');
    const second = captureStdout(() => maybeShowWelcome({
      cfg: freshCfg, env: {}, configDir, interactive: true, columns: 80,
    }));
    assert.strictEqual(second, '');
  });
});

describe('welcome content', () => {
  it('fits the 12-line budget at 80 columns without overflowing', () => {
    const lines = contentLines();
    assert.ok(lines.length <= WELCOME_MAX_LINES,
      `the note must stay within ${WELCOME_MAX_LINES} lines at 80 columns, got ${lines.length}:\n${lines.join('\n')}`);
    for (const line of lines) {
      assert.ok(line.length <= 80, `line is ${line.length} columns wide: ${JSON.stringify(line)}`);
    }
  });

  it('is plain ASCII: no emoji, no colour, readable with NO_COLOR and TERM=dumb', () => {
    for (const line of contentLines()) {
      assert.match(line, /^[\x20-\x7E]*$/, `non-ASCII or control characters in ${JSON.stringify(line)}`);
    }
    const text = welcomeText({ columns: 80, env: {}, configDir: CONTENT_CONFIG_DIR });
    assert.ok(!hasAnsi(text), 'the note must not emit ANSI escapes');
  });

  it('shows one setup action, secondary help, config location and installed version', () => {
    const text = welcomeText({ columns: 80, env: {}, configDir: CONTENT_CONFIG_DIR });
    // setup is the interactive first connection; auth login is the scriptable one.
    assert.match(text, /jsn setup\s+connect to ServiceNow/);
    // Where the marker and profiles actually live.
    assert.match(text, /Config: .*servicenow[\\/]config\.json/);
    // The agent skill, docs search, and a version/update path derived from disk.
    assert.match(text, /jsn --help/);
    assert.ok(text.includes(getVersion()), 'the installed version comes from package.json and must be shown');
    // Once-only is stated, and so is the escape hatch.
    assert.doesNotMatch(text, /Usage: jsn/);
  });

  it('mentions only commands that exist and are declared instance-free', async () => {
    // Importing the command modules is what declares their capabilities; the
    // CLI does the same at startup, so this is the same registry it consults.
    const { collectCapabilities } = await import('../src/capabilities.js');
    await Promise.all([
      import('../src/commands/setup.js'),
      import('../src/commands/auth.js'),
      import('../src/commands/docs/docs.js'),
      import('../src/commands/skill.js'),
      import('../src/commands/upgrade.js'),
    ]);
    const caps = collectCapabilities();
    const mentioned = new Set();
    for (const line of contentLines()) {
      const match = /^\s{4}jsn ([a-z][a-z-]*)/.exec(line);
      if (match) mentioned.add(match[1]);
    }
    assert.deepStrictEqual([...mentioned].sort(), ['setup'],
      'the note should only point at setup, auth, docs and skill');
    for (const name of mentioned) {
      assert.ok(caps.has(name), `"jsn ${name}" is not a registered command`);
      assert.strictEqual(caps.get(name).noInstance, true,
        `"jsn ${name}" is offered to a first run but is not declared noInstance`);
    }
  });

  it('never becomes a wizard: no prompts, no blocking, no instance wording', () => {
    const text = welcomeText({ columns: 80, env: {}, configDir: CONTENT_CONFIG_DIR }).toLowerCase();
    for (const forbidden of ['press enter', 'press any key', 'continue?', '[y/n]', 'password', 'username']) {
      assert.ok(!text.includes(forbidden), `the note must not ask for ${forbidden}`);
    }
  });

  it('derives the version from the installed package, never from the network', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf-8'));
    assert.strictEqual(getVersion(), pkg.version);
    assert.ok(contentLines().join('\n').includes(`jsn ${pkg.version}`),
      'the installed version must be shown, read from package.json');
    // An unreadable package must not print a fake version.
    assert.doesNotMatch(contentLines({ version: '0.0.0' }).join('\n'), /0\.0\.0/);
  });

  it('wraps rather than truncates on a 40- and 60-column terminal', () => {
    for (const columns of [40, 60]) {
      const lines = welcomeLines({ columns, env: {}, configDir: CONTENT_CONFIG_DIR });
      for (const line of lines) {
        assert.ok(line.length <= columns, `${columns} columns, ${line.length} wide: ${JSON.stringify(line)}`);
      }
      const text = lines.join('\n');
      for (const command of ['jsn setup', 'jsn --help']) {
        assert.ok(text.includes(command), `${command} must survive a ${columns}-column terminal intact`);
      }
    }
  });

  it('falls back to a short config label when the real path cannot fit', () => {
    const longDir = path.join('/tmp', 'x'.repeat(90), 'servicenow');
    const lines = welcomeLines({ columns: 80, env: {}, configDir: longDir });
    const label = lines.find((line) => line.startsWith('Config: '));
    assert.ok(label, 'the note always says where config lives');
    assert.ok(label.length <= 80, `the fallback label must fit: ${label}`);
    assert.match(label, /~\/\.config\/servicenow\/config\.json$/);
    for (const line of lines) assert.ok(line.length <= 80, `line too wide: ${line}`);
  });

  it('claims the marker exactly once and leaves a complete 0600 stamp', { skip: process.platform === 'win32' }, () => {
    const { configDir, marker } = freshConfigHome();
    assert.strictEqual(claimWelcome(configDir), 'claimed');
    assert.strictEqual(claimWelcome(configDir), 'taken');
    assert.strictEqual(welcomeMarkerPath(configDir), marker);
    const stamp = fs.readFileSync(marker, 'utf-8');
    assert.match(stamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z pid=\d+\n$/, 'marker must be a complete stamp, never a partial write');
    assert.strictEqual(fs.statSync(marker).mode & 0o777, 0o600);
    const leftovers = fs.readdirSync(configDir).filter((name) => name.includes('.tmp'));
    assert.deepStrictEqual(leftovers, [], 'no temp files may be left behind');
  });
});

describe('bare `jsn` first run', () => {
  it('prints unchanged help and no welcome for piped output, and does not burn the once-only marker', () => {
    const { meta, help } = loadBaseFixture();
    const { dir, marker } = freshConfigHome();
    const result = runCli([], dir);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(sha256(result.stdout), meta.sha256.help,
      'piped bare `jsn` must still print the base commit help byte for byte');
    assert.strictEqual(result.stdout, help);
    assert.ok(!hasWelcome(result.stdout));
    assert.ok(!fs.existsSync(marker), 'a non-TTY run must not consume the welcome');
  });

  it('keeps `--help`, `--json` and docs commands free of the welcome', () => {
    const { dir } = freshConfigHome();
    const help = runCli(['--help'], dir);
    assert.strictEqual(help.status, 0, help.stderr);
    assert.ok(!hasWelcome(help.stdout));
    assert.match(help.stdout, /Usage: jsn <command>/);

    const json = runCli(['--json'], dir);
    assert.strictEqual(json.status, 0, json.stderr);
    assert.ok(!hasWelcome(json.stdout));
    assert.doesNotThrow(() => JSON.parse(json.stdout), '--json must stay parseable');

    const docs = runCli(['docs', '--help'], dir);
    assert.strictEqual(docs.status, 0, docs.stderr);
    assert.ok(!hasWelcome(docs.stdout));
  });

  it('shows the standalone orientation exactly once on a real terminal', { skip: PTY_SKIP }, () => {
    const { meta, help } = loadBaseFixture();
    const { dir, marker } = freshConfigHome();

    const first = runPty(dir, [], { columns: 80 });
    assert.strictEqual(first.status, 0, first.output);
    assert.ok(hasWelcome(first.output), 'first run must show the note');
    assert.match(first.output, /jsn setup/);
    assert.doesNotMatch(first.output, /jsn auth login/);
    // Only the first-run front door replaces the catalog; subsequent help is unchanged.
    const helpStart = first.output.indexOf('Usage: jsn <command>');
    assert.equal(helpStart, -1, 'first-run front door must not append the catalog');
    assert.ok(first.output.trim().split('\n').length <= 8);
    assert.strictEqual(sha256(help), meta.sha256.help);
    assert.ok(!hasAnsi(first.output), 'a TTY must not add escape codes');
    assert.ok(fs.existsSync(marker), 'first PTY run must persist the marker');

    const block = welcomeBlock(first.output);
    assert.ok(block.length <= WELCOME_MAX_LINES, `welcome block is ${block.length} lines`);

    const second = runPty(dir, [], { columns: 80 });
    assert.strictEqual(second.status, 0, second.output);
    assert.ok(!hasWelcome(second.output));
    assert.match(second.output, /jsn setup/);
    assert.doesNotMatch(second.output, /Usage:|CORE|FLAGS/);
  });

  it('keeps the note out of an agent or CI environment even on a TTY', { skip: PTY_SKIP }, () => {
    for (const env of [{ CLAUDE_CODE: '1' }, { CI: 'true' }, { GITHUB_ACTIONS: 'true' },
      { JSN_NO_PROMPTS: '1' }, { NONINTERACTIVE: '1' }]) {
      const { dir, marker } = freshConfigHome();
      const result = runPty(dir, [], { columns: 80, env });
      assert.strictEqual(result.status, 0, result.output);
      assert.ok(!hasWelcome(result.output), `${JSON.stringify(env)} must not receive the welcome`);
      assert.ok(!fs.existsSync(marker), `${JSON.stringify(env)} must not consume the marker`);
    }
  });
});

describe('first-run note wording stays honest to the marker', () => {
  it('keeps the standalone front door separate from catalog output', () => {
    const text = stripAnsi(welcomeText({ columns: 80, env: {}, configDir: CONTENT_CONFIG_DIR }));
    assert.match(text, /jsn setup/);
    assert.doesNotMatch(text, /Usage: jsn/);
    assert.strictEqual(WELCOME_MARKER, '.welcomed');
  });
});
