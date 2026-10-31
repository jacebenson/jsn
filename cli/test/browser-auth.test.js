import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readBrowserSession, closeLoginBrowser } from '../src/browser-auth.js';
import { AuthManager } from '../src/auth.js';
import { validateLoginSelectors } from '../src/commands/auth.js';

const instance = 'https://example.service-now.com';
const token = 'fixture-user-token';
const calls = [];
let closed;
const originalWebSocket = globalThis.WebSocket;

function browserFixture({ tabs, origin = instance, cookies = [{ name: 'JSESSIONID', value: 'fixture-cookie', httpOnly: true }], userToken = token, protocolError = false, closeBeforeOpen = false, noReply = false, changedOrigin = false } = {}) {
  calls.length = 0;
  closed = false;
  mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), options });
    return Response.json(tabs || [{ type: 'page', url: `${instance}/now/nav/ui/classic`, webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/1' }]);
  });
  class BrowserSocket extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event(closeBeforeOpen ? 'close' : 'open')));
    }
    send(data) {
      const request = JSON.parse(data);
      calls.push(request);
      if (noReply) return;
      const result = request.method === 'Network.getCookies' ? { cookies }
        : { result: { value: request.params.expression === 'location.origin' ? (changedOrigin ? 'https://other.example' : origin) : { origin, token: userToken } } };
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify(protocolError ? { id: request.id, error: { message: 'SECRET_PROVIDER_ERROR' } } : { id: request.id, result }),
      })));
    }
    close() { closed = true; this.dispatchEvent(new Event('close')); }
  }
  globalThis.WebSocket = BrowserSocket;
}

afterEach(() => { mock.restoreAll(); globalThis.WebSocket = originalWebSocket; });

it('imports only the matching origin cookies and token, then closes its connection', async () => {
  browserFixture();
  assert.deepEqual(await readBrowserSession(instance), {
    auth_method: 'gck', access_token: token, cookies: 'JSESSIONID=fixture-cookie', auth_source: 'gck',
  });
  assert.equal(closed, true);
  assert.equal(calls[0].url, 'http://127.0.0.1:9222/json/list');
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(calls.find(c => c.method === 'Network.getCookies').params, { urls: [`${instance}/api/now/table/sys_user`] });
});

it('rejects remote endpoints and credential-bearing URLs before contacting them', async () => {
  browserFixture();
  for (const browserUrl of ['http://example.com:9222', 'http://127.0.0.1.evil.test:9222', 'http://user:pass@localhost:9222', 'http://localhost:9222/path']) {
    await assert.rejects(readBrowserSession(instance, { browserUrl }), /loopback|must be an origin/);
  }
  assert.equal(calls.length, 0);
});

it('requires one exact-origin page instead of choosing an account implicitly', async () => {
  browserFixture({ tabs: [{ type: 'page', url: `${instance}.evil.test` }] });
  await assert.rejects(readBrowserSession(instance), /No matching/);
  mock.restoreAll();
  browserFixture({ tabs: [1, 2].map(id => ({ type: 'page', url: `${instance}/?id=${id}` })) });
  await assert.rejects(readBrowserSession(instance), /Multiple tabs/);
});

it('rejects a debugging websocket outside the selected endpoint', async () => {
  browserFixture({ tabs: [{ type: 'page', url: instance, webSocketDebuggerUrl: 'ws://127.0.0.1:9999/devtools/page/1' }] });
  await assert.rejects(readBrowserSession(instance), /outside the selected endpoint/);
});

it('does not read cookies if the tab has changed origin or has no token', async () => {
  browserFixture({ origin: 'https://other.example' });
  await assert.rejects(readBrowserSession(instance), /No user token/);
  assert.equal(calls.some(c => c.method === 'Network.getCookies'), false);
  assert.equal(closed, true);
  mock.restoreAll();
  browserFixture({ userToken: '' });
  await assert.rejects(readBrowserSession(instance), /No user token/);
});

it('redacts protocol errors and always closes the connection', async () => {
  browserFixture({ protocolError: true });
  await assert.rejects(readBrowserSession(instance), error => !error.message.includes('SECRET_PROVIDER_ERROR'));
  assert.equal(closed, true);
});

it('validates the imported current user before saving under its identity', async () => {
  browserFixture();
  const discovery = globalThis.fetch;
  mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).includes('/json/list')) return discovery(url, options);
    const query = new URL(url).searchParams;
    assert.equal(query.get('sysparm_query'), 'user_name=javascript:gs.getUserName()');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Cookie, 'JSESSIONID=fixture-cookie');
    return Response.json({ result: [{ user_name: 'fixture-user' }] });
  });
  const saves = [];
  const auth = new AuthManager({ getUsername: () => 'other-active-user' }, {
    credentialStore: { save: (...args) => saves.push(args) },
  });
  await auth.loginWithBrowser(instance, {}, 'fixture-user');
  assert.equal(saves.length, 1);
  assert.equal(saves[0][2], 'fixture-user');
  await assert.rejects(auth.loginWithBrowser(instance, {}, 'wrong-profile-user'), /does not match/);
  assert.equal(saves.length, 1);
});

it('does not persist a successful response with no verifiable current user', async () => {
  browserFixture();
  const discovery = globalThis.fetch;
  mock.method(globalThis, 'fetch', async (url, options) => String(url).includes('/json/list')
    ? discovery(url, options) : Response.json({ result: [] }));
  const auth = new AuthManager({ getUsername: () => null }, {
    credentialStore: { save: () => assert.fail('must not save') },
  });
  await assert.rejects(auth.loginWithBrowser(instance), /Could not verify the browser account/);
});

it('rejects conflicting browser login selectors', () => {
  for (const args of [{ browser: true, basic: true }, { browser: true, headers: 'x' }, { browser: true, code: 'x' }, { browserUrl: 'http://localhost:9222' }]) {
    assert.throws(() => validateLoginSelectors(args));
  }
  assert.throws(() => validateLoginSelectors({ browser: true }, { auth_method: 'basic' }));
  assert.doesNotThrow(() => validateLoginSelectors({ browser: true }, { auth_method: 'gck' }));
});

it('handles a browser closing before connection and a stalled protocol response', async () => {
  browserFixture({ closeBeforeOpen: true });
  await assert.rejects(readBrowserSession(instance, { timeout: 30 }), /connection closed/);
  mock.restoreAll();
  browserFixture({ noReply: true });
  await assert.rejects(readBrowserSession(instance, { timeout: 30 }), /Timed out reading/);
  assert.equal(closed, true);
});

it('rejects navigation during import and malformed cookies', async () => {
  browserFixture({ changedOrigin: true });
  await assert.rejects(readBrowserSession(instance), /tab changed/);
  assert.equal(closed, true);
  mock.restoreAll();
  browserFixture({ cookies: [{ name: 'sid', value: 'bad\r\nheader' }] });
  await assert.rejects(readBrowserSession(instance), /invalid cookies/);
  assert.equal(closed, true);
});

it('closes the owned browser through its local browser-level connection', async () => {
  browserFixture();
  mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), 'http://127.0.0.1:9222/json/version');
    assert.equal(options.redirect, 'error');
    return Response.json({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/fixture' });
  });
  await closeLoginBrowser('http://127.0.0.1:9222');
  assert.ok(calls.some(call => call.method === 'Browser.close'));
  assert.equal(closed, true);
});

it('does not send browser shutdown to a different debugging endpoint', async () => {
  browserFixture();
  mock.method(globalThis, 'fetch', async () => Response.json({ webSocketDebuggerUrl: 'ws://127.0.0.1:9999/devtools/browser/fixture' }));
  await assert.rejects(closeLoginBrowser('http://127.0.0.1:9222'), /Unexpected login browser endpoint/);
  assert.equal(calls.some(call => call.method === 'Browser.close'), false);
});
