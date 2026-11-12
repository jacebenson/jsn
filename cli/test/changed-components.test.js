import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('../../scripts/changed-components.mjs', import.meta.url));
test('affected application selection includes shared docs and fails safe without a base', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-changes-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const select = base => execFileSync(process.execPath, [script, base], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git('init');
    git('config', 'user.email', 'fixture@example.test');
    git('config', 'user.name', 'Fixture');
    git('commit', '--allow-empty', '-m', 'base');
    const cases = [
      ['README.md', false, false],
      ['cli/src/app.js', true, false],
      ['site/app/example.rb', false, true],
      ['docs/example.md', false, true],
      ['cli/src/commands/docs/example.js', true, true],
      ['cli/package-lock.json', true, true],
      ['scripts/build-docs-site.mjs', false, true],
      ['.github/workflows/docs-site.yml', true, true],
      ['scripts/changed-components.mjs', true, true],
    ];
    for (const [filename, cli, site] of cases) {
      const base = git('rev-parse', 'HEAD');
      fs.mkdirSync(path.dirname(path.join(cwd, filename)), { recursive: true });
      fs.writeFileSync(path.join(cwd, filename), 'fixture\n');
      git('add', '.');
      git('commit', '-m', filename);
      assert.equal(select(base), `cli=${cli}\nsite=${site}\n`, filename);
    }
    for (const base of ['', '0'.repeat(40), 'missing-base']) {
      assert.equal(select(base), 'cli=true\nsite=true\n');
    }
    assert.equal(select('HEAD'), 'cli=false\nsite=false\n');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
