// CLI-level batch tests: real argv/middleware/output through spawnSync, with
// the SDK and config modules replaced by a recording mock transport.
//
// The observable contracts: invalid manifests exit 2 before any transport
// write, plan performs zero writes, apply creates in dependency order with
// resolved IDs, partial failures exit 1 with accurate statuses, and the
// read-only-profile / mid-run capture-context safeguards stop writes.
import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
let dir;
let manifestPath;
let invalidPath;

const MANIFEST = {
  version: 1,
  steps: [
    {
      name: 'laptop',
      type: 'catalog_item',
      operation: 'create',
      fields: { name: 'Laptop', short_description: 'Standard laptop' },
    },
    {
      name: 'cpu',
      type: 'catalog_variable',
      operation: 'create',
      fields: { cat_item: { $ref: 'steps.laptop.sys_id' }, label: 'CPU', type: 'select', mandatory: true },
    },
  ],
};

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'jsn-batch-cli-'));
  manifestPath = path.join(dir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(MANIFEST));
  invalidPath = path.join(dir, 'invalid.json');
  writeFileSync(invalidPath, JSON.stringify({
    version: 1,
    steps: [
      { name: 'a', type: 'sys_user', operation: 'create', fields: { name: 'A' } },
      { name: 'b', type: 'catalog_item', operation: 'create', fields: { name: 'B' } },
      { name: 'c', type: 'catalog_item', operation: 'create', fields: { name: 'C' } },
    ],
  }));
  writeFileSync(path.join(dir, 'fixture.mjs'), `
import { mock } from 'node:test';
import { appendFileSync } from 'node:fs';
import * as config from ${JSON.stringify(new URL('../src/config.js', import.meta.url).href)};
import * as sdk from ${JSON.stringify(new URL('../src/sdk.js', import.meta.url).href)};

mock.module(${JSON.stringify(new URL('../src/config.js', import.meta.url).href)}, { namedExports: { ...config, loadConfig: () => ({
  profiles: { fixture: { instance_url: 'https://fixture.invalid', username: 'test', auth_method: 'basic', read_only: process.env.FIXTURE_READONLY === '1', skip_confirmations: true } },
  activeProfile: 'fixture', defaultProfile: 'fixture',
}) } });

function log(entry) {
  if (process.env.FIXTURE_LOG) appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(entry) + '\\n');
}

class SDKClient {
  constructor() { this.baseURL = 'https://fixture.invalid'; this.writes = 0; }
  async list(table, params) {
    const query = params?.get?.('sysparm_query') || '';
    if (table === 'sys_user') return [{ sys_id: 'user' }];
    if (table === 'sys_user_preference') return [{ value: query.includes('apps.current_app') ? 'app1' : 'set1' }];
    return [];
  }
  async get(table, id) {
    if (table === 'sys_scope') return { scope: 'x_app' };
    if (table === 'sys_update_set') {
      const completed = process.env.FIXTURE_COMPLETE_AFTER_FIRST === '1' && this.writes > 0;
      return { name: 'My Feature', application: 'app1', state: completed ? 'complete' : 'in progress' };
    }
    if (table === 'sc_cat_item' || table === 'item_option_new') return { sys_id: id, name: 'Existing' };
    return { sys_id: id };
  }
  async create(table, data) {
    this.writes += 1;
    log({ op: 'create', table, data });
    if (table === process.env.FIXTURE_FAIL_TABLE) {
      const error = new Error('mock create rejected');
      error.code = 'api_error';
      throw error;
    }
    return { sys_id: table === 'sc_cat_item' ? '1000000000000000000000000000000' + this.writes : '2000000000000000000000000000000' + this.writes };
  }
  async update(table, id, data) {
    this.writes += 1;
    log({ op: 'update', table, id, data });
    return { sys_id: id };
  }
  async request() { return { result: [] }; }
}
mock.module(${JSON.stringify(new URL('../src/sdk.js', import.meta.url).href)}, { namedExports: { ...sdk, SDKClient } });
`);
});

after(() => rmSync(dir, { recursive: true, force: true }));

function run(args, env = {}) {
  const logPath = path.join(dir, `log-${Math.random().toString(36).slice(2)}.jsonl`);
  const result = spawnSync(process.execPath, [
    '--experimental-test-module-mocks',
    '--import', pathToFileURL(path.join(dir, 'fixture.mjs')).href,
    path.join(root, 'bin/jsn.js'), ...args,
  ], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      XDG_CONFIG_HOME: dir,
      JSN_NO_HEADER: '1',
      JSN_NO_PROMPTS: '1',
      JSN_NO_VERSION_CHECK: '1',
      JSN_NO_SKILL_CHECK: '1',
      FIXTURE_LOG: logPath,
      ...env,
    },
  });
  const entries = existsSync(logPath)
    ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
  return { ...result, entries };
}

function json(result) {
  try { return JSON.parse(result.stdout); } catch {
    assert.fail(`stdout was not JSON (exit ${result.status}): ${result.stdout}\n${result.stderr}`);
  }
}

it('plan reports targets, order and zero writes', () => {
  const result = run(['batch', 'plan', '--file', manifestPath, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const output = json(result);
  assert.equal(output.ok, true);
  assert.equal(output.data.counts.writes, 0);
  assert.equal(output.data.writes_performed, false);
  assert.deepEqual(output.data.order, ['laptop', 'cpu']);
  assert.deepEqual(output.data.steps[1].pending_refs, [{ location: 'fields.cat_item', ref: 'steps.laptop.sys_id' }]);
  assert.deepEqual(result.entries, [], 'plan made no transport writes');

  const extracted = run(['batch', 'plan', '--file', manifestPath, '--json', '--get', 'data.counts.writes']);
  assert.equal(extracted.status, 0, extracted.stderr);
  assert.equal(JSON.parse(extracted.stdout), 0, '--get works on the plan envelope');
});

it('applies in dependency order with resolved IDs', () => {
  const result = run(['batch', 'apply', '--file', manifestPath, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const output = json(result);
  assert.equal(output.ok, true);
  assert.deepEqual(output.data.steps.map(step => step.status), ['created', 'created']);
  assert.equal(output.data.counts.created, 2);
  assert.equal(output.data.partial, false);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].table, 'sc_cat_item');
  assert.equal(result.entries[1].table, 'item_option_new');
  assert.equal(result.entries[1].data.cat_item, output.data.steps[0].sys_id);
  assert.equal(output.data.steps[1].sys_id, '20000000000000000000000000000002');
});

it('reports partial success and skips dependents after a failed step', () => {
  const result = run(['batch', 'apply', '--file', manifestPath, '--json'], { FIXTURE_FAIL_TABLE: 'item_option_new' });
  assert.equal(result.status, 1, result.stderr);
  const output = json(result);
  assert.equal(output.ok, true, 'a partial batch still returns its structured result');
  assert.equal(output.data.partial, true);
  assert.deepEqual(output.data.counts, { total: 2, created: 1, updated: 0, failed: 1, skipped: 0 });
  assert.equal(output.data.steps[1].status, 'failed');
  assert.match(output.data.steps[1].error.message, /mock create rejected/);
  assert.ok(output.data.recovery.some(line => /not rolled back|not an atomic/.test(line)));
  assert.equal(result.entries.length, 2);
});

it('rejects an invalid manifest before any request write', () => {
  const result = run(['batch', 'apply', '--file', invalidPath, '--json']);
  assert.equal(result.status, 2, result.stderr);
  const output = json(result);
  assert.equal(output.ok, false);
  assert.equal(output.code, 'usage_error');
  assert.match(output.error, /Invalid batch manifest/);
  const issues = output.details.issues;
  assert.ok(issues.some(issue => /Unsupported step type "sys_user"/.test(issue.message)));
  assert.deepEqual(result.entries, []);
});

it('blocks apply on a read-only profile without writing', () => {
  const result = run(['batch', 'apply', '--file', manifestPath, '--json'], { FIXTURE_READONLY: '1' });
  assert.equal(result.status, 1, result.stderr);
  const output = json(result);
  assert.equal(output.code, 'read_only');
  assert.deepEqual(result.entries, []);
});

it('allows plan on a read-only profile', () => {
  const result = run(['batch', 'plan', '--file', manifestPath, '--json'], { FIXTURE_READONLY: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(result).data.counts.writes, 0);
});

it('stops before a step when the capture context changes mid-run', () => {
  const result = run(['batch', 'apply', '--file', manifestPath, '--json'], { FIXTURE_COMPLETE_AFTER_FIRST: '1' });
  assert.equal(result.status, 1, result.stderr);
  const output = json(result);
  assert.equal(output.data.stopped.code, 'update_set_not_in_progress');
  assert.equal(output.data.counts.created, 1);
  assert.equal(output.data.counts.skipped, 1);
  assert.equal(output.data.context_changes.length, 1);
  assert.equal(result.entries.length, 1, 'no write happened after the context became blocked');
});

it('accepts a manifest from stdin', () => {
  const result = spawnSync(process.execPath, [
    '--experimental-test-module-mocks',
    '--import', pathToFileURL(path.join(dir, 'fixture.mjs')).href,
    path.join(root, 'bin/jsn.js'), 'batch', 'plan', '--file', '-', '--json',
  ], {
    cwd: dir,
    encoding: 'utf8',
    input: JSON.stringify(MANIFEST),
    env: { ...process.env, XDG_CONFIG_HOME: dir, JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).data.order[0], 'laptop');
});
