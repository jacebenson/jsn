import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { parseNodeStatsXml } from './commands/platform.js';
import { getVersion } from './commands/version.js';

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

function valueOf(value) {
  if (value && typeof value === 'object') return value.value ?? value.display_value;
  return value;
}

function numeric(value) {
  if (value == null || String(value).trim() === '') return null;
  const n = Number(String(value).replaceAll(',', ''));
  return Number.isFinite(n) ? n : null;
}

async function platform(sdk) {
  const rows = await sdk.list('sys_cluster_state', { sysparm_fields: 'sys_id,status,node_type,node_stats', sysparm_limit: '100' });
  const nodes = [];
  for (const row of rows) {
    const id = valueOf(row.node_stats);
    if (!id) continue;
    const stats = await sdk.get('sys_cluster_node_stats', id);
    nodes.push({
      sys_id: valueOf(row.sys_id),
      status: valueOf(row.status),
      node_type: valueOf(row.node_type),
      stats: parseNodeStatsXml(stats?.stats || ''),
    });
  }
  return { metrics: { node_count: nodes.length, nodes }, security: { raw_xml: 'excluded', log_content: 'excluded' } };
}

async function transactions(sdk) {
  const query = 'sys_created_on>=javascript:gs.daysAgoStart(1)';
  const result = await sdk.aggregate('syslog_transaction', { query, groupBy: ['type'], count: true, averageFields: ['response_time'], minimumFields: ['response_time'], maximumFields: ['response_time'] });
  const types = (result?.groups || []).map(group => {
    const type = group.groupby_fields?.find(f => f.field === 'type')?.value || 'unknown';
    const stats = group.stats || {};
    const metric = (name, field) => numeric(typeof stats[name] === 'object' ? stats[name]?.[field] : stats[name]);
    return { type, count: numeric(stats.count) ?? 0, avg_response_time_ms: metric('avg', 'response_time'), min_response_time_ms: metric('min', 'response_time'), max_response_time_ms: metric('max', 'response_time') };
  });
  return { query, metrics: { transaction_types: types } };
}

async function logSummary(sdk) {
  const result = await sdk.aggregate('syslog', { query: 'sys_created_on>=javascript:gs.daysAgoStart(1)', groupBy: ['source', 'level'], count: true });
  const groups = (result?.groups || []).map(group => ({
    source: group.groupby_fields?.find(f => f.field === 'source')?.value || '',
    severity: group.groupby_fields?.find(f => f.field === 'level')?.value || '',
    count: numeric(group.stats?.count) ?? 0,
  }));
  return { query: 'sys_created_on>=javascript:gs.daysAgoStart(1)', metrics: { log_groups: groups }, security: { content: 'excluded' } };
}

async function countTables(sdk, tables) {
  const counts = {};
  for (const table of tables) counts[table] = await sdk.aggregateCount(table, 'sys_created_on>=javascript:gs.daysAgoStart(1)');
  return { metrics: { counts } };
}

async function flows(sdk) {
  const query = 'sys_created_on>=javascript:gs.daysAgoStart(1)';
  const result = await sdk.aggregate('sys_flow_context', { query, groupBy: ['state'], count: true, averageFields: ['duration'] });
  const states = (result?.groups || []).map(group => ({
    state: group.groupby_fields?.find(f => f.field === 'state')?.value || 'unknown',
    count: numeric(group.stats?.count) ?? 0,
    avg_duration: numeric(group.stats?.avg?.duration),
  }));
  return { query, metrics: { flow_states: states } };
}

async function eventQueue(sdk) {
  const result = await sdk.aggregate('sysevent', { query: 'stateINready,processing,error^sys_created_on>=javascript:gs.daysAgoStart(1)', groupBy: ['state'], count: true });
  const states = (result?.groups || []).map(group => ({
    state: group.groupby_fields?.find(f => f.field === 'state')?.value || 'unknown',
    count: numeric(group.stats?.count),
  }));
  return { query: 'stateINready,processing,error^sys_created_on>=javascript:gs.daysAgoStart(1)', metrics: { event_queue: states } };
}

const COLLECTORS = [
  ['platform_health', platform],
  ['transactions', transactions],
  ['error_warning_summary', logSummary],
  ['event_queue', eventQueue],
  ['ecc_queue', (sdk) => countTables(sdk, ['ecc_queue'])],
  ['flow_executions', flows],
  ['record_counts', (sdk) => countTables(sdk, ['incident', 'change_request', 'problem'])],
  ['scheduled_and_cleanup', (sdk) => countTables(sdk, ['sys_trigger', 'sysauto_script'])],
];

function statusForError(err) {
  const message = String(err?.message || err);
  if (/timed out|timeout/i.test(message)) return 'timeout';
  if (/permission|forbidden|access denied|401|403/i.test(message)) return 'permission_denied';
  if (/not found|does not exist|invalid table|404/i.test(message)) return 'unsupported';
  if (/network|fetch|connect/i.test(message)) return 'unavailable';
  return 'query_failure';
}

async function runCollector(name, fn, sdk) {
  const start = new Date().toISOString();
  try {
    const data = await fn(sdk);
    return { name, status: 'success', reason: null, start_time: start, finish_time: new Date().toISOString(), data };
  } catch (err) {
    return { name, status: statusForError(err), reason: String(err?.message || err), start_time: start, finish_time: new Date().toISOString(), data: null };
  }
}

export async function captureRun({ sdk, instance, profile = '', username = '', label = '', options = {} }) {
  if (!sdk || !instance) throw new Error('An authenticated instance is required for perf capture');
  const lock = acquireCaptureLock(profile, instance);
  const db = openPerfDb();
  const start = new Date().toISOString();
  const runId = nextRunId(db);
  try {
    const collectors = await Promise.all(COLLECTORS.map(([name, fn]) => runCollector(name, fn, sdk)));
    const status = collectors.every(c => c.status === 'success') ? 'complete' : 'incomplete';
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
  const formatSemaphore = (name, fields) => {
    const values = side => semaphoreFields.map(field => formatValue(fields.get(field)?.[side])).join(' ');
    const delta = semaphoreFields.map(field => formatValue(fields.get(field)?.delta)).join(' ');
    return `${shortMetric(name)} [${semaphoreLabels.join(' ')}]`.padEnd(42) + ` ${values('baseline').padStart(16)} | ${values('new').padStart(16)} | ${delta.padStart(16)}`;
  };
  const lines = [
    `Performance comparison: ${result.status}`,
    `Baseline: ${result.baseline?.profile || 'default'} @ ${result.baseline?.instance || 'unknown'} (${result.baseline_run_id})`,
    `New:      ${result.new?.profile || 'default'} @ ${result.new?.instance || 'unknown'} (${result.new_run_id})`,
    '',
    'METRIC                                      BASELINE          NEW       DELTA',
  ];
  for (const m of regular) {
    const metric = shortMetric(m.metric);
    if (m.availability === 'missing_from_baseline') lines.push(`${metric.padEnd(42)} Unavailable: missing from baseline`);
    else if (m.availability === 'missing_from_new') lines.push(`${metric.padEnd(42)} Unavailable: missing from new result`);
    else lines.push(`${metric.padEnd(42)} ${displayValue(m.baseline).padStart(16)} ${displayValue(m.new).padStart(12)} ${displayValue(m.delta).padStart(12)}`);
  }
  for (const [name, fields] of grouped) lines.push(formatSemaphore(name, fields));
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
