import test from 'node:test';
import assert from 'node:assert/strict';
import { SDKClient } from '../src/sdk.js';
import { publishFlows } from '../src/flow-publish.js';

const base = 'https://fixture.invalid';
const loginPage = '<form action="/login.do"><input name="user_name"><input name="user_password"></form>';

for (const scenario of ['binary replay', 'second rejection', 'wrong identity', 'ambiguous write', 'stateful GET', 'publish replay']) {
  test(`public raw response recovery: ${scenario}`, async t => {
    let recovered = 0, operations = 0;
    const seenBodies = [];
    const client = new SDKClient(base, { getCredentials: async () => ({
      auth_method: 'gck', access_token: 'fixture-token', cookies: `session=${recovered ? 'fresh' : 'stale'}`,
    }) }, { username: 'fixture-user', recovery: {
      recover: async () => { recovered++; return true; },
    } });
    t.mock.method(globalThis, 'fetch', async req => {
      if (new URL(req.url).pathname === '/api/now/table/sys_user') {
        assert.equal(req.headers.get('Cookie'), 'session=fresh');
        return reply(JSON.stringify({ result: [{ user_name: scenario === 'wrong identity' ? 'other' : 'fixture-user' }] }));
      }
      operations++;
      seenBodies.push(await req.text());
      if (scenario === 'ambiguous write' || scenario === 'stateful GET') return reply(loginPage, 200, { 'Content-Type': 'text/html' });
      if (!recovered || scenario === 'second rejection') return reply('', 401);
      if (scenario === 'publish replay') return reply('{"result":{"summary":{"activated":1},"results":[]}}', 422);
      return reply(new Uint8Array([0, 255, 42]), 200, { 'Content-Type': 'application/octet-stream' });
    });
    const call = () => scenario === 'publish replay' ? publishFlows(client, ['fixture-flow'])
      : client.fetchResponse(`${base}/raw`, { method: scenario === 'stateful GET' ? 'GET' : 'POST',
        ...(scenario === 'stateful GET' ? { stateful: true } : { body: 'original payload' }) });
    if (scenario === 'binary replay') {
      const response = await call();
      assert.equal(response.bodyUsed, false);
      assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0, 255, 42]);
      assert.deepEqual(seenBodies, ['original payload', 'original payload']);
    } else if (scenario === 'publish replay') {
      assert.deepEqual(await call(), { summary: { activated: 1 }, results: [], via: 'wfa_fluent' });
      assert.equal(seenBodies[0], seenBodies[1]);
    } else {
      await assert.rejects(call(), { code: 'auth_error' });
    }
    const ambiguous = scenario === 'ambiguous write' || scenario === 'stateful GET';
    assert.equal(recovered, ambiguous ? 0 : 1);
    assert.equal(operations, ambiguous || scenario === 'wrong identity' ? 1 : 2);
  });
}

const credentials = { getCredentials: async () => ({ auth_method: 'basic', username: 'fixture-user', password: 'fixture-password' }) };
const reply = (body, status = 200, headers = {}) => new Response(body, { status, headers });

for (const caller of ['fetchResponse', 'publishFlows']) {
  test(`${caller} detects MFA before any activation dispatch`, async t => {
    const requests = [];
    t.mock.method(globalThis, 'fetch', async req => {
      requests.push(new URL(req.url).pathname);
      if (new URL(req.url).pathname === '/angular.do') return reply('{"status":"mfa_code_required"}');
      return reply('{"result":{"summary":{"activated":1},"results":[]}}');
    });
    const client = new SDKClient(base, credentials, { canInteract: () => false });
    const activate = () => caller === 'publishFlows' ? publishFlows(client, ['fixture-flow'])
      : client.fetchResponse(`${base}/api/now/wfa_fluent/activate_flows`, { method: 'POST' });
    await assert.rejects(activate(), { code: 'mfa_required' });
    await assert.rejects(activate(), { code: 'mfa_required' });
    assert.deepEqual(requests, ['/angular.do']);
  });
}

// Ordinary Basic REST must work even when the optional UI bootstrap is unavailable
// or anonymous. Pin the public contract directly; historical comparison is evidence,
// not a runtime dependency on Git or on a particular checkout's object history.
for (const [label, body, status, token] of [
  ['guest', 'guest', 200, ''],
  ['nonJSON', '<html>UI unavailable</html>', 200, ''],
  ['rejectedUI', '{"status":"failure"}', 401, ''],
  ['guest with token', 'guest', 200, 'anonymous-token'],
]) {
  test(`Basic REST retains base compatibility with ${label} bootstrap`, async t => {
    const requests = [];
    t.mock.method(globalThis, 'fetch', async req => {
      requests.push(req);
      if (new URL(req.url).pathname === '/angular.do') return reply(body, status,
        { 'Set-Cookie': 'session=anonymous', ...(token ? { 'x-usertoken-response': token } : {}) });
      return req.headers.get('Authorization')?.startsWith('Basic ')
        ? reply('{"result":[{"sys_id":"rest-success"}]}') : reply('unauthorized', 401);
    });
    const client = new SDKClient(base, credentials, { canInteract: () => false });
    assert.deepEqual(await client.list('incident'), [{ sys_id: 'rest-success' }]);
    const operations = requests.filter(req => new URL(req.url).pathname === '/api/now/table/incident');
    assert.equal(operations.length, 1);
    // Known fixture-user:fixture-password header, independently specified rather
    // than derived from the client or accepted merely for having a Basic prefix.
    assert.equal(operations[0].headers.get('Authorization'), 'Basic Zml4dHVyZS11c2VyOmZpeHR1cmUtcGFzc3dvcmQ=');
    assert.equal(operations[0].headers.get('Cookie'), null);
  });
}
