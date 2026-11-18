import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
const env = { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' };

function help(args, binary = bin, cwd = undefined) {
  return spawnSync(process.execPath, [binary, ...args], { encoding: 'utf8', env, cwd });
}

const SITE = 'https://jsn.jace.pro';
const CODE_URL = `${SITE}/features/servicenow-code-search-cli/`;

test('root help points at the maintained documentation without flooding commands', () => {
  const result = help(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /https:\/\/jsn\.jace\.pro\/docs\//);
  assert.match(result.stdout, /Guides: install, setup, safety, output, agents/);
});

test('codesearch family and nested help carry the feature reference and literal syntax', () => {
  for (const args of [['codesearch', '--help'], ['codesearch', 'search', '--help']]) {
    const result = help(args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.ok(result.stdout.includes(CODE_URL), `${args.join(' ')} lacks ${CODE_URL}\n${result.stdout}`);
  }
  const nested = help(['codesearch', 'search', '--help']);
  assert.match(nested.stdout, /codesearch search <term>/);
  assert.match(nested.stdout, /jsn codesearch search GlideAjax --limit 5/);
  assert.match(nested.stdout, /flows search <term>/);
  assert.match(nested.stdout, /literal and read-only|literal, read-only/i);
});

test('flows alias and nested search retain the flow guide link', () => {
  const family = help(['flow', '--help']);
  assert.equal(family.status, 0, family.stderr);
  assert.match(family.stdout, /https:\/\/jsn\.jace\.pro\/docs\/flows\//);
  const nested = help(['flow', 'search', '--help']);
  assert.equal(nested.status, 0, nested.stderr);
  assert.match(nested.stdout, /https:\/\/jsn\.jace\.pro\/docs\/flows\//);
  assert.match(nested.stdout, /jsn flows search approval/);
});

test('docs help links to the CLI guide registered by the site', () => {
  const result = help(['docs', '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /https:\/\/jsn\.jace\.pro\/docs\/cli-guide\//);
});

test('package-only layout renders the same documentation links', () => {
  const cliRoot = fileURLToPath(new URL('..', import.meta.url));
  const dir = mkdtempSync(path.join(tmpdir(), 'jsn-package-only-'));
  try {
    for (const entry of ['bin', 'src', 'package.json']) {
      cpSync(path.join(cliRoot, entry), path.join(dir, entry), { recursive: true });
    }
    // An installed npm package has its dependencies beside package.json; link
    // the pinned install so this proves only package-shipped files and deps are
    // read, never the monorepo's site/ or docs/ trees.
    symlinkSync(path.join(cliRoot, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    const result = spawnSync(process.execPath, [path.join(dir, 'bin/jsn.js'), 'codesearch', 'search', '--help'], {
      encoding: 'utf8', env, cwd: dir,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(CODE_URL), result.stdout);
    assert.match(result.stdout, /codesearch search <term>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
