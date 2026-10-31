import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureRelatedReads } from './support/records-performance.js';

for (const mode of ['batch', 'individual', 'unsupported']) {
  test(`real HTTP ${mode} count fanout is capped, cached, record-scoped and never fetches child rows`, async () => {
    const result = await measureRelatedReads({ mode });
    const { cold, cached, other_record: other } = result.phases;
    assert.equal(cold.aggregate_operations, 50);
    assert.equal(cold.available, 50); assert.equal(cold.unavailable, 10); assert.equal(cold.coverage, 'partial');
    assert.equal(cold.http_requests, mode === 'batch' ? 1 : mode === 'unsupported' ? 51 : 50);
    assert.equal(cached.http_requests, 0); assert.equal(cached.aggregate_operations, 0);
    assert.equal(cached.available, 50);
    assert.equal(other.aggregate_operations, 50, 'a different parent cannot reuse the first parent counts');
    assert.equal(other.http_requests, mode === 'batch' ? 1 : 50);
    assert.equal(result.batch_attempts, mode === 'batch' ? 2 : mode === 'unsupported' ? 1 : 0);
    assert.ok(result.peak_http_concurrency <= (mode === 'individual' ? 4 : 1));
    assert.equal(result.only_aggregate_reads, true);
  });
}
