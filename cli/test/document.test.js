import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documentFixture, id } from './support/document-fixture.js';
import fs from 'node:fs';
import path from 'node:path';
import { documentOwner, renderInstanceDocumentation } from '../src/instance-documentation.js';

// A rejected extraction must not leave an output side effect.
test('invalid extraction refuses file creation', async () => {
  const f = await documentFixture();
  try {
    const destination = path.join(f.dir, 'rejected.md');
    await assert.rejects(f.run(['document', 'instance', '--profile', 'synthetic', '--output', destination, '--get', 'data.does_not_exist']));
    assert.equal(fs.existsSync(destination), false);
  } finally { await f.close(); }
});

const command = ['document', 'instance', '--profile', 'synthetic'];
test('same saved evidence renders deterministically offline and Mermaid labels stay inert', async () => {
  const f = await documentFixture();
  let data;
  try { data = JSON.parse((await f.run([...command, '--json'])).stdout).data; } finally { await f.close(); }
  assert.equal(renderInstanceDocumentation(JSON.parse(JSON.stringify(data))), data.markdown);
  data.applications[0].portal_relations = [{ page_title: '"]\nclick p0 "https://bad.invalid"', widget_name: '<script> %%{init: evil}%%' }];
  const graph = renderInstanceDocumentation(data).match(/```mermaid[\s\S]*?```/)[0];
  assert.doesNotMatch(graph, /https:|<script>|%%|\nclick/);
});
test('ownership refuses absent and conflicting references, retaining duplicate namespace identities', () => {
  const candidates = [{ identity: id(1), namespace: 'same' }, { identity: id(2), namespace: 'same' }];
  assert.equal(documentOwner({ sys_scope: id(1) }, candidates).kind, 'unresolved');
  assert.equal(documentOwner({ sys_scope: id(1), sys_package: id(999) }, candidates).kind, 'unresolved');
  assert.equal(documentOwner({ sys_scope: id(1), sys_package: id(2) }, candidates).kind, 'unresolved');
  assert.deepEqual(documentOwner({ sys_scope: 'global', sys_package: id(2) }, candidates), { kind: 'application', identity: id(2) });
});
test('arguments and existing destination types reject before any instance request', async () => {
  const f = await documentFixture();
  try {
    const sentinel = path.join(f.dir, 'sentinel.md'), symlink = path.join(f.dir, 'link.md');
    fs.writeFileSync(sentinel, 'sentinel bytes'); fs.symlinkSync(sentinel, symlink);
    const invalid = [[], ['--page-size', '0'], ['--page-size', '101'], ['--discovery-pages', '0'], ['--detail-pages', '4'], ['--applications', '7'], ['--max-requests', '0'], ['--max-requests', '201'], ['--page-size', '1.5'], ['--output', sentinel], ['--output', symlink], ['--output', f.dir], ['--instance', f.instance]];
    for (const flags of invalid) await assert.rejects(f.run([...(flags.length ? command : ['document', 'instance']), ...flags, '--json']));
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'sentinel bytes');
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});
test('owner-only new output, JSON extraction, help and styled report use the registered CLI', async () => {
  const f = await documentFixture();
  try {
    const destination = path.join(f.dir, 'new.md');
    const data = JSON.parse((await f.run([...command, '--output', destination, '--json'])).stdout).data;
    assert.equal(fs.readFileSync(destination, 'utf8'), data.markdown);
    assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
    assert.equal(JSON.parse((await f.run([...command, '--get', 'data.release_identity'])).stdout), 'unknown');
    assert.match((await f.run([...command, '--format', 'styled'])).stdout, /^# Instance configuration documentation/);
    assert.match((await f.run(['document', 'instance', '--help'])).stdout, /--max-requests/);
    assert.deepEqual(f.violations, []);
  } finally { await f.close(); }
});
for (const options of [{ fail: 'sys_rest_message' }, { fail: 'sys_soap_message', status: 404 }, { malformed: 'sys_hub_flow' }, { omitField: 'active' }, { noSchema: true }]) {
  test(`source gap remains explicit and does not erase evidence: ${JSON.stringify(options)}`, async () => {
    const f = await documentFixture(options);
    try {
      const data = JSON.parse((await f.run([...command, '--json'])).stdout).data;
      if (options.noSchema) {
        assert.deepEqual(data.applications, []);
        assert.match(data.limitations.join(' '), /Identity schema not established/);
        assert.ok(!f.requests.some(r => r.path.endsWith('/sys_scope')));
      } else {
        assert.equal(data.applications.length, 3);
        assert.ok(data.applications.some(a => a.sections.sys_db_object.length));
        const table = options.fail || options.malformed || 'sys_script';
        const source = data.sources.find(s => s.table === table && (!options.omitField || s.records.length));
        assert.equal(source.status, options.omitField ? 'missing-fields' : options.status === 404 || options.malformed ? 'unavailable' : 'denied');
      }
      assert.deepEqual(f.violations, []);
    } finally { await f.close(); }
  });
}
test('portal schema refusal avoids guessed joins while keeping application metadata', async () => {
  const f = await documentFixture({ badPortalReference: true });
  try {
    const data = JSON.parse((await f.run([...command, '--json'])).stdout).data;
    assert.deepEqual(data.portal_relations, []);
    assert.ok(data.applications.some(a => a.sections.sp_page.length));
    assert.match(data.limitations.join(' '), /Portal reference schema not established/);
    assert.ok(!f.requests.some(r => /\/(sp_container|sp_row|sp_column|sp_instance)$/.test(r.path)));
  } finally { await f.close(); }
});
test('repeated discovery pages retain duplicate receipts without merging identities', async () => {
  const f = await documentFixture({ repeatDiscoveryPage: true });
  try {
    const data = JSON.parse((await f.run([...command, '--json'])).stdout).data;
    assert.equal(data.candidates.length, 3);
    assert.ok(data.sources.some(s => s.table === 'sys_scope' && s.reasons.includes('duplicate_record')));
    for (const source of data.sources.filter(s => s.status !== 'not_collected')) {
      assert.ok(f.requests.some(r => r.path === source.resource && r.query.sysparm_query === source.query && r.query.sysparm_fields === source.fields.join(',') && Number(r.query.sysparm_offset) === source.bounds.offset));
    }
  } finally { await f.close(); }
});
test('transport failure is not successful empty evidence', async () => {
  const f = await documentFixture({ disconnect: 'sys_rest_message' });
  try { await assert.rejects(f.run([...command, '--json'])); } finally { await f.close(); }
});
test('authentication and server failures return nonzero instead of empty successful reports', async () => {
  for (const status of [401, 500]) {
    const f = await documentFixture({ fail: 'sys_rest_message', status });
    try { await assert.rejects(f.run([...command, '--json'])); assert.deepEqual(f.violations, []); } finally { await f.close(); }
  }
});
test('bounded discovery and source/request budgets keep honest continuation and offsets', async () => {
  const f = await documentFixture();
  try {
    let data = JSON.parse((await f.run([...command, '--max-requests', '2', '--json'])).stdout).data;
    assert.equal(data.requests_used, 2);
    assert.ok(data.sources.some(s => s.status === 'truncated' && s.reasons.includes('request_budget')));
    assert.equal(f.requests.filter(r => r.path.startsWith('/api/now/table/')).length, 2);
    data = JSON.parse((await f.run([...command, '--page-size', '1', '--json'])).stdout).data;
    assert.ok(data.sources.some(s => s.status === 'truncated' && s.reasons.includes('page_budget')));
    data = JSON.parse((await f.run([...command, '--discovery-pages', '3', '--applications', '1', '--json'])).stdout).data;
    assert.equal(data.applications.length, 1);
    assert.deepEqual(data.sources.filter(s => s.table === 'sys_scope').map(s => s.bounds.offset), [0, 25, 50]);
    assert.ok(data.sources.every(s => s.completeness === 'unknown'));
    assert.deepEqual(f.violations, []);
  } finally { await f.close(); }
});
test('human Markdown contains only the report, not a duplicate evidence dump', async () => {
  const f = await documentFixture();
  try {
    const { stdout } = await f.run([...command, '--format', 'markdown']);
    assert.match(stdout, /^# Instance configuration documentation/);
    assert.doesNotMatch(stdout, /```json/);
  } finally { await f.close(); }
});
test('registered CLI documents generic scoped and Global identities with safe useful metadata', async () => {
  const f = await documentFixture();
  try {
    const result = await f.run([...command, '--json']);
    const { ok, data } = JSON.parse(result.stdout);
    assert.equal(ok, true);
    assert.deepEqual(data.applications.map(a => a.identity).sort(), [id(1), id(2), id(3)]);
    assert.equal(data.applications.find(a => a.identity === id(2)).namespace, 'global');
    assert.equal(data.candidates.filter(a => a.namespace === 'acme_dispatch').length, 2);
    assert.deepEqual(data.global_candidates.map(row => row.name), ['u_local_lead']);
    assert.ok(data.unresolved.some(row => row.record.sys_id === id(13)));
    assert.ok(data.unresolved.some(row => row.record.sys_id === id(14)));
    assert.match(data.markdown, /Dispatch requests/);
    assert.match(data.markdown, /Validate dispatch/);
    assert.match(data.markdown, /Synthetic REST connector/);
    assert.match(data.markdown, /Synthetic nightly task/);
    assert.match(data.markdown, /Synthetic dispatch flow/);
    assert.equal(data.portal_relations.length, 1);
    assert.equal(data.portal_relations[0].page, id(30));
    assert.equal(data.portal_relations[0].widget, id(31));
    assert.match(data.markdown, /```mermaid/);
    assert.doesNotMatch(JSON.stringify(data), /SENSITIVE_.*CANARY/);
    assert.doesNotMatch(data.markdown, /<script>|https:\/\/bad|\] --> injected/);
    assert.ok(data.sources.every(s => s.fields.length && s.query && s.observed_at && s.bounds && s.completeness === 'unknown'));
    assert.ok(data.requests_used <= data.budgets.maxRequests);
    assert.deepEqual(f.violations, []);
    assert.ok(f.requests.every(r => r.method === 'GET' || r.path === '/angular.do'));
  } finally { await f.close(); }
});
