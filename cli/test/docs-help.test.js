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

// The authored registry (site/config/docs-links.json) declares one link per
// migrated command family. Every one of them must reach executable help.
const FAMILY_TARGETS = {
  codesearch: CODE_URL,
  docs: `${SITE}/docs/cli-guide/#jsn-cli-guide`,
  flows: `${SITE}/docs/flows/#flow-definition-search`,
  records: `${SITE}/docs/records/#watching-a-servicenow-record`,
  updatesets: `${SITE}/docs/updatesets/#transfer-an-update-set`,
  midservers: `${SITE}/docs/midservers/#remote-mid-management-over-ssh`,
  setup: `${SITE}/docs/setup/#connect-an-instance`,
  auth: `${SITE}/docs/setup/#authentication-lifecycle-review`,
  skill: `${SITE}/docs/agents/#use-jsn-with-ai-agents`,
};

test('every registered family help page carries its own documentation URL exactly once', () => {
  for (const [family, url] of Object.entries(FAMILY_TARGETS)) {
    const result = help([family, '--help']);
    assert.equal(result.status, 0, `${family} --help: ${result.stderr}`);
    assert.ok(result.stdout.includes(url), `${family} --help lacks ${url}\n${result.stdout}`);
    assert.equal(result.stdout.split(url).length - 1, 1, `${family} --help repeats ${url}`);
  }
});

test('ordinary nested help inherits the family URL without per-command boilerplate', () => {
  for (const [args, url] of [
    [['records', 'list', '--help'], FAMILY_TARGETS.records],
    [['records', 'watch', '--help'], FAMILY_TARGETS.records],
    [['flows', 'list', '--help'], FAMILY_TARGETS.flows],
    [['updatesets', 'diff', '--help'], FAMILY_TARGETS.updatesets],
    [['auth', 'status', '--help'], FAMILY_TARGETS.auth],
  ]) {
    const result = help(args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.ok(result.stdout.includes(url), `${args.join(' ')} lacks ${url}\n${result.stdout}`);
  }
});

test('aliases and leading global options resolve to the canonical family URL', () => {
  const alias = help(['flow', 'search', '--help']);
  assert.equal(alias.status, 0, alias.stderr);
  assert.ok(alias.stdout.includes(FAMILY_TARGETS.flows), alias.stdout);
  const global = help(['--json', 'records', 'list', '--help']);
  assert.equal(global.status, 0, global.stderr);
  assert.ok(global.stdout.includes(FAMILY_TARGETS.records), global.stdout);
});

test('an unregistered command family invents no documentation URL', () => {
  for (const args of [['discover', '--help'], ['scopes', '--help']]) {
    const result = help(args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.doesNotMatch(result.stdout, /^Documentation: /m, `${args.join(' ')}\n${result.stdout}`);
  }
});

test('root help points at the maintained documentation without flooding commands', () => {
  const result = help(['--help']);
  assert.equal(result.status, 0, result.stderr);
  // The root URL and its description come from the same authored registry the
  // command families use, so the entry cannot drift from site/config/docs-links.json.
  assert.match(result.stdout, /https:\/\/jsn\.jace\.pro\/docs\//);
  const flat = result.stdout.replace(/\s+/g, ' ');
  assert.ok(flat.includes(`${SITE}/docs/install/`), flat);
  // The renderer wraps the description column; assert the words, not the column.
  assert.match(flat, /Guides: install, setup, safety, output, agents/);
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
    // The shipped package must resolve the same registry for a nested page too.
    const nested = spawnSync(process.execPath, [path.join(dir, 'bin/jsn.js'), 'records', 'list', '--help'], {
      encoding: 'utf8', env, cwd: dir,
    });
    assert.equal(nested.status, 0, nested.stderr);
    assert.ok(nested.stdout.includes(FAMILY_TARGETS.records), nested.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
