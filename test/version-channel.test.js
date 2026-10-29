import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkLatest, getReleaseChannel, getInstallCommand, versionCmd } from '../src/commands/version.js';

test('release channel and update commands follow the installed version', () => {
  assert.equal(getReleaseChannel('4.3.11'), 'latest');
  assert.equal(getReleaseChannel('4.3.11-dev.69'), 'dev');
  assert.equal(getReleaseChannel('4.3.11-dev.69.2'), 'dev');
  assert.equal(getInstallCommand('4.3.11'), 'npm install -g @jacebenson/jsn');
  assert.equal(getInstallCommand('4.3.11-dev.69'), 'npm install -g @jacebenson/jsn@dev');
});

test('registry checks query the installed channel and tolerate failures', async (t) => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(url);
    return { ok: true, json: async () => ({ version: '4.3.11-dev.70' }) };
  });
  assert.equal(await checkLatest({ version: '4.3.11-dev.69' }), '4.3.11-dev.70');
  await checkLatest({ version: '4.3.11' });
  assert.deepEqual(urls, [
    'https://registry.npmjs.org/@jacebenson/jsn/dev',
    'https://registry.npmjs.org/@jacebenson/jsn/latest',
  ]);
  globalThis.fetch.mock.mockImplementation(async () => ({ ok: false }));
  assert.equal(await checkLatest({ version: '4.3.11-dev.69' }), null);
  globalThis.fetch.mock.mockImplementation(async () => { throw new Error('offline'); });
  assert.equal(await checkLatest(), null);
  globalThis.fetch.mock.mockImplementation(async () => ({ ok: true, json: async () => ({}) }));
  assert.equal(await checkLatest(), null);
});

test('version --check offers a dev update and recognizes the current dev build', async (t) => {
  t.mock.method(fs, 'readFileSync', () => JSON.stringify({ version: '4.3.11-dev.69' }));
  let latest = '4.3.11-dev.70';
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ version: latest }) }));
  const cmd = versionCmd(handler => handler);
  let result;
  const app = { ok: (data, meta) => { result = { data, meta }; } };
  await cmd.handler({ check: true }, app);
  assert.equal(result.data.upToDate, false);
  assert.equal(result.data.installCmd, 'npm install -g @jacebenson/jsn@dev');
  assert.equal(result.meta.breadcrumbs[0].cmd, result.data.installCmd);
  latest = '4.3.11-dev.69';
  await cmd.handler({ check: true }, app);
  assert.equal(result.data.upToDate, true);
});
