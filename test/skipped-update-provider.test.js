import test from 'node:test';
import assert from 'node:assert/strict';
import { readSkippedBaseline, revertSkippedUpdate } from '../src/skipped-update-provider.js';

const id = 'a'.repeat(32);
test('base inspection uses verified version getter path and global read-only script', async () => {
  const sdk = { executeScript: async (script, scope) => {
    assert.equal(scope, 'global');
    assert.match(script, /GlideappUpdateVersion.getStoreAppID/);
    assert.match(script, /getVersion\(name, record.upgrade_history, 'sys_upgrade_history'/);
    assert.doesNotMatch(script, /\.update\(|\.revert\(/);
    return '*** Script: JSN_SKIPPED_BASE:{"sys_id":"baseline","payload":"xml"}';
  } };
  assert.equal((await readSkippedBaseline(sdk, id)).payload, 'xml');
});
test('revert invokes provider lifecycle instead of forging resolution fields', async () => {
  const sdk = { executeScript: async (script, scope) => {
    assert.equal(scope, 'global');
    assert.match(script, /new RevertUpdateVersionAjax\(\).revertToBaseSystem/);
    assert.match(script, /getValue\('disposition'\) !== '4'/);
    assert.doesNotMatch(script, /\.update\(/);
    return 'JSN_SKIPPED_REVERT:dispatched';
  } };
  await revertSkippedUpdate(sdk, id, '2');
});
test('malformed identities never reach script execution', async () => {
  let called = false;
  const sdk = { executeScript: async () => { called = true; } };
  await assert.rejects(readSkippedBaseline(sdk, "a';bad()"));
  await assert.rejects(revertSkippedUpdate(sdk, id, "1';bad()"));
  assert.equal(called, false);
});
