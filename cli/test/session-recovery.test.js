// Bounded, safe session recovery (issue #403).
//
// Contract: docs/AUTH_LIFECYCLE.md § "Runtime authentication recovery" and
// GLOSSARY.md § "Runtime authentication recovery". A rejected session is
// replaced at most once, a request is replayed at most once and only when the
// rejection proves it never ran, concurrent requests share one recovery, and an
// unrecoverable session fails with actionable guidance instead of replaying.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SDKClient } from '../src/sdk.js';
import { createAuthRecovery } from '../src/auth-recovery.js';
import {
  MAX_SESSION_REPLAYS, canReplayAfterRecovery, classifyAuthRejection, isLoginPage,
} from '../src/session-recovery.js';

const base = 'https://recovery.invalid';
const loginPage = '<html><body><form action="/login.do"><input name="user_name"><input name="user_password" type="password"></form></body></html>';
const secrets = ['access-secret', 'refresh-secret', 'cookie-secret', 'identity-secret'];

function credentialProvider(method = 'oauth') {
  const provider = {
    current: {
      auth_method: method, username: 'selected-user', access_token: secrets[0],
      refresh_token: secrets[1], password: 'password-secret', cookies: 'JSESSIONID=stale',
    },
    lastSeen: 0,
    getCredentials: async () => ({ ...provider.current }),
    touchLastSeen() { provider.lastSeen++; },
  };
  return provider;
}

function recoveryProvider(error) {
  const state = { calls: 0, rejections: [] };
  const fallback = Object.assign(new Error('Authentication rejected for profile selected (HTTP 401).'), {
    code: 'auth_error', status: 401, profile: 'selected',
    recovery: 'jsn auth refresh --profile selected', hint: 'Run interactively: jsn auth refresh --profile selected.',
  });
  return {
    state,
    rotate: () => {},
    error: error || fallback,
    async recover(rejection) {
      state.calls++;
      state.rejections.push(rejection);
      this.rotate();
      return true;
    },
  };
}

function harness(t, { method = 'oauth', recovery = recoveryProvider(), username = 'selected-user' } = {}) {
  const creds = credentialProvider(method);
  recovery.rotate = () => { creds.current.cookies = 'JSESSIONID=fresh'; };
  const sdk = new SDKClient(base, creds, { recovery, username, timeout: 200 });
  sdk.sessionUserToken = 'token-1';
  let warms = 0;
  // Mirrors _initializeSession: a warm session yields both cookies and the
  // matching CSRF/user token, and both are replaced together.
  sdk._warmSession = async () => {
    if (sdk.oauthCookies) return sdk.oauthCookies;
    warms++;
    sdk.sessionUserToken = `token-${warms}`;
    sdk.oauthCookies = creds.current.cookies;
    return sdk.oauthCookies;
  };
  const requests = [];
  function respond(handler) {
    t.mock.method(globalThis, 'fetch', async (request) => {
      const url = new URL(request.url);
      const seen = { method: request.method, path: url.pathname, cookie: request.headers.get('Cookie'),
        authorization: request.headers.get('Authorization'), userToken: request.headers.get('X-UserToken'), request };
      requests.push(seen);
      return handler(seen, requests);
    });
  }
  const verify = user => new Response(JSON.stringify({ result: user ? [{ user_name: user }] : [] }), { status: 200 });
  return { sdk, creds, recovery, requests, respond, verify, warms: () => warms };
}

test('a stale cookie is replaced once, then the read is retried exactly once', async t => {
  const h = harness(t);
  h.respond((seen) => {
    if (seen.path === '/api/now/table/sys_user') {
      assert.equal(seen.cookie, 'JSESSIONID=fresh', 'verification must use the re-established session');
      return h.verify('selected-user');
    }
    if (seen.cookie === 'JSESSIONID=stale') return new Response('', { status: 401 });
    return new Response('{"result":{"success":true}}', { status: 200 });
  });
  assert.deepEqual(await h.sdk.request(`${base}/api/now/table/incident`), { result: { success: true } });
  const reads = h.requests.filter(request => request.path === '/api/now/table/incident');
  assert.deepEqual(reads.map(request => request.cookie), ['JSESSIONID=stale', 'JSESSIONID=fresh']);
  assert.equal(h.recovery.state.calls, 1);
  assert.equal(h.warms(), 2, 'the stale session must be invalidated before rebuilding');
});

test('failed recovery never replays the request', async t => {
  const recovery = recoveryProvider();
  recovery.recover = async () => { recovery.state.calls++; return false; };
  const h = harness(t, { recovery });
  h.respond(() => new Response('', { status: 401 }));
  await assert.rejects(h.sdk.request(`${base}/api/now/table/incident`), error => {
    assert.equal(error, recovery.error);
    return true;
  });
  assert.equal(h.requests.length, 1);
});

test('revoked credentials produce one actionable error and no replay', async t => {
  const recovery = recoveryProvider();
  recovery.recover = async () => { recovery.state.calls++; throw recovery.error; };
  const h = harness(t, { recovery });
  h.respond(() => new Response(secrets.join(' '), { status: 401 }));
  await assert.rejects(h.sdk.request(`${base}/api/now/table/incident`), error => {
    assert.equal(error.code, 'auth_error');
    assert.equal(error.profile, 'selected');
    assert.match(error.hint, /jsn auth refresh --profile selected/);
    for (const secret of secrets) assert.ok(!error.message.includes(secret));
    return true;
  });
  assert.equal(h.requests.length, 1);
});

test('a second rejection after a successful recovery is final (one replay bound)', async t => {
  const h = harness(t);
  h.respond(seen => seen.path === '/api/now/table/sys_user'
    ? h.verify('selected-user')
    : new Response('', { status: 401 }));
  await assert.rejects(h.sdk.request(`${base}/api/now/table/incident`), { code: 'auth_error' });
  assert.equal(h.requests.filter(request => request.path === '/api/now/table/incident').length, MAX_SESSION_REPLAYS + 1);
  assert.equal(h.recovery.state.calls, 1, 'a failed replay must not trigger another recovery');
});

test('concurrent rejections share a single recovery instead of a storm', async t => {
  const recovery = recoveryProvider();
  const h = harness(t, { recovery });
  let stale = 0;
  let releaseRecovery;
  const gate = new Promise(resolve => { releaseRecovery = resolve; });
  recovery.recover = async rejection => {
    recovery.state.calls++;
    recovery.state.rejections.push(rejection);
    await gate;
    h.creds.current.cookies = 'JSESSIONID=fresh';
    return true;
  };
  h.respond(seen => {
    if (seen.path === '/api/now/table/sys_user') return h.verify('selected-user');
    if (seen.cookie === 'JSESSIONID=stale') {
      stale++;
      if (stale === 5) releaseRecovery();
      return new Response('', { status: 401 });
    }
    return new Response('{"result":[]}', { status: 200 });
  });
  const results = await Promise.all(Array.from({ length: 5 }, (_, index) =>
    h.sdk.request(`${base}/api/now/table/incident?sysparm_limit=${index}`)));
  assert.equal(results.length, 5);
  assert.equal(recovery.state.calls, 1);
  const reads = h.requests.filter(request => request.path === '/api/now/table/incident');
  assert.equal(reads.length, 10);
  assert.equal(reads.filter(request => request.cookie === 'JSESSIONID=fresh').length, 5);
  assert.equal(h.requests.filter(request => request.path === '/api/now/table/sys_user').length, 1);
});

test('a rejection delivered after another request rotated the session replays without a second recovery', async t => {
  const h = harness(t);
  let releaseStale;
  const staleResponse = new Promise(resolve => { releaseStale = resolve; });
  h.respond(async seen => {
    if (seen.path === '/api/now/table/sys_user') return h.verify('selected-user');
    if (seen.cookie === 'JSESSIONID=stale') {
      // The second request was sent with the old session; hold its rejection
      // until the first request has already recovered.
      if (seen.path.endsWith('/second')) await staleResponse;
      return new Response('', { status: 401 });
    }
    return new Response('{"result":[]}', { status: 200 });
  });
  const first = h.sdk.request(`${base}/api/now/table/first`);
  const second = h.sdk.request(`${base}/api/now/table/second`);
  await first;
  releaseStale();
  await second;
  assert.equal(h.recovery.state.calls, 1);
  const secondReads = h.requests.filter(request => request.path === '/api/now/table/second');
  assert.deepEqual(secondReads.map(request => request.cookie), ['JSESSIONID=stale', 'JSESSIONID=fresh']);
});

for (const [label, response, expected] of [
  ['401', () => new Response('', { status: 401 }), 401],
  ['login page', () => new Response(loginPage, { status: 200, headers: { 'content-type': 'text/html' } }), 200],
  ['login redirect', () => new Response('', { status: 302, headers: { location: '/login.do?sysparm_referer=home' } }), 302],
]) {
  test(`a ${label} on a read recovers and replays once`, async t => {
    const h = harness(t);
    let reads = 0;
    h.respond(seen => {
      if (seen.path === '/api/now/table/sys_user') return h.verify('selected-user');
      reads++;
      return reads === 1 ? response() : new Response('{"result":[]}', { status: 200 });
    });
    assert.deepEqual(await h.sdk.request(`${base}/api/now/table/incident`), { result: [] });
    assert.equal(reads, 2);
    assert.equal(h.recovery.state.calls, 1);
    assert.equal(h.recovery.state.rejections[0].status, expected);
  });
}

test('a write rejected with 401 is a definitive pre-execution rejection and replays once', async t => {
  const h = harness(t);
  const writes = [];
  h.respond(seen => {
    if (seen.path === '/api/now/table/sys_user') return h.verify('selected-user');
    writes.push(seen);
    return writes.length === 1 ? new Response('', { status: 401 }) : new Response('{"result":{"sys_id":"abc"}}');
  });
  assert.deepEqual(await h.sdk.create('incident', { short_description: 'value' }), { sys_id: 'abc' });
  assert.equal(writes.length, 2);
  assert.deepEqual(writes.map(write => write.cookie), ['JSESSIONID=stale', 'JSESSIONID=fresh']);
});

test('a write answered with a login page is refused, never replayed', async t => {
  const h = harness(t);
  h.respond(() => new Response(loginPage, { status: 200, headers: { 'content-type': 'text/html' } }));
  await assert.rejects(
    h.sdk.rawRequest(`${base}/sys.scripts.do`, { method: 'POST', body: 'script=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }),
    error => {
      assert.equal(error.code, 'auth_error');
      assert.match(error.message, /POST \/sys\.scripts\.do/);
      assert.match(error.message, /not replayed/);
      assert.equal(error.profile, 'selected');
      assert.match(error.hint, /jsn auth refresh --profile selected/);
      assert.ok(!error.message.includes('user_password'), 'the login page body must never be echoed');
      return true;
    },
  );
  assert.equal(h.requests.length, 1);
  assert.equal(h.recovery.state.calls, 0, 'an unsafe replay must not renew the session first');
});

test('recovery refuses to continue when the new session belongs to another account', async t => {
  const h = harness(t);
  h.respond(seen => seen.path === '/api/now/table/sys_user'
    ? h.verify('someone-else')
    : new Response('', { status: 401 }));
  await assert.rejects(h.sdk.request(`${base}/api/now/table/incident`), error => {
    assert.equal(error.code, 'auth_error');
    assert.match(error.message, /different account/);
    assert.equal(error.profile, 'selected');
    assert.ok(!error.message.includes('someone-else'), 'the other account must not be disclosed');
    return true;
  });
  assert.equal(h.requests.filter(request => request.path === '/api/now/table/incident').length, 1);
});

test('recovery never falls back to a bearer-only probe for a cookie session', async t => {
  const h = harness(t);
  h.respond(seen => seen.path === '/api/now/table/sys_user'
    ? (() => {
      assert.equal(seen.cookie, 'JSESSIONID=fresh');
      assert.equal(seen.authorization, null);
      assert.ok(seen.method === 'GET');
      return h.verify('selected-user');
    })()
    : new Response('', { status: 401 }));
  await assert.rejects(h.sdk.request(`${base}/api/now/table/incident`));
  assert.equal(h.requests.filter(request => request.path === '/api/now/table/sys_user').length, 1);
});

test('recovery redirects, login-page verification and provider guidance stay bounded and secret-free', async t => {
  const h = harness(t);
  h.respond(seen => seen.path === '/api/now/table/sys_user'
    ? new Response(secrets.join(' '), { status: 401 })
    : new Response('', { status: 401 }));
  await assert.rejects(h.sdk.request(`${base}/api/now/table/incident`), error => {
    assert.equal(error.code, 'auth_error');
    assert.match(error.message, /could not|Session recovery failed/);
    for (const secret of secrets) {
      assert.ok(!error.message.includes(secret));
      assert.ok(!String(error.hint).includes(secret));
    }
    return true;
  });
  assert.equal(h.requests.filter(request => request.path === '/api/now/table/incident').length, 1);
});

test('401 recovery passes the rejection kind and never attempts a login request itself', async t => {
  const h = harness(t);
  h.respond(seen => {
    if (seen.path === '/api/now/table/sys_user') return h.verify('selected-user');
    if (seen.path.includes('login')) assert.fail('SDK must not perform a login request');
    return seen.cookie === 'JSESSIONID=stale' ? new Response('', { status: 401 }) : new Response('{"result":[]}');
  });
  await h.sdk.request(`${base}/api/now/table/incident`);
  assert.deepEqual(h.recovery.state.rejections.map(rejection => rejection.kind), ['http_401']);
});

test('a non-renewable browser session reports recapture instead of a retry hint', async () => {
  const app = {
    auth: { getCredentialsFor: async () => ({ auth_method: 'gck', username: 'selected-user' }) },
  };
  const recovery = createAuthRecovery({
    app,
    session: { instance: base, profileName: 'selected', username: 'selected-user', profile: { auth_method: 'gck', reauth: 'never' } },
    canInteract: () => true,
  });
  await assert.rejects(recovery.recover({ status: 401, kind: 'http_401' }), error => {
    assert.equal(error.code, 'auth_error');
    assert.equal(error.profile, 'selected');
    assert.equal(error.recapture_required, true);
    assert.equal(error.recovery, 'jsn auth refresh --profile selected --browser');
    assert.match(error.message, /browser session/);
    assert.match(error.message, /cannot be renewed/);
    assert.match(error.hint, /Recapture the browser session/);
    return true;
  });
});

test('classification keeps ordinary failures out of recovery', () => {
  assert.equal(classifyAuthRejection(new Response('', { status: 403 })), null);
  assert.equal(classifyAuthRejection(new Response('', { status: 500 })), null);
  assert.equal(classifyAuthRejection(new Response('{}', { status: 200 })), null);
  assert.equal(classifyAuthRejection(null), null);
  assert.equal(classifyAuthRejection(new Response(loginPage, { status: 200, headers: { 'content-type': 'text/html' } }),
    { bodyText: loginPage })?.kind, 'login_page');
  assert.equal(isLoginPage('text/html', '<input name="user_name">'), false, 'one lone field is not a login page');
  assert.equal(isLoginPage('application/json', '{"name":"user_name"}'), false);
});

test('replay eligibility is explicit per operation', () => {
  const kind = { kind: 'login_page', status: 200 };
  assert.equal(canReplayAfterRecovery({ kind: 'http_401' }, { method: 'DELETE' }), true);
  assert.equal(canReplayAfterRecovery(kind, { method: 'GET' }), true);
  assert.equal(canReplayAfterRecovery(kind, { method: 'POST' }), false);
  assert.equal(canReplayAfterRecovery(kind, { method: 'POST', allowMutationReplay: true }), true);
});
