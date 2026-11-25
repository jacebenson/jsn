import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCLI } from '../src/cli.js';
import { rankedDiscoveries } from '../src/commands/discover.js';

test('full live registry discovery corpus parses without executing suggested handlers', { timeout: 60000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), 'jsn-discovery-corpus-'));
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith('SERVICENOW_')) delete process.env[key];
    Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'),
      JSN_DATA_HOME: join(home, 'data'), JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1' });
    process.chdir(home);
    const cli = buildCLI();
    const registry = cli.commandRegistry({ details: true });
    const queries = new Set();
    for (const entry of registry.entries) {
      queries.add(entry.path.join(' '));
      if (entry.description) queries.add(entry.description);
      for (const option of entry.options) if (option.describe || option.description) queries.add(option.describe || option.description);
      for (const task of entry.tasks) for (const phrase of task.phrases) queries.add(phrase);
      for (const example of entry.examples) if (example.description) queries.add(example.description);
    }
    const results = new Map();
    for (const query of queries) {
      const suggestions = rankedDiscoveries(registry, { query });
      assert.ok(suggestions.length <= 5);
      assert.deepEqual(suggestions, rankedDiscoveries(registry, { query }));
      for (const result of suggestions) results.set(result.invocation, result);
    }
    let seen;
    cli.middlewares = [];
    const intercept = node => {
      node.middlewares = [];
      node.definition.handler = argv => { seen = argv; };
      for (const child of node.children) intercept(child);
    };
    intercept(cli.root);
    cli.fail(message => { throw new Error(message); });
    const failures = [];
    let parsed = 0, helpPointers = 0;
    for (const result of results.values()) {
      const entry = registry.entries.find(item => item.help === result.help);
      assert.ok(entry, result.help);
      if (result.args.includes('--help')) { helpPointers++; continue; }
      try {
        for (const token of result.args.filter(arg => arg.startsWith('-'))) {
          const key = token.replace(/^-+/, '').split('=')[0];
          assert.ok(entry.options.some(option => (option.token || option.name) === key || [].concat(option.alias || []).includes(key)
            || key.startsWith('no-') && option.type === 'boolean' && (option.token || option.name) === key.slice(3)), token);
        }
        cli.args = result.args.map(arg => arg.replace(/<([^>]+)>/g, (_, name) => {
          const spec = entry.options.find(option => option.name === name);
          return spec?.choices?.[0] || (spec?.type === 'number' ? '1' : 'fixture');
        }));
        seen = undefined;
        await cli.parse();
        assert.ok(seen, result.invocation);
        assert.deepEqual(seen._, entry.path);
        parsed++;
      } catch (error) { failures.push({ invocation: result.invocation, error: error.message }); }
    }
    t.diagnostic(JSON.stringify({ entries: registry.entries.length, queries: queries.size, suggestions: results.size, parsed, helpPointers, failures }));
    assert.deepEqual(failures, []);
    assert.deepEqual(readdirSync(home, { recursive: true }), [], 'discovery/parser verification writes no fixture state');
  } finally {
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    rmSync(home, { recursive: true, force: true });
  }
});
