import test from 'node:test';
import assert from 'node:assert/strict';
import { taskReport } from '../scripts/task-report.mjs';
const sample = Object.freeze({ elapsed_ms: 12.5, stdout_bytes: 89, stderr_bytes: 4, rows: 2, http_calls: 1 });
const measured = Object.freeze({ status: 'pass', version: '1.2.3', cases: [{ id: 'read', samples: [sample] }] });
const catalog = { version: 'bounded-reads-v1', tasks: [{ id: 'read', output: 'machine-json' }] };
test('preserve actual measurements and explicit unavailable metrics', () => {
  const report = taskReport(measured, catalog, 'a'.repeat(64), 'b'.repeat(40));
  const actual = report.tasks[0].samples[0];
  assert.equal(actual.durationMs, 12.5);
  assert.equal(actual.stdoutBytes, 89);
  assert.equal(actual.stderrBytes, 4);
  assert.equal(actual.requestCount.value, 1);
  assert.equal(actual.outputTokens.value, null);
  assert.equal(actual.outputTokens.status, 'unavailable');
  assert.equal(report.publicationReadback, 'unknown');
  assert.equal(report.target.family, null);
  assert.equal(report.agentGeneratedTokens.status, 'not-collected');
});
test('missing or unverified execution cannot become passed tasks', () => {
  assert.throws(() => taskReport({ ...measured, status: 'failed' }, catalog), /Verified/);
  assert.throws(() => taskReport({ ...measured, cases: [] }, catalog), /Missing/);
});
