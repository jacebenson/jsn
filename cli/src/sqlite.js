// The small synchronous SQLite contract shared by docs and performance storage.
// Do not load node:sqlite until a local database is actually opened.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let sqlite;
function runtime() {
  if (!sqlite) {
    if (Number(process.versions.node.split('.')[0]) < 24) {
      throw new Error('Local SQLite storage requires Node.js 24 or newer. Upgrade Node.js, or use hosted documentation search.');
    }
    sqlite = require('node:sqlite');
  }
  return sqlite;
}
function row(value) {
  if (value === undefined) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item instanceof Uint8Array ? Buffer.from(item) : item]));
}
let savepoint = 0;
export default class Database {
  constructor(filename, { readonly = false, fileMustExist = false, timeout = 5000 } = {}) {
    if (fileMustExist && filename !== ':memory:') fs.accessSync(filename);
    this.connection = new (runtime().DatabaseSync)(filename, {
      readOnly: readonly, timeout, enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: true,
    });
  }
  get open() { return this.connection.isOpen; }
  get inTransaction() { return this.connection.isTransaction; }
  close() { this.connection.close(); }
  exec(sql) { this.connection.exec(sql); return this; }
  prepare(sql) {
    const statement = this.connection.prepare(sql);
    // better-sqlite3 accepted unused keys in named parameter objects.
    statement.setAllowUnknownNamedParameters(true);
    const args = values => values.length === 1 && Array.isArray(values[0]) ? values[0] : values;
    return {
      run: (...values) => statement.run(...args(values)),
      get: (...values) => row(statement.get(...args(values))),
      all: (...values) => statement.all(...args(values)).map(row),
    };
  }
  pragma(sql, { simple = false } = {}) {
    const rows = this.prepare(`PRAGMA ${sql}`).all();
    return simple ? Object.values(rows[0] || {})[0] : rows;
  }
  backup(filename) { return runtime().backup(this.connection, filename); }
  transaction(operation) {
    const db = this;
    return function (...args) {
      const nested = db.inTransaction;
      const name = `jsn_${++savepoint}`;
      db.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN');
      try {
        const result = operation.apply(this, args);
        if (result && typeof result.then === 'function') throw new TypeError('SQLite transactions must be synchronous');
        db.exec(nested ? `RELEASE ${name}` : 'COMMIT');
        return result;
      } catch (error) {
        if (db.inTransaction) {
          try {
            db.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : 'ROLLBACK');
          } catch { /* Preserve the operation's original failure. */ }
        }
        throw error;
      }
    };
  }
}

// Check the actual library, not the Node major: some builds omit FTS5.
// pragma_module_list works on read-only snapshot connections too.
export function requireFts5(db) {
  try {
    if (db.prepare("SELECT 1 AS available FROM pragma_module_list WHERE name='fts5'").get()?.available) return;
  } catch { /* Report the same actionable capability error. */ }
  const error = new Error('This Node.js SQLite build has no FTS5 support. Upgrade to a current official Node.js 24 LTS or newer build with FTS5 for local docs indexing/search; hosted documentation search does not require SQLite.');
  error.code = 'sqlite_fts5_unavailable';
  throw error;
}
