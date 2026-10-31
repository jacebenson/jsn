// Coordinate atomic snapshot replacement with short-lived local search readers.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function clearStale(filename) {
  try {
    const pid = Number(fs.readFileSync(filename, 'utf8'));
    if (pid > 0 && alive(pid)) return false;
    if (!(pid > 0) && Date.now() - fs.statSync(filename).mtimeMs < 120000) return false;
    fs.rmSync(filename, { force: true });
    return true;
  } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
export function docsReaderLease(dbPath) {
  const lock = `${dbPath}.install-lock`;
  if (!clearStale(lock)) throw new Error('Docs snapshot installation is in progress; retry shortly');
  const lease = `${dbPath}.reader-${process.pid}-${randomUUID()}`;
  fs.writeFileSync(lease, String(process.pid), { flag: 'wx', mode: 0o600 });
  if (fs.existsSync(lock)) { fs.rmSync(lease, { force: true }); throw new Error('Docs snapshot installation is in progress; retry shortly'); }
  return () => fs.rmSync(lease, { force: true });
}
export function docsInstallLease(dbPath) {
  const lock = `${dbPath}.install-lock`;
  clearStale(lock);
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  return () => fs.rmSync(lock, { force: true });
}
export function docsHaveReaders(dbPath) {
  return fs.readdirSync(path.dirname(dbPath)).filter(name => name.startsWith(path.basename(dbPath) + '.reader-'))
    .some(name => !clearStale(path.join(path.dirname(dbPath), name)));
}
