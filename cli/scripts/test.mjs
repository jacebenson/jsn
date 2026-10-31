import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
function collect(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return collect(filename);
    return entry.isFile() && entry.name.endsWith('.test.js') ? [filename] : [];
  });
}
// Fixture mutations must never enter the developer's personal history store.
const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-suite-data-'));
try {
  const result = spawnSync(process.execPath, [
    '--experimental-test-module-mocks', '--test', '--test-concurrency=4',
    ...process.argv.slice(2), ...collect(path.join(root, 'test')).sort(),
  ], { cwd: root, stdio: 'inherit', env: { ...process.env, JSN_DATA_HOME: path.join(dataHome, '.jsn') } });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(dataHome, { recursive: true, force: true });
}
