import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { environmentOAuth } from '../scripts/oauth-environment.mjs';

const refresh = 'fake-refresh-canary';
const access = 'fake-access-canary';
const env = { SERVICENOW_INSTANCE_URL: 'https://example.invalid', SERVICENOW_OAUTH_REFRESH_TOKEN: refresh, SERVICENOW_OAUTH_TOKEN: 'expired' };
test('refresh contract, public client override, expiry, rotation and closed errors', async () => {
  const warnings = [];
  const fetchImpl = async (url, options) => {
    assert.equal(url.href, 'https://example.invalid/oauth_token.do');
    assert.equal(options.redirect, 'error');
    assert.equal(options.body.get('grant_type'), 'refresh_token');
    assert.equal(options.body.get('client_id'), 'test-public-client');
    assert.equal(options.body.get('refresh_token'), refresh);
    assert.equal(options.body.has('client_secret'), false);
    return Response.json({ access_token: access, expires_in: 300, refresh_token: 'rotated-canary' });
  };
  const result = await environmentOAuth({ ...env, SERVICENOW_OAUTH_CLIENT_ID: 'test-public-client' }, { fetchImpl, warn: text => warnings.push(text) });
  assert.deepEqual(result, { accessToken: access, source: 'refreshed' });
  assert.equal(warnings.length, 1);
  assert.ok(!warnings.join('').includes('rotated-canary'));
  for (const response of [Response.json({ error: `invalid_grant ${refresh}` }, { status: 400 }), Response.json({ access_token: access, expires_in: 0 }), Response.json({ access_token: access, expires_in: -1 }), Response.json({}), new Response('private-error', { status: 500 })]) {
    await assert.rejects(environmentOAuth(env, { fetchImpl: async () => response }), { message: 'authentication_failed' });
  }
  await assert.rejects(environmentOAuth(env, { fetchImpl: async () => { throw new Error(refresh); } }), { message: 'authentication_failed' });
  await assert.rejects(environmentOAuth({ ...env, SERVICENOW_INSTANCE_URL: 'http://example.invalid' }), { message: 'invalid_url' });
  assert.equal((await environmentOAuth({ ...env, SERVICENOW_OAUTH_REFRESH_TOKEN: '' })).source, 'legacy_access_token');
});

test('HTTP refresh then actual CLI GET, rejection, recovery, redirects and timeout', async () => {
  let mode = 'ok';
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    if (req.url === '/oauth_token.do') {
      if (mode === 'timeout') return;
      if (mode === 'redirect') { res.writeHead(307, { Location: '/exfiltrate' }); res.end(); return; }
      res.writeHead(mode === 'reject' ? 400 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mode === 'reject' ? { error: `invalid_grant ${refresh}` } : { access_token: access, refresh_token: refresh, expires_in: 300 }));
    } else {
      assert.equal(req.method, 'GET');
      assert.equal(req.headers.authorization, `Bearer ${access}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: [{ name: 'incident' }] }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const local = { ...env, JSN_ALWAYS_WARM_SESSION: '0', SERVICENOW_INSTANCE_URL: `http://127.0.0.1:${server.address().port}`, JSN_VERIFY_ENABLED: 'true', JSN_VERIFY_TARGET: 'vendor-1' };
  const run = () => new Promise((resolve, reject) => {
    const module = new URL('../scripts/verify-instance.mjs', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import {refreshAndVerify} from ${JSON.stringify(module)}; console.log(JSON.stringify(await refreshAndVerify(process.env,{allowLocal:true})))`], { env: { ...process.env, ...local } });
    let output = '';
    child.stdout.on('data', c => { output += c; });
    child.stderr.on('data', c => { output += c; });
    child.on('error', reject);
    child.on('close', () => { assert.ok(!output.includes(access)); assert.ok(!output.includes(refresh)); resolve(JSON.parse(output)); });
  });
  try {
    assert.equal((await run()).ok, true);
    assert.deepEqual(requests.map(r => r.method), ['POST', 'GET']);
    mode = 'reject';
    assert.equal((await run()).status, 'authentication_failed');
    assert.equal(requests.length, 3);
    mode = 'ok';
    assert.equal((await run()).ok, true);
    mode = 'redirect';
    await assert.rejects(environmentOAuth(local, { allowLocal: true }), { message: 'authentication_failed' });
    assert.ok(!requests.some(r => r.url === '/exfiltrate'));
    mode = 'timeout';
    await assert.rejects(environmentOAuth(local, { allowLocal: true, timeout: 30 }), { message: 'authentication_failed' });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
