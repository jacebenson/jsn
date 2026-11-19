import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SDKClient } from '../src/sdk.js';
import { App } from '../src/app.js';
import { checkLatest, cancelBackgroundChecks } from '../src/commands/version.js';
import { setTimeout as delay } from 'node:timers/promises';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('concurrent requests share session bootstrap and later calls retry a failed bootstrap', async () => {
  const client = new SDKClient('https://example.invalid', {});
  const gate = deferred();
  let calls = 0;
  client._initializeSession = async () => { calls++; return gate.promise; };
  const first = client._warmSession();
  const second = client._warmSession();
  assert.equal(calls, 1);
  gate.resolve('');
  assert.deepEqual(await Promise.all([first, second]), ['', '']);
  client._initializeSession = async () => { calls++; client.oauthCookies = 'session=ready'; return client.oauthCookies; };
  assert.equal(await client._warmSession(), 'session=ready');
  assert.equal(await client._warmSession(), 'session=ready');
  assert.equal(calls, 2);
});

test('related reads overlap with at most four workers, keep order and isolate failures', async () => {
  const client = new SDKClient('https://example.invalid', {});
  let active = 0, peak = 0;
  client.list = async (table) => {
    if (table === 'main') return [{ sys_id: 'record' }];
    active++; peak = Math.max(peak, active);
    await delay(table === 'slow' ? 20 : 1);
    active--;
    if (table === 'bad') throw new Error('unavailable');
    return [table];
  };
  const tables = ['slow', 'a', 'bad', 'b', 'c', 'd'];
  const related = tables.map((table) => ({ table, queryField: 'parent', queryValue: 'record', displayAs: table }));
  const result = await client.recordWithRelated('main', new URLSearchParams(), related);
  assert.equal(peak, 4);
  assert.deepEqual(Object.keys(result), ['_record', ...tables]);
  assert.deepEqual(result.bad, []);
  assert.deepEqual(result.slow, ['slow']);
  assert.deepEqual(result.d, ['d']);
});

test('retired context header performs no lookups or output even on a terminal', async t => {
  const app = { sdk: { list: () => assert.fail('No context reads') } };
  const stderr = t.mock.method(process.stderr, 'write', () => true);
  await App.prototype.printContextHeader.call(app, {});
  assert.equal(stderr.mock.callCount(), 0);
});

test('npm checks time out and background checks abort on command completion', async (t) => {
  const signals = [];
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    signals.push(signal);
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  // Keep this test alive while exercising the intentionally unrefed timeout.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  assert.equal(await checkLatest({ timeout: 10 }), null);
  assert.equal(signals[0].aborted, true);
  const pending = checkLatest({ background: true });
  cancelBackgroundChecks();
  assert.equal(await pending, null);
  assert.equal(signals[1].aborted, true);
});
