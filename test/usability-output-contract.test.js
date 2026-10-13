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
// Everything here is offline: commands are chosen so they fail at parse time,
// in the middleware guard, or in a local helper — no ServiceNow calls.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import { buildCLI } from '../src/cli.js';
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
