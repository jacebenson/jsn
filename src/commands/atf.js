// ATF (Automated Test Framework) commands — top-level `jsn atf`
//
// Reference: todo.md item 3. Execution is shipped here; generation
// (`jsn atf create`) is the greenfield wedge tracked separately.
//
// Run endpoints are tried in order (see scheduleTestRun):
//   1. POST /api/sn_cicd/tests/run_test       (modern CICD API — real path per
//      now-sdk cicd/operations.ts: tests.run_test, NOT /test/run)
//   2. POST /api/sn_atf/rest/test             (ATF plugin REST)
//   3. POST /api/now/atf/test/{id}/run        (legacy)
//   4. POST /api/now/table/sys_atf_test_result (last resort, mutation-gated)
//
// Polling (sn_cicd path): dispatch returns result.links.progress.id; poll
// GET /api/sn_cicd/progress/{id} whose status is 0=pending, 1=running,
// 2=successful, 3=error, 4=canceled. The progress tracker's successful flag
// IS the pass/fail source of truth (now-sdk atf-results.ts). On terminal,
// fetch result.links.results.id for enrichment (test_status / counts).
//
// Run is a mutation (it schedules tests that act on records), so it's gated
// by confirmDelete + registered in MUTATION_COMMANDS for read-only profiles.

import {
  getStringField, interactiveList,
  resolveFieldsParam, assertSafeExactMatch, confirmDelete,
} from '../helpers.js';
import { errUsage, errNotFound } from '../errors.js';

// sn_cicd progress statuses (now-sdk poller.ts)
const PROGRESS_PENDING = '0';
const PROGRESS_RUNNING = '1';
const PROGRESS_SUCCESSFUL = '2';
const PROGRESS_ERROR = '3';
const PROGRESS_CANCELED = '4';
const PROGRESS_TERMINAL = new Set([PROGRESS_SUCCESSFUL, PROGRESS_ERROR, PROGRESS_CANCELED]);

// Terminal statuses for sys_atf_test_result (older instances that expose a status field)
const TERMINAL_TABLE_STATUSES = new Set(['passed', 'failed', 'error', 'canceled', 'cancelled', 'skipped']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * True when the API error means "endpoint/plugin missing" — safe to fall
 * through the ladder. Some instances report a missing endpoint as 404,
 * others as 400 with ServiceNow's "Requested URI does not represent any
 * resource" body (e.g. when the sn_cicd API isn't enabled).
 */
export function isEndpointMissing(err) {
  if (err?.status === 404 || err?.status === 403) return true;
  if (err?.status === 400 && /Requested URI does not represent any resource/.test(err.message || '')) return true;
  return false;
}

/** Extract an execution/result id from a run response (legacy/plugin shapes). */
export function pickExecutionId(resp) {
  if (!resp || typeof resp !== 'object') return '';
  if (typeof resp.result === 'string') return resp.result;
  const inner = resp.result && typeof resp.result === 'object' ? resp.result : null;
  const src = inner || resp;
  for (const key of ['result_id', 'sys_id', 'tracker_id', 'progress_id', 'id']) {
    const v = src?.[key];
    if (v == null) continue;
    if (typeof v === 'object') {
      if (v.value) return String(v.value);
      if (v.display_value) return String(v.display_value);
    } else if (v) {
      return String(v);
    }
  }
  return '';
}

/** Extract result.links.progress.id (sn_cicd dispatch shape). */
export function pickProgressId(resp) {
  if (!resp || typeof resp !== 'object') return '';
  const inner = resp.result && typeof resp.result === 'object' ? resp.result : null;
  const src = inner || resp;
  return src?.links?.progress?.id || src?.progress_id || src?.tracker_id || '';
}

/** Extract result.links.results.id (sn_cicd dispatch shape), else legacy ids. */
export function pickResultId(resp) {
  if (!resp || typeof resp !== 'object') return '';
  if (typeof resp.result === 'string') return resp.result;
  const inner = resp.result && typeof resp.result === 'object' ? resp.result : null;
  const src = inner || resp;
  return src?.links?.results?.id || src?.result_id || src?.sys_id || '';
}

/**
 * Resolve an ATF test/suite by sys_id or name.
 * @returns {Promise<object>} raw record
 */
export async function resolveAtf(app, table, id, label) {
  assertSafeExactMatch(id);
  const isSysID = /^[0-9a-fA-F]{32}$/.test(id);
  const params = new URLSearchParams();
  params.set('sysparm_query', isSysID ? `sys_id=${id}` : `name=${id}`);
  params.set('sysparm_limit', '1');
  params.set('sysparm_display_value', 'all');
  const records = await app.sdk.list(table, params);
  if (!records || records.length === 0) throw errNotFound(label, id);
  return records[0];
}

/**
 * Collect the test sys_ids that belong to a suite (M2M table).
 * Deduped, in suite-member order.
 */
export async function suiteTestIds(app, suiteSysID) {
  const params = new URLSearchParams();
  params.set('sysparm_query', `test_suite=${suiteSysID}`);
  params.set('sysparm_limit', '500');
  params.set('sysparm_fields', 'test');
  const m2m = await app.sdk.list('sys_atf_test_suite_test', params);
  return [...new Set(m2m.map((r) => getStringField(r, 'test')).filter(Boolean))];
}

/**
 * Build the encoded query for a suite-filtered test list. Chunks the IN
 * clause (URL-length safety) and ANDs the user's query on top.
 */
export function buildSuiteQuery(userQuery, testIds) {
  if (!testIds || testIds.length === 0) return '';
  const chunks = [];
  for (let i = 0; i < testIds.length; i += 150) chunks.push(testIds.slice(i, i + 150).join(','));
  const inQuery = chunks.map((c) => `sys_idIN${c}`).join('^OR');
  return userQuery ? `${userQuery}^${inQuery}` : inQuery;
}

/**
 * Schedule a single ATF test run via the endpoint ladder.
 * @returns {Promise<{executionId, progressId, resultId, kind: 'sn_cicd_test'|'table', via}>}
 */
export async function scheduleTestRun(app, testSysID) {
  const base = app.sdk.baseURL;
  // 1) sn_cicd (modern) — params are QUERY params per the API spec
  //    (openapi/sn_cicd-CICD_ATF_Test_Execution_API.json: test_sys_id in:query)
  try {
    const resp = await app.sdk.request(`${base}/api/sn_cicd/tests/run_test?test_sys_id=${encodeURIComponent(testSysID)}`, {
      method: 'POST',
    });
    const progressId = pickProgressId(resp);
    const resultId = pickResultId(resp);
    if (!progressId && !resultId) throw errUsage('sn_cicd tests/run_test returned no progress/result link');
    return { executionId: resultId || progressId, progressId, resultId, kind: 'sn_cicd_test', via: 'sn_cicd' };
  } catch (err) {
    if (!isEndpointMissing(err)) throw err;
  }
  // 2) sn_atf REST (ATF plugin)
  try {
    const resp = await app.sdk.request(`${base}/api/sn_atf/rest/test`, {
      method: 'POST',
      body: JSON.stringify({ test_id: testSysID }),
    });
    const executionId = pickExecutionId(resp);
    if (!executionId) throw errUsage('sn_atf/rest/test returned no result id');
    return { executionId, progressId: '', resultId: executionId, kind: 'table', via: 'sn_atf' };
  } catch (err) {
    if (!isEndpointMissing(err)) throw err;
  }
  // 3) legacy
  try {
    const resp = await app.sdk.request(`${base}/api/now/atf/test/${testSysID}/run`, { method: 'POST' });
    const executionId = pickExecutionId(resp);
    if (!executionId) throw errUsage('legacy ATF run returned no result id');
    return { executionId, progressId: '', resultId: executionId, kind: 'table', via: 'legacy' };
  } catch (err) {
    if (!isEndpointMissing(err)) throw err;
  }
  // 4) table insert — last resort, mutation-gated by the command's confirm
  const created = await app.sdk.create('sys_atf_test_result', { test: testSysID, status: 'scheduled' });
  const executionId = getStringField(created, 'sys_id');
  if (!executionId) throw errUsage('Table-insert fallback returned no sys_id');
  return { executionId, progressId: '', resultId: executionId, kind: 'table', via: 'table_insert' };
}

/**
 * Schedule an ATF suite run.
 * @returns {Promise<{executionId, progressId, resultId, kind: 'sn_cicd_suite'|'table', via}>}
 */
export async function scheduleSuiteRun(app, suiteSysID) {
  const base = app.sdk.baseURL;
  // 1) sn_cicd (modern) — test_suite_sys_id is a QUERY param per the API spec
  //    (openapi/sn_cicd-CICD_ATF_Suite_Execution_API.json)
  try {
    const resp = await app.sdk.request(`${base}/api/sn_cicd/testsuite/run?test_suite_sys_id=${encodeURIComponent(suiteSysID)}`, {
      method: 'POST',
    });
    const progressId = pickProgressId(resp);
    const resultId = pickResultId(resp);
    if (!progressId && !resultId) throw errUsage('sn_cicd testsuite/run returned no progress/result link');
    return { executionId: resultId || progressId, progressId, resultId, kind: 'sn_cicd_suite', via: 'sn_cicd' };
  } catch (err) {
    if (!isEndpointMissing(err)) throw err;
  }
  // 2) sn_atf REST (ATF plugin)
  try {
    const resp = await app.sdk.request(`${base}/api/sn_atf/rest/suite`, {
      method: 'POST',
      body: JSON.stringify({ suite_id: suiteSysID }),
    });
    const executionId = pickExecutionId(resp);
    if (!executionId) throw errUsage('sn_atf/rest/suite returned no result id');
    return { executionId, progressId: '', resultId: executionId, kind: 'table', via: 'sn_atf' };
  } catch (err) {
    if (!isEndpointMissing(err)) throw err;
  }
  throw errUsage(
    'No ATF run API available (sn_cicd and sn_atf both unreachable).\n' +
    'Verify the ATF plugin is installed and API access is enabled on the instance.'
  );
}

/** Fetch GET /api/sn_cicd/progress/{id}; null when the endpoint is missing. */
async function fetchCicdProgress(app, progressId) {
  try {
    const resp = await app.sdk.request(`${app.sdk.baseURL}/api/sn_cicd/progress/${progressId}`, { method: 'GET' });
    const r = resp?.result && typeof resp.result === 'object' ? resp.result : (resp ?? {});
    return {
      status: String(r.status ?? ''),
      percent: Number(r.percent_complete ?? 0),
      message: r.status_message ?? '',
      detail: r.status_detail ?? '',
      links: r.links ?? {},
      raw: r,
    };
  } catch (err) {
    if (!isEndpointMissing(err)) throw err;
    return null;
  }
}

/** Map an sn_cicd progress status to a word. */
function progressStatusWord(status) {
  switch (status) {
    case PROGRESS_PENDING: return 'pending';
    case PROGRESS_RUNNING: return 'running';
    case PROGRESS_SUCCESSFUL: return 'passed';
    case PROGRESS_ERROR: return 'error';
    case PROGRESS_CANCELED: return 'canceled';
    default: return 'unknown';
  }
}

/**
 * Fetch one sn_cicd result record; null when the endpoint is missing.
 * Instances disagree about whether a single test run links to the test or
 * the suite result endpoint (the progress tracker's links.results.url is
 * authoritative), so try both segments on 404.
 */
async function fetchCicdResult(app, resultId, kind) {
  const segments = kind === 'sn_cicd_test'
    ? ['tests/test/results', 'testsuite/results']
    : ['testsuite/results', 'tests/test/results'];
  let lastErr = null;
  for (const segment of segments) {
    try {
      const resp = await app.sdk.request(`${app.sdk.baseURL}/api/sn_cicd/${segment}/${resultId}`, { method: 'GET' });
      const r = resp?.result && typeof resp.result === 'object' ? resp.result : (resp ?? {});
      const links = r.links ?? {};
      const resultUrl = links.results?.url || '';
      const norm = (s) => String(s || '').toLowerCase().replace('failure', 'failed');
      if (segment === 'testsuite/results') {
        return {
          execution_id: resultId,
          status: norm(r.test_suite_status || r.test_status) || 'complete',
          test_suite_name: r.test_suite_name ?? '',
          passed: Number(r.rolledup_test_success_count ?? 0),
          failed: Number(r.rolledup_test_failure_count ?? 0),
          error_count: Number(r.rolledup_test_error_count ?? 0),
          skipped: Number(r.rolledup_test_skip_count ?? 0),
          output: r.output ?? '',
          url: resultUrl,
          raw: r,
        };
      }
      return {
        execution_id: resultId,
        status: norm(r.test_status || r.test_suite_status) || 'unknown',
        test: r.test_name ?? '',
        output: r.output ?? '',
        url: resultUrl,
        raw: r,
      };
    } catch (err) {
      if (!isEndpointMissing(err)) throw err;
      lastErr = err;
    }
  }
  if (lastErr) return null;
  return null;
}

/** Fetch a result from the sys_atf_test_result tables; null when not found. */
export async function fetchTableResult(app, executionId) {
  for (const table of ['sys_atf_test_result', 'sys_atf_test_suite_result']) {
    try {
      const rec = await app.sdk.get(table, executionId);
      if (rec) return normalizeTableResult(rec, table);
    } catch (err) {
      if (!isEndpointMissing(err)) throw err;
    }
  }
  return null;
}

/** Normalize a sys_atf_test_result / sys_atf_test_suite_result row. */
function normalizeTableResult(rec, table) {
  const statusRaw = String(getStringField(rec, 'status') || '').toLowerCase();
  const endTime = getStringField(rec, 'end_time');
  const output = getStringField(rec, 'output');
  const failing = getStringField(rec, 'first_failing_step');
  let status = statusRaw || 'unknown';
  if (!statusRaw) {
    if (failing) status = 'failed';
    else if (endTime && output) status = 'passed';
    else if (endTime) status = 'complete';
    else if (getStringField(rec, 'start_time')) status = 'running';
  }
  return {
    execution_id: getStringField(rec, 'sys_id'),
    table,
    test: getStringField(rec, 'test') || getStringField(rec, 'test_suite'),
    status,
    started: getStringField(rec, 'sys_created_on') || '',
    updated: getStringField(rec, 'sys_updated_on') || '',
    raw: rec,
  };
}

function isTerminalTable(rec) {
  const status = String(getStringField(rec, 'status') || '').toLowerCase();
  if (TERMINAL_TABLE_STATUSES.has(status)) return true;
  const endTime = getStringField(rec, 'end_time');
  const output = getStringField(rec, 'output');
  const json = getStringField(rec, 'test_result_json');
  const failing = getStringField(rec, 'first_failing_step');
  return !!(endTime && (output || json || failing));
}

/**
 * Fetch an execution result by trying every source (used by `results`):
 * sn_cicd test result → sn_cicd suite result → progress tracker (following
 * its links.results.id for enrichment) → tables.
 */
export async function fetchAnyResult(app, executionId) {
  for (const kind of ['sn_cicd_test', 'sn_cicd_suite']) {
    const res = await fetchCicdResult(app, executionId, kind);
    if (res) return res;
  }
  const prog = await fetchCicdProgress(app, executionId);
  if (prog) {
    const base = {
      execution_id: executionId,
      status: progressStatusWord(prog.status),
      percent: prog.percent,
      message: prog.message,
      detail: prog.detail,
      raw: prog.raw,
    };
    const linkedResultId = prog.links?.results?.id || '';
    if (linkedResultId) {
      for (const kind of ['sn_cicd_test', 'sn_cicd_suite']) {
        const res = await fetchCicdResult(app, linkedResultId, kind);
        if (res) {
          return { ...base, result_id: linkedResultId, ...res, raw: res.raw };
        }
      }
    }
    return base;
  }
  return fetchTableResult(app, executionId);
}

/**
 * Poll an execution until it reaches a terminal state.
 * sn_cicd kinds poll the progress tracker, then enrich with the result
 * record; table kinds poll sys_atf_test_result directly.
 * @returns {Promise<object>} normalized result
 */
export async function pollExecution(app, { executionId, progressId, resultId, kind }, timeoutMs = 120000, intervalMs = 2000) {
  const start = Date.now();
  if (kind === 'sn_cicd_test' || kind === 'sn_cicd_suite') {
    let last = null;
    while (Date.now() - start < timeoutMs) {
      const prog = progressId ? await fetchCicdProgress(app, progressId) : null;
      if (prog && PROGRESS_TERMINAL.has(prog.status)) {
        const trackerStatus = progressStatusWord(prog.status);
        // The dispatch response often only carries the progress link; the
        // results link appears once the run completes. Follow it when present,
        // then fall back to the dispatch result id.
        let enriched = null;
        const linkedResultId = prog.links?.results?.id || '';
        if (linkedResultId) {
          for (const k of ['sn_cicd_test', 'sn_cicd_suite']) {
            const r = await fetchCicdResult(app, linkedResultId, k);
            if (r) { enriched = r; break; }
          }
        }
        if (!enriched && resultId && resultId !== progressId) {
          enriched = await fetchCicdResult(app, resultId, kind);
        }
        const status = enriched?.status && enriched.status !== 'unknown' ? enriched.status : trackerStatus;
        return {
          execution_id: resultId || progressId,
          progress_id: progressId,
          ...(enriched ? { result_id: enriched.execution_id, ...enriched } : {}),
          status,
          tracker: { status: prog.status, percent: prog.percent, message: prog.message, detail: prog.detail },
        };
      }
      last = prog;
      await sleep(intervalMs);
    }
    throw errUsage(
      `ATF run still ${last?.message || 'running'} after ${Math.round(timeoutMs / 1000)}s. ` +
      `Check later with: jsn atf results ${progressId || executionId}`
    );
  }

  // Table-based kinds (sn_atf / legacy / table insert)
  while (Date.now() - start < timeoutMs) {
    const rec = await fetchTableResult(app, executionId);
    if (rec && isTerminalTable(rec)) return rec;
    await sleep(intervalMs);
  }
  throw errUsage(
    `ATF run still running after ${Math.round(timeoutMs / 1000)}s. ` +
    `Check later with: jsn atf results ${executionId}`
  );
}

async function listRecords(app, table, columns, query, limit) {
  const params = new URLSearchParams();
  params.set('sysparm_limit', String(limit));
  params.set('sysparm_display_value', 'all');
  const fields = resolveFieldsParam(columns);
  if (fields) params.set('sysparm_fields', fields);
  if (query) params.set('sysparm_query', query);
  return app.sdk.list(table, params);
}

function outputList(app, table, columns, records, extra = {}) {
  app.ok({
    table,
    count: records.length,
    columns,
    records,
    context: { instance_url: app.getEffectiveInstance() },
    ...extra,
  }, { summary: `${records.length} record(s)` });
}

async function handleRun(app, argv, { entity, label, scheduled }) {
  if (!argv.wait) {
    app.ok({
      execution_id: scheduled.executionId,
      progress_id: scheduled.progressId,
      entity: label,
      status: 'scheduled',
      via: scheduled.via,
      poll: `jsn atf results ${scheduled.executionId}`,
    }, {
      summary: `Scheduled ATF ${entity}: ${label} (${scheduled.via}). Poll with: jsn atf results ${scheduled.executionId}`,
      breadcrumbs: [
        { action: 'results', cmd: `jsn atf results ${scheduled.executionId}`, description: 'Fetch the execution result' },
      ],
    });
    return;
  }
  const defaultTimeout = entity === 'suite' ? 300 : 120;
  const timeoutMs = (argv.timeout || defaultTimeout) * 1000;
  const result = await pollExecution(app, scheduled, timeoutMs);
  app.ok({
    execution_id: scheduled.executionId,
    progress_id: scheduled.progressId,
    entity: label,
    via: scheduled.via,
    ...result,
  }, { summary: `ATF ${entity} ${label}: ${result.status}` });
}

export function atfCmd(wrap) {
  return {
    command: 'atf [subcommand]',
    describe: 'Automated Test Framework (list, suites, run, results)',
    builder: (yargs) => {
      return yargs
        .command({
          command: 'list',
          aliases: ['ls'],
          describe: 'List ATF tests (optionally filtered by suite)',
          builder: (y) => y
            .option('query', { type: 'string', describe: 'Encoded query (e.g. "nameLIKElogin" or "active=true")' })
            .option('suite', { type: 'string', describe: 'Only tests in this suite (name or sys_id)' })
            .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns' })
            .option('limit', { alias: 'l', type: 'number', default: 50, describe: 'Max records' }),
          handler: wrap(async (argv, app) => {
            const columns = argv.columns ? argv.columns.split(',') : ['name', 'sys_class_name', 'active', 'sys_updated_on'];

            if (argv.suite) {
              app.requireInstance();
              const suite = await resolveAtf(app, 'sys_atf_test_suite', argv.suite, 'ATF suite');
              const suiteID = getStringField(suite, 'sys_id');
              const ids = await suiteTestIds(app, suiteID);
              const query = buildSuiteQuery(argv.query, ids);
              if (!query) {
                outputList(app, 'sys_atf_test', columns, [], { suite: getStringField(suite, 'name') });
                return;
              }
              const records = await listRecords(app, 'sys_atf_test', columns, query, argv.limit);
              outputList(app, 'sys_atf_test', columns, records, { suite: getStringField(suite, 'name') });
              return;
            }

            const picked = await interactiveList({
              app, table: 'sys_atf_test', singular: 'ATF test', columns, limit: argv.limit,
              query: argv.query, labelField: 'name',
              formatLabel: (r) => `${getStringField(r, 'name')} [${getStringField(r, 'sys_class_name') || '?'}]`,
            });
            if (picked === undefined) return; // user cancelled
            if (picked) {
              const sysID = getStringField(picked, 'sys_id');
              return app.ok(picked, {
                summary: `ATF test: ${getStringField(picked, 'name')}`,
                breadcrumbs: [
                  { action: 'run', cmd: `jsn atf run ${sysID}`, description: 'Run this test' },
                ],
              });
            }

            const records = await listRecords(app, 'sys_atf_test', columns, argv.query, argv.limit);
            outputList(app, 'sys_atf_test', columns, records);
          }),
        })
        .command({
          command: 'suites',
          aliases: ['ls-suite'],
          describe: 'List ATF test suites',
          builder: (y) => y
            .option('query', { type: 'string', describe: 'Encoded query' })
            .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns' })
            .option('limit', { alias: 'l', type: 'number', default: 50, describe: 'Max records' }),
          handler: wrap(async (argv, app) => {
            const columns = argv.columns ? argv.columns.split(',') : ['name', 'description', 'sys_updated_on'];
            const picked = await interactiveList({
              app, table: 'sys_atf_test_suite', singular: 'ATF suite', columns, limit: argv.limit,
              query: argv.query, labelField: 'name',
              formatLabel: (r) => {
                const desc = getStringField(r, 'description');
                return `${getStringField(r, 'name')}${desc ? ` — ${desc}` : ''}`;
              },
            });
            if (picked === undefined) return; // user cancelled
            if (picked) {
              const sysID = getStringField(picked, 'sys_id');
              let count = 0;
              try { count = (await suiteTestIds(app, sysID)).length; } catch { /* non-critical */ }
              return app.ok(picked, {
                summary: `ATF suite: ${getStringField(picked, 'name')}`,
                breadcrumbs: [
                  count > 0 ? { action: 'tests', cmd: `jsn atf list --suite "${getStringField(picked, 'name')}"`, description: `${count} test(s) in suite` } : null,
                  { action: 'run', cmd: `jsn atf run-suite ${sysID}`, description: 'Run the whole suite' },
                ].filter(Boolean),
              });
            }

            const records = await listRecords(app, 'sys_atf_test_suite', columns, argv.query, argv.limit);
            outputList(app, 'sys_atf_test_suite', columns, records);
          }),
        })
        .command({
          command: 'run <test>',
          describe: 'Run an ATF test (sys_id or name). Mutation — requires confirmation',
          builder: (y) => y
            .positional('test', { describe: 'Test sys_id or name', type: 'string' })
            .option('wait', { type: 'boolean', default: true, describe: 'Wait for completion (--no-wait to schedule and return immediately)' })
            .option('timeout', { type: 'number', describe: 'Poll timeout in seconds (default 120)' })
            .option('force', { type: 'boolean', default: false, describe: 'Skip confirmation' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            await confirmDelete(app, argv, `Run ATF test "${argv.test}"?`);
            const test = await resolveAtf(app, 'sys_atf_test', argv.test, 'ATF test');
            const scheduled = await scheduleTestRun(app, getStringField(test, 'sys_id'));
            await handleRun(app, argv, { entity: 'test', label: getStringField(test, 'name'), scheduled });
          }),
        })
        .command({
          command: 'run-suite <suite>',
          describe: 'Run an ATF test suite (sys_id or name). Mutation — requires confirmation',
          builder: (y) => y
            .positional('suite', { describe: 'Suite sys_id or name', type: 'string' })
            .option('wait', { type: 'boolean', default: true, describe: 'Wait for completion (--no-wait to schedule and return immediately)' })
            .option('timeout', { type: 'number', describe: 'Poll timeout in seconds (default 300)' })
            .option('force', { type: 'boolean', default: false, describe: 'Skip confirmation' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            await confirmDelete(app, argv, `Run ATF suite "${argv.suite}"?`);
            const suite = await resolveAtf(app, 'sys_atf_test_suite', argv.suite, 'ATF suite');
            const scheduled = await scheduleSuiteRun(app, getStringField(suite, 'sys_id'));
            await handleRun(app, argv, { entity: 'suite', label: getStringField(suite, 'name'), scheduled });
          }),
        })
        .command({
          command: 'results <id>',
          describe: 'Show an ATF execution result (id from run/run-suite)',
          builder: (y) => y
            .positional('id', { describe: 'Execution/result/progress sys_id', type: 'string' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const result = await fetchAnyResult(app, argv.id);
            if (!result) throw errNotFound('ATF execution', argv.id);
            app.ok(result, { summary: `ATF result ${argv.id}: ${result.status}` });
          }),
        });
    },
    handler: (argv) => {
      if (argv._[1]) return; // a subcommand ran — its own handler handled it
      console.log('Manage ServiceNow Automated Test Framework (ATF).\n');
      console.log('Commands:');
      console.log('  list               List ATF tests (--suite <name> filters)');
      console.log('  suites             List ATF test suites');
      console.log('  run <test>         Run a test by sys_id or name (polls by default)');
      console.log('  run-suite <suite>  Run a suite by sys_id or name');
      console.log('  results <id>       Show an execution result');
      console.log('\nRun "jsn atf <command> --help" for details.');
      console.log('\nRun is a mutation: it schedules tests that act on records.');
      console.log('  Confirm when prompted, or pass --force / profile skip_confirmations.');
    },
  };
}
