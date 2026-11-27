import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalCLI } from '../src/cli-adapter.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Architecture invariant documented in site/docs/maintainers/domain-model.md, Lazy command family.
test('real executable loads only selected heavy families; discovery retains eager safety policy', () => {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jsn-lazy-'));
  const cliDir = fileURLToPath(new URL('../', import.meta.url));
  const trace = path.join(home, 'trace.json');
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home,
    XDG_DATA_HOME: home, XDG_CACHE_HOME: home, JSN_HERMES_BASE_DIR: home,
    JSN_TEST_MODULE_TRACE: trace, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1',
    JSN_NO_PROMPTS: '1', CI: 'true', TERM: 'dumb' };
  try {
    // Families that must stay unloaded unless the command line reaches them.
    const heavy = ['records', 'updatesets', 'auth', 'setup', 'midservers', 'docs/docs',
      '_simple', 'atf', 'catalog', 'cases', 'transactions', 'knowledge', 'decisiontables', 'scan'];
    const loadedFamilies = (modules) => new Set(modules
      .map(url => url.match(/\/commands\/(.+)\.js$/)?.[1])
      .filter(Boolean));
    for (const args of [['version', '--json'], ['--help'], ['records', 'list', '--help'], ['--profile', 'flows', 'flow', 'update', '--help']]) {
      execFileSync(process.execPath, ['--import', new URL('./fixtures/trace-modules.mjs', import.meta.url).href, 'bin/jsn.js', ...args], { cwd: cliDir, env, timeout: 15000 });
      const modules = JSON.parse(fs.readFileSync(trace, 'utf8'));
      const families = loadedFamilies(modules);
      assert.ok(!modules.some(url => /\/commands\/(midservers|docs\/[^/]+)\.js$/.test(url)), args.join(' '));
      assert.equal(modules.some(url => url.endsWith('/commands/flows.js')), args.includes('flow'));
      // A path that resolves to `records list` may load records; nothing else may.
      const reachesRecords = args[0] === 'records';
      for (const family of heavy) {
        if (reachesRecords && family === 'records') continue;
        assert.ok(!families.has(family), `${args.join(' ')} loaded ${family}`);
      }
    }
    const script = `
      const { cli } = await import('./src/cli.js');
      const { collectCapabilities } = await import('./src/capabilities.js');
      const before = Object.fromEntries(collectCapabilities());
      const registry = cli.commandRegistry();
      console.log(JSON.stringify({before, after: Object.fromEntries(collectCapabilities()), registry}));
    `;
    const inventory = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: cliDir, env, timeout: 15000 }));
    assert.deepEqual(inventory.before, inventory.after);
    assert.deepEqual(inventory.before.flows.mutationSubcommands, ['clone', 'copy', 'create', 'update', 'edit', 'delete', 'publish', 'test', 'unlock', 'settings']);
    assert.equal(inventory.before.flows.transactionScopeOption, 'scope');
    assert.deepEqual(inventory.before['skipped-updates'].mutationSubcommands, ['process']);
    assert.equal(inventory.before.midservers.mutationContext, 'operational');
    assert.ok(inventory.registry.commands.find(command => command.name === 'flows').subcommands.includes('update'));
    assert.ok(inventory.registry.commands.find(command => command.name === 'docs').description.includes('documentation'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Public adapter registration and parsing seam; no provider or personal config.
test('family implementation loads at path resolution, before aliases and required options', async () => {
  let loads = 0;
  let result;
  const cli = new LocalCLI(['--profile', 'flows', 'flow', 'edit', '--value', 'yes']);
  cli.option('profile', { type: 'string' });
  cli.command({ command: 'flows', aliases: ['flow'], load: () => {
    loads++;
    return { command: 'flows', aliases: ['flow'], builder: y => y.command({
      command: 'update', aliases: ['edit'], builder: b => b.option('value', { type: 'string', demandOption: true }),
      handler: argv => { result = argv; },
    }) };
  } });
  assert.equal(loads, 0);
  await cli.parse();
  assert.equal(loads, 1);
  assert.deepEqual(result._, ['flows', 'update']);
  assert.equal(result.profile, 'flows');
  assert.equal(result.value, 'yes');
  cli.commandRegistry();
  assert.equal(loads, 1);
});

test('root help summaries leave families unloaded; complete discovery loads them explicitly', () => {
  let loads = 0;
  const cli = new LocalCLI();
  cli.command({ command: 'heavy', describe: 'Heavy family', load: () => {
    loads++;
    return { command: 'heavy', describe: 'Heavy family', builder: y => y.command({ command: 'show' }) };
  } });
  assert.equal(cli.commandRegistry({ summaries: true, shallow: true }).commands[0].description, 'Heavy family');
  assert.equal(loads, 0);
  assert.deepEqual(cli.commandRegistry().commands[0].subcommands, ['show']);
  assert.equal(loads, 1);
});

// Every declared family's root identity is the same identity its implementation
// publishes; a deferred handler is never the source of a signature, alias or
// description that help, discovery and dispatch resolve.
test('deferred declarations match the implementations they load, before and after loading', async () => {
  const { buildCLI } = await import('../src/cli.js');
  const { collectCapabilities, mutationPaths } = await import('../src/capabilities.js');
  const cli = buildCLI();
  // Function-valued declarations (queryTable) are behavior: call them with
  // representative argv shapes so a changed rule fails even though the two
  // closures are different objects.
  const SAMPLE_ARGV = [{ _: [] }, { _: ['atf', 'suites'] }, { _: ['atf', 'results'] }, { _: ['flows', 'executions'] }];
  const materialize = value => typeof value === 'function'
    ? { fn: SAMPLE_ARGV.map(argv => value(argv)) }
    : value;
  const folded = caps => JSON.stringify(Object.fromEntries([...caps].map(([name, value]) => [name, value])),
    (key, value) => (typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, materialize(v)])) : value));
  const before = folded(collectCapabilities());
  const pathsBefore = mutationPaths().map(path => path.join(' ')).sort();
  const deferred = cli.root.children.filter(node => typeof node.definition.load === 'function');
  assert.ok(deferred.length > 0);
  for (const node of deferred) {
    const implementation = node.definition.load();
    for (const key of ['command', 'describe', 'summary']) {
      assert.equal(implementation[key] ?? '', node.definition[key] ?? '', `${node.name} ${key}`);
    }
    // A command that lists its own name as an alias publishes one token once.
    assert.deepEqual((implementation.aliases || []).filter(alias => alias !== node.name), node.aliases, `${node.name} aliases`);
  }
  // Loading implementations must not change a single capability or guard path.
  assert.equal(folded(collectCapabilities()), before);
  assert.deepEqual(mutationPaths().map(path => path.join(' ')).sort(), pathsBefore);
});

// A deferred family's mutations must be declared eagerly. If they are not, the
// guard reads an incomplete registry at buildCLI() and a read-only profile runs
// the write: this happened when `tables audit` verbs were declared only in the
// family factory.
test('a deferred family declares its mutations before it loads', async () => {
  const { buildCLI } = await import('../src/cli.js');
  const { isMutationCommand, refreshMutationCommands } = await import('../src/mutations.js');
  buildCLI();
  refreshMutationCommands();
  for (const verb of ['enable', 'disable', 'exclude', 'include', 'deletes']) {
    assert.equal(isMutationCommand({ _: ['tables', 'audit', verb, 'x_case'] }), true,
      `tables audit ${verb} must be a mutation before the tables family loads`);
  }
  assert.equal(isMutationCommand({ _: ['tables', 'audit', 'x_case'] }), false, 'the audit read stays a read');
});
