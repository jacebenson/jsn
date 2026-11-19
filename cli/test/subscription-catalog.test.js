import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { scheduleCatalog, loadSchedule, estimateSubscription } from '../src/subscriptions.js';

const run = (...args) => spawnSync(process.execPath, ['bin/jsn.js', 'subscriptions', ...args], { encoding: 'utf8', env: { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1', HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1' }, timeout: 15000 });
test('site canonical records and packaged offline snapshots cannot diverge', () => {
  for (const name of ['public-inventory.json', 'itom-2026-04-09.json']) assert.equal(readFileSync(new URL(`../src/schedules/${name}`, import.meta.url), 'utf8'), readFileSync(new URL(`../../site/config/subscription-schedules/${name}`, import.meta.url), 'utf8'));
});
test('inventory reconciles unique public URLs with explicit incomplete normalization', () => {
  const all = scheduleCatalog();
  const inventory = all.filter(s => s.index_url);
  assert.equal(inventory.length, 28);
  assert.equal(new Set(inventory.map(s => s.source_url)).size, 28);
  for (const s of inventory) {
    assert.match(s.source_url, /^https:\/\/www.servicenow.com\/.*\.pdf$/);
    assert.equal(s.retrieval_status, 'extracted');
    assert.ok(s.retrieved_at);
    assert.ok(s.applicability);
    assert.ok(s.unknowns.length);
    assert.equal(s.measurement, 'unimplemented');
  }
  assert.equal(inventory.filter(s => s.normalization_status === 'pending').length, 25);
});
test('exact historical selection retains independent ratios without running current adapter', async () => {
  const old = loadSchedule('servicenow-subscription-unit-overview');
  assert.equal(old.meter.resources.find(r => r.name === 'container').resources_per_unit, 3);
  await assert.rejects(estimateSubscription(null, 'ITOM', { schedule: old.id }), { code: 'measurement_unavailable' });
  await assert.rejects(estimateSubscription(null, 'API'), { code: 'measurement_unavailable' });
  await assert.rejects(estimateSubscription(null, 'UNKNOWN-SKU'), { code: 'unsupported_product' });
});
test('actual CLI offline product/version/SKU filters, provenance and extraction', () => {
  let r = run('schedules', '--product', 'ITOM', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).data.schedules.length, 3);
  r = run('schedules', '--sku', 'PROD26897', '--get', 'data.schedules[0].id');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /snc-addendum-integrationhub/);
  r = run('schedules', '--id', 'api-servicenow-subscription-unit-overview', '--styled');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /cmdb_ci_api/);
  assert.match(r.stdout, /servicenow.com/);
  r = run('schedules', '--sku', 'UNKNOWN', '--json');
  assert.deepEqual(JSON.parse(r.stdout).data.schedules, []);
  r = run('estimate', 'API');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Known catalog product/);
  r = run('estimate', 'UNKNOWN-SKU');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No verified product meter/);
  r = run('estimate', 'ITOM', '--schedule', 'servicenow-subscription-unit-overview');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /catalog-only/);
});
