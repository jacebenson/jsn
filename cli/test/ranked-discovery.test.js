import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after } from 'node:test';
import { yargs } from '../src/cli-adapter.js';
import { rankedDiscoveries, discoverCommands, discoverCmd } from '../src/commands/discover.js';
import { visibleCommandRegistry } from '../src/command-audience.js';
import { authCmd } from '../src/commands/auth.js';
import { ticketsCmd } from '../src/commands/tickets.js';
import { recordsCmd } from '../src/commands/records.js';
import { tablesCmd } from '../src/commands/_simple.js';

const home = mkdtempSync(join(tmpdir(), 'jsn-ranked-discovery-'));
after(() => rmSync(home, { recursive: true, force: true }));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SERVICENOW_')));
Object.assign(env, { HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'), JSN_DATA_HOME: join(home, 'data'),
  JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1' });

function run(...args) {
  const entry = process.env.JSN_DISCOVERY_ENTRYPOINT || fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const result = spawnSync(process.execPath, [entry, ...args], {
    encoding: 'utf8', timeout: 15000, env,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test('current update set ranks the existing context reader without changing legacy group matching', () => {
  const { data } = JSON.parse(run('discover', 'current update set', '--json'));
  assert.deepEqual(data.commands.map(command => command.name), ['updatesets']);
  assert.equal(data.results?.[0]?.invocation, 'jsn auth status --context --json');
  assert.equal(data.results[0].help, 'jsn auth status --help');
  assert.deepEqual(data.results[0].required, []);
});

const ownerCLI = () => yargs().option('json', { type: 'boolean' })
  .command(authCmd(fn => fn)).command(ticketsCmd(fn => fn))
  .command(recordsCmd(fn => fn)).command(tablesCmd(fn => fn));
const ranked = (cli, query, options = {}) => rankedDiscoveries(cli.commandRegistry({ details: true }), { query, ...options });

test('task phrases and paraphrases find existing readers and explicitly parameterized work notes', () => {
  const cli = ownerCLI();
  for (const query of ['current update set', 'selected scope', 'capture context', 'what is my current update set', 'show my active scope', 'which scope am I in']) {
    assert.equal(ranked(cli, query)[0].invocation, 'jsn auth status --context --json', query);
  }
  for (const query of ['write work note', 'add a work note', 'append work notes', 'add internal note']) {
    const result = ranked(cli, query)[0];
    assert.deepEqual(result.args, ['tickets', 'update', '<number>', '--field', 'work_notes=<text>', '--json']);
    assert.deepEqual(result.required, ['<number>', '<text>']);
  }
  for (const query of ['record history', 'who changed a record', 'audit history']) {
    const result = ranked(cli, query)[0];
    assert.equal(result.invocation, 'jsn records inspect <table> <identifier> --json');
    assert.deepEqual(result.required, ['<table>', '<identifier>']);
  }
  for (const query of ['inherited business rules', 'parent table business rules', 'business rules from ancestors']) {
    assert.equal(ranked(cli, query)[0].invocation, 'jsn tables behavior <table> --category business_rules --json');
  }
  assert.deepEqual(ranked(cli, 'current update set unicorn'), []);
  assert.deepEqual(ranked(cli, 'write work note unicorn'), []);
  assert.deepEqual(ranked(cli, 'quasar nonexistent capability'), []);
});

function widget(flag = 'trace', example = 'amber diagnosis') {
  return { command: 'widgets', aliases: ['gear'], describe: 'Widget tools',
    discovery: { table: 'x_widget', defaultColumns: ['name'], benefits: [] },
    builder: y => y.command({ command: 'tools', aliases: ['tool'], builder: y => y
      .command({ command: 'open <id>', aliases: ['look'], describe: 'Open a widget',
        examples: [{ args: [`--${flag}`, 'sample'], description: example },
          { args: ['--secret'], description: 'hiddenexample' },
          { args: ['--unknown'], description: 'staleexample' }],
        builder: y => y.option(flag, { type: 'string', describe: 'crimson telemetry' })
          .option('tenant', { type: 'string', demandOption: true })
          .option('secret', { type: 'boolean', hidden: true, describe: 'hiddenoption' }),
        handler: () => assert.fail('a suggested handler must never execute'),
      })
      .command({ command: 'concealed', hidden: true, builder: () => assert.fail('hidden descendants must not load') }),
    }),
  };
}

test('nested actions, aliases, option help and registered examples follow live replacements', () => {
  const cli = yargs().command(widget());
  const legacy = cli.commandRegistry();
  const detailed = cli.commandRegistry({ details: true });
  assert.deepEqual(detailed.commands, legacy.commands);
  assert.deepEqual(discoverCommands(detailed, { query: 'gear' }), discoverCommands(legacy, { query: 'gear' }));
  assert.deepEqual(ranked(cli, 'crimson telemetry')[0].args, ['widgets', 'tools', 'open', '<id>', '--trace', '<trace>', '--tenant', '<tenant>']);
  assert.equal(ranked(cli, 'amber diagnosis')[0].match, 'example');
  assert.equal(ranked(cli, 'gear look')[0].help, 'jsn widgets tools open --help');
  for (const query of ['hiddenoption', 'hiddenexample', 'staleexample', 'concealed']) assert.deepEqual(ranked(cli, query), []);
  cli.command(widget('probe', 'violet inspection'));
  assert.deepEqual(ranked(cli, 'amber diagnosis'), []);
  assert.ok(ranked(cli, 'crimson telemetry')[0].args.includes('--probe'));
  assert.equal(ranked(cli, 'violet inspection')[0].match, 'example');
  assert.equal(ranked(cli, 'violet inspection', { table: 'x_widget' }).length, 1);
  assert.deepEqual(ranked(cli, 'violet inspection', { table: 'widget' }), []);
});

test('ranking prioritizes exact tasks over options/actions/groups and has stable bounded ties', () => {
  const make = reverse => {
    const cli = yargs();
    const names = Array.from({ length: 12 }, (_, index) => `item${String(index).padStart(2, '0')}`);
    for (const name of reverse ? names.reverse() : names) cli.command({ command: name, describe: 'shared telemetry',
      builder: y => y.option('observe', { type: 'boolean', describe: 'shared telemetry' }), handler() {} });
    cli.command({ command: 'preferred', describe: 'Other task', discoveryTasks: [{ phrases: ['shared telemetry'], args: [], description: 'Exact task' }], handler() {} });
    return cli;
  };
  const first = ranked(make(false), 'shared telemetry');
  assert.equal(first.length, 5);
  assert.equal(first[0].invocation, 'jsn preferred');
  assert.equal(first[0].match, 'task');
  assert.deepEqual(first, ranked(make(true), 'shared telemetry'));
  assert.deepEqual(first, ranked(make(false), 'shared telemetry'));
  assert.equal(ranked(make(false), 'shared telemetry', { limit: 2 }).length, 2);
  assert.equal(ranked(make(false), '').length, 5);
});

// The real parser validates paths, choices and missing arguments. Replace only
// handlers/middleware in this fixture so none of the suggested operations run.
async function intercepted(cli, result) {
  const registry = cli.commandRegistry({ details: true });
  const entry = registry.entries.find(entry => entry.help === result.help);
  assert.ok(entry, result.help);
  const names = new Set(entry.options.flatMap(option => [option.name, ...(Array.isArray(option.alias) ? option.alias : option.alias ? [option.alias] : [])]));
  for (const token of result.args.filter(token => token.startsWith('-'))) assert.ok(names.has(token.replace(/^-+/, '').split('=')[0]), token);
  const replace = token => token.replace(/<([^>]+)>/g, (_, name) => {
    const spec = entry.options.find(option => option.name === name);
    return spec?.choices?.[0] || (spec?.type === 'number' ? '1' : 'fixture');
  });
  let seen;
  const intercept = node => {
    node.middlewares = [];
    node.definition.handler = argv => { seen = argv; };
    for (const child of node.children) intercept(child);
  };
  intercept(cli.root);
  cli.args = result.args.map(replace);
  await cli.parse();
  assert.ok(seen, result.invocation);
  assert.deepEqual(seen._, entry.path);
  return { cli, seen };
}

test('suggested task, action, option and example invocations pass real parsing with zero handler execution', async () => {
  const queries = ['current update set', 'selected scope', 'capture context', 'write work note', 'record history', 'inherited business rules', 'verification limits'];
  for (const query of queries) for (const result of ranked(ownerCLI(), query)) {
    if (result.args.includes('--help')) continue;
    await intercepted(ownerCLI(), result);
  }
  for (const query of ['crimson telemetry', 'amber diagnosis', 'gear look']) {
    for (const result of ranked(yargs().command(widget()), query)) await intercepted(yargs().command(widget()), result);
  }
  const required = ranked(yargs().command(widget()), 'crimson telemetry')[0];
  const { cli } = await intercepted(yargs().command(widget()), required);
  cli.args = ['widgets', 'tools', 'open', 'fixture', '--trace', 'fixture'];
  await assert.rejects(() => cli.parse(), /Missing required argument: --tenant/);
  cli.args = ['widgets', 'tools', 'open', '--tenant', 'fixture'];
  await assert.rejects(() => cli.parse(), /Missing required argument: id/);
});

test('stale example values and unavailable hidden required inputs never produce suggestions', () => {
  const cli = yargs().command({ command: 'analyze', describe: 'Analysis',
    examples: [
      { args: ['--mode=invalid'], description: 'invalidchoice' },
      { args: ['--limit=oops'], description: 'invalidnumber' },
    ],
    builder: y => y.option('mode', { type: 'string', choices: ['safe'], alias: 'analysis-mode' })
      .option('limit', { type: 'number' }), handler() {},
  }).command({ command: 'hiddenneed', describe: 'hiddenneed', builder: y => y.option('credential', { type: 'string', hidden: true, demandOption: true }), handler() {} });
  assert.deepEqual(ranked(cli, 'invalidchoice'), []);
  assert.deepEqual(ranked(cli, 'invalidnumber'), []);
  assert.deepEqual(ranked(cli, 'hiddenneed'), []);
  assert.ok(ranked(cli, 'analysis mode')[0].args.includes('--mode'));
});

test('audience filtering applies equally to ranked entries without changing the legacy projection', () => {
  const registry = ownerCLI().commandRegistry({ details: true });
  const config = { defaultProfile: 'fixture', profiles: { fixture: { username: 'user', instance_url: 'https://fixture.invalid',
    command_audience: { username: 'user', instance_url: 'https://fixture.invalid', mode: 'basic' } } } };
  const visible = visibleCommandRegistry(registry, config);
  assert.deepEqual(rankedDiscoveries(visible, { query: 'inherited business rules' }), []);
  assert.equal(rankedDiscoveries(visible, { query: 'capture context' })[0].invocation, 'jsn auth status --context --json');
  assert.ok(rankedDiscoveries(visibleCommandRegistry(registry, config, { allCommands: true }), { query: 'inherited business rules' }).length);
});

test('discovery is offline and read-only, with additive JSON extraction and concise human output', async () => {
  const before = readdirSync(home, { recursive: true });
  const results = JSON.parse(run('discover', 'capture context', '--json', '--get', 'data.results'));
  assert.equal(results[0].invocation, 'jsn auth status --context --json');
  const human = run('discover', 'current update set', '--styled');
  assert.match(human, /^jsn auth status --context --json\n/);
  assert.ok(human.trim().split('\n').length <= 15, 'default human output is at most five three-line suggestions');
  assert.doesNotMatch(human, /"commands"|```json/);
  assert.match(run('discover', '--table', 'incident', '--styled'), /Configured list columns/);
  assert.match(run('discover', 'capture context', '--markdown'), /jsn auth status --context --json/);
  assert.match(run('discover', 'write work note', '--markdown'), /required: <number>, <text>/);
  const help = run('discover', '--help');
  assert.match(help, /data.commands retains legacy/);
  assert.match(help, /data.results/);
  assert.match(help, /at most 5/);
  assert.deepEqual(readdirSync(home, { recursive: true }), before);
  // Directly exercise the handler with no SDK, profile or auth facilities.
  let output;
  const cli = ownerCLI();
  const definition = discoverCmd(fn => fn, () => cli.commandRegistry({ details: true }));
  await definition.handler({ query: 'write work note' }, { ok: data => { output = data; } });
  assert.equal(output.results[0].args[0], 'tickets');
});
