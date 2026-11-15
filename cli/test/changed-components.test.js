import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);

test('website npm commands belong to the private repository, not the published CLI', () => {
  const read = file => JSON.parse(fs.readFileSync(new URL(file, root), 'utf8'));
  const repository = read('package.json');
  const cli = read('cli/package.json');
  assert.equal(repository.private, true);
  assert.equal(repository.scripts.docs, 'node scripts/build-docs-site.mjs');
  assert.equal(repository.scripts['docs:serve'], 'site/bin/preview');
  assert.equal(repository.scripts.test, 'npm --prefix cli test');
  assert.equal(repository.scripts.lint, 'npm --prefix cli run lint');
  assert.equal(Object.hasOwn(cli.scripts, 'docs'), false);
  assert.equal(Object.hasOwn(cli.scripts, 'docs:serve'), false);
});

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
      ['cli/src/commands/incidents.js', true, false],
      ['cli/test/example.test.js', true, false],
      ['cli/scripts/test.mjs', true, false],
      ['site/app/example.rb', false, true],
      ['site/config/routes.rb', false, true],
      ['site/config/guides.json', false, true],
      ['site/static/style.css', false, true],
      ['site/data/showcases.js', false, true],
      ['site/test/site_test.rb', false, true],
      ['docs/docs-install.md', false, true],
      // Retain the existing conservative docs/ policy, even for contributor notes.
      ['docs/DECISIONS.md', false, true],
      ['cli/src/commands/docs/example.js', true, true],
      ['cli/package.json', true, true],
      ['cli/package-lock.json', true, true],
      ['package.json', true, true],
      ['scripts/build-docs-site.mjs', false, true],
      ['scripts/acceptance/publish.mjs', true, false],
      ['.github/workflows/docs-site.yml', true, true],
      ['.github/workflows/ci.yml', true, true],
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
    // A mixed PR must not lose CLI selection to a website-only path.
    const mixedBase = git('rev-parse', 'HEAD');
    for (const filename of ['cli/src/app.js', 'site/static/style.css']) {
      fs.appendFileSync(path.join(cwd, filename), 'mixed change\n');
    }
    git('add', '.');
    git('commit', '-m', 'mixed CLI and website');
    assert.equal(select(mixedBase), 'cli=true\nsite=true\n');
    for (const base of ['', '0'.repeat(40), 'missing-base']) {
      assert.equal(select(base), 'cli=true\nsite=true\n');
    }
    assert.equal(select('HEAD'), 'cli=false\nsite=false\n');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
