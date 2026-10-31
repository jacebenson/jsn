import fs from 'node:fs';
import Database from 'better-sqlite3';
import { docsInstallLease, docsHaveReaders } from './locks.js';
import { errUsageHint } from '../../errors.js';

export function installDatabase(staged, dbPath, { afterInstall = () => {} } = {}) {
  let release;
  try {
    release = docsInstallLease(dbPath);
    // Refuse active databases rather than detach a WAL from its live database.
    if (docsHaveReaders(dbPath)) throw errUsageHint('Docs index is in use; existing index retained.', 'Close other jsn docs commands and retry installation.');
    if (['-wal', '-shm'].some(suffix => fs.existsSync(dbPath + suffix))) {
      // Recover an interrupted reader/writer through SQLite, never by unlinking WAL.
      const previous = new Database(dbPath, { fileMustExist: true });
      try {
        previous.pragma('busy_timeout = 2000');
        const [checkpoint] = previous.pragma('wal_checkpoint(TRUNCATE)');
        if (checkpoint.busy || previous.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') {
          throw errUsageHint('Docs index is in use; existing index retained.', 'Close other jsn docs commands and retry installation.');
        }
      } finally { previous.close(); }
    }
    if (fs.existsSync(dbPath)) fs.copyFileSync(dbPath, `${dbPath}.previous`);
    fs.renameSync(staged, dbPath);
    fs.rmSync(`${dbPath}.available.json`, { force: true });
    afterInstall();
  } finally {
    release?.();
  }
}
