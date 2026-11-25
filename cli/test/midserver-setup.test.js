import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateMidInstallDirectory, diagnoseMidAccount } from '../src/midserver-setup.js';
import { registerMidInstallationDirectory, resolveMidInstallationDirectory, forgetMidInstallationDirectory } from '../src/midserver-locations.js';
import { installDockerMidServer, validateMidCredentials } from '../src/midserver-install.js';
import { chooseMidInstallDirectory } from '../src/commands/midservers.js';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-setup-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
const url = 'https://example.service-now.com';
const id = 'a'.repeat(32);
function sdkFixture({ roles = ['mid_server', 'custom_basic'], user = {}, policy = {}, exceptions = [], denied } = {}) {
  const calls = [];
  return { calls, async list(table, params) {
    calls.push([table, params]);
    if (table === denied) throw new Error('fixture access denied');
    if (table === 'sys_user') return [{ sys_id: id, active: 'true', locked_out: 'false', web_service_access_only: 'true', ...user }];
    if (table === 'sys_user_has_role') return roles.map(role => ({ 'role.name': role }));
    if (table === 'sys_properties') return Object.entries({ 'restriction.active': 'true', 'restriction.enforce': 'true', allowed_roles: 'custom_basic', ...policy }).map(([name, value]) => ({ name: `glide.authenticate.basic_auth.${name}`, value }));
    if (table === 'sys_user_basic_auth_exception') return exceptions;
    if (table === 'sys_dictionary' || table === 'sys_choice') return [];
    assert.fail(table);
  } };
}
test('local path validation is read-only and rejects unsafe destinations before commands/download', async t => {
  const home = fixture(t), directory = path.join(home, 'new', 'mid');
  assert.equal(validateMidInstallDirectory(directory), directory);
  assert.equal(fs.existsSync(path.dirname(directory)), false);
  for (const invalid of ['relative', home, path.parse(home).root]) {
    await assert.rejects(installDockerMidServer({ directory: invalid, instanceURL: url, name: 'mid', run: () => assert.fail('no command'), fetchImpl: () => assert.fail('no fetch') }));
  }
  fs.symlinkSync(home, path.join(home, 'link'));
  assert.throws(() => validateMidInstallDirectory(path.join(home, 'link', 'mid')), /Unsafe/);
  if (os.platform() !== 'win32') {
    fs.mkdirSync(path.join(home, 'public'), { mode: 0o777 }); fs.chmodSync(path.join(home, 'public'), 0o777);
    assert.throws(() => validateMidInstallDirectory(path.join(home, 'public', 'mid')), /writable/);
  }
});
test('interactive location uses a prefilled default, accepts override and validates without creating it', async t => {
  const home = fixture(t), directory = path.join(home, 'chosen'); let prompt;
  const app = { getEffectiveInstance: () => url, output: { getFormat: () => 'auto' } };
  assert.equal(await chooseMidInstallDirectory(app, {}, 'mid', { interactive: true, prompt: async options => { prompt = options; return directory; } }), directory);
  assert.match(prompt.default, /\.servicenow[/\\]mids[/\\]example[/\\]mid$/);
  assert.equal(prompt.validate('relative') instanceof String, false);
  assert.equal(typeof prompt.validate('relative'), 'string');
  assert.equal(fs.existsSync(directory), false);
  assert.equal(await chooseMidInstallDirectory(app, { directory }, 'mid', { interactive: true, prompt: async options => options.default }), directory);
});
test('registry discovers custom directories, partitions target/instance and never substitutes ownership checks', t => {
  const homeDirectory = fixture(t), directory = path.join(homeDirectory, 'custom');
  registerMidInstallationDirectory(url, 'mid.server.mid', directory, { homeDirectory });
  assert.equal(resolveMidInstallationDirectory(url, 'mid', { homeDirectory }), directory);
  assert.notEqual(resolveMidInstallationDirectory(url, 'mid', { homeDirectory, target: 'remote' }), directory);
  assert.notEqual(resolveMidInstallationDirectory('https://other.service-now.com', 'mid', { homeDirectory }), directory);
  assert.equal(resolveMidInstallationDirectory(url, 'mid', { homeDirectory, directory: '/override' }), '/override');
  registerMidInstallationDirectory(url, 'mid', directory, { homeDirectory });
  assert.throws(() => registerMidInstallationDirectory(url, 'mid', '/other', { homeDirectory }), /already registered elsewhere/);
  forgetMidInstallationDirectory(url, 'mid', { homeDirectory });
  assert.notEqual(resolveMidInstallationDirectory(url, 'mid', { homeDirectory }), directory);
});
test('read-only account checks use actual configured roles, not a hard-coded Basic Auth role', async () => {
  const sdk = sdkFixture();
  const result = await diagnoseMidAccount(sdk, url, 'mid.user');
  assert.deepEqual(result.roles, ['mid_server', 'custom_basic']);
  assert.ok(sdk.calls.every(([, params]) => params.get('sysparm_display_value') === 'false'));
  assert.ok(sdk.calls.some(([table]) => table === 'sys_user_has_role'));
});
test('diagnostics distinguish missing roles, unsafe account flags and unreadable authorization', async () => {
  await assert.rejects(diagnoseMidAccount(sdkFixture({ roles: ['custom_basic'] }), url, 'mid'), /missing role mid_server.*sys_user_has_role/);
  await assert.rejects(diagnoseMidAccount(sdkFixture({ roles: ['mid_server'], user: { web_service_access_only: 'false' } }), url, 'mid'), /missing configured Basic Auth role \(custom_basic\)/);
  await assert.rejects(diagnoseMidAccount(sdkFixture({ user: { active: 'false', locked_out: 'true', web_service_access_only: 'false' } }), url, 'mid'), /active=true.*locked_out=false.*web_service_access_only=true/);
  await assert.rejects(diagnoseMidAccount(sdkFixture({ denied: 'sys_properties' }), url, 'mid'), /authorization is unknown/);
  await assert.rejects(diagnoseMidAccount(sdkFixture({ roles: ['mid_server'], user: { web_service_access_only: 'false' }, exceptions: [{ sys_id: id }] }), url, 'mid'), /applicability is unknown/);
  await diagnoseMidAccount(sdkFixture({ roles: ['mid_server'], policy: { 'restriction.enforce': 'false' } }), url, 'mid');
  await assert.rejects(diagnoseMidAccount(sdkFixture(), url, 'mid^ORactive=true'), /unsafe|invalid|query/i);
});
test('documented WSAO exemption needs no Basic Auth role or exception; decision values are read, never guessed', async () => {
  const wsao = sdkFixture({ roles: ['mid_server'] });
  await diagnoseMidAccount(wsao, url, 'mid');
  assert.equal(wsao.calls.some(([table]) => table === 'sys_user_basic_auth_exception'), false);
  for (const label of ['Maintain current login - Basic Auth API and UI login allowed', 'Revoke Basic Auth API login', 'Convert to web service access only account']) {
    const sdk = sdkFixture({ roles: ['mid_server'], user: { web_service_access_only: 'false' }, exceptions: [{ sys_id: id, user: id, decision: 'provider-defined-value' }] });
    const original = sdk.list.bind(sdk);
    sdk.list = async (table, params) => {
      if (table === 'sys_dictionary') return [{ element: 'decision', internal_type: 'string' }];
      if (table === 'sys_choice') return [{ value: 'provider-defined-value', label }];
      return original(table, params);
    };
    await assert.rejects(diagnoseMidAccount(sdk, url, 'mid'), error => {
      assert.ok(error.message.includes(label));
      assert.match(error.message, /no configured allowed role or WSAO exemption is effective/);
      return true;
    });
  }
});

test('401 and 403 do not establish a role failure or usable password', async () => {
  for (const status of [401, 403]) {
    await assert.rejects(validateMidCredentials(url, 'mid', 'fixture-secret', async () => ({ status, ok: false })), error => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.match(error.message, /does not prove/);
      assert.doesNotMatch(error.message, /fixture-secret/);
      return true;
    });
  }
});
