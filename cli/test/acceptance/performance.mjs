import fs from 'node:fs/promises';
import path from 'node:path';

const STATE = 'performance.suite';
const COLLECTORS = new Set(['platform_health', 'transactions', 'error_warning_summary', 'event_queue', 'ecc_queue', 'flow_executions', 'record_counts', 'scheduled_and_cleanup']);
const STATUS = new Set(['success', 'timeout', 'permission_denied', 'unsupported', 'unavailable', 'query_failure']);
const OUTCOME = new Set(['passed', 'failed', 'blocked', 'excluded', 'not-run']);
const unwrap = result => result?.json?.data ?? result?.json;
const ensure = (ok, message) => { if (!ok) throw new Error(message); };
const captureId = id => typeof id === 'string' && /^\d{8}T\d{6}Z(?:-\d+)?$/.test(id);

export function validateCapture(run) {
  ensure(run?.capture_schema_version === 1 && captureId(run.run_id), 'Unsupported or invalid perf capture schema/ID');
  ensure(['complete', 'incomplete'].includes(run.status) && Array.isArray(run.collectors), 'Malformed perf capture status/collectors');
  ensure(run.collectors.length === COLLECTORS.size && new Set(run.collectors.map(c => c.name)).size === COLLECTORS.size, 'Missing or duplicate perf collectors');
  ensure(run.collectors.every(c => COLLECTORS.has(c.name) && STATUS.has(c.status)), 'Unknown perf collector/schema');
  return run;
}

async function privateJson(root, name, result) {
  await fs.writeFile(path.join(root, name), JSON.stringify(result), { mode: 0o600, flag: 'wx' });
}

async function secureStorage(root) {
  // SQLite may create db/WAL/SHM with default permissions. Tighten only the
  // run-owned isolated data directory, never the user's existing perf store.
  const dir = path.join(root, 'data', 'perf');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    ensure(entry.isFile() && !entry.isSymbolicLink(), 'Unexpected entry in owned perf store');
    await fs.chmod(path.join(dir, entry.name), 0o600);
  }
}

async function perfCommand(ctx, state, args, file) {
  let result;
  try {
    result = await ctx.command(['perf', ...args, '--json'], { env: { JSN_DATA_HOME: path.join(state.root, 'data') } });
    await privateJson(state.root, file, result);
  } finally {
    await secureStorage(state.root);
  }
  ensure(result.exitCode === 0 && result.json, 'Performance command failed; private diagnostics retained');
  return unwrap(result);
}

async function capture(ctx, state, side) {
  const run = validateCapture(await perfCommand(ctx, state, ['capture', '--label', `${ctx.runKey}-${side}`], `${side}.json`));
  const shown = validateCapture(await perfCommand(ctx, state, ['show', run.run_id], `${side}-show.json`));
  ensure(shown.run_id === run.run_id && shown.status === run.status, 'Saved performance capture readback mismatch');
  return shown;
}

export async function observeEnvironment(ctx) {
  const environment = { platform: process.platform === 'linux' ? 'linux' : 'untested',
    domainSeparation: 'unknown', domainTable: 'unknown',
    domainSource: 'bounded Table API domain read via selected profile',
    effectiveAuth: 'unknown', effectiveRoles: 'unknown', effectiveDomain: 'unknown' };
  try {
    const found = await ctx.read('domain', { fields: ['sys_id'], limit: 1 });
    if (Array.isArray(found)) environment.domainTable = 'readable';
  } catch (error) {
    // Do not infer domain separation from a sys_domain dictionary field, an
    // empty response, ACL denial, unrelated 404 or the profile's claim.
    if ((!error.status || [400, 404].includes(error.status)) && /invalid table(?:\s+|:\s*)["'`]?domain\b/i.test(String(error?.message || ''))) {
      environment.domainTable = 'absent';
      environment.domainSeparation = 'not-installed';
    }
  }
  return environment;
}

// Integrator must call these outside the scenario loop, after safe preflight
// and in finally respectively. Timings belong to the runner's monotonic clock.
export async function beginSuite(ctx) {
  ensure(ctx.state instanceof Map && typeof ctx.command === 'function' && typeof ctx.read === 'function', 'Missing guarded perf runner operations');
  ensure(path.isAbsolute(ctx.outputDir || '') && /^[a-zA-Z0-9_-]{8,80}$/.test(ctx.runKey || ''), 'Invalid private performance run configuration');
  ensure(!ctx.state.has(STATE), 'Suite performance capture already started');
  const root = path.join(ctx.outputDir, 'performance-private');
  await fs.mkdir(root, { mode: 0o700 });
  const state = { root, before: null, after: null, comparison: null, coverage: { before: 'not-run', after: 'not-run', compare: 'not-run', list: 'not-run' }, environment: await observeEnvironment(ctx) };
  ctx.state.set(STATE, state);
  try {
    state.before = await capture(ctx, state, 'before');
    state.coverage.before = state.before.status;
  } catch {
    state.coverage.before = 'failed';
  }
  return publicPerformance(state);
}

export async function endSuite(ctx) {
  const state = ctx.state.get(STATE);
  ensure(state, 'beginSuite must precede endSuite');
  ensure(!state.ended, 'Suite performance capture already ended');
  state.ended = true;
  try {
    state.after = await capture(ctx, state, 'after');
    state.coverage.after = state.after.status;
  } catch { state.coverage.after = 'failed'; }
  try {
    const listed = await perfCommand(ctx, state, ['list', '--limit', '1000'], 'list.json');
    ensure(Array.isArray(listed?.runs) && listed.count === listed.runs.length, 'Invalid saved perf list');
    for (const run of [state.before, state.after].filter(Boolean)) ensure(listed.runs.some(r => r.run_id === run.run_id), 'Capture missing from saved perf list');
    state.coverage.list = 'passed';
  } catch { state.coverage.list = 'failed'; }
  if (state.before && state.after) {
    try {
      ensure(state.before.run_id !== state.after.run_id, 'Perf compare needs distinct run IDs');
      state.comparison = await perfCommand(ctx, state, ['compare', state.before.run_id, state.after.run_id], 'compare.json');
      ensure(state.comparison?.baseline?.run_id === state.before.run_id && state.comparison?.new?.run_id === state.after.run_id, 'Perf comparison readback mismatch');
      state.coverage.compare = 'passed';
    } catch { state.coverage.compare = 'failed'; }
  } else state.coverage.compare = 'blocked';
  return publicPerformance(state);
}

function publicCapture(run) {
  if (!run) return null;
  validateCapture(run);
  return { status: run.status,
    collectors: run.collectors.map(c => ({ name: c.name, status: c.status })) };
}

export function publicPerformance(state) {
  const env = state.environment ?? {};
  return { observational: true, releaseGate: false,
    coverage: Object.fromEntries(['before', 'after', 'compare', 'list'].map(k => [k,
      ['not-run', 'failed', 'blocked', 'passed', 'complete', 'incomplete'].includes(state.coverage?.[k]) ? state.coverage[k] : 'not-run'])),
    before: publicCapture(state.before), after: publicCapture(state.after),
    environment: { platform: env.platform === 'linux' ? 'linux' : 'untested',
      domainSeparation: env.domainSeparation === 'not-installed' ? 'not-installed' : 'unknown',
      domainTable: ['readable', 'absent'].includes(env.domainTable) ? env.domainTable : 'unknown',
      domainSource: 'bounded Table API domain read via selected profile',
      effectiveAuth: 'unknown', effectiveRoles: 'unknown', effectiveDomain: 'unknown' } };
}

// Public schema v1 is intentionally a closed projection. No spreading a raw
// report, capture, reason, argument, instance, username or provider metric label.
export function publicSummary({ revision, version, timings = [], performance }) {
  ensure(/^[a-f0-9]{40}$/i.test(revision || ''), 'A pinned full source revision is required');
  ensure(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version || ''), 'A sanitized exact CLI version is required');
  ensure(Array.isArray(timings), 'Scenario timings must be an array');
  const seen = new Set();
  const tests = timings.map(t => {
    ensure(/^[a-z][a-z0-9.-]{0,100}$/.test(t.id || '') && !seen.has(t.id), 'Invalid or duplicate public scenario ID');
    ensure(Number.isFinite(t.durationMs) && t.durationMs >= 0 && OUTCOME.has(t.status), 'Invalid monotonic scenario timing/outcome');
    seen.add(t.id);
    return { id: t.id, durationMs: t.durationMs, status: t.status };
  });
  return { schemaVersion: 1, revision, version, tests,
    performance: performance ? publicPerformance(performance) : null };
}

// Whole-suite hooks are exported separately; a scenario callback must never
// pretend to bracket the suite or collect one capture per command.
export const scenarios = [];
