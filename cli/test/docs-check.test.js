import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('../../scripts/check-docs.mjs', import.meta.url));

test('docs check validates links, packaged README and stays offline', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-docs-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const run = base => spawnSync(process.execPath, [script, base], { cwd, encoding: 'utf8' });
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), content);
  };
  const commit = message => {
    git('add', '-A');
    git('commit', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init');
    git('config', 'user.email', 'fixture@example.test');
    git('config', 'user.name', 'Fixture');
    write('cli/package.json', JSON.stringify({ private: true, files: ['bin/jsn.js', 'src/', 'skills/', 'README.md', 'LICENSE'] }, null, 2));
    write('cli/bin/jsn.js', '#!/usr/bin/env node\n');
    write('cli/src/index.js', 'export {};\n');
    write('cli/skills/servicenow/SKILL.md', '# Skill\n\nRead [the CLI notes](../../README.md).\n');
    write('cli/LICENSE', 'MIT\n');
    write('cli/README.md', '# CLI\n\nSee the [root README](../README.md).\n');
    write('README.md', '# Repository\n\nSee the [CLI README](cli/README.md) and [guide](docs/guide.md).\n\nRemote: [example](https://example.com/docs) and [mail](mailto:dev@example.test).\n');
    write('docs/guide.md', '# Guide\n\nBack to [install](docs-install.md) and [root](../README.md#readme).\n');
    write('docs/docs-install.md', '# Install\n');
    commit('base');

    // No base: every tracked Markdown file is validated.
    let result = run('');
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /all tracked Markdown/);
    assert.match(result.stdout, /External links recorded but not fetched: 2/);
    assert.match(result.stdout, /Packaged README and advertised package paths exist/);

    // A broken relative link fails the check.
    let base = git('rev-parse', 'HEAD');
    write('docs/guide.md', '# Guide\n\nBack to [install](docs-installation.md).\n');
    commit('break a link');
    result = run(base);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /docs\/guide\.md: missing relative link target "docs-installation\.md"/);

    // Restoring the target makes the same check pass again.
    base = git('rev-parse', 'HEAD');
    write('docs/guide.md', '# Guide\n\nBack to [install](docs-install.md).\n');
    commit('restore the link');
    result = run(base);
    assert.equal(result.status, 0, result.stderr);

    // Literal examples in fenced code are not link targets.
    base = git('rev-parse', 'HEAD');
    write('docs/guide.md', '# Guide\n\nBack to [install](docs-install.md).\n\n```md\n[absent](nowhere.md)\n```\n');
    commit('add a code sample');
    result = run(base);
    assert.equal(result.status, 0, result.stderr);

    // Remote links are reported, never fetched, so the check stays offline.
    assert.match(result.stdout, /External links recorded but not fetched/);

    // The published package must advertise and ship its README.
    base = git('rev-parse', 'HEAD');
    write('cli/package.json', JSON.stringify({ private: true, files: ['bin/jsn.js', 'src/', 'skills/', 'LICENSE'] }, null, 2));
    commit('drop README from package files');
    result = run(base);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cli\/package\.json files must include README\.md/);

    base = git('rev-parse', 'HEAD');
    write('cli/package.json', JSON.stringify({ private: true, files: ['bin/jsn.js', 'src/', 'skills/', 'README.md', 'LICENSE'] }, null, 2));
    commit('restore package files');

    // A deleted Markdown file is reported by the diff without breaking the check.
    base = git('rev-parse', 'HEAD');
    fs.rmSync(path.join(cwd, 'docs/docs-install.md'));
    write('docs/guide.md', '# Guide\n\nBack to [root](../README.md).\n');
    commit('delete a guide');
    result = run(base);
    assert.equal(result.status, 0, result.stderr + result.stdout);

    // Missing base falls back to every tracked Markdown file.
    result = run('missing-base');
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /all tracked Markdown/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
