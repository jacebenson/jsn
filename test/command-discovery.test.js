import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { buildCLI } from '../src/cli.js';
import { discoverCommands } from '../src/commands/discover.js';
import { buildDevCmd } from '../src/commands/_generic.js';

const env = { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1' };
function run(...args) {
  const result = spawnSync(process.execPath, ['bin/jsn.js', ...args], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test('new and replaced registrations automatically change intent discovery', () => {
  const cli = buildCLI();
  const wrap = fn => fn;
  cli.command(buildDevCmd('newwidgets', 'x_example_widget', ['widgetalias'], ['name', 'active'], wrap));
  let matches = discoverCommands(cli.commandRegistry(), { query: 'widgetalias' });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].discovery.table, 'x_example_widget');
  assert.deepEqual(matches[0].discovery.defaultColumns, ['name', 'active']);
  assert.equal(matches[0].actions.find(action => action.name === 'show').help, 'jsn newwidgets show --help');
  cli.command({ command: 'newwidgets', describe: 'Replacement description' });
  assert.equal(discoverCommands(cli.commandRegistry(), { query: 'widgetalias' })[0].description, 'Replacement description');
  matches = discoverCommands(cli.commandRegistry(), { query: 'replacement description' });
  assert.equal(matches[0].discovery, null);
});

test('live discovery searches action descriptions including enriched request views', () => {
  const commands = discoverCommands(buildCLI().commandRegistry(), { query: 'attachments catalog variables' });
  assert.ok(commands.some(command => command.name === 'requests'));
  assert.ok(commands.find(command => command.name === 'requests').actions.some(action => action.help === 'jsn requests show --help'));
});

test('CLI discovery supports JSON, extraction, text, exact table filtering and custom table fallback', () => {
  const envelope = JSON.parse(run('discover', '--table', 'incident', '--json'));
  assert.deepEqual(envelope.data.commands.map(command => command.name), ['incidents']);
  assert.equal(JSON.parse(run('discover', '--table', 'incident', '--json', '--get', 'data.commands[0].help')), 'jsn incidents --help');
  const human = run('discover', '--table', 'incident', '--styled');
  assert.match(human, /^incidents: Manage incidents/);
  assert.match(human, /Configured list columns/);
  assert.doesNotMatch(human, /_formatted/);
  assert.match(run('discover', '--table', 'x_unknown', '--markdown'), /jsn records list --help/);
  assert.match(run('discover', '--help'), /Cross-table tasks: jsn records list --table task/);
  assert.match(run('discover', '--help'), /jsn rest --help/);
});

test('root help avoids the inaccurate universal picker/query claim and explains discovery', () => {
  const help = run('--help');
  assert.match(help, /jsn discover --table incident/);
  assert.match(help, /Some list commands offer a picker/);
  assert.match(help, /search fields vary by command/);
  assert.doesNotMatch(help, /--query is available on every list command/);
});
