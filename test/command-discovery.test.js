import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { buildCLI } from '../src/cli.js';
import { discoverCommands } from '../src/commands/discover.js';
import { buildDevCmd } from '../src/commands/_generic.js';
import { buildRecordProfile } from '../src/record-profiles.js';

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
  assert.match(run('discover', '--table', 'incident', '--markdown'), /Configured list columns/);
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


test('discovery follows changed profile output and essential relationships without another command map', () => {
  const cli = buildCLI();
  const definition = { name: 'profilefixture', table: 'x_profile_fixture', aliases: [], columns: ['name'],
    output: { references: 'raw', listProjection: 'full' },
    relationships: { essential: [{ name: 'actions', table: 'x_fixture_action', foreignKey: 'parent' }] } };
  cli.command(buildRecordProfile(definition, fn => fn));
  let matches = discoverCommands(cli.commandRegistry(), { query: 'x_fixture_action' });
  assert.equal(matches.length, 1);
  assert.ok(matches[0].discovery.benefits.includes('Reference output: raw; list projection: full'));
  assert.ok(matches[0].discovery.benefits.some(value => value.includes('--no-essential')));
  assert.ok(matches[0].actions.some(action => action.help === 'jsn profilefixture show --help'));
  cli.command(buildRecordProfile({ ...definition, output: { references: 'both' },
    relationships: { essential: [{ name: 'details', table: 'x_fixture_detail', foreignKey: 'owner' }] } }, fn => fn));
  assert.equal(discoverCommands(cli.commandRegistry(), { query: 'x_fixture_action' }).length, 0);
  matches = discoverCommands(cli.commandRegistry(), { query: 'x_fixture_detail' });
  assert.equal(matches.length, 1);
  assert.ok(matches[0].discovery.benefits.includes('Reference output: both; list projection: display'));
});

test('CLI shows the configured essential UI policy action benefit', () => {
  const result = JSON.parse(run('discover', '--table', 'sys_ui_policy', '--json'));
  assert.ok(result.data.commands[0].discovery.benefits.some(value => value.includes('sys_ui_policy_action')));
  assert.match(run('discover', '--table', 'sys_ui_policy', '--markdown'), /--no-essential/);
});


test('bundled skill delegates command choice to help rather than preferring specialized commands', () => {
  const skill = readFileSync(new URL('../skills/servicenow/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /jsn discover/);
  assert.match(skill, /jsn <command> --help/);
  assert.doesNotMatch(skill, /prefer[^.\n]*(?:specialized|table-specific)[^.\n]*(?:records|REST)/i);
  assert.doesNotMatch(skill, /(?:records|REST)[^.\n]*(?:inferior|last resort)/i);
});
