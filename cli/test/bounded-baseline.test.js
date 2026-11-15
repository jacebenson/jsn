import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { measureBaseline, budgetPath, checkBudgets, statistics } from './support/bounded-baseline.js';

test('bounded offline CLI reads preserve rows, fields, docs semantics, request counts and measured byte budgets', { timeout: 120000 }, async () => {
  const budgets = JSON.parse(fs.readFileSync(budgetPath, 'utf8'));
  const result = await measureBaseline({ repetitions: 3, budgets });
  assert.equal(result.fixture_sha256, budgets.fixture_sha256, 'fixture changes require deliberate rebaseline');
  assert.equal(result.cases.length, 33);
  assert.equal(result.cases.reduce((n, c) => n + c.samples.length, 0), 99);
  // Prove a deliberate one-byte regression rejects, then the restored baseline passes.
  const broken = structuredClone(budgets);
  const first = result.cases[0];
  broken.cases[first.id].stdout_bytes = first.samples[0].stdout_bytes - 1;
  assert.throws(() => checkBudgets(result.cases, broken), /exceeds fixture ceiling/);
  checkBudgets(result.cases, budgets);
  for (const mode of ['outline', 'section']) assert.ok(
    result.cases.find(c => c.id === `docs/${mode}`).samples[0].stdout_bytes <
    result.cases.find(c => c.id === 'docs/full').samples[0].stdout_bytes);
});

test('median and nearest-rank p95 are computed, not guessed', () => {
  assert.deepEqual(statistics([50, 10, 20, 40, 30]), { median: 30, p95: 50 });
  assert.deepEqual(statistics([4, 1, 3, 2]), { median: 2.5, p95: 4 });
});
