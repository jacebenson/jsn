// Adapter-owned catalog; never rewrite the pinned producer or historical results.
import assert from 'node:assert/strict';

export function retiredCompletion(artifact = { kind: 'checkout' }) {
  // Published 5.5.5 and earlier retain their original completion obligation.
  // The unversioned checkout is the candidate, not the historical npm artifact.
  if (artifact.kind === 'checkout') return true;
  const [major, minor, patch] = artifact.version.split(/[.-]/).map(Number);
  return major > 5 || major === 5 && (minor > 5 || minor === 5 && patch > 5);
}

export function adaptCatalog(scenarios, artifact) {
  if (!retiredCompletion(artifact)) return scenarios;
  return scenarios.map(s => s.id !== 'local.completion' ? s : {
    ...s,
    id: 'local.discovery-help',
    title: 'Discover command families and record options through actual help',
    commandPaths: ['records list'],
    coverageBindings: {}, // Help is discovery evidence, not scripted record success.
    async run(ctx) {
      const root = await ctx.command(['version', '--help']);
      assert.equal(root.exitCode, 0);
      assert.match(root.stdout, /version/i);
      assert.doesNotMatch(root.stdout, /\bcompletion\b/);
      const records = await ctx.command(['records', 'list', '--help']);
      assert.equal(records.exitCode, 0);
      assert.match(records.stdout, /--table/);
      assert.match(records.stdout, /--query/);
    },
  });
}

export function adaptInventory(inventory, artifact) {
  return retiredCompletion(artifact)
    ? { ...inventory, entries: inventory.entries.filter(entry => entry.path !== 'completion') }
    : inventory;
}
