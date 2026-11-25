// Adapter-owned catalog; never rewrite the pinned producer or historical results.
import assert from 'node:assert/strict';

function atLeast(artifact, [major, minor, patch]) {
  const actual = artifact.version.split(/[.-]/).map(Number);
  return actual[0] > major || actual[0] === major && (actual[1] > minor || actual[1] === minor && actual[2] >= patch);
}

function versioned(artifact, minimum) {
  // The unversioned checkout is the candidate, not a historical npm artifact.
  if (artifact?.kind === 'checkout') return true;
  return atLeast(artifact, minimum);
}

export function retiredCompletion(artifact = { kind: 'checkout' }) {
  // Published 5.5.5 and earlier retain their original completion obligation.
  return versioned(artifact, [5, 5, 6]);
}

export function retiredHistory(artifact = { kind: 'checkout' }) {
  // `jsn history` (local mutation-history database) was retired in v5.5.7:
  // cli/src/commands/history.js is absent, so `history list` exits 2 as an
  // unknown command. v5.5.6 and earlier still ship the original obligation.
  return versioned(artifact, [5, 5, 7]);
}

export function adaptCatalog(scenarios, artifact) {
  const adapted = retiredCompletion(artifact) ? scenarios.map(s => s.id !== 'local.completion' ? s : {
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
  }) : scenarios;
  // Retirement is a compatibility boundary, never a green replacement: the
  // pinned help scenario is not recycled as authenticated history success.
  return retiredHistory(artifact) ? adapted.filter(s => s.id !== 'local.history-empty') : adapted;
}

export function adaptInventory(inventory, artifact) {
  const retired = new Set();
  if (retiredCompletion(artifact)) retired.add('completion');
  if (retiredHistory(artifact)) for (const path of ['history', 'history list', 'history prune']) retired.add(path);
  if (!retired.size) return inventory;
  return { ...inventory, entries: inventory.entries.filter(entry => !retired.has(entry.path)) };
}
