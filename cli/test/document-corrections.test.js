import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { documentFixture, id } from './support/document-fixture.js';

const command = ['document', 'instance', '--profile', 'synthetic'];
test('registered CLI rejects failed extraction before output creation using the actual envelope', async () => {
  const f = await documentFixture();
  try {
    for (const [index, selector] of ['summary.0', 'data.does_not_exist'].entries()) {
      const destination = path.join(f.dir, `rejected-${index}.md`);
      await assert.rejects(f.run([...command, '--get', selector, '--output', destination]), error => {
        assert.equal(JSON.parse(error.stdout).code, 'extraction_not_found'); return true;
      });
      assert.equal(fs.existsSync(destination), false, selector);
    }
    const destination = path.join(f.dir, 'valid-empty-summary.md');
    assert.equal(JSON.parse((await f.run([...command, '--get', 'summary', '--output', destination])).stdout), '');
    assert.match(fs.readFileSync(destination, 'utf8'), /^# Instance configuration documentation/);
    assert.equal(JSON.parse((await f.run([...command, '--get', 'data.release_identity'])).stdout), 'unknown');
    assert.deepEqual(f.violations, []);
  } finally { await f.close(); }
});
for (const widgetFollowupStatus of [undefined, 403, 404]) {
  test(`registered CLI preserves independent widget evidence and provenance after endpoint resolution: ${widgetFollowupStatus || 'observed'}`, async () => {
    const widget = (n, name) => ({ sys_id: id(n), id: `widget-${n}`, name, sys_scope: id(1), sys_package: id(1), sys_updated_on: '2026-01-02 03:04:05' });
    const f = await documentFixture({ rows: { sp_widget: [widget(31, 'Referenced widget'), widget(36, 'Independent owned widget')] }, widgetFollowupStatus });
    try {
      const data = JSON.parse((await f.run([...command, '--json'])).stdout).data;
      const app = data.applications.find(a => a.identity === id(1));
      assert.deepEqual(app.sections.sp_widget.map(row => row.sys_id), [id(31), id(36)]);
      assert.match(data.markdown, /Independent owned widget/);
      const initial = data.sources.find(source => source.table === 'sp_widget' && source.query.startsWith(`sys_scope=${id(1)}`));
      assert.ok(app.sections.sp_widget.every(row => row.source === initial.id));
      assert.equal(app.portal_relations.length, 1);
      assert.equal(app.portal_relations[0].widget, id(31));
      assert.equal(app.portal_relations[0].path.at(-1).source, initial.id);
      if (widgetFollowupStatus) {
        const followup = data.sources.find(source => source.table === 'sp_widget' && source.query.startsWith('sys_idIN'));
        assert.equal(followup.status, widgetFollowupStatus === 403 ? 'denied' : 'unavailable');
      }
      assert.deepEqual(f.violations, []);
    } finally { await f.close(); }
  });
}
const stamp = '2026-01-02 03:04:05';
const hierarchy = [
  { sys_id: id(501), name: 'sys_app', super_class: id(502) },
  { sys_id: id(502), name: 'sys_scope', super_class: id(503) },
  { sys_id: id(503), name: 'sys_package', super_class: '' },
];

test('registered CLI keeps blank, redacted and missing ownership unresolved with valid controls', async () => {
  const incomplete = [['global', ''], ['', 'global'], ['', ''], [' ', 'global'], ['global', '\t'], [null, 'global'], ['global', null], [undefined, 'global'], ['global', undefined], [id(1), ''], ['', id(1)]];
  const rows = incomplete.map((_, index) => ({ sys_id: id(80 + index), name: `u_redacted_${index}`, label: `Redacted owner ${index}`, sys_scope: 'global', sys_package: 'global', sys_updated_on: stamp }));
  const redactOwnership = Object.fromEntries(incomplete.map(([sys_scope, sys_package], index) => [id(80 + index), { sys_scope, sys_package }]));
  const controls = [
    { sys_id: id(110), name: 'u_explicit_global', label: 'Explicit Global', sys_scope: 'global', sys_package: 'global' },
    { sys_id: id(111), name: 'u_packaged_global', label: 'Packaged Global', sys_scope: 'global', sys_package: id(2) },
    { sys_id: id(112), name: 'acme_owned', label: 'Known complete owner', sys_scope: id(1), sys_package: id(1) },
  ];
  const f = await documentFixture({ rows: { sys_db_object: [...hierarchy, ...rows, ...controls] }, redactOwnership });
  try {
    const data = JSON.parse((await f.run([...command, '--json'])).stdout).data;
    for (const row of rows) {
      assert.ok(data.unresolved.some(entry => entry.record.sys_id === row.sys_id), row.name);
      assert.ok(!data.global_candidates.some(entry => entry.sys_id === row.sys_id), row.name);
      assert.ok(!data.applications.some(app => app.sections.sys_db_object.some(entry => entry.sys_id === row.sys_id)), row.name);
    }
    assert.deepEqual(data.global_candidates.map(row => row.sys_id), [id(110)]);
    assert.ok(data.applications.find(app => app.identity === id(2)).sections.sys_db_object.some(row => row.sys_id === id(111)));
    assert.ok(data.applications.find(app => app.identity === id(1)).sections.sys_db_object.some(row => row.sys_id === id(112)));
    assert.deepEqual(f.violations, []);
  } finally { await f.close(); }
});
