import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';

const exec = promisify(execFile);
const binary = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));

// Independent process-boundary observer. It stays installed when injection is
// deliberately removed, and records attempts before SDK can swallow the error.
const sentinelSource = `
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const receipt = { native: 0, writes: 0, offLoopback: 0 };
const fetch = globalThis.fetch;
globalThis.fetch = (input, ...options) => {
  const url = new URL(typeof input === 'string' ? input : input.url || String(input));
  if (url.hostname !== '127.0.0.1') {
    receipt.offLoopback++;
    throw new Error('Independent sentinel refuses non-loopback HTTP');
  }
  return fetch(input, ...options);
};
childProcess.execFileSync = () => {
  receipt.native++;
  throw new Error('Synthetic native sentinel: no OS credential access');
};
syncBuiltinESMExports();
const { defaultCredentialStore } = await import(${JSON.stringify(new URL('../src/auth/credential-store.js', import.meta.url).href)});
for (const operation of ['save', 'delete']) defaultCredentialStore[operation] = () => {
  receipt.writes++;
  throw new Error('Synthetic native sentinel: no credential writes');
};
process.on('exit', () => fs.writeFileSync(process.env.FIXTURE_RECEIPT, JSON.stringify(receipt)));
`;

test('loopback real CLI injection avoids native dispatch; omitted injection fails the independent guard and restored injection passes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-loopback-credentials-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: new URL(req.url, 'http://fixture.invalid').pathname });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ result: [{ sys_id: 'a'.repeat(32), name: 'Synthetic fixture' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const instance = `http://127.0.0.1:${server.address().port}`;
  const sentinel = path.join(directory, 'sentinel.mjs');
  fs.writeFileSync(sentinel, sentinelSource);
  const env = loopbackFixtureEnv({ HOME: directory, XDG_CONFIG_HOME: path.join(directory, 'config'),
    XDG_CACHE_HOME: path.join(directory, 'cache'), JSN_DATA_HOME: path.join(directory, 'data'),
    JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1', JSN_NO_HEADER: '1',
    SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', FIXTURE_RECEIPT: path.join(directory, 'receipt.json') });
  const run = async (injection = true, target = instance, context = env) => {
    const result = await exec(process.execPath, ['--import', pathToFileURL(sentinel).href,
      ...(injection ? loopbackCredentialArgs : []), binary, 'records', 'list', '--table', 'sys_user', '--instance', target, '--json'],
    { cwd: directory, env: context, timeout: 20000 });
    assert.equal(JSON.parse(result.stdout).data.records[0].name, 'Synthetic fixture');
    return JSON.parse(fs.readFileSync(env.FIXTURE_RECEIPT, 'utf8'));
  };
  const guard = receipt => { assert.equal(receipt.native, 0, 'fixture must not dispatch native storage'); assert.equal(receipt.writes, 0); assert.equal(receipt.offLoopback, 0); };
  guard(await run());
  const broken = await run(false);
  assert.ok(broken.native > 0, 'control must reach the actual native-storage dispatch boundary');
  assert.throws(() => guard(broken), /fixture must not dispatch native storage/);
  guard(await run());
  assert.ok(requests.some(row => row.path.startsWith('/api/now/table/sys_user')));
  assert.ok(requests.every(row => row.method === 'GET' || (row.method === 'POST' && row.path === '/angular.do')));
  const beforeRefusal = requests.length;
  await assert.rejects(run(true, 'https://example.invalid'), /loopback credential fixture/);
  guard(JSON.parse(fs.readFileSync(env.FIXTURE_RECEIPT, 'utf8')));
  const noContext = { ...env }; delete noContext.JSN_LOOPBACK_CREDENTIAL_FIXTURE;
  await assert.rejects(run(true, instance, noContext), /loopback credential fixture/);
  assert.equal(requests.length, beforeRefusal, 'scope refusal must precede HTTP');
  // Exercise the late safety boundary independently of CLI flag validation.
  for (const action of ["await fetch('https://example.invalid')",
    `store.save(${JSON.stringify(instance)}, {})`, `store.delete(${JSON.stringify(instance)})`]) {
    await assert.rejects(exec(process.execPath, ['--import', pathToFileURL(sentinel).href,
      ...loopbackCredentialArgs, '--input-type=module', '-e',
      `import { defaultCredentialStore as store } from ${JSON.stringify(new URL('../src/auth/credential-store.js', import.meta.url).href)}; ${action};`, binary],
    { cwd: directory, env, timeout: 10000 }), /loopback credential fixture/);
    guard(JSON.parse(fs.readFileSync(env.FIXTURE_RECEIPT, 'utf8')));
  }
});

test('loopback preload is child-scoped and absent from ordinary native-test processes', async () => {
  const before = process.env.NODE_OPTIONS;
  const env = loopbackFixtureEnv({ SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret' });
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(process.env.NODE_OPTIONS, before);
  const result = await exec(process.execPath, ['--input-type=module', '-e',
    `import { defaultCredentialStore, loadCredentials } from ${JSON.stringify(new URL('../src/auth/credential-store.js', import.meta.url).href)};
     if (defaultCredentialStore.load !== loadCredentials || process.execArgv.some((arg, index) => process.execArgv[index - 1] === '--import' && arg.includes('loopback-credential-fixture'))) process.exit(1);`],
  { env, timeout: 10000 });
  assert.equal(result.stderr, '');
});
