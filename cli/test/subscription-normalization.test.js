import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { scheduleCatalog, loadSchedule } from '../src/subscriptions.js';

const run = (...args) => spawnSync(process.execPath, ['bin/jsn.js', 'subscriptions', 'schedules', ...args], {
  encoding: 'utf8', timeout: 15000,
  env: { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1', HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1' },
});
test('human inspect exposes rewritten rules, definitions and section provenance without JSON scaffolding', () => {
  const r = run('--id', 'servicenow-otto-overview', '--styled');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DEFINITIONS/);
  assert.match(r.stdout, /USAGE RULES/);
  assert.match(r.stdout, /Action Fabric record reads.*100 records.*1 Assist/);
  assert.match(r.stdout, /Work notes analysis for small transitions.*fewer than 25.*100 Assist/);
  assert.match(r.stdout, /SOURCE SECTIONS/);
  assert.doesNotMatch(r.stdout, /"normalization_status":/);
});
test('all indexed documents have substantive rewrites and only source-conflicted USEM remains partial', () => {
  const all = scheduleCatalog();
  assert.equal(all.length, 32);
  const inventory = all.filter(r => r.index_url);
  assert.equal(inventory.length, 31);
  assert.equal(new Set(all.map(r => r.source_url)).size, 28);
  assert.equal(new Set(all.map(r => r.id)).size, 32);
  assert.equal(inventory.filter(r => r.normalization_status === 'normalized').length, 30);
  assert.deepEqual(inventory.filter(r => r.normalization_status !== 'normalized').map(r => r.id), ['unified-security-exposure-management-servicenow-subscription-unit-overview']);
  for (const r of inventory) {
    assert.ok(r.scope, r.id);
    assert.ok(r.definitions.length, r.id);
    assert.ok(r.source_sections.length, r.id);
    assert.equal(r.provenance.source_url, r.source_url);
    assert.equal(r.provenance.effective_date, r.effective_date);
    assert.deepEqual(r.section_coverage.omitted_sections, [], r.id);
    assert.equal(r.measurement, 'unimplemented');
    assert.equal(r.source_pdf_sha256, null);
  }
});
test('literal unusual ratio direction and conflicting USEM conversions are never silently repaired', () => {
  const eam = loadSchedule('sn-enterprise-asset-management');
  assert.deepEqual(eam.meter.ratios[0], { resource: 'Consumable', subscription_units: 25, resource_quantity: 1, source_ratio_su_to_resource: '25:1' });
  const otam = loadSchedule('otam-servicenow-subscription-unit-overview');
  assert.equal(otam.meter.ratios.find(r => r.resource === 'OT End User Computers').source_ratio_su_to_resource, '4:1');
  const usem = loadSchedule('unified-security-exposure-management-servicenow-subscription-unit-overview');
  assert.equal(usem.meter.status, 'ambiguous_source');
  assert.deepEqual(usem.meter.source_rows.find(r => r.resource === 'PaaS Resource'), { resource: 'PaaS Resource', left_resource_count: 3, right_subscription_units: 1, right_parenthetical: '1:1' });
  assert.equal(usem.meter.ratios, undefined);
});
test('historical multi-product sections stay separately selectable with product-specific applicability', () => {
  const sam = loadSchedule('servicenow-subscription-unit-overview-sam');
  const ham = loadSchedule('servicenow-subscription-unit-overview-ham');
  const tnpm = loadSchedule('servicenow-subscription-unit-overview-tnpm');
  assert.match(sam.scope, /Now Buying Program ONLY/);
  assert.equal(sam.source_url, ham.source_url);
  assert.equal(ham.source_url, tnpm.source_url);
  assert.equal(tnpm.meter.ratios.find(r => r.resource === 'Container').resources_per_su, 3);
});
test('credit windows, bundled capability limits and complete legacy matrix survive structured inspection', () => {
  const otto = loadSchedule('servicenow-otto-overview');
  assert.equal(otto.meter.rules.length, 285);
  assert.equal(otto.meter.rules.find(r => r.skill === 'App generation').assists, 2500);
  assert.equal(otto.meter.rules.find(r => r.skill === 'Action Fabric record reads').assists, 1);
  assert.match(otto.meter.rules.find(r => r.skill === 'Action Fabric record reads').action, /excludes/);
  assert.equal(otto.meter.rules.find(r => r.skill === 'Voice agents').assists, null);
  const factory = loadSchedule('servicenow-ai-workflow-factory-credit-overview');
  assert.match(factory.meter.rules.find(r => r.capability === 'Developer Sandbox').usage, /Peak/);
  assert.equal(loadSchedule('data-fabric-credit-overview').meter.rules.find(r => r.capability === 'Data Access Requests').quantity_per_event, 200);
  assert.equal(loadSchedule('wdf-foundation-overview').meter.unit, null);
  assert.equal(loadSchedule('custom-table-guide').meter.limits.many_to_many_custom_fields, 3);
  const hub = loadSchedule('snc-addendum-integrationhub');
  assert.equal(hub.packages.length, 22);
  assert.equal(hub.packages.find(r => r.name === 'Integration Hub Starter V4').api_access_volume_per_day, '300 MB');
  assert.ok(scheduleCatalog({ sku: 'PROD19397' }).some(r => r.id === hub.id));
  const result = run('--id', otto.id, '--get', 'data.schedules[0].meter.rules[23].assists');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout), 2500);
});
