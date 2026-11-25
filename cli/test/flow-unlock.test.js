import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseOwnFlowSafeEdit } from '../src/flow-safe-edit.js';

function fixture({ statuses = [{ canUserEdit: false, currentEditor: null }], deleteResult = { deleteSuccess: true, id: 'flow-id' } } = {}) {
  const calls = [];
  let reads = 0;
  const sdk = { request: async (url, options) => {
    const { query } = JSON.parse(options.body); calls.push(query);
    assert.equal(url, 'https://example.test/api/now/graphql');
    if (query.includes('delete:')) return { data: { global: { snFlowDesigner: { safeEdit: { deleteResult } } } } };
    const status = statuses[Math.min(reads++, statuses.length - 1)];
    return { data: { global: { snFlowDesigner: { safeEdit: { status } } } } };
  } };
  return { sdk, calls };
}

const release = f => releaseOwnFlowSafeEdit(f.sdk, 'https://example.test', 'flow-id');

test('no reported session releases nothing and mutates nothing', async () => {
  const f = fixture();
  const result = await release(f);
  assert.equal(result.released, false);
  assert.deepEqual(result.before, { canUserEdit: false, currentEditor: null });
  assert.equal(f.calls.length, 1);
  assert.doesNotMatch(f.calls[0], /delete:|upsert:/);
});

test('a stale session this user holds is released and read back absent', async () => {
  const f = fixture({ statuses: [{ canUserEdit: true, currentEditor: null }, { canUserEdit: false, currentEditor: null }] });
  const result = await release(f);
  assert.equal(result.released, true);
  assert.equal(result.before.canUserEdit, true);
  assert.equal(result.after.canUserEdit, false);
  assert.equal(f.calls.length, 3);
  assert.match(f.calls[1], /delete:/);
  assert.doesNotMatch(f.calls.join('\n'), /upsert:/);
});

test('an unconfirmed provider release fails instead of reporting success', async () => {
  const f = fixture({ statuses: [{ canUserEdit: true, currentEditor: null }], deleteResult: { deleteSuccess: false, id: 'flow-id' } });
  await assert.rejects(release(f), /release was not confirmed.*deleteSuccess=false.*canUserEdit=true/i);
  assert.equal(f.calls.length, 2);
});

test('a lease that survives the release is an error, not a success', async () => {
  const f = fixture({ statuses: [{ canUserEdit: true, currentEditor: null }, { canUserEdit: true, currentEditor: null }] });
  await assert.rejects(release(f), /readback still reports an edit session.*canUserEdit=true/i);
  assert.equal(f.calls.length, 3);
});

test('an unreadable status fails closed before any release attempt', async () => {
  for (const status of [null, {}, { canUserEdit: 'true', currentEditor: null }]) {
    const f = fixture({ statuses: [status] });
    await assert.rejects(release(f), /Unreadable safe edit status/);
    assert.equal(f.calls.length, 1);
  }
});

test('a named editor is reported in the untouched before state', async () => {
  const f = fixture({ statuses: [{ canUserEdit: false, currentEditor: 'Someone' }, { canUserEdit: false, currentEditor: null }] });
  const result = await release(f);
  assert.equal(result.released, true);
  assert.equal(result.before.currentEditor, 'Someone');
  assert.equal(result.after.currentEditor, null);
});
