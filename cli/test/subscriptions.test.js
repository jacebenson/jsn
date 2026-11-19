import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSchedule } from '../src/subscriptions.js';

test('dated ITOM schedule preserves source applicability, ratios and unresolved literal', () => {
  const s = loadSchedule();
  assert.equal(s.effective_for_skus_introduced, '2026-04-09');
  assert.deepEqual(s.categories.map(c => c.resources_per_su), [1, 3, 10, 3, 4, 20, 1, 1, 3, 1, 4]);
  assert.ok(s.categories[1].classes.includes('cmdb_ci_could_database'));
  assert.match(s.source_url, /servicenow.com.*\.pdf$/);
});
