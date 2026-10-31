import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { yargs } from '../src/cli-adapter.js';

describe('local CLI adapter', () => {
  it('supports nested commands, aliases, typed options, defaults, and positionals', async () => {
    const seen = [];
    const cli = yargs(['users', 'ls', '--limit', '3', '-c', 'name', 'alice'])
      .option('verbose', { type: 'boolean', default: false })
      .command({
        command: 'users [subcommand]', aliases: ['user'],
        builder: (y) => y.command({
          command: 'list [name]', aliases: ['ls'],
          builder: (y) => y.option('limit', { alias: 'l', type: 'number', default: 20 })
            .option('columns', { alias: ['c', 'fields'], type: 'string' }),
          handler: (argv) => { seen.push(argv); },
        }),
      });
    await cli.parse();
    assert.equal(seen[0].limit, 3);
    assert.equal(seen[0].columns, 'name');
    assert.equal(seen[0].name, 'alice');
    assert.deepEqual(seen[0]._, ['users', 'list']);
    assert.equal(seen[0].verbose, false);
  });

  it('supports --no booleans and demandOption failures', async () => {
    const seen = [];
    const cli = yargs(['run', '--no-wait'])
      .command({ command: 'run', builder: (y) => y.option('wait', { type: 'boolean', default: true }), handler: (argv) => seen.push(argv) });
    await cli.parse();
    assert.equal(seen[0].wait, false);

    const failures = [];
    await yargs(['create']).command({ command: 'create', builder: (y) => y.option('name', { type: 'string', demandOption: true }), handler: () => {} }).fail((msg) => failures.push(msg)).parse();
    assert.match(failures[0], /--name/);
  });

  it('preserves repeated array options as a flat array', async () => {
    let seen;
    await yargs(['catalogitems', 'create', '--name', 'Laptop', '--variable', 'model:string:Model', '-v', 'serial:string:Serial'])
      .command({ command: 'catalogitems', builder: (y) => y.command({
        command: 'create',
        builder: (y) => y.option('name', { type: 'string' }).option('variable', { alias: 'v', type: 'array' }),
        handler: (argv) => { seen = argv; },
      }) })
      .parse();
    assert.deepEqual(seen.variable, ['model:string:Model', 'serial:string:Serial']);
    assert.deepEqual(seen.v, seen.variable);
  });

  it('coerces boolean equals values for names, aliases, and negated names', async () => {
    const seen = [];
    for (const args of [['--json=false'], ['--json=true'], ['-j=false'], ['--no-json'], ['--no-json=false'], ['--no-json=true']]) {
      await yargs(['run', ...args])
        .command({ command: 'run', builder: (y) => y.option('json', { alias: 'j', type: 'boolean' }), handler: (argv) => seen.push(argv.json) })
        .parse();
    }
    assert.deepEqual(seen, [false, true, false, false, true, false]);
  });

  it('consumes global option values while discovering a nested command path', async () => {
    const seen = [];
    await yargs(['--profile', 'dev', 'records', 'list'])
      .option('profile', { type: 'string' })
      .command({ command: 'records', builder: (y) => y.command({
        command: 'list', handler: (argv) => seen.push(argv),
      }) })
      .parse();
    assert.equal(seen[0].profile, 'dev');
    assert.deepEqual(seen[0]._, ['records', 'list']);
  });

  it('renders nested help with the complete command path', async () => {
    const output = [];
    const original = process.stdout.write;
    process.stdout.write = (text) => { output.push(text); return true; };
    try {
      await yargs(['records', 'list', '--help'])
        .command({ command: 'records', builder: (y) => y.command({ command: 'list', handler: () => {} }) })
        .parse();
    } finally {
      process.stdout.write = original;
    }
    assert.match(output.join(''), /Usage: jsn records list/);
  });

  it('calls the registered completion callback with yargs-compatible arguments', async () => {
    let call;
    await yargs(['--get-yargs-completions', 'jsn', 'r'])
      .command({ command: 'records' })
      .completion('__completion', false, (current, argv, completionFilter, finish) => {
        call = { current, argv, completionFilter };
        completionFilter((err, values) => finish([...values, 'custom']));
      })
      .parse();
    assert.equal(call.current, 'r');
    assert.deepEqual(call.argv._, []);
    assert.equal(typeof call.completionFilter, 'function');
  });

  it('rejects invalid choices and numeric values', async () => {
    const failures = [];
    let handled = false;
    await yargs(['run', '--format', 'xml', '--limit', 'nope'])
      .option('format', { type: 'string', choices: ['json'] })
      .command({ command: 'run', builder: (y) => y.option('limit', { type: 'number' }), handler: () => { handled = true; } })
      .fail((message) => failures.push(message))
      .parse();
    assert.equal(handled, false);
    assert.match(failures.join('\\n'), /Invalid value for --format|Invalid number for --limit/);
  });

  it('supports help targeting by command name', async () => {
    const output = [];
    const original = process.stdout.write;
    process.stdout.write = (text) => { output.push(text); return true; };
    try {
      await yargs(['help', 'records'])
        .command({ command: 'records', describe: 'Record commands' })
        .parse();
    } finally {
      process.stdout.write = original;
    }
    assert.match(output.join(''), /Usage: jsn records/);
    assert.match(output.join(''), /Record commands/);
  });
});
