import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Repository ownership contract: only .github/, cli/, and site/ belong at
// the root. Documentation belongs under site/, not a separate docs/ tree.
test('tracked root directories are limited to .github, cli, and site', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root, encoding: 'utf8',
  }).split('\0').filter(file => file && existsSync(path.join(root, file)));
  const allowed = new Set(['.github', 'cli', 'site']);
  const unexpected = [...new Set(files.filter(file => file.includes('/'))
    .map(file => file.split('/')[0]))].filter(dir => !allowed.has(dir)).sort();
  assert.deepEqual(unexpected, [],
    `Only .github/, cli/, and site/ are allowed at the repository root. Move content out of: ${unexpected.join(', ')}`);
});
