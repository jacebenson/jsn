import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('local captures round trip without an SDK and comparisons ignore capture metadata and ordering', async () => {
  const { captureReport, getReport, listReports, compareReports } = await import('../src/customizations.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-customizations-'));
  try {
    const a = await captureReport({ sdk: readOnlySdk({ sys_metadata: metadata }), instance: 'https://mock.example', label: 'first', dir });
    const b = await captureReport({ sdk: readOnlySdk({ sys_metadata: [...metadata].reverse() }), instance: 'https://mock.example', label: 'second', dir });
    assert.deepEqual(getReport(a.run_id, { dir }), a);
    assert.equal(listReports({ dir }).length, 2);
    const same = compareReports(a, b);
    assert.deepEqual(same.additions, []);
    assert.deepEqual(same.removals, []);
    assert.deepEqual(same.changes, []);
    assert.equal(same.status, 'incomplete');
    const changed = structuredClone(b);
    changed.categories.unclassified[0].identity.name = 'changed';
    changed.categories.unclassified.pop();
    changed.categories.unclassified.push({ ...structuredClone(a.categories.unclassified[0]), identity: { sys_id: 'new', table: 'sys_script', name: 'new' } });
    const diff = compareReports(a, changed);
    assert.equal(diff.changes.length, 1);
    assert.equal(diff.additions.length, 1);
    assert.equal(diff.removals.length, 1);
    assert.equal(diff.removals[0].availability, 'not_observed_in_new');
    assert.throws(() => getReport('../bad', { dir }), /Invalid/);
    assert.throws(() => compareReports(a, { ...b, instance: 'https://other.example' }), /same instance/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const metadata = [
  { sys_id: 'a', sys_update_name: 'sys_script_a', sys_name: 'Vendor rule', sys_scope: 'global', sys_class_name: 'sys_script', sys_updated_on: '2026-01-01' },
  { sys_id: 'b', sys_update_name: 'sys_script_b', sys_name: 'Our rule', sys_scope: 'ours', sys_class_name: 'sys_script' },
  { sys_id: 'c', sys_name: 'Store rule', sys_scope: 'store', sys_class_name: 'sys_script' },
];
function readOnlySdk(rows = {}) {
  return new Proxy({ async list(table, params) {
    const all = rows[table] || [];
    return all.slice(Number(params.sysparm_offset), Number(params.sysparm_offset) + Number(params.sysparm_limit));
  } }, { get(target, key) { if (key === 'list') return target.list; throw new Error(`Forbidden SDK operation: ${String(key)}`); } });
}

test('capture uses only table reads and separates evidenced historical OOTB changes from declared customer scopes', async () => {
  const { captureCustomizations } = await import('../src/customizations.js');
  const result = await captureCustomizations({ sdk: readOnlySdk({
    sys_metadata: metadata,
    sys_scope: [{ sys_id: 'ours', scope: 'x_acme_ours', name: 'Ours' }, { sys_id: 'store', scope: 'sn_store', name: 'Vendor' }],
    sys_upgrade_history_log: [{ sys_id: 'log', name: 'sys_script_a', disposition: 'skipped', resolution_status: 'retained' }],
  }), customerScopes: ['x_acme_ours'], pageSize: 2, maxPages: 5 });
  assert.equal(result.categories.ootb_modifications.length, 1);
  assert.equal(result.categories.customer_app_artifacts.length, 1);
  assert.equal(result.categories.unclassified.length, 1);
  const item = result.categories.ootb_modifications[0];
  assert.equal(item.identity.sys_id, 'a');
  assert.ok(item.evidence.length);
  assert.equal(item.risk.rating, 'unknown');
  assert.match(item.risk.rationale, /baseline/i);
  assert.match(item.reversion.unknowns.join(' '), /dependencies/i);
  assert.match(result.categories.customer_app_artifacts[0].evidence.at(-1).basis, /declared/i);
  assert.equal(result.coverage.sources.sys_metadata.status, 'exhausted');
  assert.equal(result.coverage.complete, false);
});

test('missing required fields never produce apparently exhausted coverage', async () => {
  const { captureCustomizations } = await import('../src/customizations.js');
  const result = await captureCustomizations({ sdk: readOnlySdk({ sys_metadata: [{ sys_id: 'hidden' }] }) });
  assert.equal(result.coverage.sources.sys_metadata.status, 'missing_fields');
});

test('missing upgrade resolution and installed scopes remain unclassified', async () => {
  const { captureCustomizations } = await import('../src/customizations.js');
  const result = await captureCustomizations({ sdk: readOnlySdk({ sys_metadata: metadata, sys_upgrade_history_log: [{ sys_id: 'log', name: 'sys_script_a', disposition: 'skipped' }] }) });
  assert.equal(result.categories.ootb_modifications.length, 0);
  assert.equal(result.categories.customer_app_artifacts.length, 0);
  assert.equal(result.categories.unclassified.length, 3);
});

test('strict SDK reads reject mutations, do not warm sessions, refresh expired OAuth or stamp credentials', async () => {
  const { SDKClient } = await import('../src/sdk.js');
  const { AuthManager } = await import('../src/auth.js');
  const auth = new AuthManager({ getEffectiveInstance: () => 'https://mock.example', getAuthMethod: () => 'oauth' }, { credentialStore: {
    load: () => ({ auth_method: 'oauth', access_token: 'fixture', refresh_token: 'fixture', expires_at: 1 }),
    save: () => assert.fail('credential write'),
  } });
  auth.refreshToken = () => assert.fail('OAuth refresh');
  const sdk = new SDKClient('https://mock.example', auth);
  sdk._warmSession = () => assert.fail('Session warm-up');
  await assert.rejects(sdk.list('sys_metadata', {}, { readOnly: true }), /expired/);
  const scopedSdk = new SDKClient('https://mock.example', auth.createProfileProvider('https://mock.example', { authMethod: 'oauth' }));
  await assert.rejects(scopedSdk.list('sys_metadata', {}, { readOnly: true }), /expired/);
  await assert.rejects(sdk.request('https://mock.example/api/now/table/sys_metadata', { readOnly: true, method: 'POST' }), /require GET/);
});

test('ACL failures retain prior pages and bounded pagination never implies completeness', async () => {
  const { captureCustomizations } = await import('../src/customizations.js');
  const limited = await captureCustomizations({ sdk: readOnlySdk({ sys_metadata: metadata }), pageSize: 1, maxPages: 1 });
  assert.equal(limited.coverage.sources.sys_metadata.status, 'limited');
  const sdk = readOnlySdk({ sys_metadata: metadata });
  const result = await captureCustomizations({ sdk: { async list(table, params) {
    if (table === 'sys_metadata' && Number(params.sysparm_offset) > 0) throw new Error('403 Forbidden');
    return sdk.list(table, params);
  } }, pageSize: 1, maxPages: 5 });
  assert.equal(result.coverage.sources.sys_metadata.status, 'permission_denied');
  assert.equal(result.categories.unclassified.length, 1);
  assert.equal(result.coverage.complete, false);
});
