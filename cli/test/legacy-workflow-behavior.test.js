import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectVersion, inspectWorkflow, formatWorkflowOutline, listWorkflows } from '../src/workflow-inspection.js';

const id = n => String(n).padStart(32, '0');
const version = (n, date, published = true, active = true) => ({
  sys_id: id(n), created_on: date, published, active,
});
const old = version(1, '2024-01-01 00:00:00');
const latest = version(2, '2024-02-01 00:00:00');
const draft = version(3, '2024-03-01 00:00:00', false);

function sdkFor({ versions = [old, latest, draft], configuration = {} } = {}) {
  const rows = versions.map(v => ({
    ...v, workflow: id(10), name: `Version ${v.sys_id}`, sys_created_on: v.created_on,
    published: String(v.published), active: String(v.active),
  }));
  return { listStrict: async (table) => {
    switch (table) {
      case 'wf_workflow': return [{ sys_id: id(10), name: 'Synthetic workflow', table: 'incident' }];
      case 'wf_workflow_version': return rows;
      case 'wf_activity': return [{ sys_id: id(20), name: 'Synthetic activity' }];
      case 'sys_variable_value': return Object.entries(configuration).map(([element, value]) => ({
        document_key: id(20), 'variable.element': element, value,
      }));
      default: return [];
    }
  } };
}

test('default selects newest published from unsorted candidates without mutating them', () => {
  const rows = [old, draft, latest];
  assert.deepEqual(selectVersion(rows), { version: latest, reason: 'latest_published' });
  assert.deepEqual(rows, [old, draft, latest]);
});

test('active published versions win over newer inactive ones, newest active wins', () => {
  const inactive = version(4, '2025-01-01 00:00:00', true, false);
  assert.equal(selectVersion([old, inactive, latest]).version, latest);
  assert.equal(selectVersion([old, inactive]).version, old);
});

test('without published versions newest overall wins regardless of active state', () => {
  const olderActive = { ...old, published: false };
  const newestInactive = { ...draft, active: false };
  assert.deepEqual(selectVersion([olderActive, newestInactive, { ...latest, published: false }]), {
    version: newestInactive, reason: 'newest',
  });
  assert.deepEqual(selectVersion([]), { version: null, reason: 'none' });
});

test('explicit version overrides defaults and rejects unknown or malformed IDs', () => {
  assert.deepEqual(selectVersion([old, latest, draft], draft.sys_id), { version: draft, reason: 'requested' });
  assert.throws(() => selectVersion([old, latest], id(99)), /not one of this workflow's versions/);
  assert.throws(() => selectVersion([old], 'invalid'), /--version must be/);
});

test('versions are newest-first and rendered marker and reason identify the selected default', async () => {
  const data = await inspectWorkflow(sdkFor(), { identifier: id(10) });
  assert.deepEqual(data.versions.map(v => v.sys_id), [draft.sys_id, latest.sys_id, old.sys_id]);
  assert.equal(data.selection.selected_version_id, latest.sys_id);
  assert.equal(data.selection.reason, 'latest_published');
  const output = formatWorkflowOutline(data);
  assert.match(output, /latest published version \(active preferred\)/);
  assert.ok(output.includes(` * 2. Version ${latest.sys_id}`));
  assert.equal(output.split('\n').filter(line => line.startsWith(' * ')).length, 1);
  const listed = await listWorkflows(sdkFor());
  assert.equal(listed.records[0].published_version.sys_id, latest.sys_id);
});

for (const field of ['script', 'script_condition', 'email_to_script']) {
  test(`comment-only ${field} is omitted with activity breadcrumb and coverage count`, async () => {
    const comments = '  // disabled statement\r\n\n /* block\n * comment\n */ // trailing comment\n';
    const data = await inspectWorkflow(sdkFor({ configuration: { [field]: comments } }), { identifier: id(10) });
    const activity = data.activities[0];
    assert.equal(Object.hasOwn(activity.configuration, field), false);
    assert.deepEqual(activity.configuration_omissions, [{ field, reason: 'comment_only_script' }]);
    assert.equal(data.coverage.comment_only_scripts_omitted, 1);
    const output = formatWorkflowOutline(data);
    assert.match(output, new RegExp(`omitted ${field}: comment-only script`));
    assert.match(output, /1 comment-only script fields omitted/);
    assert.ok(!output.includes('disabled statement'));
  });
}

test('executable scripts including comments are preserved byte-for-byte and descriptions are unaffected', async () => {
  const code = '\n// explanation\r\n/* header */ current.update(); // keep\n';
  const description = '// description is not a script';
  const data = await inspectWorkflow(sdkFor({ configuration: {
    script: code, script_condition: code, email_to_script: code, short_description: description,
  } }), { identifier: id(10) });
  assert.deepEqual(data.activities[0].configuration, {
    script: code, script_condition: code, email_to_script: code, short_description: description,
  });
  assert.deepEqual(data.activities[0].configuration_omissions, []);
  assert.equal(data.coverage.comment_only_scripts_omitted, 0);
});

test('shebangs, executable tokens, strings, blank values and unclosed blocks are not comment-only', async () => {
  for (const value of ['#!/usr/bin/env node\n// comment', '// comment\n;', '/* comment */ answer = true;', '"// string"', '/* unclosed', '  \n']) {
    const data = await inspectWorkflow(sdkFor({ configuration: { script: value } }), { identifier: id(10) });
    assert.equal(data.activities[0].configuration.script, value);
    assert.equal(data.coverage.comment_only_scripts_omitted, 0);
  }
});

test('omission counts aggregate fields without changing ordinary configuration values', async () => {
  const data = await inspectWorkflow(sdkFor({ configuration: {
    script: '// one', script_condition: '/* two */', email_to_script: '// three', short_description: '// keep',
  } }), { identifier: id(10) });
  assert.equal(data.coverage.comment_only_scripts_omitted, 3);
  assert.deepEqual(data.activities[0].configuration, { short_description: '// keep' });
});
