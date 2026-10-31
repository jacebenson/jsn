import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withFlowSafeEdit } from '../src/flow-safe-edit.js';

function fixture({ before = { canUserEdit: false, currentEditor: null }, acquired = { canUserEdit: true, currentEditor: null, clientFlowStale: null }, release = true } = {}) {
  const calls = [];
  const sdk = { request: async (url, options) => {
    const { query } = JSON.parse(options.body); calls.push(query);
    assert.equal(url, 'https://example.test/api/now/graphql');
    let safeEdit;
    if (query.includes('upsert:')) safeEdit = { status: acquired };
    else if (query.includes('delete:')) safeEdit = { deleteResult: { deleteSuccess: release, id: 'flow-id' } };
    else safeEdit = { status: before };
    return { data: { global: { snFlowDesigner: { safeEdit } } } };
  } };
  return { sdk, calls };
}
const run = (f, operation) => withFlowSafeEdit(f.sdk, 'https://example.test', 'flow-id', '2020-01-01 00:00:00', operation);
test('legacy edit acquires before content writes, releases and reads back', async () => {
  const f = fixture();
  assert.equal(await run(f, async () => { assert.match(f.calls[1], /lastUpdated:"2020-01-01 00:00:00"/); return 'saved'; }), 'saved');
  assert.equal(f.calls.length, 4); assert.match(f.calls[2], /delete:/); assert.match(f.calls[3], /read:/);
});
test('never mutates or releases pre-existing same-user or other-user lock', async () => {
  for (const before of [{canUserEdit:true,currentEditor:null}, {canUserEdit:false,currentEditor:'Someone'}]) {
    const f=fixture({before}); await assert.rejects(run(f,()=>assert.fail('content write')), /existing.*session|editor/i); assert.equal(f.calls.length,1);
  }
});
test('stale acquisition refuses content, but releases newly acquired session', async () => {
  const f=fixture({acquired:{canUserEdit:true,currentEditor:null,clientFlowStale:true}});
  await assert.rejects(run(f,()=>assert.fail('content write')), /stale/); assert.equal(f.calls.length,4);
});
test('another editor winning acquisition is not released', async () => {
  const f=fixture({acquired:{canUserEdit:false,currentEditor:'Other',clientFlowStale:false}});
  await assert.rejects(run(f,()=>assert.fail('content write')), /editor|acquire/i); assert.equal(f.calls.length,2);
});
test('cleanup failure preserves original partial-write error', async () => {
  const f=fixture({release:false}); await assert.rejects(run(f,()=>{throw new Error('patch persisted; autosave failed');}), /patch persisted; autosave failed.*release failed/i);
});
test('unknown acquisition timeout is reported without unsafe release', async () => {
  const f=fixture(), request=f.sdk.request;
  f.sdk.request=async(url,options)=>{
    if(JSON.parse(options.body).query.includes('upsert:')) throw new Error('transport timeout');
    return request(url,options);
  };
  await assert.rejects(run(f,()=>assert.fail('content write')), /acquisition is uncertain.*no release attempted/i);
  assert.equal(f.calls.length,1);
});
test('malformed statuses and missing timestamps fail closed', async () => {
  for(const before of [null,{}, {canUserEdit:'true',currentEditor:null}]) {
    const f=fixture({before});await assert.rejects(run(f,()=>assert.fail('content write')), /Unreadable/);assert.equal(f.calls.length,1);
  }
  const f=fixture();await assert.rejects(withFlowSafeEdit(f.sdk,'https://example.test','flow-id',undefined,()=>assert.fail()), /timestamp/);assert.equal(f.calls.length,0);
});
test('release must read back no remaining user lease', async () => {
  const f=fixture(),request=f.sdk.request;
  f.sdk.request=async(url,options)=>{
    const r=await request(url,options);
    if(f.calls.length===4) r.data.global.snFlowDesigner.safeEdit.status.canUserEdit=true;
    return r;
  };
  await assert.rejects(run(f,async()=>'saved'), /release failed.*readback/i);
});
test('cleanup failure cannot return false success', async () => {
  const f=fixture({release:false}); await assert.rejects(run(f,async()=>'saved'), /release failed/i);
});
