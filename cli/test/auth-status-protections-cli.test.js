// Offline CLI evidence: injected auth/SDK, no live instance or credential store.
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
  dir = mkdtempSync(path.join(tmpdir(), 'jsn-auth-protections-'));
  writeFileSync(path.join(dir, 'fixture.mjs'), `
import { mock } from 'node:test';
import * as config from ${JSON.stringify(new URL('../src/config.js', import.meta.url).href)};
import * as auth from ${JSON.stringify(new URL('../src/auth.js', import.meta.url).href)};
import * as sdk from ${JSON.stringify(new URL('../src/sdk.js', import.meta.url).href)};
const profile = { instance_url: 'https://private.invalid', username: 'private-user', auth_method: 'basic' };
mock.module(${JSON.stringify(new URL('../src/config.js', import.meta.url).href)}, { namedExports: { ...config, loadConfig: () => ({ profiles: { reader: { ...profile, read_only: true }, writer: { ...profile, skip_confirmations: true } }, activeProfile: 'reader', defaultProfile: 'reader' }), saveConfig: () => { throw Error('no config writes'); } } });
class AuthManager {
  createProfileProvider() { return {}; }
  isAuthenticated() { return true; }
  isAuthenticatedFor() { return process.env.FIXTURE_MISSING !== '1'; }
  getLastSeen() { return null; }
  hasLegacyCredentials() { return false; }
  getAuthState() { return { auth_method: 'basic', auth_source: 'fixture', state: process.env.FIXTURE_MISSING === '1' ? 'missing' : 'available' }; }
  async probeCurrentUser(instance, provider) {
    await provider.getCurrentUser({ touchLastSeen: false });
    return process.env.FIXTURE_FAILED === '1' ? { status: 'failed', code: 'permission_denied', message: 'Fixture permission denial.' } : { status: 'succeeded' };
  }
}
class SDKClient {
  async getCurrentUser() { return { user_name: 'private-user' }; }
  async request() { throw Error('unexpected data request'); }
}
mock.module(${JSON.stringify(new URL('../src/auth.js', import.meta.url).href)}, { namedExports: { ...auth, AuthManager } });
mock.module(${JSON.stringify(new URL('../src/sdk.js', import.meta.url).href)}, { namedExports: { ...sdk, SDKClient } });
`);
});
after(() => rmSync(dir, { recursive: true, force: true }));
function run(args, env = {}) {
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--import', pathToFileURL(path.join(dir, 'fixture.mjs')).href, path.join(root, 'bin/jsn.js'), 'auth', 'status', ...args], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: dir, JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
it('human CLI explains mixed protections once, keeps the table and hides identities', () => {
  const text = run(['--local', '--format', 'styled']);
  assert.match(text, /PROFILE\s+AUTH\s+CREDENTIALS\s+CONNECTION\s+ACCESS\s+DELETES\s+COUNTS/);
  assert.match(text, /reader \* \(default\).*Read-only\s+Confirm/);
  assert.match(text, /writer.*Read\/write\s+No prompt/);
  assert.equal(text.split('Profile protections').length, 2);
  assert.match(text, /writes, deletes and raw REST even with GET/);
  assert.match(text, /--force bypasses this prompt, not read-only/);
  assert.match(text, /not ServiceNow ACL authorization/);
  assert.match(text, /only CONNECTION Verified confirms the status probe succeeded/);
  assert.doesNotMatch(text, /private-user|private.invalid/);
});
it('explicit selection explains only displayed protection modes, not the active default', () => {
  const text = run(['--profile', 'writer', '--local', '--format', 'styled']);
  assert.match(text, /writer \*/);
  assert.doesNotMatch(text, /reader|Read-only:| {2}Confirm:/);
  assert.match(text, /Read\/write:.*command's guards/);
  assert.match(text, /No prompt:.*command-specific safeguards still apply/);
});
it('JSON preserves safety and diagnostic fields and the existing formatted field without private identity', () => {
  const text = run(['--local', '--json']);
  const { data } = JSON.parse(text);
  assert.equal(data.profiles.length, 2);
  assert.equal(data.profiles[0].read_only, true);
  assert.equal(data.profiles[0].skip_confirmations, false);
  assert.equal(data.profiles[1].read_only, false);
  assert.equal(data.profiles[1].skip_confirmations, true);
  assert.equal(data.profiles[0].verified, null);
  assert.equal(data.profiles[0].diagnostics.probe.code, 'not_requested');
  assert.equal(typeof data._formatted, 'string');
  assert.doesNotMatch(text, /private-user|private.invalid/);
});
it('JSON explicit selection and details preserve opt-in identity fields', () => {
  const { data } = JSON.parse(run(['--profile', 'writer', '--details', '--json']));
  assert.equal(data.profiles.length, 1);
  assert.equal(data.profiles[0].name, 'writer');
  assert.equal(data.profiles[0].active, true);
  assert.equal(data.profiles[0].username, 'private-user');
  assert.equal(data.profiles[0].verified_as, 'private-user');
  assert.equal(data.profiles[0].instance, 'https://private.invalid');
  assert.equal(data.profiles[0].verified, true);
});
it('human details reveals identity only on request and extraction retains JSON fields', () => {
  const text = run(['--profile', 'writer', '--local', '--details', '--format', 'styled']);
  assert.match(text, /USER\s+INSTANCE/);
  assert.match(text, /private-user\s+https:\/\/private.invalid/);
  assert.equal(JSON.parse(run(['--profile', 'reader', '--local', '--get', 'data.profiles[0].read_only'])), true);
});
it('human CLI distinguishes available/unverified, missing and failed probe diagnostics', () => {
  assert.match(run(['--local', '--format', 'styled']), /Available\s+Not checked/);
  assert.match(run(['--local', '--format', 'styled'], { FIXTURE_MISSING: '1' }), /Missing\s+Not checked/);
  const failed = run(['--format', 'styled'], { FIXTURE_FAILED: '1' });
  assert.match(failed, /Available\s+Failed/);
  assert.match(failed, /Fixture permission denial/);
  const { data } = JSON.parse(run(['--json'], { FIXTURE_FAILED: '1' }));
  assert.equal(data.profiles[0].authenticated, true);
  assert.equal(data.profiles[0].verified, false);
  assert.equal(data.profiles[0].diagnostics.probe.code, 'permission_denied');
});
