import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url));
let dir;
before(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'jsn-context-cli-'));
  writeFileSync(path.join(dir, 'fixture.mjs'), `
import { mock } from 'node:test';
import * as config from ${JSON.stringify(new URL('../src/config.js', import.meta.url).href)};
import * as sdk from ${JSON.stringify(new URL('../src/sdk.js', import.meta.url).href)};
mock.module(${JSON.stringify(new URL('../src/config.js', import.meta.url).href)}, { namedExports: { ...config, loadConfig: () => ({ profiles: { fixture: { instance_url: 'https://fixture.invalid', username: 'test', auth_method: 'basic', read_only: process.env.FIXTURE_READONLY === '1', skip_confirmations: true } }, activeProfile: 'fixture', defaultProfile: 'fixture' }) } });
class SDKClient {
  async list(table, params) {
    if (table === 'sys_user') return [{ sys_id: 'user' }];
    if (table === 'sys_user_preference') return [{ value: params.get('sysparm_query').includes('apps.current_app') ? (process.env.FIXTURE_SCOPE || 'global') : 'set' }];
    return [];
  }
  async get(table) { return table === 'sys_scope' ? { scope: process.env.FIXTURE_SCOPE || 'global' } : { sys_id: 'set', name: process.env.FIXTURE_SET || 'Default', application: process.env.FIXTURE_SCOPE || 'global', state: 'in progress' }; }
  async create() { return { sys_id: 'created' }; }
  async request() { return { result: [] }; }
}
mock.module(${JSON.stringify(new URL('../src/sdk.js', import.meta.url).href)}, { namedExports: { ...sdk, SDKClient } });
`);
});
after(() => rmSync(dir, { recursive: true, force: true }));
function run(args, env = {}) {
  return spawnSync(process.execPath, ['--experimental-test-module-mocks', '--import', pathToFileURL(path.join(dir, 'fixture.mjs')).href, path.join(root, 'bin/jsn.js'), ...args], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: dir, JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', ...env },
  });
}
for (const format of ['--json', '--quiet']) {
  it(`enforces approval and structured context with ${format} and headers disabled`, () => {
    const result = run(['records', 'create', '--table', 'incident', '--data', '{}', format]);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stdout, result.stderr);
    const error = JSON.parse(result.stdout);
    assert.equal(error.code, 'confirmation_required'); assert.equal(error.context.scope, 'global');
    assert.equal(error.context.diagnostics[0].code, 'global_default_update_set');
    assert.match(error.hint, /records create.*--table incident.*--force/);
  });
}
it('approved override reaches actual command handler with structured context', () => {
  const result = run(['records', 'create', '--table', 'incident', '--data', '{}', '--json', '--force']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.context.mutation.approved, true); assert.equal(output.data.sys_id, 'created');
});
it('ordinary create in named set needs no confirmation', () => {
  const result = run(['records', 'create', '--table', 'incident', '--data', '{}', '--json'], { FIXTURE_SET: 'My Feature' });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).context.mutation.approval_required, false);
});
it('read-only REST GET remains blocked by existing policy', () => {
  const result = run(['rest', '/api/now/table/incident', '--json'], { FIXTURE_READONLY: '1' });
  assert.equal(result.status, 1, result.stderr); assert.equal(JSON.parse(result.stdout).code, 'read_only');
});

it('write-enabled REST GET runs without capture-context approval', () => {
  const result = run(['rest', '/api/now/table/incident', '--json']);
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).ok, true);
});
