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

// Sanitized Table API rows observed on pdi, 2026-10-14. No payloads or credentials.
// sys_choice confirms 4/104 = Skipped/Skipped (second pass) and
// reviewed_reverted = Reviewed and Reverted; labels are not raw values.
const providerRows = JSON.parse(fs.readFileSync(new URL('./fixtures/customizations-provider.json', import.meta.url), 'utf8'));
test('observed provider file_name joins metadata update name and raw skip/resolution choices drive classification', async () => {
  const { captureCustomizations } = await import('../src/customizations.js');
  const capture = rows => captureCustomizations({ sdk: readOnlySdk(rows) });
  const result = await capture(providerRows);
  assert.equal(result.categories.ootb_modifications.length, 1);
  assert.equal(result.categories.ootb_modifications[0].identity.table, 'sys_security_acl');
  assert.equal(result.categories.ootb_modifications[0].evidence.at(-1).disposition, '4');
  assert.equal(result.coverage.sources.sys_upgrade_history_log.status, 'exhausted');
  assert.equal(result.coverage.unmatched_upgrade_records, 0);
  for (const [disposition, resolution, expected] of [
    ['104', '', 1], ['4', 'reviewed_retained', 1], ['4', 'reviewed_reverted', 0],
    ['7', '', 0], ['11', '', 0], ['skipped', '', 0],
  ]) {
    const rows = structuredClone(providerRows);
    rows.sys_upgrade_history_log[0].disposition = { value: disposition, display_value: 'Skipped' };
    rows.sys_upgrade_history_log[0].resolution_status = { value: resolution, display_value: 'Reviewed and Retained' };
    assert.equal((await capture(rows)).categories.ootb_modifications.length, expected, `${disposition}/${resolution}`);
  }
  const hidden = structuredClone(providerRows);
  delete hidden.sys_upgrade_history_log[0].file_name;
  const missing = await capture(hidden);
  assert.equal(missing.coverage.sources.sys_upgrade_history_log.status, 'missing_fields');
  assert.equal(missing.categories.ootb_modifications.length, 0);
});

test('customization summaries group by file type by default and support scope/updater grouping and group expansion', async () => {
  const { captureReport, formatReport } = await import('../src/customizations.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-customizations-groups-'));
  try {
    const report = await captureReport({ sdk: readOnlySdk({
      sys_scope: [{ sys_id: 'scope-a', scope: 'x_acme_a', name: 'A' }],
      sys_metadata: [
        { sys_id: 'one', sys_name: 'One', sys_update_name: 'sys_script_one', sys_scope: 'scope-a', sys_class_name: 'sys_script', sys_updated_by: 'alice' },
        { sys_id: 'two', sys_update_name: 'sys_script_two', sys_scope: 'scope-a', sys_class_name: 'sys_script_include', sys_updated_by: 'bob' },
      ],
    }), instance: 'https://mock.example', dir });
    const summary = formatReport(report);
    assert.match(summary, /GROUPED BY FILE TYPE/);
    assert.match(summary, /Script \(1\)/);
    assert.match(summary, /Script Include \(1\)/);
    assert.match(summary, /--filter <group-name>/);
    assert.match(summary, /--group-by updated-by/);
    assert.match(formatReport(report, { groupBy: 'scope' }), /x_acme_a \(2\)/);
    assert.match(formatReport(report, { groupBy: 'updated-by' }), /alice \(1\)/);
    assert.match(formatReport(report, { groupBy: 'updated-by' }), /bob \(1\)/);
    const expanded = formatReport(report, { filter: 'sys_script_include' });
    assert.match(expanded, /Script Include:two Two/);
    assert.match(expanded, /Filtered by type: sys_script_include/);
    assert.throws(() => formatReport(report, { groupBy: 'publisher' }), /group-by must be one of/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const metadata = [
  { sys_id: 'a', sys_update_name: 'sys_script_a', sys_name: 'Vendor rule', sys_scope: 'global', sys_class_name: 'sys_script', sys_updated_on: '2026-01-01' },
  { sys_id: 'b', sys_update_name: 'sys_script_b', sys_name: 'Our rule', sys_scope: 'ours', sys_class_name: 'sys_script' },
  { sys_id: 'c', sys_update_name: 'sys_script_c', sys_name: 'Store rule', sys_scope: 'store', sys_class_name: 'sys_script' },
];
function readOnlySdk(rows = {}) {
  // The Stats API count is the completeness evidence a capture relies on; the
  // mock answers it for the same visible population it pages through.
  const target = {
    async list(table, params) {
      const all = rows[table] || [];
      return all.slice(Number(params.sysparm_offset), Number(params.sysparm_offset) + Number(params.sysparm_limit));
    },
    async aggregateCount(table) { return (rows[table] || []).length; },
  };
  return new Proxy(target, {
    get(t, key) {
      if (key === 'list') return t.list;
      if (key === 'aggregateCount') return t.aggregateCount;
      if (key === 'listStrict') return undefined;
      throw new Error(`Forbidden SDK operation: ${String(key)}`);
    },
  });
}

test('capture uses only table reads and separates evidenced historical OOTB changes from declared customer scopes', async () => {
  const { captureCustomizations } = await import('../src/customizations.js');
  const result = await captureCustomizations({ sdk: readOnlySdk({
    sys_metadata: metadata,
    sys_scope: [{ sys_id: 'ours', scope: 'x_acme_ours', name: 'Ours' }, { sys_id: 'store', scope: 'sn_store', name: 'Vendor' }],
    sys_upgrade_history_log: [{ sys_id: 'log', file_name: 'sys_script_a', disposition: '4', resolution_status: 'reviewed_retained' }],
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
  const missingJoin = await captureCustomizations({ sdk: readOnlySdk({ sys_metadata: [{ sys_id: 'join-hidden', sys_class_name: 'sys_script', sys_scope: 'global' }] }) });
  assert.equal(missingJoin.coverage.sources.sys_metadata.status, 'missing_fields');
});

test('missing upgrade resolution and installed scopes remain unclassified', async () => {
  const { captureCustomizations } = await import('../src/customizations.js');
  const result = await captureCustomizations({ sdk: readOnlySdk({ sys_metadata: metadata, sys_upgrade_history_log: [{ sys_id: 'log', file_name: 'sys_script_a', disposition: '4' }] }) });
  assert.equal(result.categories.ootb_modifications.length, 0);
  assert.equal(result.categories.customer_app_artifacts.length, 0);
  assert.equal(result.categories.unclassified.length, 3);
});

test('read-only data requests preserve OAuth refresh and session bootstrap while rejecting record mutations', async t => {
  const { SDKClient } = await import('../src/sdk.js');
  const { AuthManager } = await import('../src/auth.js');
  let creds = { auth_method: 'oauth', access_token: 'expired-fixture', refresh_token: 'fixture', expires_at: 1 };
  let saves = 0;
  const auth = new AuthManager({ getEffectiveInstance: () => 'https://mock.example', getAuthMethod: () => 'oauth' }, { credentialStore: {
    load: () => creds,
    save: (_instance, refreshed) => { creds = refreshed; saves++; },
  } });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input, opts) => {
    const req = input instanceof Request ? input : new Request(input, opts);
    const url = new URL(req.url);
    requests.push(`${req.method} ${url.pathname}`);
    if (url.pathname === '/oauth_token.do') {
      assert.equal(new URLSearchParams(await req.text()).get('grant_type'), 'refresh_token');
      return Response.json({ access_token: 'fresh-fixture', refresh_token: 'fixture', expires_in: 3600 });
    }
    if (url.pathname === '/angular.do') {
      return new Response('{}', { headers: { 'set-cookie': 'JSESSIONID=fixture; Path=/', 'x-usertoken-response': 'fixture-gck' } });
    }
    if (url.pathname === '/api/now/table/sys_scope') {
      assert.equal(req.headers.get('Authorization'), 'Bearer fresh-fixture');
      return Response.json({ result: [{ sys_id: 'global' }] });
    }
    assert.equal(req.method, 'GET');
    assert.equal(url.pathname, '/api/now/table/sys_metadata');
    assert.equal(req.headers.get('Cookie'), 'JSESSIONID=fixture');
    assert.equal(req.headers.get('X-UserToken'), 'fixture-gck');
    assert.equal(req.headers.get('Authorization'), null);
    return Response.json({ result: metadata });
  });
  const sdk = new SDKClient('https://mock.example', auth.createProfileProvider('https://mock.example', { authMethod: 'oauth' }));
  assert.deepEqual(await sdk.list('sys_metadata', {}, { readOnly: true }), metadata);
  assert.equal(saves, 1);
  assert.deepEqual(requests, ['POST /oauth_token.do', 'POST /angular.do', 'GET /api/now/table/sys_scope', 'POST /angular.do', 'GET /api/now/table/sys_metadata']);
  const count = requests.length;
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    await assert.rejects(sdk.request('https://mock.example/api/now/table/sys_metadata', { readOnly: true, method }), /require GET/);
  }
  assert.equal(requests.length, count);
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

// Defect 1: a page shorter than the requested size is not proof of exhaustion.
// Live pdi returns short offset pages while 621969 sys_metadata rows are visible.
const captureRows = ids => ids.map(id => ({ sys_id: id, sys_class_name: 'sys_script', sys_scope: 'global', sys_update_name: `sys_script_${id}` }));
function shortPageSdk({ rows, count }) {
  return {
    async list(table, params) {
      if (table !== 'sys_metadata') return [];
      return Number(params.sysparm_offset) === 0 ? rows : [];
    },
    ...(count === undefined ? {} : { async aggregateCount(table) { return table === 'sys_metadata' ? count : 0; } }),
  };
}

test('a short page never implies exhaustion and coverage reports rows fetched against the Stats API count', async () => {
  const { captureCustomizations } = await import('../src/customizations.js');
  const rows = captureRows(['a', 'b', 'c']);
  const partial = await captureCustomizations({ sdk: shortPageSdk({ rows, count: 621969 }), pageSize: 100, maxPages: 10 });
  const coverage = partial.coverage.sources.sys_metadata;
  assert.notEqual(coverage.status, 'exhausted');
  assert.equal(coverage.status, 'limited');
  assert.equal(coverage.fetched, 3);
  assert.equal(coverage.available, 621969);
  assert.match(coverage.reason, /3 of 621969/);
  const complete = await captureCustomizations({ sdk: shortPageSdk({ rows, count: rows.length }), pageSize: 100, maxPages: 10 });
  assert.equal(complete.coverage.sources.sys_metadata.status, 'exhausted');
  assert.equal(complete.coverage.sources.sys_metadata.available, rows.length);
  const uncounted = await captureCustomizations({ sdk: shortPageSdk({ rows }), pageSize: 100, maxPages: 10 });
  assert.equal(uncounted.coverage.sources.sys_metadata.status, 'limited');
  assert.equal(uncounted.coverage.sources.sys_metadata.available, null);
  assert.match(uncounted.coverage.sources.sys_metadata.reason, /unavailable/i);
});

// Defect 2: the live pdi table holds 425 rows with raw disposition 4 or 104
// behind 334670 other rows, so an unfiltered read spends the whole budget
// before reaching any preserved-customization evidence.
test('upgrade history is read with a server-side disposition filter so skipped customizations survive a default budget', async () => {
  const { captureCustomizations } = await import('../src/customizations.js');
  const noise = Array.from({ length: 400 }, (_, index) => ({ sys_id: `noise-${String(index).padStart(4, '0')}`, file_name: `noise_${index}`, disposition: '1', resolution_status: '' }));
  const logRows = [...noise, { sys_id: 'skip-4', file_name: 'sys_script_a', disposition: '4', resolution_status: '' }, { sys_id: 'skip-104', file_name: 'sys_script_orphan', disposition: '104', resolution_status: '' }];
  const metadataRows = [{ sys_id: 'a', sys_update_name: 'sys_script_a', sys_name: 'Vendor rule', sys_scope: 'global', sys_class_name: 'sys_script', sys_updated_on: '2026-01-01' }];
  const queries = [];
  const visible = (table, query) => {
    if (table === 'sys_metadata') return metadataRows;
    if (table === 'sys_upgrade_history_log') return query.includes('dispositionIN4,104') ? logRows.filter(row => ['4', '104'].includes(row.disposition)) : logRows;
    return [];
  };
  const result = await captureCustomizations({ sdk: {
    async list(table, params) {
      queries.push({ table, query: params.sysparm_query });
      const offset = Number(params.sysparm_offset);
      return visible(table, params.sysparm_query).slice(offset, offset + Number(params.sysparm_limit));
    },
    async aggregateCount(table, query = '') { return visible(table, query).length; },
  } });
  assert.equal(result.categories.ootb_modifications.length, 1);
  assert.equal(result.categories.ootb_modifications[0].identity.sys_id, 'a');
  assert.equal(result.categories.ootb_modifications[0].evidence.at(-1).disposition, '4');
  const historyQuery = queries.find(entry => entry.table === 'sys_upgrade_history_log').query;
  assert.match(historyQuery, /dispositionIN4,104/);
  assert.equal(result.coverage.sources.sys_upgrade_history_log.status, 'exhausted');
  assert.equal(result.coverage.sources.sys_upgrade_history_log.fetched, 2);
  assert.equal(result.coverage.sources.sys_upgrade_history_log.available, 2);
  // Unmatched counts stay honest about the filtered population.
  assert.equal(result.coverage.unmatched_upgrade_records, 1);
});

// Defect 6: the broad sys_metadata read is an arbitrary sys_id-ordered slice.
// Live pdi with the default budget reads 994 of 621972 rows, and only 2 of the
// 425 skipped-upgrade artifacts fall inside it. An inventory of skipped
// customizations must resolve the observed update names directly.
function queryAwareSdk(data) {
  const visible = (table, query = '') => {
    let rows = data[table] || [];
    const names = /sys_update_nameIN([^ ^]+)/.exec(query);
    if (names) { const wanted = new Set(names[1].split(',')); rows = rows.filter(row => wanted.has(String(row.sys_update_name))); }
    const dispositions = /dispositionIN([^ ^]+)/.exec(query);
    if (dispositions) { const wanted = new Set(dispositions[1].split(',')); rows = rows.filter(row => wanted.has(String(row.disposition))); }
    return rows;
  };
  const queries = [];
  return { queries, sdk: {
    async list(table, params) {
      queries.push({ table, query: params.sysparm_query });
      const offset = Number(params.sysparm_offset);
      return visible(table, params.sysparm_query).slice(offset, offset + Number(params.sysparm_limit));
    },
    async aggregateCount(table, query = '') { return visible(table, query).length; },
  } };
}

test('observed skipped upgrade names are resolved by direct lookup, not left to the arbitrary metadata sample', async () => {
  const { captureCustomizations, formatReport } = await import('../src/customizations.js');
  const noise = Array.from({ length: 1200 }, (_, index) => ({ sys_id: `noise-${String(index).padStart(4, '0')}`, sys_update_name: `sys_script_noise_${index}`, sys_name: `Noise ${index}`, sys_scope: 'global', sys_class_name: 'sys_script' }));
  const artifact = { sys_id: 'artifact-target', sys_update_name: 'sys_script_target', sys_name: 'Skipped vendor rule', sys_scope: 'global', sys_class_name: 'sys_script', sys_updated_on: '2026-02-02 00:00:00' };
  const { sdk, queries } = queryAwareSdk({
    sys_metadata: [...noise, artifact],
    sys_upgrade_history_log: [{ sys_id: 'skip-1', file_name: 'sys_script_target', disposition: '4', resolution_status: '' }],
  });
  const result = await captureCustomizations({ sdk });
  // The bounded sample still only ever sees the first 1000 rows by sys_id.
  assert.equal(result.coverage.sources.sys_metadata.status, 'limited');
  assert.equal(result.coverage.sources.sys_metadata.fetched, 1000);
  assert.equal(result.coverage.sources.sys_metadata.kind, 'bounded sample');
  assert.equal(result.categories.ootb_modifications.length, 1, 'the skipped artifact must appear in the OOTB inventory');
  assert.equal(result.categories.ootb_modifications[0].identity.sys_id, 'artifact-target');
  assert.equal(result.categories.ootb_modifications[0].evidence.at(-1).disposition, '4');
  const resolution = result.coverage.sources.sys_metadata_name_resolution;
  assert.equal(resolution.status, 'exhausted');
  assert.equal(resolution.kind, 'targeted name resolution');
  assert.equal(resolution.requested_names, 1);
  assert.equal(resolution.resolved_names, 1);
  assert.equal(resolution.fetched, 1);
  assert.equal(resolution.available, 1);
  assert.equal(result.coverage.upgrade_evidence.skipped_rows_observed, 1);
  assert.deepEqual(result.coverage.upgrade_evidence.unresolved_update_names, []);
  assert.equal(result.coverage.unmatched_upgrade_records, 0);
  assert.ok(queries.some(call => call.table === 'sys_metadata' && /sys_update_nameIN/.test(call.query || '')), 'the resolution must query sys_metadata by update name');
  assert.match(formatReport(result), /bounded sample/);
});

// Defect 7: an unresolvable skipped name stays visible as a gap, and a failed
// lookup chunk is reported instead of being hidden behind the sample.
test('unresolved skipped names and failed lookup chunks are reported, never silently dropped', async () => {
  const { captureCustomizations } = await import('../src/customizations.js');
  const { sdk } = queryAwareSdk({
    sys_metadata: [{ sys_id: 'm1', sys_update_name: 'sys_script_present', sys_name: 'Present', sys_scope: 'global', sys_class_name: 'sys_script' }],
    sys_upgrade_history_log: [
      { sys_id: 's1', file_name: 'sys_script_present', disposition: '4', resolution_status: '' },
      { sys_id: 's2', file_name: 'sys_script_absent', disposition: '104', resolution_status: '' },
    ],
  });
  const result = await captureCustomizations({ sdk });
  assert.equal(result.coverage.upgrade_evidence.skipped_rows_observed, 2);
  assert.deepEqual(result.coverage.upgrade_evidence.unresolved_update_names, ['sys_script_absent']);
  assert.equal(result.coverage.unmatched_upgrade_records, 1);
  // A blocked name lookup is an ACL-limited lookup, not a silent gap: the
  // sampled rows and the resolveable names are still inventoried, and the
  // failure is counted in coverage and in the upgrade evidence summary.
  const { sdk: working } = queryAwareSdk({
    sys_metadata: [{ sys_id: 'm1', sys_update_name: 'sys_script_present', sys_name: 'Present', sys_scope: 'global', sys_class_name: 'sys_script' }],
    sys_upgrade_history_log: [{ sys_id: 's1', file_name: 'sys_script_present', disposition: '4', resolution_status: '' }],
  });
  const blocked = await captureCustomizations({ sdk: {
    async list(table, params) {
      if (table === 'sys_metadata' && /sys_update_nameIN/.test(params.sysparm_query || '')) throw new Error('403 Forbidden');
      return working.list(table, params);
    },
    async aggregateCount(table, query = '') { return working.aggregateCount(table, query); },
  } });
  const lookup = blocked.coverage.sources.sys_metadata_name_resolution;
  assert.equal(blocked.coverage.sources.sys_metadata.status, 'exhausted');
  assert.equal(lookup.status, 'permission_denied');
  assert.equal(lookup.failed_chunks, 1);
  assert.match(lookup.reason, /ACL visibility or a read error/);
  assert.equal(blocked.coverage.upgrade_evidence.lookup_failures, 1);
  assert.equal(blocked.categories.ootb_modifications.length, 1);
});

// Defect 3: a 200 with an unexpected body is not an empty table.
test('a malformed table envelope is an unavailable source, never an empty or exhausted one', async t => {
  const { captureCustomizations, captureReport, compareReports, formatReportComparison } = await import('../src/customizations.js');
  const { SDKClient } = await import('../src/sdk.js');
  t.mock.method(globalThis, 'fetch', async input => {
    const req = input instanceof Request ? input : new Request(input);
    if (new URL(req.url).pathname === '/angular.do') return new Response('{}', { headers: { 'set-cookie': 'JSESSIONID=fixture; Path=/' } });
    return Response.json({ unexpected: true });
  });
  const sdk = new SDKClient('https://mock.example', { getCredentials: async () => ({ auth_method: 'basic', username: 'fixture', password: 'fixture' }) });
  const malformed = await captureCustomizations({ sdk });
  for (const [table, coverage] of Object.entries(malformed.coverage.sources)) {
    assert.equal(coverage.status, 'unavailable', table);
    assert.equal(coverage.available, null, table);
    assert.notEqual(coverage.status, 'exhausted', table);
  }
  assert.equal(malformed.categories.unclassified.length, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-customizations-'));
  try {
    const good = await captureReport({ sdk: readOnlySdk({ sys_metadata: metadata }), instance: 'https://mock.example', dir });
    const broken = { run_id: 'malformed-run', instance: good.instance, start_time: good.start_time, capture_schema_version: good.capture_schema_version, ...malformed };
    const compared = compareReports(good, broken);
    assert.equal(compared.status, 'unreliable');
    assert.ok(compared.impaired_sources.new.includes('sys_metadata (unavailable)'));
    assert.match(compared.unknowns.join(' '), /unreliable/i);
    const rendered = formatReportComparison(compared);
    assert.match(rendered, /Unreliable new sources: .*sys_metadata \(unavailable\)/);
    // The unreadable side is never rendered as verified removals only.
    assert.match(rendered, /must not be read as mass creation or deletion/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Defect 4: readOnly must suppress the credential last-seen write even when a
// caller also passes touchLastSeen.
test('readOnly suppresses the credential last-seen write unconditionally', async t => {
  const { SDKClient } = await import('../src/sdk.js');
  t.mock.method(globalThis, 'fetch', async () => Response.json({ result: [] }));
  let touches = 0;
  const sdk = new SDKClient('https://mock.example', { getCredentials: async () => ({ auth_method: 'basic', username: 'fixture', password: 'fixture' }), touchLastSeen: () => { touches++; } });
  await sdk.request('https://mock.example/api/now/table/sys_metadata', { method: 'GET', readOnly: true, touchLastSeen: true });
  assert.equal(touches, 0);
  await sdk.request('https://mock.example/api/now/table/sys_scope', { method: 'GET' });
  assert.equal(touches, 1);
  await sdk.request('https://mock.example/api/now/table/sys_scope', { method: 'GET', touchLastSeen: false });
  assert.equal(touches, 1);
});

// Defect 5: a human must be able to see what changed, was added or was removed.
test('comparison output renders before/after values and item detail without changing the JSON', async () => {
  const { captureReport, compareReports, formatReportComparison } = await import('../src/customizations.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-customizations-'));
  const row = (id, name) => ({ sys_id: id, sys_update_name: `sys_script_${id}`, sys_name: name, sys_scope: 'global', sys_class_name: 'sys_script' });
  try {
    const baseline = await captureReport({ sdk: readOnlySdk({ sys_metadata: [row('a', 'Vendor rule'), row('b', 'Removed rule')] }), instance: 'https://mock.example', dir });
    const newer = await captureReport({ sdk: readOnlySdk({ sys_metadata: [row('a', 'Renamed rule'), row('c', 'Added rule')] }), instance: 'https://mock.example', dir });
    const diff = compareReports(baseline, newer);
    assert.equal(diff.changes.length, 1);
    assert.equal(diff.additions.length, 1);
    assert.equal(diff.removals.length, 1);
    assert.deepEqual(Object.keys(diff.changes[0]).sort(), ['baseline', 'id', 'new']);
    const text = formatReportComparison(diff);
    assert.match(text, /Vendor rule/);
    assert.match(text, /Renamed rule/);
    assert.match(text, /identity\.name: "Vendor rule" -> "Renamed rule"/);
    assert.match(text, /ADDITIONS \(1\)/);
    assert.match(text, /Added rule/);
    assert.match(text, /Evidence: sys_metadata:c/);
    assert.match(text, /REMOVALS \(1\)/);
    assert.match(text, /Removed rule/);
    assert.ok(!JSON.stringify(diff).includes('identity.name:'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
