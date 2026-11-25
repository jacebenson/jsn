import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SDKClient } from '../src/sdk.js';

const base = 'https://oauth-fixture.invalid';
const oauth = { getCredentials: async () => ({ auth_method: 'oauth', access_token: 'fixture-access' }) };
function mode(t, value) {
  const before = process.env.JSN_ALWAYS_WARM_SESSION;
  if (value === undefined) delete process.env.JSN_ALWAYS_WARM_SESSION;
  else process.env.JSN_ALWAYS_WARM_SESSION = value;
  t.after(() => { if (before === undefined) delete process.env.JSN_ALWAYS_WARM_SESSION; else process.env.JSN_ALWAYS_WARM_SESSION = before; });
}
function transport(t) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async req => {
    const url = new URL(req.url);
    calls.push(req);
    if (url.pathname === '/angular.do') return new Response('{}', { headers: {
      'Set-Cookie': `JSESSIONID=${url.hostname}; Path=/`,
      'X-UserToken-Response': `token-${url.hostname}`,
    } });
    return new Response('{"result":[]}');
  });
  return calls;
}
const pathOf = req => new URL(req.url).pathname;
const isBootstrap = req => pathOf(req) === '/angular.do' || pathOf(req) === '/api/now/table/sys_scope';
function sessionHeaders(req) {
  const host = new URL(req.url).hostname;
  assert.equal(req.headers.get('Cookie'), `JSESSIONID=${host}`);
  assert.equal(req.headers.get('X-UserToken'), `token-${host}`);
  assert.equal(req.headers.has('Authorization'), false);
}

test('fresh OAuth Table/Stats/batch share one bootstrap, reuse matching session headers and isolate profiles', async t => {
  mode(t);
  const calls = transport(t);
  const sdk = new SDKClient(base, oauth);
  await Promise.all([
    sdk.request(`${base}/api/now/table/sys_store_app`),
    sdk.request(`${base}/api/now/stats/sys_store_app?sysparm_count=true`),
    sdk.request(`${base}/api/now/v1/batch`, { method: 'POST', body: '{"rest_requests":[]}' }),
  ]);
  assert.equal(calls.filter(req => pathOf(req) === '/angular.do').length, 2);
  assert.equal(calls.filter(req => pathOf(req).endsWith('sys_scope')).length, 1);
  assert.equal(calls.find(req => pathOf(req).endsWith('sys_scope')).headers.get('Authorization'), 'Bearer fixture-access', 'internal bootstrap must still bind the existing OAuth identity');
  const count = calls.length;
  await sdk.request(`${base}/api/now/table/sys_properties`, { headers: { Authorization: 'Bearer caller-stale' } });
  assert.equal(calls.length, count + 1);
  const other = new SDKClient('https://other-fixture.invalid', oauth);
  await other.request('https://other-fixture.invalid/api/now/table/sys_properties');
  calls.filter(req => !isBootstrap(req)).forEach(sessionHeaders);
  assert.notEqual(sdk.oauthCookies, other.oauthCookies);
  assert.notEqual(sdk.sessionUserToken, other.sessionUserToken);
});

test('same-origin OAuth profiles keep separate cookie/token generations', async t => {
  mode(t);
  let seed = 0;
  const data = [];
  t.mock.method(globalThis, 'fetch', async req => {
    const path = pathOf(req);
    const cookie = req.headers.get('Cookie');
    if (path === '/angular.do') {
      const value = cookie || `JSESSIONID=anonymous-${++seed}`;
      return new Response('{}', { headers: { 'Set-Cookie': `${value}; Path=/`, 'X-UserToken-Response': `token-${value}` } });
    }
    if (path.endsWith('sys_scope')) {
      const identity = req.headers.get('Authorization').slice('Bearer '.length);
      return new Response('{"result":[]}', { headers: { 'Set-Cookie': `JSESSIONID=${identity}; Path=/` } });
    }
    data.push(req);
    return new Response('{"result":[]}');
  });
  const sdk = identity => new SDKClient(base, { getCredentials: async () => ({ auth_method: 'oauth', access_token: identity }) });
  const a = sdk('profile-a'), b = sdk('profile-b');
  await Promise.all([a.request(`${base}/api/now/table/sys_properties`), b.request(`${base}/api/now/table/sys_properties`)]);
  assert.deepEqual(data.map(req => req.headers.get('Cookie')).sort(), ['JSESSIONID=profile-a', 'JSESSIONID=profile-b']);
  for (const req of data) {
    assert.equal(req.headers.get('X-UserToken'), `token-${req.headers.get('Cookie')}`);
    assert.equal(req.headers.has('Authorization'), false);
  }
});

test('OAuth opt-out is header-only on stateless paths but cannot override required UI/stateful or force-session callers', async t => {
  mode(t, '0');
  const calls = transport(t);
  const sdk = new SDKClient(base, oauth);
  sdk.oauthCookies = 'JSESSIONID=stale'; sdk.sessionUserToken = 'stale-token';
  for (const path of ['/api/now/table/sys_properties', '/api/now/stats/sys_store_app', '/api/now/v1/batch']) {
    await sdk.request(base + path, { headers: { Cookie: 'caller-cookie', 'X-UserToken': 'caller-token' } });
  }
  assert.equal(calls.length, 3, 'opt-out must not bootstrap');
  for (const req of calls) {
    assert.equal(req.headers.get('Authorization'), 'Bearer fixture-access');
    assert.equal(req.headers.has('Cookie'), false);
    assert.equal(req.headers.has('X-UserToken'), false);
  }
  const fresh = new SDKClient(base, oauth);
  await fresh.request(`${base}/api/now/graphql`, { method: 'POST', body: '{}' });
  await fresh.request(`${base}/api/now/table/sys_store_app`, { stateful: true });
  calls.slice(3).filter(req => !isBootstrap(req)).forEach(sessionHeaders);
  process.env.JSN_ALWAYS_WARM_SESSION = '1';
  await fresh.request(`${base}/api/now/table/sys_properties`);
  sessionHeaders(calls.at(-1));
});

test('token and GCK stateless transport semantics are unchanged; OAuth opt-out cannot bypass Basic MFA', async t => {
  mode(t, '0');
  const calls = transport(t);
  const token = new SDKClient(base, { getCredentials: async () => ({ auth_method: 'token', access_token: 'supplied-fixture' }) });
  await token.request(`${base}/api/now/table/sys_properties`);
  assert.equal(calls.at(-1).headers.get('Authorization'), 'Bearer supplied-fixture');
  const gck = new SDKClient(base, { getCredentials: async () => ({ auth_method: 'gck', access_token: 'gck-token', cookies: 'session=gck' }) });
  await gck.request(`${base}/api/now/table/sys_properties`);
  assert.equal(calls.length, 2);
  assert.equal(calls.at(-1).headers.get('Cookie'), 'session=gck');
  assert.equal(calls.at(-1).headers.get('X-UserToken'), 'gck-token');
  assert.equal(calls.at(-1).headers.has('Authorization'), false);
  t.mock.method(globalThis, 'fetch', async req => {
    assert.equal(pathOf(req), '/angular.do', 'MFA gate must reject before data dispatch');
    return new Response('{"status":"mfa_code_required"}');
  });
  const basic = new SDKClient(base, { getCredentials: async () => ({ auth_method: 'basic', username: 'fixture', password: 'fixture' }) }, { canInteract: () => false });
  await assert.rejects(basic.request(`${base}/api/now/table/sys_properties`, { method: 'POST', body: '{}' }), { code: 'mfa_required' });
});

for (const scenario of ['bootstrap_transport_failure', 'bootstrap_missing_token', 'forbidden_data', 'ambiguous_write']) {
  test(`OAuth default preserves bounded behavior for ${scenario}`, async t => {
    mode(t);
    const data = [], bootstrap = [];
    t.mock.method(globalThis, 'fetch', async req => {
      if (isBootstrap(req)) {
        bootstrap.push(req);
        if (scenario === 'bootstrap_transport_failure') throw new Error('fixture bootstrap unavailable');
        return new Response('{}', { headers: {
          'Set-Cookie': 'JSESSIONID=fixture; Path=/',
          ...(scenario === 'bootstrap_missing_token' ? {} : { 'X-UserToken-Response': 'fixture-token' }),
        } });
      }
      data.push(req);
      if (scenario === 'forbidden_data') return new Response('{}', { status: 403 });
      if (scenario === 'ambiguous_write') return new Response('<form action="/login.do"><input name="user_name"><input name="user_password"></form>', { headers: { 'Content-Type': 'text/html' } });
      return new Response('{"result":{"sys_id":"fixture"}}');
    });
    const sdk = new SDKClient(base, oauth, { recovery: { recover() { assert.fail('must not recover or replay these operations'); } } });
    const call = () => sdk.request(`${base}/api/now/table/incident`, { method: 'POST', body: '{"short_description":"fixture"}' });
    if (scenario === 'forbidden_data') await assert.rejects(call(), { status: 403 });
    else if (scenario === 'ambiguous_write') await assert.rejects(call(), { code: 'auth_error' });
    else {
      await call();
      assert.equal(data[0].headers.get('Authorization'), 'Bearer fixture-access', 'preserve pre-existing unavailable-session fallback');
      assert.equal(data[0].headers.has('Cookie'), false, 'never send a partial cookie/token pair');
    }
    assert.equal(data.length, 1, 'bootstrap failure/403/ambiguous writes never duplicate data dispatch');
    assert.ok(bootstrap.length > 0);
  });
}
