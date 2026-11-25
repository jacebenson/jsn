import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SDKClient } from '../src/sdk.js';
import { errAPI } from '../src/errors.js';
import { elevationHint, authMethodCarriesSession } from '../src/security-authoring.js';

const base = 'This is an authorization/ACL/role problem, not a login problem. Check access to this endpoint.';

test('elevation guidance depends on whether the credential family has a session', () => {
  assert.equal(authMethodCarriesSession('gck'), true);
  assert.equal(authMethodCarriesSession('basic'), false);
  assert.equal(authMethodCarriesSession(''), false);

  const gck = elevationHint('gck');
  assert.match(gck, /captured/);
  assert.match(gck, /jsn auth login --gck/);

  const basic = elevationHint('basic');
  assert.match(basic, /cannot carry it/);
  assert.match(basic, /jsn auth login --gck/);

  assert.equal(elevationHint(''), '');
});

test('a 403 without request context keeps the existing wording', () => {
  const error = errAPI(403, 'denied');
  assert.equal(error.code, 'forbidden');
  assert.equal(error.status, 403);
  assert.equal(error.message, 'Access forbidden (HTTP 403).');
  assert.equal(error.hint, base);
});

test('a 403 on a mutation names the elevation boundary for the profile', () => {
  const basic = errAPI(403, 'denied', { authMethod: 'basic', mutation: true });
  assert.ok(basic.hint.startsWith(base));
  assert.match(basic.hint, /basic credential JSN sends/);

  const gck = errAPI(403, 'denied', { authMethod: 'gck', mutation: true });
  assert.ok(gck.hint.startsWith(base));
  assert.match(gck.hint, /browser session/);
});

test('a 403 on a read stays terse even with an auth method', () => {
  assert.equal(errAPI(403, 'denied', { authMethod: 'basic', mutation: false }).hint, base);
});

test('SDK 403s carry the profile auth method for mutations only', async (t) => {
  const sdk = new SDKClient('https://example.invalid', {}, { timeout: 20 });
  sdk._setAuth = async () => { sdk._authMethod = 'basic'; };
  t.mock.method(globalThis, 'fetch', async () => new Response('denied', { status: 403 }));

  await assert.rejects(
    sdk.request('https://example.invalid/api/now/table/sys_security_acl', { method: 'POST', body: '{}' }),
    (error) => error.status === 403 && /cannot carry it/.test(error.hint),
  );
  await assert.rejects(
    sdk.request('https://example.invalid/api/now/table/sys_security_acl'),
    (error) => error.status === 403 && error.hint === base,
  );
});
