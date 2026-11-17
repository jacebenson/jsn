import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('real CLI mutations preserve output without creating or touching retired history files', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-history-cli-'));
  const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const auth = new URL('../src/auth.js', import.meta.url).href;
  const preload = path.join(directory, 'fixture.mjs');
  fs.writeFileSync(preload, `
    import { AuthManager } from ${JSON.stringify(auth)};
    AuthManager.prototype.createProfileProvider = () => ({ getCredentials: async () => ({ auth_method: 'gck', access_token: 'fixture-secret' }) });
    globalThis.fetch = async req => {
      const url = new URL(req.url);
      const table = url.pathname.split('/')[4];
      if (process.env.FIXTURE_FAIL === '1' && req.method === 'POST') return new Response('{"error":{"message":"synthetic refusal"}}', { status: 403 });
      if (req.method === 'POST') return new Response(JSON.stringify({ result: { sys_id: 'full-resolved-id', number: 'INC0001', ...JSON.parse(await req.text()) } }));
      if (req.method === 'PATCH' || req.method === 'PUT') return new Response(JSON.stringify({ result: { sys_id: 'full-resolved-id' } }));
      if (req.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ result: table === 'sys_scope' ? [{ sys_id: 'scoped-app', name: 'Fixture', scope: 'x_fixture' }]
        : table === 'u_custom' && url.searchParams.get('sysparm_query') === 'sys_id=full-resolved-id'
          ? [{ sys_id: 'full-resolved-id', active: false, private_field: 'never-store-this' }] : [] }));
    };
  `);
  const env = { ...process.env, HOME: directory, XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, JSN_CONFIG_HOME: directory, JSN_DATA_HOME: directory,
    JSN_NO_HEADER: '1', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1' };
  const run = args => spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, cli, ...args], {
    env, cwd: directory, encoding: 'utf8', timeout: 10000,
  });
  try {
    for (const args of [
      ['records', 'create', '--table', 'u_custom', '--data', '{"private_field":"never-store-this"}'],
      ['incidents', 'create', '--description', 'never-store-this'],
      ['properties', 'create', '--data', '{"name":"fixture","value":"never-store-this"}'],
      ['records', 'update', '--table', 'u_custom', '--sys-id', 'full-resolved-id', '--data', '{"active":false}'],
      ['records', 'delete', '--table', 'u_custom', '--sys-id', 'full-resolved-id', '--force'],
    ]) {
      const result = run([...args, '--instance', 'https://fixture.example.test', '--json']);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.equal(JSON.parse(result.stdout).ok, true);
      assert.doesNotMatch(result.stderr, /local mutation history|could not be saved/);
    }
    const assertNoHistory = () => {
      const names = fs.readdirSync(directory, { recursive: true });
      assert.ok(!names.some(name => /history\.db(?:-|$)/.test(name)), names.join(', '));
    };
    assertNoHistory();
    const unconfirmed = run(['records', 'delete', '--table', 'u_custom', '--sys-id', 'full-resolved-id', '--instance', 'https://fixture.example.test', '--json']);
    assert.notEqual(unconfirmed.status, 0);
    assert.match(unconfirmed.stdout + unconfirmed.stderr, /confirm|force/i);
    assertNoHistory();
    env.FIXTURE_FAIL = '1';
    const failed = run(['records', 'create', '--table', 'u_custom', '--data', '{}', '--instance', 'https://fixture.example.test', '--json']);
    assert.notEqual(failed.status, 0);
    assert.equal(JSON.parse(failed.stdout).ok, false);
    assertNoHistory();
    delete env.FIXTURE_FAIL;
    delete env.JSN_DATA_HOME;
    const defaultHome = run(['records', 'create', '--table', 'u_custom', '--data', '{}', '--instance', 'https://fixture.example.test', '--json']);
    assert.equal(defaultHome.status, 0, defaultHome.stderr + defaultHome.stdout);
    assertNoHistory();
    env.JSN_DATA_HOME = directory;
    // Opaque pre-existing user data must not be opened, pruned, migrated or deleted.
    const retained = path.join(directory, 'history.db');
    fs.writeFileSync(retained, 'opaque retained user data');
    const before = fs.statSync(retained);
    const successful = run(['records', 'create', '--table', 'u_custom', '--data', '{}', '--instance', 'https://fixture.example.test', '--json']);
    assert.equal(successful.status, 0, successful.stderr + successful.stdout);
    for (const args of [['history'], ['history', 'list'], ['history', 'prune']]) {
      const retired = run([...args, '--json']);
      assert.notEqual(retired.status, 0);
      assert.match(retired.stdout + retired.stderr, /unknown|not recognized|invalid command/i);
    }
    const help = run(['--help', '--all-commands']);
    assert.doesNotMatch(help.stdout, /--reason|Local seven-day mutation history/);
    assert.equal(fs.readFileSync(retained, 'utf8'), 'opaque retained user data');
    assert.equal(fs.statSync(retained).mtimeMs, before.mtimeMs);
    assert.deepEqual(fs.readdirSync(directory, { recursive: true }).filter(name => /history\.db/.test(name)), ['history.db']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

