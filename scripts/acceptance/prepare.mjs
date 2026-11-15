// Reuse the real reviewed acceptance producer, not node:test or synthetic results.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
export const HARNESS_SHA = '65c4f3c8a66ea37b3bd3ecca87957bec30eb3fba';
export const FILES = [
  ...['bindings', 'run', 'session-adapter', 'support'].map(n => `cli/scripts/acceptance/${n}.mjs`),
  ...['auth', 'performance', 'read-only-catalog', 'read-only', 'resources', 'workflows'].map(n => `cli/test/acceptance/${n}.mjs`),
  'cli/test/acceptance/coverage.json',
];
export function prepare(root) {
  // Never overwrite tracked producer files if main eventually adopts the runner.
  for (const file of FILES) if (fs.existsSync(path.join(root, file))) throw new Error('Acceptance producer path already exists; reconcile the pinned adapter');
  for (const file of FILES) {
    const bytes = execFileSync('git', ['show', `${HARNESS_SHA}:${file}`], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  }
}
if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  execFileSync('git', ['fetch', '--no-tags', 'https://github.com/jacebenson/jsn.git', HARNESS_SHA], { stdio: 'ignore' });
  prepare(process.cwd());
}
