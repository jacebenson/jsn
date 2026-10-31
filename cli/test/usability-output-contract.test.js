// Regression coverage for the jsn usability fixes that landed on top of
// 4.3.7:
//
//   #2 one failure contract — usage failures exit 2 and, in JSON mode, print a
//      single parseable error envelope on stdout instead of prose on stderr
//   #3 parent discovery — machine-readable child lists, no silent parent
//      success, root help generated from the command registry
//   #4 `--get` on a missing path — structured error + nonzero exit, while a
//      present null/false/0/"" still round-trips
//   #6 duplicate registration — the layered (enriched) handler wins, aliases
//      and help follow the handler that actually dispatches
//
// Plus the follow-up blockers found in the post-merge review of #264:
//   * the handler-less parent discovery callback now renders its failures
//     through wrap() instead of rejecting parse()
//   * the format a failure renders in is resolved ONCE (adapter tokens +
//     resolveRequestedFormat), so the stream/shape cannot depend on whether
//     parse-time or the handler rejected the command
//   * root discovery (bare `jsn --json`) honours --get
//   * a registration collision always leaves exactly one owner per token
//
// Everything here is offline: commands are chosen so they fail at parse time,
// in the middleware guard, or in a local helper — no ServiceNow calls.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import { buildCLI, resolveRequestedFormat } from '../src/cli.js';
import { renderHelp } from '../src/help.js';
import { yargs } from '../src/cli-adapter.js';
import { OutputWriter, FormatJSON, FormatStyled, resolvePath } from '../src/output.js';
import { CodeExtractionNotFound } from '../src/errors.js';
import { requestsCmd } from '../src/commands/requests.js';
import { wrapHandler } from './support/command-test-helpers.js';

const CLI = path.resolve('bin/jsn.js');
// Scratch HOME/XDG + all three disable flags: no real profile, no keyring, no
// network, no prompt.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-usability-'));
const ENV = {
  ...process.env,
  HOME: SCRATCH,
  XDG_CONFIG_HOME: path.join(SCRATCH, 'config'),
  XDG_CACHE_HOME: path.join(SCRATCH, 'cache'),
  JSN_NO_PROMPTS: '1',
  JSN_NO_VERSION_CHECK: '1',
  JSN_NO_SKILL_CHECK: '1',
};
delete ENV.SERVICENOW_INSTANCE_URL;
delete ENV.SERVICENOW_FORMAT;

/** Run the real binary, always through a pipe (so `auto` resolves to JSON). */
function run(args) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8', env: ENV, input: '' });
}

/** Build the CLI in-process to inspect the registry it actually registers. */
function buildRegistry() {
  const cli = buildCLI();
  return { cli, registry: cli.commandRegistry() };
}

function writerFor(format) {
  let text = '';
  const writer = new Writable({ write(chunk, _enc, cb) { text += chunk.toString(); cb(); } });
  return { output: new OutputWriter({ format, writer }), text: () => text };
}

describe('#2 usage failures have one contract: exit 2 + structured JSON', () => {
  const cases = [
    { name: 'missing required option', args: ['records', 'list'] },
    { name: 'missing required positional', args: ['incidents', 'show'] },
    { name: 'invalid number', args: ['incidents', 'list', '--limit', 'NaN'] },
    { name: 'invalid choice', args: ['records', 'list', '--table', 'incident', '--format', 'xml'] },
    { name: 'unknown command', args: ['definitely-not-a-command'] },
  ];

  for (const { name, args } of cases) {
    it(`${name}: --json prints one parseable error object, exit 2, empty stderr`, () => {
      const result = run([...args, '--json']);
      assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout} ${result.stderr}`);
      assert.equal(result.stderr, '', 'machine mode must not write prose to stderr');
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.ok, false, 'a failure must not look like a success');
      assert.equal(envelope.code, 'usage_error');
      assert.equal(typeof envelope.error, 'string');
      assert.ok(envelope.error.length > 0, 'the error must say what was wrong');
      assert.equal(typeof envelope.hint, 'string');
      assert.ok(envelope.hint.length > 0, 'a usage failure must point at the help for the command');
    });
  }

  it('human mode keeps readable prose on stderr and exits 2', () => {
    const result = run(['records', 'list', '--format=styled']);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Error \(usage\): Missing required argument: --table/);
    assert.match(result.stderr, /Hint: Run "jsn records list --help" for usage\./);
  });

  it('a handler-thrown usage error (missing instance) matches the parse-time contract', () => {
    const result = run(['records', 'list', '--table', 'incident', '--json']);
    assert.equal(result.status, 2, `expected guard exit 2, got ${result.status}: ${result.stderr}`);
    assert.equal(result.stderr, '');
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, 'usage_error');
    assert.match(envelope.error, /Instance URL required/);
  });

  it('the mutation guard keeps its structured, non-zero read-only failure', () => {
    // No instance configured, so this fails in the require-instance guard
    // before any SDK call could happen.
    const result = run(['records', 'create', '--table', 'incident', '--json']);
    assert.equal(result.status, 2, `expected exit 2, got ${result.status}: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, 'usage_error');
    assert.equal(result.stderr, '');
  });

  it('successful JSON output is unchanged (no regression to the envelope)', () => {
    const result = run(['version', '--json']);
    assert.equal(result.status, 0);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    assert.ok(envelope.data.version);
  });
});

describe('#3 parent commands are machine-readable and never silently succeed', () => {
  const parents = ['cmdb', 'platform', 'records', 'docs'];

  for (const parent of parents) {
    it(`${parent} --json returns structured child signatures`, () => {
      const result = run([parent, '--json']);
      assert.equal(result.status, 0, `${parent}: ${result.stdout} ${result.stderr}`);
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.ok, true);
      assert.equal(envelope.data.command, parent);
      assert.ok(Array.isArray(envelope.data.subcommands) && envelope.data.subcommands.length > 0,
        `${parent} must advertise its subcommands`);
      for (const child of envelope.data.subcommands) {
        assert.equal(typeof child.name, 'string');
        assert.equal(typeof child.description, 'string');
        assert.ok(Array.isArray(child.aliases));
      }
    });
  }

  it('a handler-less parent no longer exits 0 with no output', () => {
    // cmdb and platform declared no default handler: both used to exit 0
    // printing nothing at all.
    for (const parent of ['cmdb', 'platform']) {
      const result = run([parent, '--json']);
      assert.notEqual(result.stdout.trim(), '', `${parent} produced no output`);
    }
  });

  it('parent discovery lists exactly the registered children', () => {
    const { registry } = buildRegistry();
    const byName = new Map(registry.commands.map((command) => [command.name, command]));
    for (const parent of ['cmdb', 'platform', 'records']) {
      const result = run([parent, '--json']);
      const names = JSON.parse(result.stdout).data.subcommands.map((child) => child.name).sort();
      assert.deepEqual(names, [...byName.get(parent).subcommands].sort(),
        `${parent} discovery disagrees with the registry`);
    }
  });

  it('every registered root command appears in the grouped root help', () => {
    const { registry } = buildRegistry();
    // Capability-conditioned hiding (domains) is the ONLY allowed omission, so
    // compare with the capability present and then confirm the omission itself.
    const config = { activeProfile: 'p', profiles: { p: { domain_separation: true } } };
    const help = renderHelp(config, registry);
    const missing = registry.commands.filter((command) => !help.includes(`jsn ${command.name}`));
    assert.deepEqual(missing.map((command) => command.name), [],
      'root help dropped a registered command (it must land in a group or MORE)');
    const hidden = registry.commands.filter((command) => !renderHelp({}, registry).includes(`jsn ${command.name}`));
    assert.deepEqual(hidden.map((command) => command.name), ['domains'],
      'only the capability-conditioned command may be omitted');
  });

  it('capability-conditioned hiding is preserved (domains)', () => {
    const { registry } = buildRegistry();
    const withoutDS = renderHelp({ activeProfile: 'p', profiles: { p: {} } }, registry);
    assert.ok(!withoutDS.includes('jsn domains'), 'domains must stay hidden without the plugin');
    const withDS = renderHelp({ activeProfile: 'p', profiles: { p: { domain_separation: true } } }, registry);
    assert.ok(withDS.includes('jsn domains'), 'domains must appear when the profile has it');
  });

  it('global flags are generated from the registry (--get and --csv were missing)', () => {
    const { registry } = buildRegistry();
    const help = renderHelp({}, registry);
    for (const flag of ['--instance', '--profile', '--format', '--json', '--csv', '--get', '--quiet', '--styled', '--markdown', '--help']) {
      assert.ok(help.includes(flag), `root help is missing ${flag}`);
    }
    assert.match(help, /--format\s+.*\[string: auto, json, markdown, styled, quiet, csv\]/);
  });

  it('explicit --help stays human readable (no JSON envelope)', () => {
    const result = run(['records', '--help']);
    assert.equal(result.status, 0);
    assert.ok(!result.stdout.trimStart().startsWith('{'), '--help must not print JSON');
    assert.match(result.stdout, /Usage: jsn records/);
  });

  it('bare jsn with --json answers with the registry instead of prose', () => {
    const result = run(['--json']);
    assert.equal(result.status, 0);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    assert.ok(Array.isArray(envelope.data.commands) && envelope.data.commands.length > 50);
    assert.ok(envelope.data.commands.every((command) => typeof command.name === 'string'));
  });

  it('bare jsn without --json still prints the grouped help and exits 0', () => {
    const result = run([]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: jsn <command> \[options\]/);
  });
});

describe('#4 --get distinguishes a missing path from a present falsy value', () => {
  it('a missing path fails with a structured error and nonzero exit', () => {
    const result = run(['version', '--get', 'data.not_a_key']);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, CodeExtractionNotFound);
    assert.match(envelope.error, /data\.not_a_key/);
  });

  it('a resolvable path still extracts the value', () => {
    const result = run(['version', '--get', 'data.version']);
    assert.equal(result.status, 0);
    const version = JSON.parse(result.stdout);
    assert.match(version, /^\d+\.\d+\.\d+/);
  });

  it('out-of-range array indexes are failures, not undefined values', () => {
    const result = run(['version', '--get', 'data.records.7.number']);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).code, CodeExtractionNotFound);
  });

  it('a present null, false, 0, or empty string is still returned as-is', () => {
    const values = { data: { nothing: null, disabled: false, count: 0, empty: '', list: [null, false, 0, ''] , zero: { deep: 0 } } };
    for (const [expected, key] of [[null, 'nothing'], [false, 'disabled'], [0, 'count'], ['', 'empty'], [0, 'list.2'], [0, 'zero.deep']]) {
      const { output, text } = writerFor(FormatJSON);
      output.setJqFilter(`data.${key}`);
      output.ok(values.data);
      assert.deepEqual(JSON.parse(text()), expected, `${key} must round-trip`);
    }
  });

  it('the styled/human path keeps a readable error when --get misses', () => {
    const { output, text } = writerFor(FormatStyled);
    output.setJqFilter('data.nope');
    assert.throws(() => output.ok({ version: '1' }), /extraction_not_found|No value at --get path/);
    assert.equal(text(), '', 'nothing should be written for a failed extraction');
    // resolvePath itself is unchanged for present values.
    assert.equal(resolvePath({ data: { zero: 0 } }, 'data.zero'), 0);
    assert.equal(resolvePath({ data: {} }, 'data.missing'), undefined);
  });
});

describe('#6 a re-registered command replaces the earlier definition', () => {
  it('the adapter dispatches the last registration and keeps the earlier aliases', async () => {
    const seen = [];
    await yargs(['widgets', 'show', '1'])
      .command({
        command: 'widgets',
        builder: (y) => y
          .command({ command: 'show <id>', aliases: ['get'], describe: 'base', handler: () => seen.push('base') })
          .command({ command: 'show <id>', aliases: ['view'], describe: 'enriched', handler: () => seen.push('enriched') }),
      })
      .parse();
    assert.deepEqual(seen, ['enriched'], 'the last registration must win the slot');

    const registrySeen = [];
    await yargs(['widgets', 'get', '1'])
      .command({
        command: 'widgets',
        builder: (y) => y
          .command({ command: 'show <id>', aliases: ['get'], describe: 'base', handler: () => registrySeen.push('base') })
          .command({ command: 'show <id>', aliases: ['view'], describe: 'enriched', handler: () => registrySeen.push('enriched') }),
      })
      .parse();
    assert.deepEqual(registrySeen, ['enriched'], 'an alias published by the base registration must resolve to the replacement');
  });

  it('the real registry has no duplicate canonical path and a single requests show', () => {
    const { cli } = buildRegistry();
    const paths = [];
    const walk = (node, prefix) => {
      node.build();
      for (const child of node.children.filter((c) => c.name !== '__completion')) {
        const full = `${prefix}${child.name}`;
        paths.push(full);
        walk(child, `${full} `);
      }
    };
    for (const root of cli.root.children.filter((c) => c.name !== '__completion')) {
      paths.push(root.name);
      walk(root, `${root.name} `);
    }
    const counts = new Map();
    for (const p of paths) counts.set(p, (counts.get(p) || 0) + 1);
    assert.deepEqual([...counts].filter(([, n]) => n > 1), [], 'duplicate canonical paths must not exist');

    const requests = cli.root.children.find((c) => c.name === 'requests');
    requests.build();
    const show = requests.children.filter((c) => c.name === 'show');
    assert.equal(show.length, 1);
    assert.match(show[0].definition.describe, /attachments and catalog variables/);
  });

  it('help and dispatch both describe the handler that runs', () => {
    const result = run(['requests', 'show', '--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Show a specific request with attachments and catalog variables/);
    assert.doesNotMatch(result.stdout, /Show a specific requests/);
  });

  it('the enriched requests show handler is what dispatches (attachments + variables)', async () => {
    const record = { sys_id: 'abc123', number: 'RITM0010001' };
    const calls = [];
    const envelopes = [];
    const app = {
      sdk: {
        list: async (table) => { calls.push(`list:${table}`); return [record]; },
        fetchAttachments: async () => { calls.push('attachments'); return [{ file_name: 'a.txt' }]; },
        fetchCatalogVariables: async () => { calls.push('variables'); return [{ question: 'q', value: 'v' }]; },
      },
      getEffectiveInstance: () => 'https://example.service-now.com',
      ok: (data, opts) => envelopes.push({ data, opts }),
    };
    await yargs(['requests', 'show', 'RITM0010001'])
      .command(requestsCmd(wrapHandler))
      .middleware((argv) => { argv.app = app; })
      .parse();
    assert.deepEqual(calls, ['list:sc_req_item', 'attachments', 'variables']);
    assert.equal(envelopes.length, 1);
    assert.deepEqual(envelopes[0].data._attachments, [{ file_name: 'a.txt' }]);
    assert.deepEqual(envelopes[0].data._variables, [{ question: 'q', value: 'v' }]);
  });
});

// ── Follow-up review of #264: the format a failure renders in is one policy ──
//
// Two layers can reject the same command line: the parser (missing required
// option) and the handler/middleware guard (no instance configured). Same
// formatting arguments, so the same stream and shape — the caller cannot tell
// which layer said no.
describe('#264 follow-up: parse-time and handler-time failures agree on formatting', () => {
  // `records list <flags>` fails at parse time (--table is required);
  // `records list --table incident <flags>` fails in the handler (no instance).
  const cases = [
    { flags: ['--json'], shape: 'json' },
    { flags: ['--format', 'json'], shape: 'json' },
    { flags: ['--json', '--styled'], shape: 'human' }, // styled is applied last
    { flags: ['--styled=true'], shape: 'human' },
    { flags: ['--format=json', '--format=styled'], shape: 'human' }, // last wins
    { flags: ['--styled', '--', '--json'], shape: 'human' }, // --json is positional data
    { flags: ['--styled', '--get', '--json'], shape: 'human' }, // --json is --get's value
    { flags: ['--json', '--no-json', '--styled'], shape: 'human' }, // negated, then styled
    { flags: ['--csv'], shape: 'human' },
  ];

  for (const { flags, shape } of cases) {
    it(`jsn records list ${flags.join(' ')} renders the same in both layers`, () => {
      const parseTime = run(['records', 'list', ...flags]);
      const handlerTime = run(['records', 'list', '--table', 'incident', ...flags]);

      for (const [layer, result] of [['parse-time', parseTime], ['handler-time', handlerTime]]) {
        assert.equal(result.status, 2, `${layer}: want exit 2, got ${result.status} — ${result.stdout} ${result.stderr}`);
        if (shape === 'json') {
          assert.equal(result.stderr, '', `${layer}: machine mode must not write prose to stderr`);
          const envelope = JSON.parse(result.stdout);
          assert.equal(envelope.ok, false, `${layer}: a failure must not look like a success`);
          assert.equal(envelope.code, 'usage_error', `${layer}: ${result.stdout}`);
        } else {
          assert.equal(result.stdout, '', `${layer}: human mode must not write an envelope to stdout`);
          assert.match(result.stderr, /^Error \(usage\): /, `${layer}: ${result.stderr}`);
        }
      }

      // The pair must be indistinguishable on the streams, not just individually valid.
      assert.equal(parseTime.stdout === '', handlerTime.stdout === '',
        'stdout presence must not depend on the rejecting layer');
      assert.equal(parseTime.stderr === '', handlerTime.stderr === '',
        'stderr presence must not depend on the rejecting layer');
    });
  }

  it('the adapter resolves global flags with the parser, not a raw token scan', () => {
    const cli = yargs([]).options({
      json: { type: 'boolean' },
      quiet: { type: 'boolean', alias: 'q' },
      csv: { type: 'boolean' },
      markdown: { type: 'boolean' },
      styled: { type: 'boolean' },
      format: { type: 'string' },
      get: { type: 'string' },
    });

    const resolve = (args) => resolveRequestedFormat(cli.parseGlobalOptions(args));
    assert.equal(resolve(['--json']), 'json');
    assert.equal(resolve(['--json', '--styled']), 'styled', 'last shortcut applied wins');
    assert.equal(resolve(['--styled=true']), 'styled');
    assert.equal(resolve(['--format=json', '--format=styled']), 'styled', 'repeated --format: last wins');
    assert.equal(resolve(['--styled', '--', '--json']), 'styled', '-- ends the options');
    assert.equal(resolve(['--styled', '--get', '--json']), 'styled', '--json is --get\'s value');
    assert.equal(resolve(['--json', '--no-json', '--styled']), 'styled', '--no-json negates');
    assert.equal(resolve(['--json=false']), '', 'a negated boolean is not a request');
    assert.equal(resolve(['--format', 'json']), 'json');
    assert.equal(resolve(['-q']), 'quiet');

    // A value error is the failure being rendered; it must not abort resolution.
    const bad = cli.parseGlobalOptions(['records', 'list', '--table', 'incident', '--format', 'xml', '--json']);
    assert.equal(resolveRequestedFormat(bad), 'json');
  });
});

// ── Follow-up review of #264: the handler-less parent discovery is wrapped ───
describe('#264 follow-up: discovery failures use the shared error renderer', () => {
  it('a genuinely handler-less parent fails --get misses with the extraction envelope', () => {
    // cmdb and platform gained explicit handlers in the reviewed change, so they
    // no longer exercise the adapter's fallback. This parent has no handler of
    // its own — if that stops being true the assertion below fails loudly rather
    // than quietly testing the wrong path.
    const { cli } = buildRegistry();
    const records = cli.root.children.find((command) => command.name === 'records');
    records.build();
    const attachments = records.children.find((command) => command.name === 'attachments');
    assert.equal(attachments.definition.handler, undefined,
      'records attachments must stay handler-less for this regression to cover the fallback');
    attachments.build();
    assert.ok(attachments.children.length > 0);

    const miss = run(['records', 'attachments', '--json', '--get', 'data.nope']);
    assert.equal(miss.status, 1, `want exit 1 — ${miss.stdout} ${miss.stderr}`);
    assert.doesNotMatch(miss.stderr, /at LocalCLI|AppError:/, 'a miss must not print a Node stack');
    const envelope = JSON.parse(miss.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, CodeExtractionNotFound);
    assert.match(envelope.error, /data\.nope/);

    const hit = run(['records', 'attachments', '--json', '--get', 'data.command']);
    assert.equal(hit.status, 0, `${hit.stdout} ${hit.stderr}`);
    assert.equal(JSON.parse(hit.stdout), 'records attachments');
  });

  it('the handler-less parent still answers with its discovery envelope', () => {
    const result = run(['records', 'attachments', '--json']);
    assert.equal(result.status, 0, `${result.stdout} ${result.stderr}`);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.command, 'records attachments');
    assert.deepEqual(envelope.data.subcommands.map((child) => child.name), ['list', 'get', 'add']);
  });
});

// ── Follow-up review of #264: the new root discovery shape honours --get ─────
describe('#264 follow-up: root discovery extraction', () => {
  it('extracts a value from the root discovery envelope', () => {
    const result = run(['--json', '--get', 'data.commands.0.name']);
    assert.equal(result.status, 0, `${result.stdout} ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout), 'setup');
    assert.equal(result.stderr, '');
  });

  it('a miss is an extraction failure, not the whole envelope', () => {
    const result = run(['--json', '--get', 'data.nope']);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, CodeExtractionNotFound);
    assert.match(envelope.error, /data\.nope/);
  });

  it('root discovery resolves flags with the same policy as the middleware', () => {
    // --format=json still asks for the machine surface…
    const viaFormat = run(['--format=json']);
    assert.equal(viaFormat.status, 0);
    assert.equal(JSON.parse(viaFormat.stdout).ok, true);
    // …and a later --styled wins over --json, exactly as it would for a command.
    const styled = run(['--json', '--styled']);
    assert.equal(styled.status, 0);
    assert.ok(!styled.stdout.trimStart().startsWith('{'), 'styled wins, so no envelope');
    assert.match(styled.stdout, /Usage: jsn <command>/);
  });
});

// ── Follow-up review of #264 (optional): one owner per command token ─────────
describe('#264 follow-up: a command token has exactly one owner', () => {
  const register = (argv, definitions) => {
    let cli = yargs(argv);
    for (const definition of definitions) cli = cli.command(definition);
    return cli;
  };
  const tokensOf = (cli) => {
    const owned = new Map();
    for (const node of cli.root.children) {
      owned.set(node.name, node.name);
      for (const alias of node.aliases) owned.set(alias, node.name);
    }
    return owned;
  };

  it('a shared alias belongs to the later registration, and both commands stay reachable', async () => {
    const defs = [
      { command: 'alpha', aliases: ['x'], handler: () => {} },
      { command: 'beta', aliases: ['x'], handler: () => {} },
    ];
    const owned = tokensOf(register([], defs));
    assert.equal(owned.get('x'), 'beta', 'the later registration owns the shared alias');
    assert.equal(owned.get('alpha'), 'alpha', 'the earlier command keeps its canonical name');

    const dispatch = async (argv) => {
      const seen = [];
      await register(argv, defs.map((def) => ({ ...def, handler: () => seen.push(def.command) }))).parse();
      return seen;
    };
    assert.deepEqual(await dispatch(['x']), ['beta']);
    assert.deepEqual(await dispatch(['alpha']), ['alpha']);
  });

  it('a canonical name that was another command alias replaces it without self-aliasing', () => {
    const cli = register([], [
      { command: 'alpha', aliases: ['x'], handler: () => {} },
      { command: 'x', handler: () => {} },
    ]);
    assert.deepEqual(cli.root.children.map((node) => node.name), ['x']);
    assert.deepEqual(cli.root.children[0].aliases, [], 'x must not be its own alias');
  });

  it('a declared self-alias is dropped', () => {
    const cli = register([], [{ command: 'widgets', aliases: ['widgets', 'w'], handler: () => {} }]);
    assert.deepEqual(cli.root.children[0].aliases, ['w']);
  });

  it('the real registry publishes every command token exactly once', () => {
    const { cli } = buildRegistry();
    const tokens = [];
    const walk = (node, prefix) => {
      node.build();
      for (const child of node.children.filter((c) => c.name !== '__completion')) {
        tokens.push(prefix + child.name);
        for (const alias of child.aliases) tokens.push(prefix + alias);
        walk(child, `${prefix}${child.name} `);
      }
    };
    walk(cli.root, '');
    const duplicates = [...new Set(tokens.filter((token, index) => tokens.indexOf(token) !== index))];
    assert.deepEqual(duplicates, [], 'a token that resolves to two commands is a dispatch bug');
  });
});
