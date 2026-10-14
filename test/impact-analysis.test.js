import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeImpact } from '../src/impact-analysis.js';

const xml = fields => `<record_update table="sys_script_include"><sys_script_include action="INSERT_OR_UPDATE"><sys_id>${'b'.repeat(32)}</sys_id>${fields}</sys_script_include></record_update>`;
test('impact analysis exposes literal behavior changes, evidence and unknown deeper effects', () => {
  const impact = analyzeImpact({ artifact: { table: 'sys_script_include', sys_id: 'b'.repeat(32) },
    current: { script: 'custom()', active: 'true' },
    baseline: { payload: xml('<script><![CDATA[base()]]></script><active>false</active>'), sys_id: 'c'.repeat(32) },
    dependencies: [{ table: 'sys_ui_action', sys_id: 'd'.repeat(32), field: 'script_include' }] });
  assert.deepEqual(impact.changes.map(c => c.field), ['active', 'script']);
  assert.equal(impact.changes.find(c => c.field === 'script').current, 'custom()');
  assert.equal(impact.changes.find(c => c.field === 'script').base, 'base()');
  assert.equal(impact.recommendation.action, 'retain');
  assert.equal(impact.known_dependencies.length, 1);
  assert.match(impact.unknown.join(' '), /dynamic|transitive/);
});
test('scope and class metadata are behavior-relevant, not ignored as generic sys fields', () => {
  const impact = analyzeImpact({ artifact: { table: 'sys_script_include', sys_id: 'b'.repeat(32) },
    current: { sys_scope: 'custom-scope', sys_class_name: 'custom-class', sys_mod_count: '9' },
    baseline: { payload: xml('<sys_scope>base-scope</sys_scope><sys_class_name>base-class</sys_class_name><sys_mod_count>1</sys_mod_count>') } });
  assert.deepEqual(impact.changes.map(change => change.field), ['sys_class_name', 'sys_scope']);
});

test('missing or malformed baseline never implies safe revert', () => {
  for (const payload of ['', '<record_update><nested/></record_update>', '<!DOCTYPE x>']) {
    const impact = analyzeImpact({ artifact: { table: 'sys_script_include', sys_id: 'b'.repeat(32) }, current: {}, baseline: { payload } });
    assert.equal(impact.recommendation.action, 'retain');
    assert.equal(impact.direct_behavior.status, 'unknown');
  }
});
