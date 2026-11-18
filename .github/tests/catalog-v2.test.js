import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptCatalog, adaptInventory, retiredHistory } from '../scripts/acceptance/catalog-v2.mjs';

test('catalog retirement is explicit for candidates, retains historical npm obligations and never mutates producer data', async () => {
  const legacy = { id: 'local.completion', commandPaths: ['completion'], coverageBindings: { completion: {} }, run: async () => 'legacy' };
  const scenarios = [legacy];
  const inventory = { entries: [{ path: 'completion' }, { path: 'records list' }] };
  assert.equal(adaptCatalog(scenarios, { kind: 'npm', version: '5.5.5' }), scenarios);
  assert.equal(adaptInventory(inventory, { kind: 'npm', version: '5.5.5' }), inventory);
  const [replacement] = adaptCatalog(scenarios);
  assert.equal(replacement.id, 'local.discovery-help');
  assert.deepEqual(adaptInventory(inventory).entries, [{ path: 'records list' }]);
  assert.equal(legacy.id, 'local.completion');
  const calls = [];
  await replacement.run({ command: async args => { calls.push(args); return { exitCode: 0, stdout: args[0] === 'version' ? 'jsn version' : '--table --query' }; } });
  assert.deepEqual(calls, [['version', '--help'], ['records', 'list', '--help']]);
  await assert.rejects(replacement.run({ command: async () => ({ exitCode: 1, stdout: '' }) }));
  await assert.rejects(replacement.run({ command: async () => ({ exitCode: 0, stdout: 'records completion' }) }));
  assert.deepEqual(inventory.entries.map(e => e.path), ['completion', 'records list']);
});

test('history retirement is bounded by the v5.5.7 removal and never rewrites obligations', () => {
  const history = { id: 'local.history-empty', commandPaths: ['history list'], run: async () => 'legacy' };
  const discovery = { id: 'local.discovery-help', commandPaths: ['records list'], run: async () => 'current' };
  const scenarios = [history, discovery];
  const inventory = { entries: [{ path: 'history' }, { path: 'history list' }, { path: 'history prune' }, { path: 'records list' }] };
  // Candidates and published artifacts at/after the removal retire the scenario
  // and its inventory entries; the pinned bytes and input arrays stay untouched.
  assert.equal(retiredHistory({ kind: 'checkout' }), true);
  assert.equal(retiredHistory({ kind: 'npm', version: '5.5.7' }), true);
  assert.equal(retiredHistory({ kind: 'npm', version: '5.6.0' }), true);
  assert.equal(retiredHistory({ kind: 'npm', version: '6.0.0' }), true);
  assert.equal(retiredHistory({ kind: 'npm', version: '5.5.6' }), false);
  assert.equal(retiredHistory({ kind: 'npm', version: '5.5.5' }), false);
  assert.deepEqual(adaptCatalog(scenarios).map(s => s.id), ['local.discovery-help']);
  assert.deepEqual(adaptCatalog(scenarios, { kind: 'npm', version: '5.5.7' }).map(s => s.id), ['local.discovery-help']);
  assert.deepEqual(adaptCatalog(scenarios, { kind: 'npm', version: '5.5.6' }).map(s => s.id), ['local.history-empty', 'local.discovery-help']);
  assert.deepEqual(adaptCatalog(scenarios, { kind: 'npm', version: '5.5.5' }).map(s => s.id), ['local.history-empty', 'local.discovery-help']);
  assert.deepEqual(adaptInventory(inventory).entries.map(e => e.path), ['records list']);
  assert.deepEqual(adaptInventory(inventory, { kind: 'npm', version: '5.5.7' }).entries.map(e => e.path), ['records list']);
  assert.deepEqual(adaptInventory(inventory, { kind: 'npm', version: '5.5.6' }).entries.map(e => e.path), ['history', 'history list', 'history prune', 'records list']);
  assert.equal(adaptInventory(inventory, { kind: 'npm', version: '5.5.5' }), inventory);
  // The retired scenario is dropped, not replaced with a help-based success.
  assert.ok(!adaptCatalog(scenarios).some(s => s.id === 'local.history-empty' || s.commandPaths.includes('history list')));
  assert.deepEqual(scenarios.map(s => s.id), ['local.history-empty', 'local.discovery-help']);
  assert.equal(inventory.entries.length, 4);
});
