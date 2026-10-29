// Local convenience history, independent of documentation indexes and sync.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { errUsage } from './errors.js';

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const operations = ['create', 'update', 'delete'];
const outcomes = ['succeeded', 'failed', 'unknown'];
export function historyPath() {
  return path.join(process.env.JSN_DATA_HOME || path.join(os.homedir(), '.jsn'), 'history.db');
}
function openHistory(filename, now) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new Database(filename);
  try {
    if (process.platform !== 'win32') fs.chmodSync(filename, 0o600);
    db.pragma('busy_timeout = 3000');
    db.exec(`CREATE TABLE IF NOT EXISTS mutation_history (
      id INTEGER PRIMARY KEY, timestamp INTEGER NOT NULL, instance TEXT NOT NULL,
      profile TEXT, table_name TEXT NOT NULL, sys_id TEXT, operation TEXT NOT NULL,
      outcome TEXT NOT NULL, reason TEXT, http_status INTEGER
    ); CREATE INDEX IF NOT EXISTS mutation_history_time ON mutation_history(timestamp)`);
    db.prepare('DELETE FROM mutation_history WHERE timestamp < ?').run(now - RETENTION_MS);
    return db;
  } catch (error) { db.close(); throw error; }
}
export function sanitizeReason(value) {
  if (!value) return null;
  // eslint-disable-next-line no-control-regex -- strip controls from user-supplied prose
  return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[redacted]')
    .replace(/\b(password|token|cookie|secret|authorization|access_token|sysparm_ck)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, '$1=[redacted]')
    .slice(0, 1000);
}
export function appendMutation(event, { filename = historyPath(), now = Date.now() } = {}) {
  if (!operations.includes(event.operation) || !outcomes.includes(event.outcome)) throw errUsage('Invalid history event');
  const instance = new URL(event.instance).origin;
  // Deliberate whitelist: never serialize SDK options, response bodies, or payloads.
  const row = { timestamp: now, instance, profile: event.profile || null,
    table_name: event.table, sys_id: event.sys_id || null, operation: event.operation,
    outcome: event.outcome, reason: sanitizeReason(event.reason), http_status: event.http_status || null };
  const db = openHistory(filename, now);
  try {
    db.prepare(`INSERT INTO mutation_history
      (timestamp,instance,profile,table_name,sys_id,operation,outcome,reason,http_status)
      VALUES (@timestamp,@instance,@profile,@table_name,@sys_id,@operation,@outcome,@reason,@http_status)`).run(row);
  } finally { db.close(); }
}
export function pruneHistory({ filename = historyPath(), now = Date.now() } = {}) {
  const db = openHistory(filename, now);
  try { return { retentionDays: 7 }; } finally { db.close(); }
}
export function listHistory(filters = {}, { filename = historyPath(), now = Date.now() } = {}) {
  const where = [], values = [];
  for (const [key, column] of Object.entries({ instance: 'instance', profile: 'profile', table: 'table_name', operation: 'operation', record: 'sys_id' })) {
    if (filters[key]) { where.push(`${column} = ?`); values.push(key === 'instance' ? new URL(filters[key]).origin : filters[key]); }
  }
  for (const [key, operator] of [['since', '>='], ['until', '<=']]) {
    if (filters[key]) {
      const time = Date.parse(filters[key]);
      if (!Number.isFinite(time)) throw errUsage(`Invalid --${key} timestamp; use an ISO date`);
      where.push(`timestamp ${operator} ?`); values.push(time);
    }
  }
  const limit = filters.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw errUsage('--limit must be an integer from 1 to 10000');
  const db = openHistory(filename, now);
  try {
    return db.prepare(`SELECT id,timestamp,instance,profile,table_name AS "table",sys_id,operation,outcome,reason,http_status
      FROM mutation_history ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY timestamp DESC,id DESC LIMIT ?`)
      .all(...values, limit).map(row => ({ ...row, timestamp: new Date(row.timestamp).toISOString() }));
  } finally { db.close(); }
}
