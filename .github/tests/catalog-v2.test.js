import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptCatalog, adaptInventory } from '../scripts/acceptance/catalog-v2.mjs';

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
