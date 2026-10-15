import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildActionableReport, classifyCustomization, renderCustomizationHtml, writeCustomizationHtml } from '../src/customizations-report.js';

const fixture = {
  run_id: 'capture-1', label: 'review', instance: 'https://dev.example', status: 'incomplete',
  categories: {
    ootb_modifications: [{ identity: { sys_id: 'a1', table: 'sys_script_include', name: 'AutoResolutionSLACondition' }, scope: { scope: 'global' }, evidence: [{ source: 'sys_upgrade_history_log', sys_id: 'h1', basis: 'Upgrade disposition skipped.' }], recommendation: 'Retain pending review.', risk: { rating: 'unknown', rationale: 'No baseline.' } }],
    customer_app_artifacts: [{ identity: { sys_id: 'b2', table: 'sys_ui_policy_action', name: '<img src=x onerror=alert(1)>' }, scope: { scope: 'x_acme_app' }, evidence: [{ source: 'sys_metadata', sys_id: 'b2', basis: 'Visible metadata.' }] }],
    unclassified: [{ identity: { sys_id: 'c3', table: 'sys_hub_action_type_snapshot', name: 'c3' }, evidence: [] }],
  },
  coverage: { sources: { sys_metadata: { status: 'partial', fetched: 3, available: 10, reason: 'bounded read' } }, limitations: ['No current baseline.'] },
};

test('actionable triage separates evidence confidence from risk and gives safe next steps', () => {
  const view = buildActionableReport(fixture);
  assert.equal(view.artifacts.length, 3);
  assert.equal(view.artifacts[0].triage.label, 'Historical upgrade skip');
  assert.equal(view.artifacts[0].triage.confidence, 'Historical evidence only');
  assert.equal(view.artifacts[0].risk.rating, 'unknown');
  assert.equal(view.artifacts[0].triage.automated_remediation, false);
  assert.match(view.artifacts[0].triage.next_steps.join(' '), /trusted baseline/i);
  assert.equal(view.artifacts[1].triage.confidence, 'Declaration, not verified ownership');
  assert.match(view.artifacts[1].triage.summary, /does not verify/i);
  assert.equal(view.artifacts[2].triage.confidence, 'Insufficient evidence');
});

test('standalone HTML groups, searches, escapes untrusted artifact data, and links directly to records', () => {
  const html = renderCustomizationHtml(fixture);
  assert.match(html, /Search artifacts/);
  assert.match(html, /Group by/);
  assert.match(html, /Next steps/);
  assert.match(html, /No current baseline/);
  assert.match(html, /https:\/\/dev\.example\/sys_script_include\.do\?sys_id=a1/);
  assert.ok(html.includes('\\u003cimg src=x onerror=alert(1)\\u003e'));
  assert.doesNotMatch(html, /<img src=x onerror=alert/);
  assert.doesNotMatch(renderCustomizationHtml({ ...fixture, instance: 'javascript:alert(1)' }), /href="javascript:/);
});

test('HTML export creates a private file without overwriting an existing report', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-customizations-html-'));
  try {
    const out = path.join(dir, 'review.html');
    assert.equal(writeCustomizationHtml(fixture, { out }), out);
    assert.match(fs.readFileSync(out, 'utf8'), /Customization review/);
    assert.equal(fs.statSync(out).mode & 0o777, 0o600);
    assert.throws(() => writeCustomizationHtml(fixture, { out }), { code: 'EEXIST' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('classification falls back safely for categories added by older or newer captures', () => {
  const result = classifyCustomization('future_category');
  assert.equal(result.code, 'unclassified');
  assert.equal(result.automated_remediation, false);
});
