import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDeprecations, planDeprecations } from '../scripts/deprecate-old-versions.mjs';

function metadata() {
  // Deliberately unordered; dev run numbers and patch versions must sort numerically.
  const versions = Object.fromEntries([
    '4.3.8', '4.3.11-dev.9', '4.3.11', '4.3.9', '4.3.11-dev.11',
    '4.3.10', '4.3.11-dev.10', '4.3.11-dev.11.2', '4.3.11-dev.11.1',
    '0.2.0', '4.4.0-beta.1',
  ].map(version => [version, {}]));
  return { versions, 'dist-tags': { latest: '4.3.11', dev: '4.3.11-dev.11.2', node: '0.2.0' } };
}

test('stable support retains current plus two previous releases, independently of dev', () => {
  const plan = planDeprecations(metadata(), 'latest', '4.3.11');
  assert.deepEqual(plan.supported, ['4.3.11', '4.3.10', '4.3.9']);
  assert.deepEqual(plan.deprecate, ['4.3.8', '0.2.0']);
  assert.match(plan.message, /Update before reporting an issue/);
  assert.match(plan.message, /@jacebenson\/jsn@latest$/);
});

test('dev support sorts run and attempt numbers and leaves stable and other prereleases alone', () => {
  const plan = planDeprecations(metadata(), 'dev', '4.3.11-dev.11.2');
  assert.deepEqual(plan.supported, ['4.3.11-dev.11.2', '4.3.11-dev.11.1', '4.3.11-dev.11']);
  assert.deepEqual(plan.deprecate, ['4.3.11-dev.10', '4.3.11-dev.9']);
  assert.match(plan.message, /@jacebenson\/jsn@dev$/);
});

test('preserves existing deprecations and supports channels with fewer than three versions', () => {
  const data = metadata();
  data.versions['4.3.8'].deprecated = 'Specific security warning';
  assert.deepEqual(planDeprecations(data, 'latest', '4.3.11').deprecate, ['0.2.0']);
  data.versions = { '4.3.11': {}, '4.3.10': {} };
  assert.deepEqual(planDeprecations(data, 'latest', '4.3.11').deprecate, []);
});

test('refuses stale, mismatched, missing, or invalid release metadata before modifying npm', () => {
  assert.throws(() => planDeprecations(metadata(), 'beta', '4.3.11'), /Channel/);
  assert.throws(() => planDeprecations(metadata(), 'dev', '4.3.11'), /does not match channel/);
  assert.throws(() => planDeprecations(metadata(), 'latest', '4.3.10'), /tag does not match/);
  const data = metadata();
  delete data.versions['4.3.11'];
  assert.throws(() => planDeprecations(data, 'latest', '4.3.11'), /tag does not match/);
  data.versions['4.3.12'] = {};
  data.versions['4.3.11'] = {};
  assert.throws(() => planDeprecations(data, 'latest', '4.3.11'), /not the newest/);
});

test('applies only exact planned versions and stops if a registry write fails', () => {
  const plan = planDeprecations(metadata(), 'latest', '4.3.11');
  const calls = [];
  applyDeprecations(plan, (...args) => { calls.push(args); return { status: 0 }; });
  assert.deepEqual(calls.map(call => call[1][1]), ['@jacebenson/jsn@4.3.8', '@jacebenson/jsn@0.2.0']);
  assert.equal(calls[0][0], 'npm');
  assert.equal(calls[0][1][2], plan.message);
  assert.equal(calls[0][2].shell, false);
  let count = 0;
  assert.throws(() => applyDeprecations(plan, () => { count++; return { status: 1 }; }), /failed for 4.3.8/);
  assert.equal(count, 1);
  assert.throws(() => applyDeprecations(plan, () => ({ error: new Error('not found') })), /failed for/);
});
