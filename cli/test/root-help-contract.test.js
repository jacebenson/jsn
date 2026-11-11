// Root help has two jobs and two pages:
//   * ordinary `jsn --help` is a concise task directory (common commands,
//     essential flags, three runnable examples, discovery pointers);
//   * `jsn --all-commands --help` is the exhaustive reference built from the
//     live registry, including capability-conditioned visibility.
//
// Targeted command pages, mutation safety text, machine JSON and profile
// visibility are unchanged by the short page.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildCLI } from '../src/cli.js';
import { renderHelp } from '../src/help.js';

const CLI = path.resolve('bin/jsn.js');

function freshEnv() {
  const dir = mkdtempSync(path.join(tmpdir(), 'jsn-root-help-'));
  return {
    dir,
    env: {
      ...process.env,
      HOME: dir,
      XDG_CONFIG_HOME: path.join(dir, 'config'),
      XDG_CACHE_HOME: path.join(dir, 'cache'),
      JSN_DATA_HOME: path.join(dir, 'data'),
      JSN_NO_VERSION_CHECK: '1',
      JSN_NO_SKILL_CHECK: '1',
      JSN_NO_PROMPTS: '1',
      JSN_NO_HEADER: '1',
      JSN_NO_WELCOME: '1',
    },
  };
}

function run(args) {
  const { dir, env } = freshEnv();
  try {
    return spawnSync('node', [CLI, ...args], { encoding: 'utf8', env, input: '' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const output = (result) => {
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

const fullRegistry = () => new Map(buildCLI([]).commandRegistry().commands.map((command) => [command.name, command]));

describe('ordinary root help is a concise task directory', () => {
  it('stays short and lists common commands without repeating jsn on every row', () => {
    const stdout = output(run(['--help']));
    const lines = stdout.split('\n').filter(Boolean);
    assert.ok(lines.length <= 45, `root help is ${lines.length} lines`);
    assert.ok(stdout.length <= 3000, `root help is ${stdout.length} characters`);
    assert.match(stdout, /^Usage: jsn <command> \[options\]$/m);
    assert.match(stdout, /^COMMON COMMANDS$/m);
    assert.match(stdout, /^EXAMPLES$/m);
    assert.match(stdout, /^FLAGS$/m);
    assert.match(stdout, /^MORE$/m);

    for (const name of ['incidents', 'requests', 'tasks', 'changes', 'approvals', 'knowledge', 'records', 'setup', 'discover']) {
      assert.match(stdout, new RegExp(`^  ${name}\\s{2,}\\S`, 'm'), `${name} is missing from common commands`);
    }
    // The command rows do not repeat the executable name; the pointer block
    // and the examples are the only place a full `jsn` command appears.
    const [common] = stdout.split('\nEXAMPLES\n');
    assert.doesNotMatch(common, /^ {2}jsn /m);
  });

  it('shows three runnable examples and the discovery/full-help pointers', () => {
    const stdout = output(run(['--help']));
    const examples = stdout.split('\nEXAMPLES\n')[1].split('\nFLAGS\n')[0]
      .split('\n').filter((line) => line.startsWith('  jsn '));
    assert.equal(examples.length, 3, `expected three examples:\n${examples.join('\n')}`);
    for (const pointer of [
      'jsn <command> <action> --help',
      'jsn discover <word>',
      'jsn discover --table <table>',
      'jsn --all-commands --help',
    ]) {
      assert.ok(stdout.includes(pointer), `missing pointer: ${pointer}`);
    }
    for (const flag of ['-p, --profile', '-i, --instance', '--json', '--all-commands', '--help']) {
      assert.ok(stdout.includes(flag), `missing essential flag: ${flag}`);
    }
  });

  it('wraps and aligns cleanly at a narrow terminal width', () => {
    const registry = buildCLI([]).commandRegistry({ summaries: true });
    const help = renderHelp({}, registry, { width: 60 });
    for (const line of help.split('\n')) {
      assert.ok(line.length <= 60, `line exceeds 60 columns: ${JSON.stringify(line)}`);
    }
    assert.match(help, /^COMMON COMMANDS$/m);
  });
});

describe('--all-commands --help remains the exhaustive reference', () => {
  it('names every registered root command and global option', () => {
    const registry = buildCLI([]).commandRegistry();
    // Domains is the only capability-conditioned command; enable the plugin so
    // this test can require every registration without a special case.
    const help = renderHelp({ activeProfile: 'p', profiles: { p: { domain_separation: true } } }, registry, { full: true });
    for (const command of registry.commands) {
      assert.match(help, new RegExp(`^ {2}${command.name}\\s{2,}\\S`, 'm'),
        `${command.name} is missing from full help`);
    }
    for (const option of registry.options) {
      assert.match(help, new RegExp(`^ {2}.*--${option.name}\\b`, 'm'),
        `--${option.name} is missing from full help`);
    }
    assert.match(help, /--format\s+Output format/);
    assert.match(help, /\[string: auto, json, markdown, styled, quiet, csv\]/);
  });

  it('the CLI flag reaches the full page and keeps tips/picker detail', () => {
    const stdout = output(run(['--all-commands', '--help']));
    const names = [...fullRegistry().keys()].filter((name) => name !== 'domains');
    for (const name of names) {
      assert.match(stdout, new RegExp(`^ {2}${name}\\s{2,}\\S`, 'm'), `${name} is missing`);
    }
    assert.match(stdout, /^TIPS$/m);
    assert.match(stdout, /^LEARN MORE$/m);
    assert.match(stdout, /Show every command, including admin and developer tools/);
    assert.match(stdout, /Arrow keys browse/);
  });

  it('keeps long command and flag names separated from their descriptions', () => {
    const stdout = output(run(['--all-commands', '--help']));
    assert.match(stdout, /^ {2}cataloguipolicies {2,}Manage /m);
    assert.match(stdout, /^ {2}--include-reference-links {2,}Include /m);
  });

  it('includes a command registered after the built-in catalog', () => {
    const cli = buildCLI([]);
    cli.command({ command: 'dynamicfixture', describe: 'Dynamic fixture command', handler: () => {} });
    const help = renderHelp({}, cli.commandRegistry(), { full: true });
    assert.match(help, /^ {2}dynamicfixture\s{2,}Dynamic fixture command$/m);
  });

  it('respects capability-conditioned hiding in the full reference', () => {
    const registry = buildCLI([]).commandRegistry();
    const without = renderHelp({ activeProfile: 'p', profiles: { p: {} } }, registry, { full: true });
    const withDomain = renderHelp({ activeProfile: 'p', profiles: { p: { domain_separation: true } } }, registry, { full: true });
    assert.doesNotMatch(without, /^ {2}domains\s/m);
    assert.match(withDomain, /^ {2}domains\s/m);
  });
});

describe('help cleanup leaves targeted help and machine output unchanged', () => {
  it('keeps targeted command pages and mutation safety text', () => {
    const incidents = output(run(['incidents', '--help']));
    assert.match(incidents, /^Usage: jsn incidents <command> \[options\]$/m);

    const records = output(run(['records', 'list', '--help']));
    assert.match(records, /^Usage: jsn records list \[options\]$/m);

    const updatesets = output(run(['updatesets', '--help']));
    assert.match(updatesets, /Global \+ Default mutations require approval/);
    assert.match(updatesets, /--force/);
  });

  it('keeps the machine command-discovery schema exactly as it was', () => {
    const result = output(run(['--json']));
    const envelope = JSON.parse(result);
    assert.equal(envelope.ok, true);
    assert.ok(envelope.data.commands.length > 50);
    assert.deepEqual(Object.keys(envelope.data.commands[0]).sort(), [
      'actions', 'aliases', 'command', 'description', 'discovery', 'help', 'name', 'subcommands',
    ]);
    assert.equal(envelope.data.commands[0].summary, undefined);

    const discovered = JSON.parse(output(run(['discover', 'incident', '--json'])));
    assert.deepEqual(Object.keys(discovered.data.commands[0]).sort(), [
      'actions', 'aliases', 'command', 'description', 'discovery', 'help', 'name', 'subcommands',
    ]);
    assert.equal(discovered.data.commands[0].summary, undefined);
  });
});
