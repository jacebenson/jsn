import assert from 'node:assert/strict';
import { getVersion } from '../../src/commands/version.js';
import { assertCommand, classifyCommand, ScenarioError } from '../../scripts/acceptance/support.mjs';

const common = { modes: ['readonly', 'pdi'], mutates: false, requires: [] };
const data = result => {
  classifyCommand(result); assertCommand(result, { json: true });
  assert.equal(result.json.ok, true);
  return result.json.data;
};
export const scenarios = [
  { ...common, id: 'local.version', title: 'Installed CLI version in JSON and human formats', commandPaths: ['version'], sources: ['cli/src/commands/version.js'],
    async run(ctx) {
      const value = data(await ctx.command(['version', '--json']));
      assert.equal(value.version, getVersion(), 'CLI-reported version differs from checked-out package');
      assertCommand(await ctx.command(['version']), { human: /\d+\.\d+\.\d+/ });
    } },
  { ...common, id: 'local.completion', title: 'Generate usable shell completion without installing it', commandPaths: ['completion'], sources: ['cli/src/cli-adapter.js'],
    async run(ctx) {
      const result = assertCommand(await ctx.command(['completion']));
      assert.match(result.stdout, /complete|compdef|compgen/);
      assert.match(result.stdout, /jsn/);
    } },
  { ...common, id: 'local.history-empty', title: 'Read isolated empty mutation history', commandPaths: ['history list'], sources: ['cli/src/commands/history.js', 'cli/src/mutation-history.js'],
    async run(ctx) {
      const value = data(await ctx.command(['history', 'list', '--json', '--limit', '1']));
      const serialized = JSON.stringify(value);
      assert.ok(serialized.includes('[]') || Array.isArray(value) && value.length === 0, 'history must be isolated and empty');
    } },
  { ...common, id: 'local.parser-rejection', title: 'Actual CLI rejects missing required table', commandPaths: ['records list'], sources: ['cli/src/commands/records.js', 'cli/src/cli-adapter.js'],
    async run(ctx) {
      for (const args of [['records', 'list', '--json']]) {
        const result = await ctx.command(args);
        assert.notEqual(result.exitCode, 0, 'invalid invocation unexpectedly succeeded');
        assert.notEqual(result.json, undefined, 'usage failure must be JSON');
        assert.equal(result.json.ok, false);
        assert.match(JSON.stringify(result.json), /table|unknown|argument|option/i);
      }
    } },
  { ...common, modes: ['pdi'], id: 'local.output-contract', title: 'Shared --format contract across local and docs commands', commandPaths: ['version', 'history list', 'discover', 'docs', 'docs status'], sources: ['cli/src/cli-adapter.js', 'cli/src/output.js'],
    async run(ctx) {
      const expected = {
        'version': value => `jsn ${value.version}`,
        'history list': () => 'entries',
        'discover': value => `${value.commands.length} matching command`,
        'docs': () => 'Search ServiceNow documentation',
        'docs status': value => `Documentation service: ${value.state}`
      };
      for (const [command, marker] of Object.entries(expected)) {
        const args = command.split(' ');
        const explicit = data(await ctx.command([...args, '--format', 'json']));
        const auto = await ctx.command(args);
        assertCommand(auto, { json: true });
        assert.deepEqual(auto.json.data, explicit, `${command} auto output disagrees with explicit JSON`);
        const marked = await ctx.command([...args, '--format', 'markdown']);
        assert.ok(marked.stdout.includes(marker(explicit)), `${command} markdown missing human marker`);
        assert.doesNotMatch(marked.stdout.trim(), /^\{/, `${command} markdown unexpectedly emitted a bare JSON envelope`);
      }
      const version = data(await ctx.command(['version', '--json']));
      assert.equal(version.version, getVersion(), '--json shortcut disagrees with the checked-out package');
      const malformed = await ctx.command(['version', '--format', 'xml']);
      assert.notEqual(malformed.exitCode, 0, 'malformed --format value was accepted');
      assert.match(malformed.stderr, /Invalid value for --format/, 'malformed --format did not fail as usage');
      const missing = await ctx.command(['version', '--format']);
      assert.notEqual(missing.exitCode, 0, 'missing --format value was accepted');
      assert.match(missing.stderr, /requires a value|not enough arguments|Invalid value/i, 'missing --format did not fail as usage');
    } },
  { ...common, id: 'readonly.records', title: 'Bounded non-PII metadata list, projection and independent readback', commandPaths: ['records list', 'records get'], sources: ['cli/src/commands/records.js', 'cli/src/records-engine.js'],
    async run(ctx) {
      const args = ['records', 'list', '--table', 'sys_db_object', '--query', 'name=sys_user', '--fields', 'sys_id,name', '--limit', '1', '--no-count'];
      const value = data(await ctx.command([...args, '--json']));
      const records = Array.isArray(value) ? value : value.records;
      assert.ok(Array.isArray(records), 'record array missing');
      if (!records.length) throw new ScenarioError('blocked-access', 'Expected metadata not visible; empty response cannot establish feature coverage');
      assert.equal(records.length, 1);
      const id = typeof records[0].sys_id === 'object' ? records[0].sys_id.value : records[0].sys_id;
      assert.match(id, /^[a-f0-9]{32}$/);
      const independently = await ctx.read('sys_db_object', { id, fields: ['sys_id', 'name'], limit: 1 });
      const record = Array.isArray(independently) ? independently[0] : independently;
      assert.equal(record.name, 'sys_user'); assert.equal(record.sys_id, id);
      const fetched = data(await ctx.command(['records', 'get', '--table', 'sys_db_object', '--sys-id', id, '--fields', 'sys_id,name', '--json']));
      assert.ok(JSON.stringify(fetched).includes(id), 'exact record missing from get result');
      assertCommand(await ctx.command([...args, '--format', 'markdown']), { human: /sys_user/ });
    } },
];
