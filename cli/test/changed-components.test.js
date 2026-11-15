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
  assert.equal(repository.scripts.docs, 'node site/scripts/build-docs-site.mjs');
  assert.equal(repository.scripts['docs:serve'], 'site/bin/preview');
  assert.equal(repository.scripts.test, 'npm --prefix cli test');
  assert.equal(repository.scripts.lint, 'npm --prefix cli run lint');
  assert.equal(Object.hasOwn(cli.scripts, 'docs'), false);
  assert.equal(Object.hasOwn(cli.scripts, 'docs:serve'), false);
});

const script = fileURLToPath(new URL('../../.github/scripts/changed-components.mjs', import.meta.url));
test('affected application selection keeps prose docs light and runtime paths checked', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-changes-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const select = base => execFileSync(process.execPath, [script, base], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = (filename, content = 'fixture\n') => {
    const base = git('rev-parse', 'HEAD');
    fs.mkdirSync(path.dirname(path.join(cwd, filename)), { recursive: true });
    fs.writeFileSync(path.join(cwd, filename), content);
    git('add', '-A');
    git('commit', '-m', filename);
    return base;
  };
  const expect = (filename, cli, site, docs, content) => {
    assert.equal(select(commit(filename, content)), `cli=${cli}\nsite=${site}\ndocs=${docs}\n`, filename);
  };
  try {
    git('init');
    git('config', 'user.email', 'fixture@example.test');
    git('config', 'user.name', 'Fixture');
    git('commit', '--allow-empty', '-m', 'base');

    // User and contributor prose: only the lightweight documentation check.
    expect('README.md', false, false, true);
    expect('cli/README.md', false, false, true);
    expect('cli/examples/README.md', false, false, true);
    expect('AGENTS.md', false, false, true);
    expect('.github/pull_request_template.md', false, false, true);

    // Prose plus code in one PR must still run the runtime suites.
    let base = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(cwd, 'README.md'), 'more prose\n');
    fs.mkdirSync(path.join(cwd, 'cli/src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'cli/src/app.js'), '// runtime change\n');
    git('add', '-A');
    git('commit', '-m', 'README and CLI code');
    assert.equal(select(base), 'cli=true\nsite=false\ndocs=true\n');

    // Every other CLI path, including runtime-read Markdown, keeps the CLI matrix.
    expect('cli/src/commands/incidents.js', true, false, false);
    expect('cli/test/example.test.js', true, false, false);
    expect('cli/scripts/test.mjs', true, false, false);
    expect('cli/skills/servicenow/SKILL.md', true, false, true);
    expect('cli/test/fixtures/first-run/onboarding-proof.md', true, false, true);
    expect('cli/src/commands/docs/example.js', true, true, false);
    expect('cli/package.json', true, true, false);
    expect('cli/package-lock.json', true, true, false);

    // Public guides and the website keep the website suite.
    expect('docs/docs-install.md', false, true, true);
    expect('docs/DECISIONS.md', false, true, true);
    expect('site/README.md', false, true, true);
    expect('site/app/example.rb', false, true, false);
    expect('site/config/routes.rb', false, true, false);
    expect('site/config/guides.json', false, true, false);
    expect('site/static/style.css', false, true, false);
    expect('site/data/showcases.js', false, true, false);
    expect('site/test/site_test.rb', false, true, false);
    expect('site/scripts/build-docs-site.mjs', false, true, false);

    // Shared command wiring, workflows and unknown root tooling stay fail-safe.
    expect('package.json', true, true, false);
    expect('.github/scripts/changed-components.mjs', true, true, false);
    expect('.github/workflows/ci.yml', true, true, false);
    expect('.github/workflows/docs-site.yml', true, true, false);
    expect('ops/unclassified-tool.mjs', true, true, false);
    expect('.github/scripts/acceptance/publish.mjs', true, true, false);
    expect('.github/scripts/oauth-environment.mjs', true, true, false);
    expect('.github/tests/acceptance-ci.test.js', true, true, false);

    // Deleted and renamed guide files are still website changes.
    commit('docs/retired-guide.md');
    base = git('rev-parse', 'HEAD');
    fs.rmSync(path.join(cwd, 'docs/retired-guide.md'));
    git('add', '-A');
    git('commit', '-m', 'delete guide');
    assert.equal(select(base), 'cli=false\nsite=true\ndocs=true\n');

    commit('docs/docs-install.md', '# Install guide\n');
    base = git('rev-parse', 'HEAD');
    fs.renameSync(path.join(cwd, 'docs/docs-install.md'), path.join(cwd, 'docs/docs-installation.md'));
    git('add', '-A');
    git('commit', '-m', 'rename guide');
    assert.equal(select(base), 'cli=false\nsite=true\ndocs=true\n');

    // Missing or unusable base assumes every application changed.
    for (const missing of ['', '0'.repeat(40), 'missing-base']) {
      assert.equal(select(missing), 'cli=true\nsite=true\ndocs=true\n');
    }
    assert.equal(select('HEAD'), 'cli=false\nsite=false\ndocs=false\n');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
