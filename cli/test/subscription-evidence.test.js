import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscriptionEvidence, formatSubscriptionEvidence } from '../src/subscription-evidence.js';
import { SDKClient } from '../src/sdk.js';
import { subscriptionsCmd } from '../src/commands/subscriptions.js';
import yargs from '../src/cli-adapter.js';

function fixture() {
  const seen = [];
  return {
    seen,
    sdk: { baseURL: 'https://example.invalid', async request(endpoint, options) {
      const u = new URL(endpoint);
      seen.push({ u, options });
      assert.equal(options.method, 'GET');
      const query = u.searchParams.get('sysparm_query');
      const table = u.pathname.split('/').at(-1);
      if (table === 'sys_db_object') return { result: query === 'name=subscription_entitlement'
        ? [{ sys_id: 'a'.repeat(32), name: 'subscription_entitlement', super_class: '' }] : [] };
      if (table === 'sys_dictionary') return { result: [
        { name: 'subscription_entitlement', element: 'quantity', internal_type: 'integer', reference: '' },
        { name: 'subscription_entitlement', element: 'product_name', internal_type: 'string', reference: '' },
        { name: 'subscription_entitlement', element: 'customer', internal_type: 'string', reference: '' },
      ] };
      if (table === 'subscription_entitlement') return { result: [{ quantity: '12', product_name: 'Example Product', customer: 'private@example.invalid' }] };
      return { result: [] };
    } },
  };
}

test('bounded schema-gated evidence preserves quantities without identities or inferred rights', async () => {
  const { sdk, seen } = fixture();
  const report = await subscriptionEvidence(sdk);
  const source = report.entitlements.find(s => s.source === 'subscription_entitlement');
  assert.deepEqual(source.observations, [{ quantity: '12', product_name: 'Example Product' }]);
  assert.equal(source.status, 'observed');
  assert.equal(source.coverage.complete, false);
  assert.equal(report.authoritative, false);
  assert.equal(report.consumption.length, 3);
  assert.equal(report.access.status, 'unavailable');
  assert.ok(!JSON.stringify(report).includes('private@'));
  assert.ok(seen.every(r => r.options.readOnly === true));
  const fields = seen.find(r => r.u.pathname.endsWith('/subscription_entitlement')).u.searchParams.get('sysparm_fields');
  assert.equal(fields, 'quantity,product_name');
});

async function registered(sdk, args, requireInstance = () => {}) {
  let output;
  const app = { sdk, requireInstance, ok(data) { output = data; } };
  await yargs(['subscriptions', 'evidence', ...args]).command(subscriptionsCmd(fn => argv => fn(argv, app))).parse();
  return output;
}

test('registered evidence requires an instance and formats the shared report', async () => {
  const { sdk } = fixture();
  let required = false;
  const report = await registered(sdk, ['--limit', '1'], () => { required = true; });
  assert.equal(required, true);
  assert.equal(report.entitlements[1].observations.length, 1);
  assert.match(report._formatted, /quantity=12/);
  assert.ok(!JSON.stringify(report).includes('_formatted'));
  assert.match(formatSubscriptionEvidence(report), /Nonproduction installs do not prove production deployment/);
});

for (const limit of [0, -1, 201, 1.5, NaN, Infinity, '2']) test(`invalid evidence limit ${limit} refuses before I/O`, async () => {
  const { sdk, seen } = fixture();
  await assert.rejects(subscriptionEvidence(sdk, { limit }), { code: 'usage_error' });
  assert.equal(seen.length, 0);
});

function tableFixture({ table = 'subscription_detail', definitions, dictionary, observations = [], error, malformed = false } = {}) {
  const { sdk, seen } = fixture();
  const original = sdk.request;
  sdk.request = async (endpoint, options) => {
    const u = new URL(endpoint), target = u.pathname.split('/').at(-1), query = u.searchParams.get('sysparm_query');
    if (target === 'sys_db_object' && query === `name=${table}`) return { result: definitions || [{ sys_id: 'b'.repeat(32), name: table, super_class: '' }] };
    if (target === 'sys_dictionary' && query.startsWith(`name=${table}^`)) return { result: dictionary || [
      { name: table, element: 'count', internal_type: 'integer', reference: '' },
      { name: table, element: 'sys_updated_on', internal_type: 'glide_date_time', reference: '' },
    ] };
    if (target === table) {
      seen.push({ u, options });
      if (error) throw error;
      return malformed ? {} : { result: observations };
    }
    return original(endpoint, options);
  };
  return { sdk, seen };
}

test('ITOM sources expose observations only, with typed timestamp and sanitized extra fields', async () => {
  const { sdk } = tableFixture({ table: 'itom_lu_ci_counts', observations: [{ count: '9', sys_updated_on: '2026-01-02 03:04:05', user: 'private@example.invalid', ci: 'a'.repeat(32) }] });
  const report = await subscriptionEvidence(sdk);
  assert.deepEqual(report.consumption[0].observations, [{ count: '9', sys_updated_on: '2026-01-02 03:04:05' }]);
  assert.match(report.consumption[0].freshness.source_updated_on, /Per-row/);
  assert.ok(!JSON.stringify(report).includes('private@'));
  assert.ok(!Object.hasOwn(report, 'total_units'));
});

test('verified latest boolean is required before filtering allocation', async () => {
  const table = 'subscription_detail';
  const { sdk, seen } = tableFixture({ dictionary: [
    { name: table, element: 'is_latest', internal_type: 'boolean', reference: '' },
    { name: table, element: 'quantity', internal_type: 'integer', reference: '' },
    { name: table, element: 'product_name', internal_type: 'reference', reference: 'sys_user' },
  ], observations: [{ is_latest: 'true', quantity: '2', product_name: { value: 'a'.repeat(32), display_value: 'PRIVATE' } }] });
  const report = await subscriptionEvidence(sdk);
  const source = report.allocation[0];
  assert.equal(source.query, 'is_latest=true^ORDERBYsys_id');
  assert.deepEqual(source.observations, [{ is_latest: true, quantity: '2' }]);
  assert.deepEqual(source.schema.references, [{ table, field: 'product_name', target: 'sys_user' }]);
  assert.ok(!seen.find(r => r.u.pathname.endsWith(`/${table}`)).u.searchParams.get('sysparm_fields').includes('product_name'));
});

test('without latest metadata allocation stays an observation, not current allocation', async () => {
  const { sdk } = tableFixture();
  const report = await subscriptionEvidence(sdk);
  assert.equal(report.allocation[0].status, 'no-visible-rows');
  assert.equal(report.allocation[0].query, 'ORDERBYsys_id');
  assert.match(report.allocation[0].latest_filter, /not established/);
});

for (const [label, options, expected] of [
  ['forbidden', { error: Object.assign(new Error('private@example.invalid'), { status: 403 }) }, 'forbidden'],
  ['missing', { error: Object.assign(new Error('private@example.invalid'), { status: 404 }) }, 'missing-or-hidden'],
  ['other', { error: Object.assign(new Error('private@example.invalid'), { code: 'private@example.invalid' }) }, 'unavailable'],
  ['malformed', { malformed: true }, 'malformed'],
  ['ambiguous schema', { definitions: [{}, {}] }, 'ambiguous-schema'],
  ['bad schema', { definitions: [{}] }, 'malformed'],
  ['dictionary cap', { dictionary: Array.from({ length: 201 }, () => ({})) }, 'metadata-cap'],
]) test(`${label} is unavailable, not zero, and does not echo provider text`, async () => {
  const { sdk } = tableFixture(options);
  const report = await subscriptionEvidence(sdk);
  assert.equal(report.allocation[0].reason, expected);
  assert.equal(report.allocation[0].observations, null);
  assert.ok(!JSON.stringify(report).includes('private@'));
});

test('authentication failure is terminal and sanitized', async () => {
  const { sdk } = tableFixture({ error: Object.assign(new Error('private@example.invalid'), { status: 401 }) });
  await assert.rejects(subscriptionEvidence(sdk), e => e.code === 'auth_error' && !e.message.includes('private@'));
});

test('overflow is bounded and null field values are not converted into zero', async () => {
  const { sdk } = tableFixture({ observations: [{ count: '', sys_updated_on: 'private@example.invalid' }, { count: '3' }] });
  const report = await subscriptionEvidence(sdk, { limit: 1 });
  assert.deepEqual(report.allocation[0].observations, [{ count: null, sys_updated_on: null }]);
  assert.equal(report.allocation[0].coverage.truncated, true);
  assert.equal(report.allocation[0].coverage.complete, false);
});

test('SDK transport uses GET-only requests and rejects malformed source envelopes', async t => {
  const fake = tableFixture({ malformed: true });
  const sdk = new SDKClient('https://example.invalid', {});
  sdk._setAuth = async () => {};
  t.mock.method(globalThis, 'fetch', async request => {
    assert.equal(request.method, 'GET');
    return new Response(JSON.stringify(await fake.sdk.request(request.url, { method: request.method, readOnly: true })), { status: 200 });
  });
  const report = await subscriptionEvidence(sdk);
  assert.equal(report.allocation[0].reason, 'malformed');
  assert.ok(report.request_budget.used.metadata <= report.request_budget.limits.metadata_requests);
  assert.ok(report.request_budget.used.data <= report.request_budget.limits.data_requests);
});


test('hidden reference metadata must not authorize a potentially identifying field', async () => {
  const table = 'subscription_detail';
  const { sdk } = tableFixture({ dictionary: [{ name: table, element: 'product_name', internal_type: 'string' }], observations: [{ product_name: 'Private Customer' }] });
  const report = await subscriptionEvidence(sdk);
  assert.equal(report.allocation[0].status, 'unavailable');
  assert.equal(report.allocation[0].observations, null);
});

test('inventory errors cannot leak arbitrary provider error codes', async () => {
  const table = 'v_plugin';
  const { sdk } = tableFixture({ table, dictionary: ['sys_id', 'id', 'name', 'version', 'active'].map(element => ({ name: table, element, internal_type: 'string', reference: '' })) });
  const original = sdk.request;
  sdk.request = (endpoint, options) => endpoint.includes('/stats/v_plugin')
    ? Promise.reject(Object.assign(new Error('private@example.invalid'), { code: 'private@example.invalid' })) : original(endpoint, options);
  const report = await subscriptionEvidence(sdk);
  assert.equal(report.installed_hints[1].reason, 'unavailable');
  assert.ok(!JSON.stringify(report).includes('private@'));
});

test('nearest dictionary definitions preserve inherited quantity without inventing joins', async () => {
  const { sdk } = tableFixture({ definitions: [{ sys_id: 'b'.repeat(32), name: 'subscription_detail', super_class: 'c'.repeat(32) }], dictionary: [{ name: 'subscription_detail', element: 'status', internal_type: 'string', reference: '' }], observations: [{ quantity: '4', status: 'active' }] });
  const original = sdk.request;
  sdk.request = (endpoint, options) => {
    const u = new URL(endpoint), q = u.searchParams.get('sysparm_query');
    if (q === `sys_id=${'c'.repeat(32)}`) return { result: [{ sys_id: 'c'.repeat(32), name: 'base_subscription', super_class: '' }] };
    if (q === 'name=base_subscription^elementISNOTEMPTY^ORDERBYelement') return { result: [{ name: 'base_subscription', element: 'quantity', internal_type: 'integer', reference: '' }] };
    return original(endpoint, options);
  };
  const report = await subscriptionEvidence(sdk);
  assert.deepEqual(report.allocation[0].observations, [{ status: 'active', quantity: '4' }]);
  assert.deepEqual(report.allocation[0].schema.hierarchy, ['subscription_detail', 'base_subscription']);
});

test('cyclic schema ancestry does not permit data reads', async () => {
  const { sdk, seen } = tableFixture({ definitions: [{ sys_id: 'b'.repeat(32), name: 'subscription_detail', super_class: 'b'.repeat(32) }] });
  const original = sdk.request;
  sdk.request = (endpoint, options) => new URL(endpoint).searchParams.get('sysparm_query') === `sys_id=${'b'.repeat(32)}`
    ? { result: [{ sys_id: 'b'.repeat(32), name: 'subscription_detail', super_class: 'b'.repeat(32) }] } : original(endpoint, options);
  const report = await subscriptionEvidence(sdk);
  assert.equal(report.allocation[0].reason, 'malformed');
  assert.ok(!seen.some(r => r.u.pathname.endsWith('/subscription_detail')));
});

test('all sources share a hard metadata request budget', async () => {
  let actual = 0;
  const sdk = { baseURL: 'https://example.invalid', request: async endpoint => {
    actual++;
    const u = new URL(endpoint), q = u.searchParams.get('sysparm_query');
    if (u.pathname.endsWith('/sys_dictionary')) return { result: [] };
    const name = q.startsWith('name=') ? q.slice(5) : `ancestor_${actual}`;
    return { result: [{ sys_id: actual.toString(16).padStart(32, '0'), name, super_class: (actual + 1).toString(16).padStart(32, '0') }] };
  } };
  const report = await subscriptionEvidence(sdk);
  assert.equal(actual, 96);
  assert.equal(report.request_budget.used.metadata, 96);
  assert.equal(report.request_budget.used.data, 0);
  assert.ok(report.consumption.some(s => s.reason === 'request-budget'));
});


test('real CLI discovery, JSON, extraction, text, invalid limit and missing instance work offline', t => {
  const home = mkdtempSync(join(tmpdir(), 'jsn-evidence-cli-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const script = `
    import { SDKClient } from ${JSON.stringify(new URL('../src/sdk.js', import.meta.url).href)};
    import { buildCLI } from ${JSON.stringify(new URL('../src/cli.js', import.meta.url).href)};
    SDKClient.prototype._setAuth = async () => {};
    globalThis.fetch = async request => {
      if (request.method !== 'GET') throw Error('unexpected write');
      const url = new URL(request.url);
      if (url.hostname !== 'example.invalid') throw Error('unexpected destination');
      const table = url.pathname.split('/').at(-1);
      let rows = [];
      if (table === 'sys_db_object' && url.searchParams.get('sysparm_query') === 'name=subscription_entitlement') rows = [{ sys_id: 'a'.repeat(32), name: 'subscription_entitlement', super_class: '' }];
      if (table === 'sys_dictionary') rows = [{ name: 'subscription_entitlement', element: 'quantity', internal_type: 'integer', reference: '' }];
      if (table === 'subscription_entitlement') rows = [{ quantity: '12' }];
      return new Response(JSON.stringify({ result: rows }));
    };
    process.argv = ['node', 'jsn', 'subscriptions', ...JSON.parse(process.env.EVIDENCE_ARGS)];
    await buildCLI().parse();
  `;
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home,
    SERVICENOW_INSTANCE_URL: '', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' };
  const run = args => spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8', timeout: 15000, env: { ...env, EVIDENCE_ARGS: JSON.stringify(args) },
  });
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /evidence/);
  const json = run(['evidence', '--instance', 'https://example.invalid', '--json']);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).data.entitlements[1].observations[0].quantity, '12');
  const get = run(['evidence', '--instance', 'https://example.invalid', '--get', 'data.entitlements[1].observations[0].quantity']);
  assert.equal(get.status, 0, get.stderr);
  assert.equal(JSON.parse(get.stdout), '12');
  const human = run(['evidence', '--instance', 'https://example.invalid', '--styled']);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /quantity=12/);
  for (const limit of ['0', '201', '1.5', 'NaN', 'Infinity']) {
    const invalid = run(['evidence', '--limit', limit, '--json']);
    assert.notEqual(invalid.status, 0, limit);
    assert.match(invalid.stdout + invalid.stderr, /limit.*integer|Invalid.*limit/i);
  }
  const missing = run(['evidence', '--json']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout + missing.stderr, /instance/i);
});

for (const kind of ['store', 'plugins']) test(`${kind} installed inventory remains a bounded hint`, async () => {
  const table = kind === 'store' ? 'sys_store_app' : 'v_plugin';
  const names = kind === 'store' ? ['sys_id', 'scope', 'name', 'version', 'active', 'install_date'] : ['sys_id', 'id', 'name', 'version', 'active'];
  const { sdk } = tableFixture({ table, dictionary: names.map(element => ({ name: table, element, internal_type: 'string', reference: '' })) });
  const original = sdk.request;
  sdk.request = (endpoint, options) => {
    if (endpoint.includes(`/stats/${table}?`)) return { result: { stats: { count: '1' } } };
    if (new URL(endpoint).pathname.endsWith(`/${table}`)) return { result: [{ sys_id: 'a'.repeat(32), id: 'example.plugin', scope: 'example_app', name: 'Example Product', version: '1.0', active: kind === 'plugins' ? 'active' : 'true', install_date: '2026-01-01' }] };
    return original(endpoint, options);
  };
  const report = await subscriptionEvidence(sdk, { limit: 1 });
  const source = report.installed_hints.find(s => s.kind === kind);
  assert.equal(source.status, 'observed');
  assert.equal(source.observations[0].name, 'Example Product');
  assert.equal(source.observations[0].active, true);
  assert.equal(source.coverage.complete, false);
  assert.ok(!JSON.stringify(source.observations).includes('a'.repeat(32)));
});


test('Store inventory does not request optional fields absent from verified metadata', async () => {
  const table = 'sys_store_app', names = ['sys_id', 'scope', 'name', 'version', 'active', 'install_date'];
  const { sdk } = tableFixture({ table, dictionary: names.map(element => ({ name: table, element, internal_type: 'string', reference: '' })) });
  const original = sdk.request;
  let projection;
  sdk.request = (endpoint, options) => {
    if (endpoint.includes('/stats/sys_store_app?')) return { result: { stats: { count: '1' } } };
    if (new URL(endpoint).pathname.endsWith('/sys_store_app')) {
      projection = new URL(endpoint).searchParams.get('sysparm_fields');
      return { result: [] };
    }
    return original(endpoint, options);
  };
  await subscriptionEvidence(sdk);
  assert.equal(projection, names.join(','));
});

test('hidden parent metadata is not treated as a verified root', async () => {
  const { sdk } = tableFixture({ definitions: [{ sys_id: 'b'.repeat(32), name: 'subscription_detail', super_class: null }] });
  const report = await subscriptionEvidence(sdk);
  assert.equal(report.allocation[0].status, 'unavailable');
});


test('real SDK Store table 403 falls back only to installed-tab POST discovery', async t => {
  const table = 'sys_store_app';
  const fake = tableFixture({ table, dictionary: ['sys_id', 'scope', 'name', 'version', 'active', 'install_date'].map(element => ({ name: table, element, internal_type: 'string', reference: '' })) });
  const sdk = new SDKClient('https://example.invalid', { touchLastSeen() { assert.fail('evidence must not touch credential metadata'); } });
  sdk._setAuth = async () => {};
  const calls = [];
  t.mock.method(globalThis, 'fetch', async request => {
    const url = new URL(request.url);
    calls.push({ method: request.method, path: url.pathname });
    assert.equal(url.origin, 'https://example.invalid');
    if (url.pathname === '/api/now/stats/sys_store_app') return Response.json({ result: { stats: { count: '1' } } });
    if (url.pathname === '/api/now/table/sys_store_app') return new Response('forbidden', { status: 403 });
    if (url.pathname === '/api/sn_appclient/appmanager/apps') {
      assert.equal(request.method, 'POST');
      assert.equal(await request.text(), '{}');
      assert.equal(url.search, '?tab_context=installed&sysparm_limit=200&sysparm_offset=0');
      return Response.json({ result: { apps: [{ sys_id: 'd'.repeat(32), scope: 'example_app', name: 'Example Product', version: '1.0', isInstalled: true }] } });
    }
    assert.equal(request.method, 'GET');
    return Response.json(await fake.sdk.request(request.url, { method: request.method, readOnly: true }));
  });
  const report = await subscriptionEvidence(sdk);
  const source = report.installed_hints.find(s => s.kind === 'store');
  assert.equal(source.status, 'observed');
  assert.equal(source.observations[0].name, 'Example Product');
  assert.equal(source.observations[0].installed, true);
  assert.equal(source.observations[0].installation_evidence, 'appclient_installed_tab');
  assert.equal(source.coverage.complete, false);
  assert.deepEqual(calls.filter(c => c.method === 'POST'), [{ method: 'POST', path: '/api/sn_appclient/appmanager/apps' }]);
});

test('unsafe POST variants are rejected before real SDK transport', async t => {
  const { requestSubscriptionEvidence } = await import('../src/subscription-evidence.js');
  assert.equal(typeof requestSubscriptionEvidence, 'function');
  const sdk = new SDKClient('https://example.invalid', {});
  let calls = 0;
  sdk._setAuth = async () => { assert.fail('unsafe requests must not authenticate'); };
  t.mock.method(globalThis, 'fetch', async () => { calls++; assert.fail('unsafe requests must not reach transport'); });
  const path = '/api/sn_appclient/appmanager/apps?tab_context=installed&sysparm_limit=200&sysparm_offset=0';
  for (const [endpoint, options] of [
    ['https://example.invalid/api/now/table/incident', { method: 'POST', body: '{}' }],
    ['https://example.invalid/api/sn_appclient/appmanager/app/install', { method: 'POST', body: '{}' }],
    ['https://example.invalid/api/sn_appclient/appmanager/app/install?app_id=example', { method: 'GET' }],
    ['https://example.invalid/api/sn_appclient/appmanager/app/update?app_id=example', { method: 'GET' }],
    ['https://example.invalid' + path.replace('installed', 'available_for_you'), { method: 'POST', body: '{}' }],
    ['https://example.invalid' + path + '&other=1', { method: 'POST', body: '{}' }],
    ['https://example.invalid' + path.replace('offset=0', 'offset=200'), { method: 'POST', body: '{}' }],
    ['https://other.invalid' + path, { method: 'POST', body: '{}' }],
    ['https://example.invalid' + path, { method: 'POST', body: '{"install":true}' }],
    ['https://example.invalid' + path, { method: 'DELETE', body: '{}' }],
    ['https://example.invalid' + path, { method: 'POST', body: '{}', readOnly: false }],
  ]) await assert.rejects(requestSubscriptionEvidence(sdk, endpoint, options), { code: 'unsafe-evidence-request' });
  assert.equal(calls, 0);
});
