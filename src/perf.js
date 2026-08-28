import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { getVersion } from './commands/version.js';
import { capturePerformance } from './perf-capture.js';

export const PERF_SCHEMA_VERSION = 1;

function dataHome() {
  return process.env.JSN_DATA_HOME || path.join(os.homedir(), '.jsn');
}

export function getPerfDir() {
  return path.join(dataHome(), 'perf');
}

export function getPerfDbPath() {
  return path.join(getPerfDir(), 'perf.db');
}

export function openPerfDb(opts = {}) {
  const dir = opts.dir || getPerfDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new Database(opts.dbPath || path.join(dir, 'perf.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      label TEXT,
      profile TEXT,
      instance TEXT NOT NULL,
      username TEXT,
      command_options TEXT NOT NULL,
      start_time TEXT NOT NULL,
      finish_time TEXT,
      status TEXT NOT NULL,
      jsn_version TEXT NOT NULL,
      capture_schema_version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collectors (
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      start_time TEXT NOT NULL,
      finish_time TEXT,
      data TEXT,
      PRIMARY KEY (run_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_perf_runs_instance ON runs(instance, profile, start_time);
  `);
  return db;
}

export function closePerfDb(db) {
  try { db.close(); } catch { /* already closed */ }
}

function nextRunId(db, now = new Date()) {
  const base = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  let id = base;
  let n = 1;
  while (db.prepare('SELECT 1 FROM runs WHERE run_id = ?').get(id)) id = `${base}-${n++}`;
  return id;
}

function lockKey(profile, instance) {
  return crypto.createHash('sha256').update(`${profile || ''}\0${instance}`).digest('hex').slice(0, 24);
}

export function acquireCaptureLock(profile, instance, opts = {}) {
  const dir = opts.dir || getPerfDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `capture-${lockKey(profile, instance)}.lock`);
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, profile: profile || '', instance, started_at: new Date().toISOString() }));
    return { file, release: () => {
      try { fs.closeSync(fd); } catch { /* already closed */ }
      try { fs.unlinkSync(file); } catch { /* already removed */ }
    } };
  } catch (err) {
    if (err.code === 'EEXIST') {
      const e = new Error(`A performance capture is already running for profile "${profile || '(default)'}" and instance ${instance}`);
      e.code = 'perf_capture_overlap';
      e.hint = 'Wait for the existing capture to finish, or remove the lock only after confirming that process is gone.';
      throw e;
    }
    throw err;
  }
}

export async function captureRun({ sdk, instance, profile = '', username = '', label = '', options = {} }) {
  if (!sdk || !instance) throw new Error('An authenticated instance is required for perf capture');
  const lock = acquireCaptureLock(profile, instance);
  const db = openPerfDb();
  const start = new Date().toISOString();
  const runId = nextRunId(db);
  try {
    const capture = await capturePerformance({ sdk, instance, profile, username, label, options });
    const { collectors } = capture;
    const { status } = capture;
    const finish = new Date().toISOString();
    db.prepare(`INSERT INTO runs (run_id,label,profile,instance,username,command_options,start_time,finish_time,status,jsn_version,capture_schema_version) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(runId, label || null, profile || null, instance, username || null, JSON.stringify(options), start, finish, status, getVersion(), PERF_SCHEMA_VERSION);
    const insert = db.prepare('INSERT INTO collectors (run_id,name,status,reason,start_time,finish_time,data) VALUES (?,?,?,?,?,?,?)');
    const save = db.transaction(items => { for (const c of items) insert.run(runId, c.name, c.status, c.reason, c.start_time, c.finish_time, c.data == null ? null : JSON.stringify(c.data)); });
    save(collectors);
    return getRun(runId, db);
  } finally {
    closePerfDb(db);
    lock.release();
  }
}

function parseRun(row, collectors) {
  return {
    run_id: row.run_id, label: row.label, profile: row.profile, instance: row.instance, username: row.username,
    command_options: JSON.parse(row.command_options || '{}'), start_time: row.start_time, finish_time: row.finish_time,
    status: row.status, jsn_version: row.jsn_version, capture_schema_version: row.capture_schema_version,
    collectors: collectors.map(c => ({ ...c, data: c.data ? JSON.parse(c.data) : null })),
  };
}

export function getRun(runId, db = null) {
  const ownsDb = !db;
  const database = db || openPerfDb();
  try {
    const row = database.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId);
    if (!row) return null;
    const collectors = database.prepare('SELECT name,status,reason,start_time,finish_time,data FROM collectors WHERE run_id = ? ORDER BY name').all(runId);
    return parseRun(row, collectors);
  } finally {
    if (ownsDb) closePerfDb(database);
  }
}

export function listRuns({ profile, instance, limit = 50 } = {}) {
  const db = openPerfDb();
  try {
    let sql = 'SELECT * FROM runs WHERE 1=1';
    const args = [];
    if (profile) { sql += ' AND profile = ?'; args.push(profile); }
    if (instance) { sql += ' AND instance = ?'; args.push(instance); }
    sql += ' ORDER BY start_time DESC LIMIT ?'; args.push(Math.max(1, Math.min(1000, Number(limit) || 50)));
    return db.prepare(sql).all(...args).map(row => ({ run_id: row.run_id, label: row.label, profile: row.profile, instance: row.instance, start_time: row.start_time, finish_time: row.finish_time, status: row.status, jsn_version: row.jsn_version, capture_schema_version: row.capture_schema_version }));
  } finally { closePerfDb(db); }
}

function arrayIdentity(item, index) {
  if (!item || typeof item !== 'object') return String(index);
  if (item.source != null || item.severity != null) return `source=${item.source ?? 'unknown'},severity=${item.severity ?? 'unknown'}`;
  for (const field of ['type', 'state', 'name', 'sys_id']) if (item[field] != null) return `${field}=${item[field]}`;
  return String(index);
}

function flatten(value, prefix = '', out = new Map()) {
  if (value == null) return out;
  if (typeof value === 'number' && Number.isFinite(value)) out.set(prefix, value);
  else if (Array.isArray(value)) value.forEach((v, i) => flatten(v, `${prefix}[${arrayIdentity(v, i)}]`, out));
  else if (typeof value === 'object') Object.entries(value).forEach(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k, out));
  return out;
}

function runContext(run) {
  return {
    run_id: run.run_id,
    label: run.label,
    instance: run.instance,
    profile: run.profile,
    start_time: run.start_time,
    finish_time: run.finish_time,
  };
}

export function compareRuns(baseline, newer) {
  const a = new Map();
  const b = new Map();
  for (const c of baseline.collectors) flatten(c.data?.metrics, c.name, a);
  for (const c of newer.collectors) flatten(c.data?.metrics, c.name, b);
  const names = [...new Set([...a.keys(), ...b.keys()])].sort();
  const metrics = names.map(metric => {
    if (!a.has(metric)) return { metric, availability: 'missing_from_baseline', baseline: null, new: b.get(metric), delta: null, percent_change: null };
    if (!b.has(metric)) return { metric, availability: 'missing_from_new', baseline: a.get(metric), new: null, delta: null, percent_change: null };
    const delta = b.get(metric) - a.get(metric);
    return { metric, availability: 'available', baseline: a.get(metric), new: b.get(metric), delta, percent_change: a.get(metric) === 0 ? null : (delta / a.get(metric)) * 100 };
  });
  return { baseline: runContext(baseline), new: runContext(newer), baseline_run_id: baseline.run_id, new_run_id: newer.run_id, status: metrics.some(m => m.availability !== 'available') ? 'incomplete' : 'complete', metrics };
}

export function formatRun(run) {
  const lines = [`Run ${run.run_id}${run.label ? ` (${run.label})` : ''}`, `Status: ${run.status}`, `Instance: ${run.instance}`, `Started: ${run.start_time}`, 'COLLECTOR                 STATUS             REASON'];
  for (const c of run.collectors) lines.push(`${c.name.padEnd(25)} ${c.status.padEnd(18)} ${c.reason || ''}`);
  return `${lines.join('\n')}\n`;
}

export function formatRunDetailed(run) {
  const lines = [`Run ${run.run_id}${run.label ? ` (${run.label})` : ''}`, `Status: ${run.status}`, `Instance: ${run.instance}`, `Profile: ${run.profile || 'default'}`, `Started: ${run.start_time}`, 'COLLECTOR                 STATUS             REASON'];
  for (const c of run.collectors) lines.push(`${c.name.padEnd(25)} ${c.status.padEnd(18)} ${c.reason || ''}`);
  lines.push('', 'CAPTURED DETAILS');
  for (const c of run.collectors) {
    lines.push(`  ${c.name}`);
    if (c.status !== 'success' || !c.data) {
      lines.push(`    ${c.reason || 'No data captured'}`);
      continue;
    }
    const metrics = c.data.metrics || {};
    if (c.name === 'transactions') {
      for (const row of metrics.transaction_types || []) lines.push(`    ${row.type}: ${row.count ?? 'unavailable'} requests, avg ${row.avg_response_time_ms ?? 'unavailable'} ms, max ${row.max_response_time_ms ?? 'unavailable'} ms`);
    } else if (c.name === 'platform_health') {
      lines.push(`    Nodes: ${metrics.node_count ?? 'unavailable'}`);
      for (const node of metrics.nodes || []) lines.push(`    ${node.status || '?'} node ${node.sys_id || ''}: queue ${node.stats?.queue?.length ?? 'unavailable'}, sessions ${node.stats?.active_sessions ?? 'unavailable'}`);
    } else if (c.name === 'error_warning_summary') {
      const totals = {};
      for (const row of metrics.log_groups || []) totals[row.severity || 'unknown'] = (totals[row.severity || 'unknown'] || 0) + (row.count || 0);
      lines.push(`    Groups: ${(metrics.log_groups || []).length}, by severity: ${Object.entries(totals).map(([severity, count]) => `${severity}=${count}`).join(', ') || 'none'}`);
    } else if (c.name === 'flow_executions') {
      for (const row of metrics.flow_states || []) lines.push(`    ${row.state}: ${row.count ?? 'unavailable'} executions, avg ${row.avg_duration ?? 'unavailable'} ms`);
    } else if (c.name === 'event_queue') {
      lines.push(`    States: ${(metrics.event_queue || []).length}`);
      for (const row of metrics.event_queue || []) lines.push(`    ${row.groupby_fields?.[0]?.value || 'unknown'}: ${row.stats?.count ?? 'unavailable'}`);
    } else if (metrics.counts) {
      for (const [name, value] of Object.entries(metrics.counts)) lines.push(`    ${name}: ${value ?? 'unavailable'}`);
    } else {
      lines.push(`    ${JSON.stringify(metrics)}`);
    }
  }
  const newline = String.fromCharCode(10);
  return lines.join(newline) + newline;
}

export function formatRunList(runs) {
  const lines = ['RUN ID                     STATUS      LABEL                 INSTANCE'];
  lines.push('-------------------------  ----------  --------------------  ------------------------------');
  for (const run of runs) lines.push(`${run.run_id.padEnd(25)}  ${run.status.padEnd(10)}  ${String(run.label || '').slice(0, 20).padEnd(20)}  ${run.instance}`);
  if (runs.length === 0) lines.push('(no performance captures)');
  return `${lines.join('\n')}\n`;
}

export function formatComparisonDetailed(result) {
  const shortMetric = (metric) => metric
    .replace(/error_warning_summary\.log_groups\[source=([^,\]]+),severity=([^\]]+)\]/g, 'logs[$1,sev=$2]')
    .replace(/transactions\.transaction_types\[type=([^\]]+)\]/g, 'tx[$1]')
    .replace('error_warning_summary', 'logs')
    .replace('platform_health', 'platform')
    .replace('flow_executions', 'flows')
    .replace('scheduled_and_cleanup', 'scheduled')
    .replace('record_counts', 'records')
    .replace(/nodes\[sys_id=([^\]]+)\]/g, (_, id) => `node[${id.slice(0, 8)}]`)
    .replace(/semaphores\[name=([^\]]+)\]/g, 'sem[$1]')
    .replace('.stats.active_sessions', '.sessions')
    .replace('.stats.queue.length', '.queue')
    .replace('.stats.queue.age', '.queue_age')
    .replace('.stats.semaphores', '.semaphores')
    .replace('.stats.transactions.daily', '.daily_tx')
    .replace('.avg_response_time_ms', '.avg_ms')
    .replace('.min_response_time_ms', '.min_ms')
    .replace('.max_response_time_ms', '.max_ms')
    .replace('.stats.', '.');
  const displayMetric = metric => shortMetric(metric);
  const displayValue = value => typeof value === 'number' && !Number.isInteger(value) ? value.toFixed(2) : String(value);
  const semaphoreFields = ['available', 'borrowed', 'maximum_concurrency', 'queue_depth', 'queue_depth_limit'];
  const semaphoreLabels = ['avail', 'borrow', 'max', 'qd', 'qlim'];
  const semaphorePattern = /^(.*\.semaphores\[name=[^\]]+\])\.(available|borrowed|maximum_concurrency|queue_depth|queue_depth_limit)$/;
  const grouped = new Map();
  const regular = [];
  for (const metric of result.metrics) {
    const match = metric.metric.match(semaphorePattern);
    if (!match) {
      regular.push(metric);
      continue;
    }
    if (!grouped.has(match[1])) grouped.set(match[1], new Map());
    grouped.get(match[1]).set(match[2], metric);
  }
  const formatValue = value => value == null ? '?' : displayValue(value);
  const formatSemaphore = (name, fields, width) => {
    const values = side => semaphoreFields.map(field => formatValue(fields.get(field)?.[side])).join(' ');
    const delta = semaphoreFields.map(field => formatValue(fields.get(field)?.delta)).join(' ');
    const label = shortMetric(name).replace(/^platform\./, '');
    return `${label.padEnd(width)} ${values('baseline').padStart(16)} | ${values('new').padStart(16)} | ${delta.padStart(16)}`;
  };
  const sectionFor = metric => {
    if (metric.startsWith('ecc_queue.')) return 'ECC queue';
    if (metric.startsWith('logs[')) return 'Logs';
    if (metric.startsWith('flows.')) return 'Flows';
    if (metric.startsWith('platform.')) return 'Platform';
    if (metric.startsWith('records.')) return 'Records';
    if (metric.startsWith('scheduled.')) return 'Scheduled';
    if (metric.startsWith('tx[')) return 'Transactions';
    return 'Other';
  };
  const lines = [
    `Performance comparison: ${result.status}`,
    `Baseline: ${result.baseline?.profile || 'default'} @ ${result.baseline?.instance || 'unknown'} (${result.baseline_run_id})`,
    `New:      ${result.new?.profile || 'default'} @ ${result.new?.instance || 'unknown'} (${result.new_run_id})`,
  ];
  const addMetric = (m, width) => {
    const metric = displayMetric(m.metric);
    if (m.availability === 'missing_from_baseline') lines.push(`${metric.padEnd(width)} Unavailable: missing from baseline`);
    else if (m.availability === 'missing_from_new') lines.push(`${metric.padEnd(width)} Unavailable: missing from new result`);
    else lines.push(`${metric.padEnd(width)} ${displayValue(m.baseline).padStart(12)} ${displayValue(m.new).padStart(12)} ${displayValue(m.delta).padStart(12)}`);
  };
  const sections = new Map();
  for (const metric of regular) {
    const section = sectionFor(displayMetric(metric.metric));
    if (!sections.has(section)) sections.set(section, []);
    sections.get(section).push(metric);
  }
  for (const [section, metrics] of sections) {
    const width = Math.max(34, ...metrics.map(metric => displayMetric(metric.metric).length));
    lines.push('', section.toUpperCase(), `${'METRIC'.padEnd(width)} BASELINE         NEW       DELTA`);
    for (const metric of metrics) addMetric(metric, width);
  }
  if (grouped.size) {
    const semaphoreNames = [...grouped.keys()].map(name => shortMetric(name).replace(/^platform\./, ''));
    const width = Math.max(36, ...semaphoreNames.map(name => name.length));
    lines.push('', 'SEMAPHORES', `${'NAME'.padEnd(width)} BASELINE [${semaphoreLabels.join(' ')}] | NEW [${semaphoreLabels.join(' ')}] | DELTA [${semaphoreLabels.join(' ')}]`);
    for (const [name, fields] of grouped) lines.push(formatSemaphore(name, fields, width));
  }
  const newline = String.fromCharCode(10);
  return lines.join(newline) + newline;
}

export function formatComparison(result) {
  const lines = [`Compare ${result.baseline_run_id} -> ${result.new_run_id}`, `Overall: ${result.status}`, 'METRIC                                      BASELINE       NEW          DELTA'];
  for (const m of result.metrics) {
    if (m.availability === 'missing_from_baseline') lines.push(`${m.metric.padEnd(42)} Unavailable: missing from baseline`);
    else if (m.availability === 'missing_from_new') lines.push(`${m.metric.padEnd(42)} Unavailable: missing from new result`);
    else lines.push(`${m.metric.padEnd(42)} ${String(m.baseline).padStart(12)} ${String(m.new).padStart(12)} ${String(m.delta).padStart(12)}`);
  }
  return `${lines.join('\n')}\n`;
}
