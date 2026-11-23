// Operation preference guard, testing guidance consumption and template naming in
// the real update-set create handler.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCLI } from '../src/cli.js';
import { operationOf, collectCapabilities } from '../src/capabilities.js';
import { updateSetsCmd } from '../src/commands/updatesets.js';
import { setPreference } from '../src/preferences.js';
import { globalConfigPath } from '../src/config.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/jsn.js');
let root;
let originalXdg;
let originalCwd;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-prefs-ops-'));
  originalXdg = process.env.XDG_CONFIG_HOME;
  originalCwd = process.cwd();
  process.env.XDG_CONFIG_HOME = path.join(root, 'config');
  process.chdir(root);
});

after(() => {
  process.chdir(originalCwd);
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = originalXdg;
  fs.rmSync(root, { recursive: true, force: true });
});

function writeGlobal(config) {
  fs.mkdirSync(path.dirname(globalConfigPath()), { recursive: true });
  fs.writeFileSync(globalConfigPath(), JSON.stringify(config, null, 2));
}

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf-8',
    env: { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', NO_COLOR: '1' },
  });
}

buildCLI([]);
const CAPS = collectCapabilities();

describe('operationOf derives the operation class from the capability registry', () => {
  const cases = [
    [['scan', 'checks', 'delete', 'abc'], 'delete'],
    [['scan', 'checks', 'create'], 'create'],
    [['scan', 'suites', 'update', 'abc'], 'update'],
    [['scan', 'suites', 'add-check', 'abc'], 'update'],
    [['catalogitems', 'order'], 'create'],
    [['domains', 'session-set'], 'update'],
    [['records', 'create'], 'create'],
    [['records', 'update', 'abc'], 'update'],
    [['records', 'delete', 'abc'], 'delete'],
    [['records', 'delete-many'], 'delete'],
    [['records', 'bulk'], null],
    [['records', 'list'], null],
    [['attachments', 'upload', 'f.txt'], 'create'],
    [['updatesets', 'create'], 'create'],
    [['updatesets', 'import'], 'create'],
    [['updatesets', 'preview'], 'update'],
    [['updatesets', 'commit'], 'update'],
    [['updatesets', 'set'], 'update'],
    [['updatesets', 'list'], null],
    [['atf', 'run'], 'update'],
    [['atf', 'list'], null],
    [['platform', 'health'], null],
    [['history', 'list'], null],
  ];
  for (const [argv, expected] of cases) {
    it(`${argv.join(' ')} -> ${expected}`, () => {
      assert.equal(operationOf({ _: argv }, CAPS), expected);
    });
  }

  it('classifies explicit REST methods and eval', () => {
    assert.equal(operationOf({ _: ['rest', '/api/now/table/incident'], method: 'DELETE' }, CAPS), 'delete');
    assert.equal(operationOf({ _: ['rest', '/api/now/table/incident'], method: 'POST' }, CAPS), 'create');
    assert.equal(operationOf({ _: ['rest', '/api/now/table/incident'], method: 'GET' }, CAPS), null);
    assert.equal(operationOf({ _: ['eval', 'gs.info(1)'] }, CAPS), 'update');
  });
});

describe('operation guard middleware', () => {
  function config(profileOverrides = {}, preferences = { operations: { delete: false } }) {
    writeGlobal({
      preferences,
      profiles: { default: { instance_url: 'https://127.0.0.1:1' }, ...profileOverrides },
      default_profile: 'default',
    });
  }

  it('denies a disabled delete before any provider write', () => {
    config();
    const result = run(['records', 'delete-many', '--table', 'incident', '--query', 'active=true', '--json']);
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 'operation_denied');
    assert.match(payload.hint, /jsn preferences set operations\.delete true/);
  });

  it('denies disabled create and update too', () => {
    config({}, { operations: { create: false, update: false } });
    let result = run(['records', 'create', '--table', 'incident', '--data', '{}', '--json']);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).code, 'operation_denied');
    result = run(['records', 'update', 'abc', '--table', 'incident', '--data', '{}', '--json']);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).code, 'operation_denied');
  });

  it('--force does not bypass the preference', () => {
    config();
    const result = run(['records', 'delete-many', '--table', 'incident', '--query', 'active=true', '--force', '--yes', '--json']);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).code, 'operation_denied');
  });

  it('read-only profile policy keeps precedence', () => {
    config({ default: { instance_url: 'https://127.0.0.1:1', read_only: true } });
    const result = run(['records', 'delete-many', '--table', 'incident', '--query', 'active=true', '--json']);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).code, 'read_only');
  });

  it('allows the operation again after re-enabling it', () => {
    config();
    setPreference({ key: 'operations.delete', value: true });
    const result = run(['records', 'delete-many', '--table', 'incident', '--query', 'active=true', '--json']);
    assert.notEqual(JSON.parse(result.stdout || '{"code":"operation_denied"}').code, 'operation_denied');
  });
});

function commandMap() {
  const collected = [];
  const y = {
    command(definition) { collected.push(definition); return this; },
    option() { return this; }, positional() { return this; }, epilogue() { return this; },
    demandOption() { return this; }, alias() { return this; }, describe() { return this; },
  };
  updateSetsCmd(fn => fn).builder(y);
  return new Map(collected.map(definition => [definition.command.split(' ')[0], definition]));
}

function appForCreate(overrides = {}) {
  const created = [];
  const ok = [];
  return {
    created, okCalls: ok,
    session: { profileName: 'test' },
    config: { activeProfile: 'test', defaultProfile: 'test', profiles: { test: { instance_url: 'https://example.invalid', scope: 'x_custom' } } },
    context: { scope: '' },
    ok: (data, opts) => ok.push({ data, opts }),
    sdk: {
      create: async (table, payload) => { created.push({ table, payload }); return { sys_id: 'abc', name: payload.name }; },
      list: async () => { throw new Error('offline fixture: no provider'); },
      request: async () => { throw new Error('offline fixture: no provider'); },
    },
    ...overrides,
  };
}

describe('update-set create naming', () => {
  it('renders the configured template and creates the record with it', async () => {
    writeGlobal({
      preferences: { updatesets: { initials: 'AB', dateFormat: 'YYYY-MM-DD' } },
      profiles: { test: { instance_url: 'https://example.invalid', scope: 'x_custom' } },
    });
    const app = appForCreate();
    await commandMap().get('create').handler({ tracker: 'STRY001' }, app);
    assert.equal(app.created.length, 1);
    assert.match(app.created[0].payload.name, /^STRY001-\d{4}-\d{2}-\d{2}-AB-x_custom$/);
  });

  it('keeps an explicit --name verbatim (no template)', async () => {
    writeGlobal({ preferences: { updatesets: { initials: 'AB' } }, profiles: { test: { instance_url: 'https://example.invalid' } } });
    const app = appForCreate();
    await commandMap().get('create').handler({ name: 'Verbatim {{tracker}} name' }, app);
    assert.equal(app.created[0].payload.name, 'Verbatim {{tracker}} name');
  });

  it('missing tracker/initials/scope and invalid tokens create nothing', async () => {
    writeGlobal({ preferences: { updatesets: { initials: '' } }, profiles: { test: { instance_url: 'https://example.invalid' } } });
    let app = appForCreate();
    await assert.rejects(commandMap().get('create').handler({}, app), e => e.code === 'usage_error' && /tracker/.test(e.message));
    assert.equal(app.created.length, 0);

    writeGlobal({ preferences: { updatesets: { initials: 'AB', nameTemplate: '{{tracker}}-{{bogus}}' } }, profiles: { test: { instance_url: 'https://example.invalid', scope: 's' } } });
    app = appForCreate();
    await assert.rejects(commandMap().get('create').handler({ tracker: 'T' }, app), e => e.code === 'usage_error');
    assert.equal(app.created.length, 0);
  });
});
