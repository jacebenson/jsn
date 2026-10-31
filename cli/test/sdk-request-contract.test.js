import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SDKClient } from '../src/sdk.js';

function client() {
  return new SDKClient('https://example.invalid', {}, { domain: 'domain-id', timeout: 20 });
}

test('request variants retain distinct headers, bootstrap policy and response shapes', async (t) => {
  const sdk = client();
  const requests = [], authOptions = [];
  sdk._setAuth = async (request, options) => { authOptions.push(options); request.headers.set('Authorization', 'fixture'); };
  t.mock.method(globalThis, 'fetch', async (request) => {
    requests.push(request);
    return new Response('{"result":[]}', { status: 200 });
  });
  assert.deepEqual(await sdk.request('https://example.invalid/json', { method: 'POST', body: '{}' }), { result: [] });
  assert.equal(await sdk.rawRequest('https://example.invalid/form', { method: 'POST', body: 'x=y' }), '{"result":[]}');
  assert.ok(await sdk.fetchResponse('https://example.invalid/raw') instanceof Response);
  assert.equal(requests[0].headers.get('Accept'), 'application/json');
  assert.equal(requests[0].headers.get('Content-Type'), 'application/json');
  assert.equal(requests[0].headers.get('X-Now-Domain'), 'domain-id');
  assert.equal(requests[1].headers.get('Content-Type'), 'application/x-www-form-urlencoded');
  assert.equal(requests[1].headers.get('X-Now-Domain'), null);
  assert.equal(requests[2].headers.get('Accept'), null);
  assert.deepEqual(authOptions, [{ skipOAuthSession: false }, { skipOAuthSession: false }, { skipOAuthSession: true }]);
});

test('text and JSON requests reject API errors while raw responses remain inspectable', async (t) => {
  const sdk = client();
  sdk._setAuth = async () => {};
  t.mock.method(globalThis, 'fetch', async () => new Response('denied', { status: 403 }));
  for (const method of ['request', 'rawRequest']) {
    await assert.rejects(sdk[method]('https://example.invalid'), (error) => error.status === 403 && error.code === 'forbidden');
  }
  assert.equal((await sdk.fetchResponse('https://example.invalid')).status, 403);
});

test('JSON and text timeouts include consuming the body, raw-response timers end at headers', async (t) => {
  const sdk = client();
  sdk._setAuth = async () => {};
  const signals = [];
  t.mock.method(globalThis, 'fetch', async (request) => {
    signals.push(request.signal);
    return {
      ok: true, status: 200,
      text: () => new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
      }),
    };
  });
  for (const method of ['request', 'rawRequest']) {
    await assert.rejects(sdk[method]('https://example.invalid'), /Request timed out/);
  }
  await sdk.fetchResponse('https://example.invalid');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(signals.map((signal) => signal.aborted), [true, true, false]);
});

test('raw responses preserve unnormalized transport errors', async (t) => {
  const sdk = client();
  sdk._setAuth = async () => {};
  const failure = Object.assign(new Error('fixture'), { code: 'ECONNREFUSED' });
  t.mock.method(globalThis, 'fetch', async () => { throw failure; });
  await assert.rejects(sdk.fetchResponse('https://example.invalid'), (error) => error === failure);
  for (const method of ['request', 'rawRequest']) {
    await assert.rejects(sdk[method]('https://example.invalid'), (error) => error.code === 'network_error');
  }
});
