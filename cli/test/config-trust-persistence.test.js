import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, saveLocalConfig, setActiveProfile } from '../src/config.js';
import { loginProfile } from '../src/commands/auth.js';
import { configureGlobalDefaults } from '../src/setup-preferences.js';
import { credentialFixtureArgs } from './helpers/fake-keyring.js';

const exec = promisify(execFile);
const entry = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
const trusted = { instance_url: 'https://trusted.invalid', auth_method: 'oauth' };
// Capture before isolated() changes TMPDIR; fixture roots must remain siblings.
const temporaryBase = process.env.TMPDIR || os.tmpdir();
function fixture(local = {}) {
  const root = fs.mkdtempSync(path.join(temporaryBase, 'jsn-trust-save-'));
  const globalPath = path.join(root, 'xdg/servicenow/config.json');
  const localPath = path.join(root, '.servicenow/config.json');
  const global = { default_profile: 'primary', profiles: { primary: trusted, other: { instance_url: 'https://other.invalid' } }, format: 'json' };
  fs.mkdirSync(path.dirname(globalPath), { recursive: true });
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(globalPath, JSON.stringify(global));
  fs.writeFileSync(localPath, JSON.stringify(local));
  // Allowlist, not inherited credentials or provider settings. No keyring utilities.
  const env = { HOME: root, XDG_CONFIG_HOME: path.join(root, 'xdg'), XDG_CACHE_HOME: path.join(root, 'cache'), TMPDIR: root, PATH: path.join(root, 'no-utilities'), JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1' };
  return { root, global, globalPath, localPath, env, read: () => JSON.parse(fs.readFileSync(globalPath)), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
async function run(f, args, env = {}) {
  try { return { ...await exec(process.execPath, [...credentialFixtureArgs, entry, ...args], { cwd: f.root, env: { ...f.env, ...env }, timeout: 15000 }), code: 0 }; }
  catch (error) { return { stdout: error.stdout, stderr: error.stderr, code: error.code }; }
}

for (const basic of [false, true]) {
  for (const projectOnly of [false, true]) {
    for (const operation of ['switch', 'modify', 'status']) {
      test(`real CLI ${operation}: ${basic ? 'Basic' : 'OAuth'} ${projectOnly ? 'project-only' : 'shadow'} cannot acquire global trust`, async () => {
        const requests = [];
        const server = http.createServer((req, res) => { requests.push(req.headers.authorization); res.setHeader('Content-Type', 'application/json'); res.end('{"result":[]}'); });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const sink = `http://127.0.0.1:${server.address().port}`;
        const name = projectOnly ? 'injected' : 'primary';
        const f = fixture({ default_profile: name, profiles: { [name]: { instance_url: sink } } });
        const credentials = basic ? { SN_USERNAME: 'synthetic-user', SN_PASSWORD: 'synthetic-password' } : { SERVICENOW_OAUTH_TOKEN: 'synthetic-token' };
        try {
          assert.notEqual((await run(f, ['records', 'list', '--table', 'sys_user', '--json'], credentials)).code, 0);
          const result = await run(f, operation === 'status' ? ['auth', 'status', '--json'] : ['auth', operation, name, ...(operation === 'modify' ? ['--include-counts'] : []), '--json'], credentials);
          assert.equal(result.code, operation === 'status' ? 0 : 2, result.stdout + result.stderr);
          assert.deepEqual(f.read(), f.global);
          assert.notEqual((await run(f, ['records', 'list', '--table', 'sys_user', '--json'], credentials)).code, 0);
          assert.deepEqual(requests, []);
          // Explicit destination approval remains a request-scoped positive control.
          assert.equal((await run(f, ['records', 'list', '--table', 'sys_user', '--instance', sink, '--json'], credentials)).code, 0);
          assert.ok(requests.some(value => value === (basic ? `Basic ${Buffer.from('synthetic-user:synthetic-password').toString('base64')}` : 'Bearer synthetic-token')));
          assert.deepEqual(f.read(), f.global);
        } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.cleanup(); }
      });
    }
  }
}

test('real CLI trusted switch and modify ignore unrelated project profiles', async () => {
  const f = fixture({ profiles: { injected: { instance_url: 'https://project.invalid' } } });
  try {
    assert.equal((await run(f, ['auth', 'switch', 'other', '--json'])).code, 0);
    assert.equal((await run(f, ['auth', 'modify', 'other', '--include-counts', '--json'])).code, 0);
    const saved = f.read();
    assert.equal(saved.default_profile, 'other');
    assert.equal(saved.profiles.other.include_counts, true);
    assert.equal(saved.profiles.injected, undefined);
    assert.deepEqual(saved.profiles.primary, trusted);
  } finally { f.cleanup(); }
});

async function isolated(local, callback) {
  const f = fixture(local);
  const env = { ...process.env };
  const cwd = process.cwd();
  try {
    for (const key of Object.keys(process.env)) if (/^(SN_|SERVICENOW_|JSN_)/.test(key)) delete process.env[key];
    Object.assign(process.env, f.env);
    process.chdir(f.root);
    await callback(f);
  } finally {
    process.chdir(cwd);
    // node:test tracks environment assignments; replacing process.env does not
    // reliably remove keys introduced by the fixture when absent on entry.
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(env, key)) delete process.env[key];
    Object.assign(process.env, env);
    assert.deepEqual({ ...process.env }, env);
    f.cleanup();
  }
}

test('unrelated repeated saves preserve global roots, project fields and env/flag overlays', async () => {
  const local = { instance_url: 'https://project.invalid', default_profile: 'injected', format: 'csv', profiles: { primary: { instance_url: 'https://sink.invalid', domain: 'evil' }, injected: { instance_url: 'https://new.invalid' } }, custom: true };
  await isolated(local, async f => {
    process.env.SERVICENOW_INSTANCE_URL = 'https://env.invalid';
    process.env.SERVICENOW_FORMAT = 'quiet';
    const cfg = loadConfig({ instance: 'https://flag.invalid', format: 'markdown' });
    cfg.docs = { mode: 'hosted' };
    saveConfig(cfg);
    await configureGlobalDefaults(cfg, { documentation: false, prompts: { confirm: async () => true } });
    assert.deepEqual(f.read(), { ...f.global, docs: cfg.docs, connection_defaults: cfg.connectionDefaults });
    assert.deepEqual(JSON.parse(fs.readFileSync(f.localPath)), local);
    cfg.profiles.other.include_counts = false;
    saveConfig(cfg);
    assert.equal(f.read().profiles.other.include_counts, false);
    assert.deepEqual(f.read().profiles.primary, trusted);
    assert.equal(f.read().profiles.injected, undefined);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.localPath)).profiles.primary, local.profiles.primary);
  });
});

test('trusted switch, modification, deletion and local-only saves remain available', async () => {
  await isolated({ profiles: { injected: { instance_url: 'https://project.invalid' } } }, async f => {
    const cfg = loadConfig();
    setActiveProfile(cfg, 'other');
    cfg.profiles.other.include_counts = false;
    saveConfig(cfg);
    assert.equal(f.read().default_profile, 'other');
    assert.equal(f.read().profiles.other.include_counts, false);
    delete cfg.profiles.primary;
    saveConfig(cfg);
    assert.equal(f.read().profiles.primary, undefined);
    const before = fs.readFileSync(f.globalPath, 'utf8');
    cfg.profiles.injected.include_counts = true;
    saveLocalConfig(cfg);
    assert.equal(fs.readFileSync(f.globalPath, 'utf8'), before);
    assert.equal(JSON.parse(fs.readFileSync(f.localPath)).profiles.injected.include_counts, true);
  });
});

test('explicit login approves only the authored profile, never unrelated project data', async () => {
  await isolated({ default_profile: 'injected', profiles: { primary: { instance_url: 'https://approved.invalid', domain: 'project-domain' }, injected: { instance_url: 'https://unrelated.invalid' } } }, async f => {
    // loginProfile preflights credential storage before authenticating. This
    // in-process case has no task-owned keyring on either platform, so it
    // declares the documented plaintext opt-in instead of probing for one.
    const savedPlaintext = process.env.JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE;
    process.env.JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE = '1';
    try {
    const cfg = loadConfig();
    const sdk = { getCurrentUser: async () => ({ user_name: 'synthetic-user' }), get: async () => ({ result: [] }) };
    const app = { config: cfg, sdk, getSDKForProfile: () => sdk, auth: { loginWithPassword: async () => ({ username: 'synthetic-user' }) }, ok: () => {} };
    await assert.rejects(loginProfile({ profile: 'primary', basic: true }, app), /not globally trusted/);
    // --profile is authoritative: an ignored literal argument cannot approve
    // that profile's project-shadowed destination.
    await assert.rejects(loginProfile({ profile: 'primary', instance: 'https://trusted.invalid', basic: true }, app), /not globally trusted/);
    assert.deepEqual(f.read(), f.global);
    await loginProfile({ instance: 'https://approved.invalid', basic: true, makeDefault: true, 'include-counts': true }, app);
    const saved = f.read();
    assert.equal(saved.profiles.primary.instance_url, 'https://approved.invalid');
    assert.equal(saved.profiles.primary.username, 'synthetic-user');
    assert.equal(saved.profiles.primary.domain, undefined);
    assert.equal(saved.profiles.injected, undefined);
    assert.deepEqual(saved.profiles.other, f.global.profiles.other);
    assert.equal(saved.default_profile, 'primary');
    assert.equal(saved.instance_url, 'https://approved.invalid');
    } finally {
      if (savedPlaintext === undefined) delete process.env.JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE;
      else process.env.JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE = savedPlaintext;
    }
  });
});
