import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SDKClient, needsUiSession } from '../src/sdk.js';

const basicAuth = {
  getCredentials: async () => ({ auth_method: 'basic', username: 'admin', password: 'secret' }),
};

/**
 * The UI session bootstrap (`/angular.do`) mints cookies and an X-UserToken for
 * processor-style endpoints. OAuth Table, stats and batch requests skip it;
 * Basic deliberately checks for a TOTP challenge before operation dispatch.
 */
test('needsUiSession is false only for header-authenticated REST resources', () => {
  const base = 'https://example.service-now.com';
  for (const path of [
    '/api/now/table/sys_user?sysparm_limit=1',
    '/api/now/table/sys_user/abc123',
    '/api/now/stats/incident',
    '/api/now/v1/batch',
  ]) {
    assert.equal(needsUiSession(`${base}${path}`), false, path);
  }
  for (const path of [
    '/api/now/graphql',
    '/api/now/ui/concoursepicker/application',
    '/api/now/attachment/abc123/file',
    '/angular.do?sysparm_type=get_user',
    '/xmlhttp.do',
    '/sys.scripts.do',
    '/processflow/flow/abc',
  ]) {
    assert.equal(needsUiSession(`${base}${path}`), true, path);
  }
});

test('needsUiSession keeps the bootstrap for stateful callers and the env override', () => {
  const table = 'https://example.service-now.com/api/now/table/sys_user';
  assert.equal(needsUiSession(table, { stateful: true }), true);
  assert.equal(needsUiSession(table, { forceSession: true }), true);
  assert.equal(needsUiSession('not a url'), true);
});

function spyClient(auth = basicAuth) {
  const client = new SDKClient('https://example.service-now.com', auth);
  const state = { warmed: 0, requests: [] };
  client._warmSession = async () => {
    state.warmed += 1;
    return 'JSESSIONID=1';
  };
  return { client, state };
}

function stubFetch(t, state) {
  t.mock.method(globalThis, 'fetch', async (request) => {
    state.requests.push({
      url: String(request.url),
      authorization: request.headers.get('Authorization'),
      cookie: request.headers.get('Cookie'),
    });
    return new Response('{"result":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

test('a table read authenticates from its header without bootstrapping a session', async (t) => {
  const { client, state } = spyClient({ getCredentials: async () => ({ auth_method: 'oauth', access_token: 'fixture' }) });
  stubFetch(t, state);
  await client.request('https://example.service-now.com/api/now/table/sys_user?sysparm_limit=1');
  assert.equal(state.warmed, 0);
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].authorization, 'Bearer fixture');
  assert.equal(state.requests[0].cookie, null);
});

test('a processor-shaped request still bootstraps the UI session', async (t) => {
  const { client, state } = spyClient();
  stubFetch(t, state);
  await client.request('https://example.service-now.com/api/now/graphql', {
    method: 'POST',
    body: JSON.stringify({ query: '{ __typename }' }),
  });
  assert.equal(state.warmed, 1);
  assert.equal(state.requests[0].cookie, 'JSESSIONID=1');
});

test('JSN_ALWAYS_WARM_SESSION=1 restores the bootstrap for table reads', async (t) => {
  const previous = process.env.JSN_ALWAYS_WARM_SESSION;
  process.env.JSN_ALWAYS_WARM_SESSION = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.JSN_ALWAYS_WARM_SESSION;
    else process.env.JSN_ALWAYS_WARM_SESSION = previous;
  });
  const { client, state } = spyClient();
  stubFetch(t, state);
  await client.request('https://example.service-now.com/api/now/table/sys_user?sysparm_limit=1');
  assert.equal(state.warmed, 1);
});
