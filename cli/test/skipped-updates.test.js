import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverSkippedUpdates, prepareSkippedBatch, processSkippedBatch } from '../src/skipped-updates.js';

const id = 'a'.repeat(32);
const artifactId = 'b'.repeat(32);
const finding = { sys_id: id, file_name: `sys_script_include_${artifactId}`, target_name: 'Example',
  disposition: '4', resolution_status: 'not_reviewed', sys_mod_count: '2', upgrade_history: 'c'.repeat(32) };
const base = { sys_id: 'd'.repeat(32), payload: `<record_update table="sys_script_include"><sys_script_include action="INSERT_OR_UPDATE"><sys_id>${artifactId}</sys_id><script>base()</script></sys_script_include></record_update>` };
function fakeSDK() {
  return { get: async table => table === 'sys_upgrade_history_log' ? { ...finding } : { sys_id: artifactId, script: 'custom()' },
    getSkippedUpdateBaseline: async () => base,
    list: async table => table === 'sys_script_include' ? [{ script: 'revertToBaseSystem : function (sys_id) { GlideappUpdateVersion.getVersion(); }' }] : [] };
}

test('batch preview contains exact selected identities, explicit action, impact and stable confirmation token', async () => {
  const preview = await prepareSkippedBatch(fakeSDK(), { ids: [id], action: 'retain', instance: 'https://example.service-now.com' });
  assert.equal(preview.selected.length, 1);
  assert.equal(preview.selected[0].sys_id, id);
  assert.equal(preview.selected[0].action, 'retain');
  assert.equal(preview.selected[0].impact.changes[0].base, 'base()');
  assert.match(preview.confirmation_token, /^[a-f0-9]{64}$/);
  const other = await prepareSkippedBatch(fakeSDK(), { ids: [id], action: 'revert', instance: 'https://example.service-now.com' });
  assert.notEqual(preview.confirmation_token, other.confirmation_token);
});

test('invalid IDs, duplicate selection and invalid action fail before provider access', async () => {
  const sdk = { get: () => assert.fail('unexpected provider access') };
  for (const options of [{ ids: ['a'], action: 'retain' }, { ids: [id, id], action: 'retain' }, { ids: [id], action: 'recommended' }]) {
    await assert.rejects(prepareSkippedBatch(sdk, options));
  }
});

test('resolved findings cannot be prepared for processing', async () => {
  const sdk = fakeSDK(); sdk.get = async () => ({ ...finding, resolution_status: 'reviewed' });
  await assert.rejects(prepareSkippedBatch(sdk, { ids: [id], action: 'retain' }), /unresolved/);
});

test('missing resolution field is unknown, not a blank unresolved state', async () => {
  const sdk = fakeSDK(); sdk.get = async () => {
    const { resolution_status: _hidden, ...rest } = finding; return rest;
  };
  sdk.update = () => assert.fail('unexpected write');
  await assert.rejects(processSkippedBatch({ sdk, ids: [id], action: 'retain', confirm: async () => true }), /unresolved/);
  await assert.rejects(discoverSkippedUpdates({ list: async () => [{ sys_id: id, disposition: '4' }] }), /state/);
});

test('missing current baseline behavior fields block revert before any mutation', async () => {
  const sdk = fakeSDK();
  sdk.getSkippedUpdateBaseline = async () => ({ ...base, payload: base.payload.replace('<script>', '<active>true</active><script>') });
  sdk.revertSkippedUpdate = () => assert.fail('unexpected destructive write');
  await assert.rejects(processSkippedBatch({ sdk, ids: [id], action: 'revert', confirm: async () => true }), /unsupported/);
});

test('unsupported baseline XML and non-4 skip dispositions cannot prepare a revert batch', async () => {
  const sdk = fakeSDK();
  sdk.getSkippedUpdateBaseline = async () => ({ ...base, payload: '<unsupported/>' });
  await assert.rejects(prepareSkippedBatch(sdk, { ids: [id], action: 'revert' }), /unsupported/);
  sdk.getSkippedUpdateBaseline = async () => base;
  sdk.get = async table => table === 'sys_upgrade_history_log' ? { ...finding, disposition: '10' } : { sys_id: artifactId, script: 'custom()' };
  await assert.rejects(prepareSkippedBatch(sdk, { ids: [id], action: 'revert' }), /unsupported/);
});

test('cancellation, missing consent, mismatched token and read-only never write', async () => {
  const sdk = fakeSDK();
  sdk.update = () => assert.fail('unexpected write');
  sdk.revertSkippedUpdate = () => assert.fail('unexpected revert');
  const options = { sdk, ids: [id], action: 'retain', instance: 'https://example.service-now.com' };
  let previews = 0, prompts = 0;
  const result = await processSkippedBatch({ ...options, onPreview: async preview => {
    previews++; assert.equal(preview.selected[0].sys_id, id);
  }, confirm: async () => { assert.equal(previews, 1); prompts++; return false; } });
  assert.equal(result.cancelled, true); assert.equal(prompts, 1);
  await assert.rejects(processSkippedBatch(options), err => {
    assert.equal(err.code, 'confirmation_required');
    assert.doesNotMatch(err.hint, /[a-f0-9]{64}/); // token is issued only by an exact preview
    return true;
  });
  await assert.rejects(processSkippedBatch({ ...options, confirmationToken: 'bad' }), /changed|token/);
  await assert.rejects(processSkippedBatch({ ...options, readOnly: true }), err => err.code === 'read_only');
});

test('one confirmation processes only selected action and reports partial failure with verified readback', async () => {
  const otherId = 'e'.repeat(32);
  const states = new Map([[id, { ...finding }], [otherId, { ...finding, sys_id: otherId }]]);
  const sdk = fakeSDK();
  sdk.get = async (table, sysID) => table === 'sys_upgrade_history_log' ? { ...states.get(sysID) } : { sys_id: artifactId, script: 'custom()' };
  const writes = [];
  sdk.update = async (table, sysID, data) => {
    writes.push({ table, sysID, data });
    if (sysID === otherId) throw new Error('provider rejected');
    states.get(sysID).resolution_status = data.resolution_status;
  };
  sdk.revertSkippedUpdate = () => assert.fail('recommendation was incorrectly applied');
  let prompts = 0;
  const result = await processSkippedBatch({ sdk, ids: [id, otherId], action: 'retain',
    confirm: async () => { prompts++; return true; } });
  assert.equal(prompts, 1); assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].data, { resolution_status: 'reviewed_retained' });
  assert.equal(result.success_count, 1); assert.equal(result.failure_count, 1);
  assert.equal(result.partial, true); assert.equal(result.results[1].effect, 'unknown');
});

test('provider acknowledgement without state readback is a failure, never success', async () => {
  const sdk = fakeSDK(); sdk.update = async () => ({ resolution_status: 'reviewed_retained' });
  const result = await processSkippedBatch({ sdk, ids: [id], action: 'retain', confirm: async () => true });
  assert.equal(result.success_count, 0); assert.equal(result.failure_count, 1);
});

test('changed snapshot after confirmation fails before writing that finding', async () => {
  const sdk = fakeSDK(); sdk.update = () => assert.fail('unexpected write');
  const result = await processSkippedBatch({ sdk, ids: [id], action: 'retain', confirm: async () => {
    sdk.get = async () => ({ ...finding, sys_mod_count: '3' }); return true;
  } });
  assert.equal(result.failure_count, 1); assert.equal(result.results[0].write_attempted, false);
});

test('explicit revert uses lifecycle and verifies state and artifact changes', async () => {
  const sdk = fakeSDK(); let reverted = false;
  sdk.update = () => assert.fail('revert must not forge state with generic update');
  sdk.revertSkippedUpdate = async (sysID, mod) => { assert.equal(sysID, id); assert.equal(mod, '2'); reverted = true; };
  // Live behavior: the provider writes a NEW base version record (new sys_id,
  // identical payload) as part of reverting. Readback must accept that and still
  // verify the artifact is at the previewed base content.
  sdk.getSkippedUpdateBaseline = async () => reverted ? { ...base, sys_id: 'e'.repeat(32) } : base;
  sdk.get = async table => table === 'sys_upgrade_history_log'
    ? { ...finding, ...(reverted ? { disposition: '5', resolution_status: 'reviewed_reverted' } : {}) }
    : { sys_id: artifactId, script: reverted ? 'base()' : 'custom()' };
  const preview = await prepareSkippedBatch(sdk, { ids: [id], action: 'revert' });
  const result = await processSkippedBatch({ sdk, ids: [id], action: 'revert', confirmationToken: preview.confirmation_token });
  assert.equal(result.success_count, 1);
  assert.equal(result.results[0].base_version, 'e'.repeat(32));
});

test('revert readback rejects a base version whose content is not the previewed base', async () => {
  const sdk = fakeSDK(); let reverted = false;
  sdk.revertSkippedUpdate = async () => { reverted = true; };
  // Provider returns a different base version AND different base content: that is
  // not the content the operator previewed, so the finding must not report success.
  sdk.getSkippedUpdateBaseline = async () => reverted
    ? { ...base, sys_id: 'e'.repeat(32), payload: base.payload.replace('base()', 'other()') } : base;
  sdk.get = async table => table === 'sys_upgrade_history_log'
    ? { ...finding, ...(reverted ? { disposition: '5', resolution_status: 'reviewed_reverted' } : {}) }
    : { sys_id: artifactId, script: reverted ? 'base()' : 'custom()' };
  const result = await processSkippedBatch({ sdk, ids: [id], action: 'revert', confirm: async () => true });
  assert.equal(result.success_count, 0); assert.equal(result.failure_count, 1);
  assert.equal(result.results[0].effect, 'unknown');
});

test('revert verifies unchanged baseline fields too, not only the previewed differences', async () => {
  const sdk = fakeSDK(); let reverted = false;
  sdk.getSkippedUpdateBaseline = async () => ({ ...base, payload: base.payload.replace('<script>', '<active>true</active><script>') });
  sdk.revertSkippedUpdate = async () => { reverted = true; };
  sdk.get = async table => table === 'sys_upgrade_history_log'
    ? { ...finding, ...(reverted ? { disposition: '5', resolution_status: 'reviewed_reverted' } : {}) }
    : { sys_id: artifactId, script: reverted ? 'base()' : 'custom()', active: reverted ? 'false' : 'true' };
  const result = await processSkippedBatch({ sdk, ids: [id], action: 'revert', confirm: async () => true });
  assert.equal(result.success_count, 0); assert.equal(result.failure_count, 1);
});

test('discovers unresolved skips instance-wide without an upgrade event filter', async () => {
  let params;
  const sdk = { list: async (table, p) => {
    assert.equal(table, 'sys_upgrade_history_log'); params = p;
    return [{ sys_id: 'a'.repeat(32), disposition: '4', resolution_status: '' }];
  } };
  const result = await discoverSkippedUpdates(sdk, { limit: 10, offset: 0 });
  assert.equal(result.findings.length, 1);
  assert.equal(params.get('sysparm_query'), 'dispositionIN4,104,9,10,11^resolution_statusIN,not_reviewed^ORDERBYsys_id');
  assert.equal(result.has_more, false);
});
