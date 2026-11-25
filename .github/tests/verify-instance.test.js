import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { verifyInstance } from '../scripts/verify-instance.mjs';

const token = 'FAKE-private-token-canary';
const base = { JSN_ALWAYS_WARM_SESSION: '0', JSN_VERIFY_TARGET: 'pdi', JSN_VERIFY_ENABLED: 'true', SERVICENOW_INSTANCE_URL: 'https://example.invalid', SERVICENOW_OAUTH_TOKEN: token };
test('selected instance rejects disabled, missing and malformed configuration', () => {
  assert.equal(verifyInstance({ ...base, JSN_VERIFY_ENABLED: '' }).status, 'disabled');
  assert.equal(verifyInstance({ ...base, SERVICENOW_OAUTH_TOKEN: '' }).status, 'not_configured');
  assert.equal(verifyInstance({ ...base, JSN_VERIFY_TARGET: 'other' }).status, 'invalid_target');
  for (const url of ['http://example.invalid', 'https://user:pass@example.invalid', 'https://example.invalid/path']) {
    assert.equal(verifyInstance({ ...base, SERVICENOW_INSTANCE_URL: url }).status, 'invalid_url');
  }
});

test('real CLI uses env OAuth on bounded GET; failures never emit provider data', async () => {
  let mode = 200;
  let records = [{ name: 'incident', user_id: 'private-user-canary' }];
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const url = new URL(req.url, 'http://fixture.invalid');
    const result = url.pathname.endsWith('/sys_user')
      ? [{ sys_id: 'a'.repeat(32), user_name: 'fixture' }]
      : url.pathname.endsWith('/sys_dictionary')
        ? [{ name: 'sys_db_object', element: 'name', internal_type: 'string', reference: '' }]
        : url.searchParams.get('sysparm_fields') === 'sys_id,name,super_class'
          ? [{ sys_id: 'b'.repeat(32), name: 'sys_db_object', super_class: '' }]
          : records;
    res.writeHead(mode, { 'Content-Type': 'application/json', 'X-Total-Count': String(result.length) });
    res.end(JSON.stringify(mode === 200 ? { result } : { error: { message: `${token} private-user-canary` } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const run = (instance = url, target = 'pdi') => new Promise((resolve, reject) => {
    const moduleURL = new URL('../scripts/verify-instance.mjs', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import {verifyInstance} from ${JSON.stringify(moduleURL)}; console.log(JSON.stringify(verifyInstance(process.env,{allowLocal:true})))`], {
      env: { ...process.env, ...base, JSN_VERIFY_TARGET: target, SERVICENOW_INSTANCE_URL: instance }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; });
    child.stderr.on('data', chunk => { text += chunk; });
    child.on('error', reject);
    child.on('close', () => { assert.ok(!text.includes(token)); assert.ok(!text.includes('private-user-canary')); resolve(JSON.parse(text)); });
  });
  try {
    assert.equal((await run()).ok, true);
    assert.equal(requests.length, 4);
    assert.ok(requests.every(request => request.method === 'GET' && request.auth === `Bearer ${token}`));
    assert.deepEqual(requests.map(request => new URL(request.url, url).pathname), [
      '/api/now/table/sys_user', '/api/now/table/sys_db_object',
      '/api/now/table/sys_dictionary', '/api/now/table/sys_db_object',
    ]);
    const request = new URL(requests.at(-1).url, url);
    assert.equal(request.pathname, '/api/now/table/sys_db_object');
    assert.equal(request.searchParams.get('sysparm_query'), 'name=incident');
    assert.equal(request.searchParams.get('sysparm_limit'), '1');
    for (const target of ['vendor-1', 'vendor-2']) {
      const result = await run(url, target);
      assert.equal(result.ok, true);
      assert.equal(result.target, target);
    }
    records = [];
    assert.equal((await run()).status, 'verification_failed');
    records = [{ name: 'incident' }];
    mode = 401;
    assert.equal((await run()).status, 'authentication_failed');
    mode = 503;
    assert.equal((await run()).ok, false);
    mode = 200;
    assert.equal((await run()).ok, true);
  } finally { await new Promise(resolve => server.close(resolve)); }
  assert.equal((await run()).status, 'unavailable');
});
