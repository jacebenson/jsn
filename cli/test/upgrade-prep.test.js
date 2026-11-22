import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upgradeFixture } from './support/upgrade-prep-fixture.js';

const prep = ['upgrade', 'prep', '--profile', 'fixture'];
test('real CLI discovers platform, Store, preview, clone, ATF and scan evidence without a target', async () => {
  const f = await upgradeFixture();
  try {
    const { data, ok } = JSON.parse((await f.run([...prep, '--json'])).stdout);
    assert.equal(ok, true);
    assert.equal(data.target, null);
    assert.equal(data.status, 'incomplete');
    const finding = kind => data.findings.filter(row => row.kind === kind);
    assert.equal(finding('offered_targets')[0].records[0].value, 'glide-fixture-patch2');
    assert.match(finding('last_completed_platform_history')[0].detail, /not live node build/);
    assert.equal(finding('store_metadata_conflict').length, 2);
    assert.ok(finding('store_metadata_conflict').every(row => row.status === 'verified_problem'));
    assert.equal(finding('store_update_candidate').length, 1);
    assert.deepEqual(finding('preview_finding')[0].metadata, { severity: 'provider-warning', priority: '2', disposition: 'requires_review' });
    assert.equal(finding('historical_skips')[0].evidence.count, 1);
    assert.equal(finding('clone_evidence').length, 3);
    assert.equal(finding('existing_atf')[0].evidence.status, 'failed');
    assert.equal(finding('existing_scan')[0].evidence.status, 'successful');
    assert.equal(finding('existing_scan')[0].source_refs.length, 4);
    assert.ok(finding('stale_evidence').length > 0);
    assert.ok(data.sources.every(source => source.profile === 'fixture' && source.instance === f.instance));
    for (const source of data.sources) {
      assert.equal(source.method, 'GET');
      assert.match(source.read_command, /jsn records (get|list) --table /);
      assert.ok(source.observed_at);
      assert.ok(f.requests.some(request => request.path === source.path && JSON.stringify(request.query) === JSON.stringify(source.params)), source.id);
    }
    const activityIds = new Set(data.activities.map(activity => activity.id));
    const sourceIds = new Set(data.sources.map(source => source.id));
    for (const activity of data.activities) {
      assert.ok(activity.completion_check);
      assert.ok(activity.depends_on.every(id => activityIds.has(id)));
      assert.ok(activity.source_refs.every(id => sourceIds.has(id)));
    }
    assert.ok(!f.requests.some(request => request.lower));
    assert.equal(f.violations.length, 0);
    assert.equal(finding('existing_scan')[0].evidence.findings[0].finding_details, 'Fixture finding');
    assert.ok(finding('stale_evidence').length);
    assert.ok(!f.requests.some(row => row.lower));
    assert.ok(data.activities.every(row => row.completion_check && Array.isArray(row.depends_on) && Array.isArray(row.source_refs)));
    const ids = new Set(data.sources.map(s => s.id));
    assert.ok(data.findings.every(row => row.source_refs.every(id => ids.has(id))));
    assert.ok(data.sources.every(row => row.instance === f.instance && row.profile === 'fixture' && row.method === 'GET' && row.read_command.includes('--table') && row.observed_at && row.bounds));
    assert.ok(data.sources.find(s => s.table === 'sys_upgrade_history').encoded_query.startsWith('to_versionSTARTSWITHglide'));
    assert.deepEqual(f.violations, []);
    assert.ok(f.requests.every(r => r.method === 'GET' || r.path === '/angular.do'));
  } finally { await f.close(); }
});

test('selected target and explicitly related profile retain actual lower-environment evidence', async () => {
  const f = await upgradeFixture();
  try {
    const data = JSON.parse((await f.run([...prep, '--target', 'glide-fixture-patch2', '--related-profile', 'lower', '--json'])).stdout).data;
    assert.equal(data.target, 'glide-fixture-patch2');
    assert.equal(data.findings.find(row => row.kind === 'target_selection').status, 'observed');
    const lower = data.findings.filter(row => row.kind === 'lower_environment_preservation');
    assert.equal(lower.length, 2);
    assert.equal(lower[0].records[0].name, 'Fixture preserved work');
    assert.equal(lower[1].records[0].name, 'Fixture retrieved work');
    assert.ok(data.sources.filter(row => ['sys_update_set', 'sys_remote_update_set'].includes(row.table)).every(row => row.profile === 'lower' && row.instance !== f.instance));
    assert.ok(f.requests.some(row => row.lower && row.path.endsWith('/sys_remote_update_set')));
    assert.deepEqual(f.violations, []);
  } finally { await f.close(); }
});

for (const options of [{ empty: true }, { deny: 'sys_store_app' }, { error: 'upgrade_center_metadata' }, { noSchema: true }, { malformed: 'sys_upgrade_history_log' }, { omitField: 'latest_version' }]) {
  test(`evidence gaps remain explicit: ${JSON.stringify(options)}`, async () => {
    const f = await upgradeFixture(options);
    try {
      const data = JSON.parse((await f.run([...prep, '--json'])).stdout).data;
      assert.equal(data.status, 'incomplete');
      if (options.empty) assert.ok(data.findings.some(row => row.kind === 'clone_gap'));
      if (options.deny) assert.equal(data.sources.find(s => s.table === options.deny).status, 'inaccessible');
      if (options.error) assert.equal(data.sources.find(s => s.table === options.error).status, 'error');
      if (options.malformed) assert.equal(data.sources.find(s => s.table === options.malformed).status, 'error');
      if (options.omitField) {
        assert.ok(data.findings.some(row => row.kind === 'unreadable_fields' && row.fields.includes(options.omitField)));
        assert.ok(!data.findings.some(row => row.kind === 'store_metadata_conflict'));
      }
      if (options.noSchema) {
        assert.ok(data.findings.some(row => row.kind === 'schema_gap'));
        assert.ok(!f.requests.some(row => row.path.endsWith('/upgrade_preview_log')));
      }
      assert.deepEqual(f.violations, []);
    } finally { await f.close(); }
  });
}

test('bounded discovery, exact GET references, --get, human output and update alias', async () => {
  const f = await upgradeFixture();
  try {
    const data = JSON.parse((await f.run([...prep, '--limit', '1', '--json'])).stdout).data;
    assert.ok(data.findings.some(row => row.kind === 'bounded_evidence'));
    const refs = JSON.parse((await f.run(['update', 'prep', '--instance', f.instance, '--get', 'data.sources'])).stdout);
    assert.ok(refs.every(row => row.profile === null));
    assert.ok(refs.some(row => row.table === 'upgrade_preview_log' && row.fields.includes('priority')));
    const human = (await f.run([...prep, '--format', 'markdown'])).stdout;
    assert.match(human, /not readiness certification/);
    assert.match(human, /store_metadata_conflict/);
    assert.match(human, /source-\d+/);
    assert.match(human, /Completion:/);
    assert.deepEqual(f.violations, []);
  } finally { await f.close(); }
});

test('Store flags distinguish explicit contradictions from missing, blank and unrecognized evidence', async () => {
  const cases = [
    { label: 'omitted', flag: undefined, latest: '2.0', expected: 'missing' },
    { label: 'blank', flag: '', latest: '2.0', expected: 'missing' },
    { label: 'unrecognized', flag: 'unknown', latest: '2.0', expected: 'missing' },
    { label: 'true with equal versions', flag: 'true', latest: '1.0', expected: 'verified_problem' },
    { label: 'false with different versions', flag: 'false', latest: '2.0', expected: 'verified_problem' },
    { label: 'numeric true', flag: '1', latest: '1.0', expected: 'verified_problem' },
    { label: 'numeric false', flag: '0', latest: '2.0', expected: 'verified_problem' },
    { label: 'boolean true', flag: true, latest: '1.0', expected: 'verified_problem' },
    { label: 'boolean false', flag: false, latest: '2.0', expected: 'verified_problem' },
    { label: 'reference false', flag: { value: false }, latest: '2.0', expected: 'verified_problem' },
    { label: 'unreadable latest', flag: true, latest: undefined, expected: 'observed' },
    { label: 'blank latest', flag: true, latest: '', expected: 'observed' },
    { label: 'whitespace latest', flag: true, latest: '   ', expected: 'observed' },
    { label: 'unreadable version object', flag: true, latest: { display_value: '1.0' }, expected: 'observed' },
  ];
  const rows = cases.map((item, index) => ({ sys_id: String(index + 1000).padStart(32, '0'),
    name: item.label, scope: 'x_fixture', version: '1.0',
    ...(item.latest !== undefined ? { latest_version: item.latest } : {}),
    ...(item.flag !== undefined ? { update_available: item.flag } : {}),
  }));
  const f = await upgradeFixture({ storeApps: rows });
  try {
    const data = JSON.parse((await f.run([...prep, '--json'])).stdout).data;
    for (const item of cases) {
      const finding = data.findings.find(row => row.record?.name === item.label);
      assert.ok(finding, item.label);
      assert.equal(finding.status, item.expected, item.label);
      assert.equal(finding.kind, item.expected === 'verified_problem' ? 'store_metadata_conflict' : 'store_update_candidate', item.label);
      assert.equal(finding.record.version, '1.0', item.label);
      if (item.expected === 'missing') assert.match(finding.detail, /missing or unrecognized/, item.label);
    }
    assert.deepEqual(f.violations, []);
  } finally { await f.close(); }
});

test('reject implicit selection, invalid bounds and unknown related profile before any request', async () => {
  const f = await upgradeFixture();
  try {
    for (const args of [['upgrade', 'prep', '--json'], [...prep, '--limit', '0', '--json'], [...prep, '--related-profile', 'unknown', '--json']]) {
      await assert.rejects(f.run(args));
    }
    assert.equal(f.requests.length, 0);
    const result = JSON.parse((await f.run(['upgrade', '--dry-run', '--json'])).stdout);
    assert.match(result.data.installCmd, /npm install -g/);
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});
