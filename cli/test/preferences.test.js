// Configurable workflow preferences: resolution, persistence and CLI surface.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PREFERENCES, resolvePreferences, setPreference, unsetPreference,
  renderUpdateSetName, testingGuidance, coercePreferenceValue,
} from '../src/preferences.js';
import { loadConfig, saveConfig, setActiveProfile, globalConfigPath } from '../src/config.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/jsn.js');
let root;
let originalXdg;
let originalHome;
let originalCwd;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-prefs-'));
  originalXdg = process.env.XDG_CONFIG_HOME;
  originalHome = process.env.HOME;
  originalCwd = process.cwd();
  process.env.XDG_CONFIG_HOME = path.join(root, 'config');
  process.env.HOME = path.join(root, 'home');
  process.chdir(root);
});

after(() => {
  process.chdir(originalCwd);
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = originalXdg;
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(root, 'config'), { recursive: true, force: true });
  fs.rmSync(path.join(root, '.servicenow'), { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
});

function writeGlobal(config) {
  fs.mkdirSync(path.dirname(globalConfigPath()), { recursive: true });
  fs.writeFileSync(globalConfigPath(), JSON.stringify(config, null, 2));
}

function readGlobal() {
  return JSON.parse(fs.readFileSync(globalConfigPath(), 'utf-8'));
}

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf-8',
    env: { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', NO_COLOR: '1' },
  });
}

describe('resolution and defaults', () => {
  it('with no config, every default reproduces today\'s behavior', () => {
    const { preferences, sources } = resolvePreferences();
    assert.deepEqual(preferences, JSON.parse(JSON.stringify(DEFAULT_PREFERENCES)));
    assert.equal(preferences.operations.create, true);
    assert.equal(preferences.operations.update, true);
    assert.equal(preferences.operations.delete, true);
    assert.deepEqual(preferences.testing.methods, ['atf', 'scan']);
    assert.equal(preferences.testing.recommend, true);
    assert.equal(preferences.testing.suggestMissing, true);
    assert.equal(preferences.updatesets.nameTemplate, '{{tracker}}-{{date}}-{{initials}}-{{scope}}');
    for (const source of Object.values(sources)) assert.equal(source, 'default');
  });

  it('inherits per field: installation and profile overrides only their own leaves', () => {
    writeGlobal({
      preferences: { operations: { delete: false }, testing: { methods: [] } },
      profiles: { prod: { instance_url: 'https://prod.example', preferences: { operations: { create: false }, updatesets: { initials: 'AB' } } } },
    });
    const { preferences, sources } = resolvePreferences({ profile: 'prod' });
    assert.equal(preferences.operations.delete, false, 'installation explicit false');
    assert.equal(preferences.operations.create, false, 'profile explicit false');
    assert.equal(preferences.operations.update, true, 'default inherited');
    assert.deepEqual(preferences.testing.methods, [], 'empty array is explicit');
    assert.equal(preferences.testing.recommend, true, 'sibling field still default');
    assert.equal(preferences.updatesets.initials, 'AB');
    assert.equal(sources['operations.delete'], 'installation');
    assert.equal(sources['operations.create'], 'profile');
    assert.equal(sources['operations.update'], 'default');
  });

  it('ignores project-local preferences entirely', () => {
    fs.mkdirSync(path.join(root, '.servicenow'), { recursive: true });
    fs.writeFileSync(path.join(root, '.servicenow', 'config.json'), JSON.stringify({
      preferences: { operations: { delete: false }, testing: { recommend: false } },
    }));
    const { preferences } = resolvePreferences();
    assert.equal(preferences.operations.delete, true);
    assert.equal(preferences.testing.recommend, true);
  });

  it('does not mutate the frozen built-in defaults', () => {
    writeGlobal({ preferences: { operations: { delete: false } } });
    resolvePreferences();
    assert.equal(DEFAULT_PREFERENCES.operations.delete, true);
  });
});

describe('set/unset persistence', () => {
  it('installation and selected profile preferences survive ordinary config saves', () => {
    const preferences = { operations: { delete: false }, testing: { recommend: false } };
    const profilePreferences = { updatesets: { initials: 'ZZ' } };
    writeGlobal({ preferences, default_profile: 'customer', profiles: {
      customer: { instance_url: 'https://customer.invalid', preferences: profilePreferences },
      other: { instance_url: 'https://other.invalid' },
    } });
    fs.mkdirSync(path.join(root, '.servicenow'), { recursive: true });
    fs.writeFileSync(path.join(root, '.servicenow/config.json'), JSON.stringify({ preferences: { operations: { delete: true } } }));
    const config = loadConfig();
    config.format = 'json';
    saveConfig(config);
    config.connectionDefaults = { read_only: true };
    saveConfig(config);
    setActiveProfile(config, 'other');
    setPreference({ key: 'testing.suggestMissing', value: false });
    preferences.testing.suggestMissing = false;
    setPreference({ key: 'updatesets.initials', value: 'NEW', profile: 'customer' });
    profilePreferences.updatesets.initials = 'NEW';
    config.profiles.customer.include_counts = true;
    saveConfig(config);
    assert.deepEqual(readGlobal().preferences, preferences);
    assert.deepEqual(readGlobal().profiles.customer.preferences, profilePreferences);
  });

  it('round-trips installation values and preserves unrelated global keys', () => {
    writeGlobal({ instance_url: 'https://keep.example', custom_key: { keep: true }, profiles: { prod: { instance_url: 'https://prod.example' } } });
    setPreference({ key: 'operations.delete', value: 'false' });
    let raw = readGlobal();
    assert.equal(raw.preferences.operations.delete, false);
    assert.equal(raw.instance_url, 'https://keep.example');
    assert.deepEqual(raw.custom_key, { keep: true });
    assert.equal(raw.profiles.prod.instance_url, 'https://prod.example');
    // Windows does not expose POSIX permission bits; the persistence checks
    // above and below still run there, while Unix verifies the private mode.
    if (process.platform !== 'win32') assert.equal(fs.statSync(globalConfigPath()).mode & 0o777, 0o600);

    setPreference({ key: 'testing.methods', value: 'fixscripts,backgroundscripts' });
    assert.deepEqual(readGlobal().preferences.testing.methods, ['fixscripts', 'backgroundscripts']);

    unsetPreference({ key: 'operations.delete' });
    raw = readGlobal();
    assert.equal(raw.preferences.operations, undefined, 'empty parent scaffolding is pruned');
    assert.equal(raw.instance_url, 'https://keep.example');
  });

  it('writes profile overrides without touching installation preferences', () => {
    writeGlobal({
      preferences: { operations: { delete: false } },
      profiles: { prod: { instance_url: 'https://prod.example' } },
    });
    setPreference({ key: 'operations.delete', value: true, profile: 'prod' });
    const raw = readGlobal();
    assert.equal(raw.preferences.operations.delete, false);
    assert.equal(raw.profiles.prod.preferences.operations.delete, true);
    assert.equal(resolvePreferences({ profile: 'prod' }).preferences.operations.delete, true);
  });

  it('rejects unknown profiles, keys and malformed values with usage errors', () => {
    writeGlobal({ profiles: { prod: { instance_url: 'https://prod.example' } } });
    assert.throws(() => setPreference({ key: 'operations.delete', value: true, profile: 'missing' }), e => e.code === 'usage_error');
    assert.throws(() => setPreference({ key: 'nope.delete', value: true }), e => e.code === 'usage_error');
    assert.throws(() => coercePreferenceValue('operations.delete', 'yes'), e => e.code === 'usage_error');
    assert.throws(() => coercePreferenceValue('testing.methods', 'atf,nope'), e => e.code === 'usage_error');
    assert.throws(() => coercePreferenceValue('testing.methods', 'none,atf'), e => e.code === 'usage_error');
    assert.throws(() => coercePreferenceValue('updatesets.nameTemplate', '{{tracker}}-{{bogus}}'), e => e.code === 'usage_error');
    assert.throws(() => coercePreferenceValue('updatesets.dateFormat', 'YYYY/MM/DD'), e => e.code === 'usage_error');
  });
});

describe('testing guidance', () => {
  it('default guidance mentions ATF, scans and missing checks', () => {
    const guidance = testingGuidance(DEFAULT_PREFERENCES);
    assert.match(guidance.text, /ATF tests/);
    assert.match(guidance.text, /instance scans/);
    assert.match(guidance.text, /create missing checks/);
  });

  it('suppresses recommendations when disabled and reflects configured methods', () => {
    assert.equal(testingGuidance({ ...DEFAULT_PREFERENCES, testing: { recommend: false, methods: ['atf'], suggestMissing: true } }), null);
    assert.equal(testingGuidance({ ...DEFAULT_PREFERENCES, testing: { recommend: true, methods: ['none'], suggestMissing: true } }), null);
    const guidance = testingGuidance({ ...DEFAULT_PREFERENCES, testing: { recommend: true, methods: ['fixscripts', 'backgroundscripts'], suggestMissing: false } });
    assert.match(guidance.text, /fix scripts/);
    assert.match(guidance.text, /background scripts/);
    assert.doesNotMatch(guidance.text, /create missing checks/);
    assert.deepEqual(guidance.hints.map(h => h.action), ['fixscripts', 'backgroundscripts']);
    assert.match(guidance.hints[0].cmd, /sys_script_fix/);
    assert.match(guidance.hints[1].cmd, /jsn eval/);
  });
});

describe('update-set name template', () => {
  const prefs = values => ({
    ...DEFAULT_PREFERENCES,
    updatesets: { ...DEFAULT_PREFERENCES.updatesets, ...values },
  });

  it('renders tracker, date, initials and scope locally', () => {
    const name = renderUpdateSetName({
      preferences: prefs({ initials: 'AB', dateFormat: 'YYYY-MM-DD' }),
      tracker: 'STRY001',
      scope: 'x_custom',
      date: new Date(Date.UTC(2026, 10, 23)),
    });
    assert.equal(name, 'STRY001-2026-11-23-AB-x_custom');
  });

  it('supports a custom date format', () => {
    const name = renderUpdateSetName({
      preferences: prefs({ initials: 'AB', dateFormat: 'YYYY.MM.DD' }),
      tracker: 'T1', scope: 'app', date: new Date(Date.UTC(2026, 0, 2)),
    });
    assert.equal(name, 'T1-2026.01.02-AB-app');
  });

  it('missing values and invalid tokens are usage errors', () => {
    assert.throws(() => renderUpdateSetName({ preferences: prefs({ initials: 'AB' }), scope: 'app' }), e => e.code === 'usage_error' && /tracker/.test(e.message));
    assert.throws(() => renderUpdateSetName({ preferences: prefs({}), tracker: 'T', scope: 'app' }), e => e.code === 'usage_error' && /initials/.test(e.message));
    assert.throws(() => renderUpdateSetName({ preferences: prefs({ initials: 'AB' }), tracker: 'T' }), e => e.code === 'usage_error' && /scope/.test(e.message));
    assert.throws(() => renderUpdateSetName({ preferences: prefs({ nameTemplate: '{{tracker}}-{{wat}}', initials: 'A' }), tracker: 'T', scope: 's' }), e => e.code === 'usage_error');
  });
});

describe('preferences CLI', () => {
  it('documented positional setters work and conflicting/missing values never write', () => {
    assert.equal(run(['preferences', 'set', 'testing.methods', 'atf,scan', '--json']).status, 0);
    assert.equal(run(['preferences', 'set', 'updatesets.initials', 'ZZ', '--json']).status, 0);
    assert.equal(run(['preferences', 'set', 'operations.delete', 'false', '--json']).status, 0);
    const before = fs.readFileSync(globalConfigPath(), 'utf8');
    for (const args of [[], ['true', '--value', 'false']]) {
      assert.notEqual(run(['preferences', 'set', 'operations.delete', ...args, '--json']).status, 0);
      assert.equal(fs.readFileSync(globalConfigPath(), 'utf8'), before);
    }
    assert.equal(JSON.parse(run(['preferences', 'show', '--get', 'data.preferences.operations.delete']).stdout), false);
  });

  it('malformed stored shapes fail with usage errors rather than permitting writes', () => {
    for (const preferences of [{ operations: [] }, { operations: { delete: 'false' } }, { testing: { methods: 'scan' } }]) {
      writeGlobal({ preferences });
      assert.throws(() => resolvePreferences(), e => e.code === 'usage_error');
    }
  });

  it('show works offline with no instance and reports default sources', () => {
    const result = run(['preferences', 'show', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.data.preferences, JSON.parse(JSON.stringify(DEFAULT_PREFERENCES)));
    assert.equal(envelope.data.sources['operations.delete'], 'default');
    assert.equal(envelope.data.profile, null);
  });

  it('set and unset round-trip through the real CLI', () => {
    let result = run(['preferences', 'set', 'operations.delete', '--value', 'false', '--json']);
    assert.equal(result.status, 0, result.stderr);
    result = run(['preferences', 'show', '--json']);
    assert.equal(JSON.parse(result.stdout).data.preferences.operations.delete, false);
    assert.equal(JSON.parse(result.stdout).data.sources['operations.delete'], 'installation');

    result = run(['preferences', 'unset', 'operations.delete', '--json']);
    assert.equal(result.status, 0, result.stderr);
    result = run(['preferences', 'show', '--json']);
    assert.equal(JSON.parse(result.stdout).data.preferences.operations.delete, true);
  });

  it('unknown or malformed input exits with a usage error', () => {
    let result = run(['preferences', 'set', 'operations.nope', '--value', 'true']);
    assert.equal(result.status, 2);
    assert.match(result.stderr + result.stdout, /Unknown preference key/);
    result = run(['preferences', 'set', 'testing.methods', '--value', 'atf,nope']);
    assert.equal(result.status, 2);
    assert.match(result.stderr + result.stdout, /Unknown testing method/);
  });

  it('targets a profile override with --profile', () => {
    writeGlobal({ profiles: { prod: { instance_url: 'https://prod.example' } } });
    const result = run(['preferences', 'set', 'updatesets.initials', '--value', 'AB', '--profile', 'prod', '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readGlobal().profiles.prod.preferences.updatesets.initials, 'AB');
    const show = run(['preferences', 'show', '--profile', 'prod', '--json']);
    assert.equal(JSON.parse(show.stdout).data.preferences.updatesets.initials, 'AB');
    assert.equal(JSON.parse(show.stdout).data.sources['updatesets.initials'], 'profile');
  });
});
