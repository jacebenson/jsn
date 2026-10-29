import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDeprecations, fetchMetadata, planDeprecations, waitForChannelTag } from '../scripts/deprecate-old-versions.mjs';

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

test('waits for the registry dist-tag to catch up with the version just published', async () => {
  const stale = metadata();
  const fresh = metadata();
  fresh.versions['4.3.11-dev.11.3'] = {};
  fresh['dist-tags'].dev = '4.3.11-dev.11.3';
  const responses = [stale, stale, fresh];
  const reads = [];
  const result = await waitForChannelTag('dev', '4.3.11-dev.11.3', {
    readMetadata: async () => { reads.push(1); return responses.shift(); },
    sleep: async () => {},
  });
  assert.equal(reads.length, 3);
  assert.equal(result['dist-tags'].dev, '4.3.11-dev.11.3');
});

test('gives up loudly and names the tag it kept reading instead of deprecating blind', async () => {
  await assert.rejects(
    waitForChannelTag('dev', '4.3.11-dev.11.3', {
      readMetadata: async () => metadata(),
      sleep: async () => {},
      attempts: 3,
      intervalMs: 1,
    }),
    /still reads "4\.3\.11-dev\.11\.2" after 3 reads; expected 4\.3\.11-dev\.11\.3\. Nothing was deprecated\./,
  );
});

test('reads the packument through a cache-busting URL and reports registry errors', async () => {
  const urls = [];
  const data = await fetchMetadata(async (url, options) => {
    urls.push({ url, options });
    return { ok: true, json: async () => metadata() };
  }, 'https://registry.example');
  assert.equal(data['dist-tags'].latest, '4.3.11');
  assert.match(urls[0].url, /^https:\/\/registry\.example\/@jacebenson\/jsn\?t=\d{13}$/);
  assert.equal(urls[0].options.headers['cache-control'], 'no-cache');
  await assert.rejects(
    fetchMetadata(async () => ({ ok: false, status: 503 }), 'https://registry.example'),
    /HTTP 503/,
  );
});
