import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-perf-'));
  process.env.JSN_DATA_HOME = dir;
});

afterEach(() => {
  delete process.env.JSN_DATA_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
});

function sdkFor({ failTable } = {}) {
  return {
    async list(table) {
      if (table === 'sys_cluster_state') return [];
      if (failTable === table) throw new Error(`permission denied for ${table}`);
      return [];
    },
    async get() { return null; },
    async aggregate(table) {
      if (failTable === table) throw new Error(`permission denied for ${table}`);
      return { groups: [] };
    },
    async aggregateCount(table) {
      if (failTable === table) throw new Error(`permission denied for ${table}`);
      return table === 'incident' ? 7 : 0;
    },
  };
}

describe('performance capture storage', () => {
  it('creates a durable complete run with metadata and independent collectors', async () => {
    const { captureRun, getRun, listRuns } = await import('../src/perf.js');
    const run = await captureRun({ sdk: sdkFor(), instance: 'https://dev.example', profile: 'admin', username: 'admin', label: 'before' });
    assert.match(run.run_id, /^\d{8}T\d{6}Z/);
    assert.equal(run.status, 'complete');
    assert.equal(run.label, 'before');
    assert.equal(run.capture_schema_version, 1);
    assert.equal(run.collectors.length, 8);
    assert.ok(run.collectors.every(c => c.status === 'success'));
    assert.deepEqual(getRun(run.run_id).run_id, run.run_id);
    assert.equal(listRuns()[0].run_id, run.run_id);
  });

  it('keeps partial collector failures without invalidating the run', async () => {
    const { captureRun } = await import('../src/perf.js');
    const run = await captureRun({ sdk: sdkFor({ failTable: 'syslog' }), instance: 'https://dev.example' });
    assert.equal(run.status, 'incomplete');
    const logs = run.collectors.find(c => c.name === 'error_warning_summary');
    assert.equal(logs.status, 'permission_denied');
    assert.match(logs.reason, /permission denied/);
    assert.equal(logs.data, null);
  });

  it('fails fast when the same instance and profile is already captured', async () => {
    const { acquireCaptureLock, captureRun } = await import('../src/perf.js');
    const lock = acquireCaptureLock('admin', 'https://dev.example');
    try {
      await assert.rejects(
        captureRun({ sdk: sdkFor(), instance: 'https://dev.example', profile: 'admin' }),
        error => error.code === 'perf_capture_overlap' && /already running/.test(error.message),
      );
    } finally {
      lock.release();
    }
  });
});

describe('performance formatter', () => {
  it('shows captured metric details in the default view', async () => {
    const { formatRunDetailed } = await import('../src/perf.js');
    const output = formatRunDetailed({
      run_id: 'RUN1', label: 'before', status: 'complete', instance: 'https://dev.example', profile: 'admin', start_time: '2026-08-28T00:00:00Z',
      collectors: [{ name: 'transactions', status: 'success', reason: null, data: { metrics: { transaction_types: [{ type: 'rest', count: 4, avg_response_time_ms: 12, max_response_time_ms: 30 }] } } }],
    });
    assert.match(output, /CAPTURED DETAILS/);
    assert.match(output, /rest: 4 requests, avg 12 ms, max 30 ms/);
  });
});

describe('performance comparison', () => {
  it('marks missing metrics unavailable and does not calculate a delta', async () => {
    const { compareRuns } = await import('../src/perf.js');
    const baseline = { run_id: 'A', collectors: [{ name: 'one', data: { metrics: { count: 2, old_metric: 9 } } }] };
    const newer = { run_id: 'B', collectors: [{ name: 'one', data: { metrics: { count: 5, new_metric: 11 } } }] };
    const result = compareRuns(baseline, newer);
    assert.equal(result.status, 'incomplete');
    assert.deepEqual(result.metrics.find(m => m.metric === 'one.count'), { metric: 'one.count', availability: 'available', baseline: 2, new: 5, delta: 3, percent_change: 150 });
    assert.equal(result.metrics.find(m => m.metric === 'one.old_metric').availability, 'missing_from_new');
    assert.equal(result.metrics.find(m => m.metric === 'one.new_metric').availability, 'missing_from_baseline');
    assert.equal(result.metrics.find(m => m.metric === 'one.old_metric').delta, null);
  });
});
