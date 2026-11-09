// Subcommand help pages (`jsn flows --help`) printed one unbroken line per
// entry, so a description written for the command's own page became an
// 801-column line the terminal cut off, and the usage line named the command
// without its positionals or options.
//
// Contract under test:
//   * the usage line names the subcommand placeholder and `[options]`, and a
//     leaf page keeps the positionals it declares
//   * every rendered line fits the available width
//   * subcommand rows share one label column; aliases, option types and option
//     defaults are visible
//   * long descriptions live on the command's own page (epilogue), not in the
//     parent list
//
// Offline: `--help` returns before any middleware or instance lookup.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { renderRows, renderSubcommandHelp, wrapText } from '../src/help.js';

const CLI = path.resolve('bin/jsn.js');
const ENV = {
  ...process.env,
  JSN_NO_VERSION_CHECK: '1',
  JSN_NO_SKILL_CHECK: '1',
};

function run(args) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8', env: ENV, input: '' });
}

const lines = (text) => text.split('\n').filter(Boolean);

/**
 * Command and option rows — the generated part of a help page. The epilogue is
 * authored text (command examples) and is not re-wrapped, so width checks apply
 * to these rows.
 */
function rowLines(text) {
  const rows = [];
  let inSection = false;
  for (const line of lines(text)) {
    if (/^(Commands|Options):$/.test(line)) { inSection = true; continue; }
    if (inSection && !line.startsWith(' ')) inSection = false;
    if (inSection) rows.push(line);
  }
  return rows;
}


describe('wrapText', () => {
  it('wraps at the requested width and indents continuation lines', () => {
    const wrapped = wrapText('one two three four five six seven eight', { width: 20, firstIndent: 2, indent: 4 });
    for (const line of wrapped) assert.ok(line.length <= 20, `line exceeds width: ${JSON.stringify(line)}`);
    assert.match(wrapped[0], /^ {2}one two three/);
    for (const line of wrapped.slice(1)) assert.match(line, /^ {4}\S/);
    assert.equal(wrapped.join(' ').replace(/\s+/g, ' ').trim(), 'one two three four five six seven eight');
  });

  it('keeps a token longer than the width whole instead of splitting it', () => {
    const wrapped = wrapText('security.can_write=true', { width: 8 });
    assert.deepEqual(wrapped, ['security.can_write=true']);
  });
});

describe('renderRows', () => {
  it('aligns labels and does not split an alias note across lines', () => {
    const rendered = renderRows([
      { label: 'list', description: 'List flows', note: '[aliases: ls]' },
      { label: 'executions [identifier]', description: 'Show executions', note: '[aliases: runs, contexts]' },
    ], { width: 80 });
    const rows = lines(rendered);
    assert.equal(rows[0], '  list                     List flows [aliases: ls]');
    assert.ok(rows.some((line) => line.trimEnd().endsWith('[aliases: runs, contexts]')), rendered);
    for (const line of rows) assert.ok(line.length <= 80, `line exceeds width: ${line}`);
  });
});

describe('renderSubcommandHelp', () => {
  it('omits empty sections and separates the rest with one blank line', () => {
    const page = renderSubcommandHelp({
      usage: 'Usage: jsn demo [options]',
      description: 'Demo command',
      commands: [{ label: 'run', description: 'Run it' }],
      options: [],
      width: 80,
    });
    assert.equal(page, 'Usage: jsn demo [options]\n\nDemo command\n\nCommands:\n  run  Run it\n');
  });
});

describe('jsn subcommand help', () => {
  it('names the subcommand and options in the usage line', () => {
    const { status, stdout } = run(['flows', '--help']);
    assert.equal(status, 0);
    assert.match(stdout, /^Usage: jsn flows <command> \[options\]$/m);
  });

  it('keeps a leaf page positional in the usage line', () => {
    const { status, stdout } = run(['flows', 'show', '--help']);
    assert.equal(status, 0);
    assert.match(stdout, /^Usage: jsn flows show \[identifier\] \[options\]$/m);
  });

  it('lists every subcommand within the terminal width', () => {
    const { stdout } = run(['flows', '--help']);
    const page = lines(stdout);
    for (const name of ['schemas', 'list', 'executions', 'show [identifier]', 'publish [identifier]',
      'status [identifier]', 'test [identifier]', 'doctor', 'create', 'update [identifier]',
      'unlock [identifier]', 'delete [identifier]']) {
      assert.ok(page.some((line) => line.trimStart().startsWith(name)), `missing ${name}`);
    }
    // Piped output has no terminal size, so the renderer uses its 100-column
    // cap. Before this fix `flows update` alone was an 801-column line.
    const tooWide = rowLines(stdout).filter((line) => line.length > 100);
    assert.deepEqual(tooWide, [], 'help rows must not exceed the render width');
  });

  it('shows aliases, option types and option defaults', () => {
    const parent = run(['flows', '--help']).stdout;
    assert.match(parent, /List flows \[aliases: ls\]/);
    assert.match(parent, /\[aliases: runs, contexts\]/);

    const leaf = run(['flows', 'list', '--help']).stdout;
    // Long aliases are flags, not `-fields`.
    assert.match(leaf, /--columns, -c, --fields/);
    assert.doesNotMatch(leaf, /, -[a-z]{2,}/);
    assert.match(leaf, /Max records \[number\] \[default: 50\]/);
  });

  it('keeps the long edit contract on the command page, not in the parent list', () => {
    const parent = run(['flows', '--help']).stdout;
    assert.doesNotMatch(parent, /componentIndexes/);
    const update = run(['flows', 'update', '--help']).stdout;
    assert.match(update, /stage\s+placement/);
    assert.match(update, /componentIndexes/);
    assert.match(update, /--preview/);
  });

  it('renders the same layout for a fixed table command family', () => {
    const { status, stdout } = run(['records', 'list', '--help']);
    assert.equal(status, 0);
    assert.match(stdout, /^Usage: jsn records list \[options\]$/m);
    assert.ok(rowLines(stdout).length > 0, 'records list must render its option rows');
    assert.deepEqual(rowLines(stdout).filter((line) => line.length > 100), []);
  });
});
