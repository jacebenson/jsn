// Tests for ATF commands — structure, endpoint ladder, result normalization
// API model matches now-sdk cicd: tests/run_test → progress poll → result enrich

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { errAPI } from '../src/errors.js';

// ─── Command Structure ───

describe('ATF Command Structure', () => {
  it('should export atfCmd', async () => {
    const { atfCmd } = await import('../src/commands/atf.js');
    assert.strictEqual(typeof atfCmd, 'function');
  });

  it('should define all subcommands', async () => {
    const { atfCmd } = await import('../src/commands/atf.js');
    const wrap = (fn) => fn;
    const cmd = atfCmd(wrap);
    const subcommands = [];
    const mockYargs = { command: (c) => { subcommands.push(typeof c === 'string' ? c : c.command); return mockYargs; } };
    cmd.builder(mockYargs);
    const names = subcommands.map(s => s.split(' ')[0]);
    for (const n of ['list', 'suites', 'run', 'run-suite', 'results']) {
      assert.ok(names.includes(n), `missing subcommand: ${n}`);
    }
  });
});

// ─── Mock app helper ───

function mockApp({ requestImpl, listImpl, getImpl, createImpl } = {}) {
  const calls = { request: [], list: [], get: [], create: [] };
  const app = {
    getEffectiveInstance: () => 'https://dev.service-now.com',
    requireInstance: () => {},
    sdk: {
      baseURL: 'https://dev.service-now.com',
      request: async (endpoint, opts = {}) => {
        calls.request.push({ endpoint, method: opts.method || 'GET', body: opts.body });
        if (!requestImpl) throw new Error(`unexpected request: ${endpoint}`);
        return requestImpl(endpoint, opts);
      },
      list: async (table, params) => {
        calls.list.push({ table, params });
        return listImpl ? listImpl(table, params) : [];
      },
      get: async (table, sysID) => {
        calls.get.push({ table, sysID });
        return getImpl ? getImpl(table, sysID) : null;
      },
      create: async (table, data) => {
        calls.create.push({ table, data });
        return createImpl ? createImpl(table, data) : { sys_id: 'tbl001' };
      },
    },
  };
  return { app, calls };
}

// ─── Helpers ───

describe('pick ids from dispatch responses', () => {
  it('extracts progress and result ids from sn_cicd links', async () => {
    const { pickProgressId, pickResultId } = await import('../src/commands/atf.js');
    const resp = { result: { links: { progress: { id: 'p1' }, results: { id: 'r1' } } } };
    assert.strictEqual(pickProgressId(resp), 'p1');
    assert.strictEqual(pickResultId(resp), 'r1');
  });

  it('handles legacy flat shapes', async () => {
    const { pickExecutionId, pickProgressId, pickResultId } = await import('../src/commands/atf.js');
    assert.strictEqual(pickExecutionId({ result: { sys_id: 's1' } }), 's1');
    assert.strictEqual(pickExecutionId({ result: 'str1' }), 'str1');
    assert.strictEqual(pickResultId({ result: { result_id: 'r2' } }), 'r2');
    assert.strictEqual(pickProgressId({ result: { progress_id: 'p2' } }), 'p2');
    assert.strictEqual(pickExecutionId({}), '');
    assert.strictEqual(pickExecutionId(null), '');
  });
});

describe('isEndpointMissing', () => {
  it('returns true for 404 and 403, false for others', async () => {
    const { isEndpointMissing } = await import('../src/commands/atf.js');
    assert.strictEqual(isEndpointMissing(errAPI(404, 'nope')), true);
    assert.strictEqual(isEndpointMissing(errAPI(403, 'nope')), true);
    assert.strictEqual(isEndpointMissing(errAPI(500, 'boom')), false);
    assert.strictEqual(isEndpointMissing(errAPI(400, 'bad')), false);
    assert.strictEqual(isEndpointMissing(null), false);
  });

  it('treats 400 "Requested URI does not represent any resource" as endpoint-missing', async () => {
    const { isEndpointMissing } = await import('../src/commands/atf.js');
    const err = errAPI(400, '{"error":{"message":"Requested URI does not represent any resource","detail":"Requested URI does not represent any resource"}}');
    assert.strictEqual(isEndpointMissing(err), true);
  });
});

describe('resolveAtf', () => {
  it('resolves by sys_id when given 32 hex chars', async () => {
    const { resolveAtf } = await import('../src/commands/atf.js');
    const sysID = 'a'.repeat(32);
    const { app, calls } = mockApp({ listImpl: () => [{ sys_id: sysID, name: 'Login Test' }] });
    const rec = await resolveAtf(app, 'sys_atf_test', sysID, 'ATF test');
    assert.strictEqual(rec.name, 'Login Test');
    assert.strictEqual(calls.list[0].params.get('sysparm_query'), `sys_id=${sysID}`);
  });

  it('resolves by name', async () => {
    const { resolveAtf } = await import('../src/commands/atf.js');
    const { app, calls } = mockApp({ listImpl: () => [{ sys_id: 't1', name: 'Login Test' }] });
    await resolveAtf(app, 'sys_atf_test', 'Login Test', 'ATF test');
    assert.strictEqual(calls.list[0].params.get('sysparm_query'), 'name=Login Test');
  });

  it('throws not_found when no record matches', async () => {
    const { resolveAtf } = await import('../src/commands/atf.js');
    const { app } = mockApp({ listImpl: () => [] });
    await assert.rejects(resolveAtf(app, 'sys_atf_test', 'Missing', 'ATF test'), (err) => err.code === 'not_found');
  });
});

// ─── Run ladder ───

describe('scheduleTestRun endpoint ladder', () => {
  it('uses sn_cicd tests/run_test first when it responds', async () => {
    const { scheduleTestRun } = await import('../src/commands/atf.js');
    const { app, calls } = mockApp({
      requestImpl: () => ({ result: { links: { progress: { id: 'p1' }, results: { id: 'r1' } } } }),
    });
    const out = await scheduleTestRun(app, 't1');
    assert.deepStrictEqual(out, { executionId: 'r1', progressId: 'p1', resultId: 'r1', kind: 'sn_cicd_test', via: 'sn_cicd' });
    assert.ok(calls.request[0].endpoint.includes('/api/sn_cicd/tests/run_test?test_sys_id=t1'));
    assert.strictEqual(calls.request[0].method, 'POST');
  });

  it('falls back to sn_atf/rest when sn_cicd 404s', async () => {
    const { scheduleTestRun } = await import('../src/commands/atf.js');
    const { app, calls } = mockApp({
      requestImpl: (endpoint) => {
        if (endpoint.includes('/sn_cicd/')) throw errAPI(404, 'no such endpoint');
        return { result: { sys_id: 'r2' } };
      },
    });
    const out = await scheduleTestRun(app, 't1');
    assert.deepStrictEqual(out, { executionId: 'r2', progressId: '', resultId: 'r2', kind: 'table', via: 'sn_atf' });
    assert.ok(calls.request[1].endpoint.endsWith('/api/sn_atf/rest/test'));
  });

  it('falls all the way to the table insert as last resort', async () => {
    const { scheduleTestRun } = await import('../src/commands/atf.js');
    const { app, calls } = mockApp({
      requestImpl: () => { throw errAPI(404, 'missing'); },
      createImpl: (table, data) => {
        assert.strictEqual(table, 'sys_atf_test_result');
        assert.deepStrictEqual(data, { test: 't1', status: 'scheduled' });
        return { sys_id: 'tbl001' };
      },
    });
    const out = await scheduleTestRun(app, 't1');
    assert.deepStrictEqual(out, { executionId: 'tbl001', progressId: '', resultId: 'tbl001', kind: 'table', via: 'table_insert' });
    assert.strictEqual(calls.create.length, 1);
    assert.strictEqual(calls.request.length, 3); // sn_cicd + sn_atf + legacy
  });

  it('aborts on non-endpoint-missing errors (no silent fallback)', async () => {
    const { scheduleTestRun } = await import('../src/commands/atf.js');
    const { app, calls } = mockApp({
      requestImpl: () => { throw errAPI(500, 'server exploded'); },
    });
    await assert.rejects(scheduleTestRun(app, 't1'), (err) => err.status === 500);
    assert.strictEqual(calls.create.length, 0);
    assert.strictEqual(calls.request.length, 1);
  });
});

describe('scheduleSuiteRun endpoint ladder', () => {
  it('uses sn_cicd testsuite/run first', async () => {
    const { scheduleSuiteRun } = await import('../src/commands/atf.js');
    const { app, calls } = mockApp({
      requestImpl: () => ({ result: { links: { progress: { id: 'sp1' }, results: { id: 'sr1' } } } }),
    });
    const out = await scheduleSuiteRun(app, 's1');
    assert.deepStrictEqual(out, { executionId: 'sr1', progressId: 'sp1', resultId: 'sr1', kind: 'sn_cicd_suite', via: 'sn_cicd' });
    assert.ok(calls.request[0].endpoint.includes('/api/sn_cicd/testsuite/run?test_suite_sys_id=s1'));
  });

  it('falls back to sn_atf/rest/suite', async () => {
    const { scheduleSuiteRun } = await import('../src/commands/atf.js');
    const { app, calls } = mockApp({
      requestImpl: (endpoint) => {
        if (endpoint.includes('/sn_cicd/')) throw errAPI(404, 'missing');
        return { result: { sys_id: 'sr2' } };
      },
    });
    const out = await scheduleSuiteRun(app, 's1');
    assert.deepStrictEqual(out, { executionId: 'sr2', progressId: '', resultId: 'sr2', kind: 'table', via: 'sn_atf' });
    assert.ok(calls.request[1].endpoint.endsWith('/api/sn_atf/rest/suite'));
  });

  it('throws usage when no suite API is available', async () => {
    const { scheduleSuiteRun } = await import('../src/commands/atf.js');
    const { app } = mockApp({ requestImpl: () => { throw errAPI(404, 'missing'); } });
    await assert.rejects(scheduleSuiteRun(app, 's1'), (err) => err.code === 'usage_error');
  });
});

// ─── Result fetching / polling ───

describe('pollExecution (sn_cicd progress)', () => {
  it('polls progress to terminal and enriches with the result record', async () => {
    const { pollExecution } = await import('../src/commands/atf.js');
    const { app, calls } = mockApp({
      requestImpl: (endpoint) => {
        if (endpoint.includes('/progress/')) return { result: { status: '2', percent_complete: 100, status_message: 'done' } };
        if (endpoint.includes('/tests/test/results/')) return { result: { test_status: 'passed', output: 'ok', links: { results: { url: 'https://x/result' } } } };
        throw new Error(`unexpected: ${endpoint}`);
      },
    });
    const res = await pollExecution(app, { executionId: 'r1', progressId: 'p1', resultId: 'r1', kind: 'sn_cicd_test' }, 5000, 5);
    assert.strictEqual(res.status, 'passed');
    assert.strictEqual(res.output, 'ok');
    assert.strictEqual(res.tracker.percent, 100);
    assert.ok(calls.request.some((c) => c.endpoint.includes('/api/sn_cicd/progress/p1')));
    assert.ok(calls.request.some((c) => c.endpoint.includes('/api/sn_cicd/tests/test/results/r1')));
  });

  it('throws a usage error after the timeout while progress is running', async () => {
    const { pollExecution } = await import('../src/commands/atf.js');
    const { app } = mockApp({
      requestImpl: () => ({ result: { status: '1', percent_complete: 10, status_message: 'running' } }),
    });
    await assert.rejects(
      pollExecution(app, { executionId: 'r1', progressId: 'p1', resultId: 'r1', kind: 'sn_cicd_test' }, 20, 5),
      (err) => err.code === 'usage_error'
    );
  });
});

describe('pollExecution (table kinds)', () => {
  it('returns a terminal status from the result table', async () => {
    const { pollExecution } = await import('../src/commands/atf.js');
    const { app } = mockApp({
      getImpl: (table) => table === 'sys_atf_test_result'
        ? { sys_id: 'r1', test: 't1', status: 'failed' }
        : null,
    });
    const res = await pollExecution(app, { executionId: 'r1', progressId: '', resultId: 'r1', kind: 'table' }, 5000, 5);
    assert.strictEqual(res.status, 'failed');
    assert.strictEqual(res.table, 'sys_atf_test_result');
  });

  it('derives completion from end_time/output when no status column exists', async () => {
    const { pollExecution } = await import('../src/commands/atf.js');
    const { app } = mockApp({
      getImpl: (table) => table === 'sys_atf_test_result'
        ? { sys_id: 'r1', test: 't1', start_time: '2026-01-01 00:00:00', end_time: '2026-01-01 00:00:05', output: 'PASS' }
        : null,
    });
    const res = await pollExecution(app, { executionId: 'r1', progressId: '', resultId: 'r1', kind: 'table' }, 5000, 5);
    assert.strictEqual(res.status, 'passed');
  });
});

describe('fetchAnyResult', () => {
  it('tries sn_cicd test result first', async () => {
    const { fetchAnyResult } = await import('../src/commands/atf.js');
    const { app } = mockApp({
      requestImpl: () => ({ result: { test_status: 'failed', output: 'nope' } }),
    });
    const res = await fetchAnyResult(app, 'r1');
    assert.strictEqual(res.status, 'failed');
    assert.strictEqual(res.execution_id, 'r1');
  });

  it('falls through to the progress tracker', async () => {
    const { fetchAnyResult } = await import('../src/commands/atf.js');
    const { app } = mockApp({
      requestImpl: (endpoint) => {
        if (endpoint.includes('/results/')) throw errAPI(404, 'missing');
        return { result: { status: '3', percent_complete: 100, status_message: 'boom', status_detail: 'detail' } };
      },
    });
    const res = await fetchAnyResult(app, 'p1');
    assert.strictEqual(res.status, 'error');
    assert.strictEqual(res.message, 'boom');
  });

  it('falls back to the result table', async () => {
    const { fetchAnyResult } = await import('../src/commands/atf.js');
    const { app } = mockApp({
      requestImpl: () => { throw errAPI(404, 'missing'); },
      getImpl: (table) => table === 'sys_atf_test_result'
        ? { sys_id: 'r1', test: 't1', status: 'passed' }
        : null,
    });
    const res = await fetchAnyResult(app, 'r1');
    assert.strictEqual(res.status, 'passed');
    assert.strictEqual(res.table, 'sys_atf_test_result');
  });
});

// ─── Suite filtering ───

describe('buildSuiteQuery', () => {
  it('returns "" for an empty suite', async () => {
    const { buildSuiteQuery } = await import('../src/commands/atf.js');
    assert.strictEqual(buildSuiteQuery('', []), '');
  });

  it('builds a sys_idIN query', async () => {
    const { buildSuiteQuery } = await import('../src/commands/atf.js');
    const q = buildSuiteQuery('', ['a', 'b']);
    assert.strictEqual(q, 'sys_idINa,b');
  });

  it('ANDs a user query on top', async () => {
    const { buildSuiteQuery } = await import('../src/commands/atf.js');
    const q = buildSuiteQuery('active=true', ['a', 'b']);
    assert.strictEqual(q, 'active=true^sys_idINa,b');
  });
});

describe('suiteTestIds', () => {
  it('collects and dedupes test sys_ids', async () => {
    const { suiteTestIds } = await import('../src/commands/atf.js');
    const { app, calls } = mockApp({
      listImpl: (table) => table === 'sys_atf_test_suite_test'
        ? [{ test: { value: 't1' } }, { test: { value: 't2' } }, { test: { value: 't1' } }, { test: '' }]
        : [],
    });
    const ids = await suiteTestIds(app, 's1');
    assert.deepStrictEqual(ids, ['t1', 't2']);
    assert.strictEqual(calls.list[0].params.get('sysparm_query'), 'test_suite=s1');
  });
});
