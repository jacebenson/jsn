import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { SDKClient } from '../src/sdk.js';
const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64');
async function fixture(handler, options = {}) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const call = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
    calls.push(call);
    const response = await handler(call, calls.length);
    res.writeHead(response.status || 200, { 'Content-Type': 'application/json' });
    res.end(response.body === undefined ? '' : JSON.stringify(response.body));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let touches = 0;
  const sdk = new SDKClient(`http://127.0.0.1:${server.address().port}`, {
    getCredentials: () => options.credentials || { auth_method: 'oauth', access_token: 'fixture-token' },
    touchLastSeen: () => { touches++; },
  }, { domain: 'fixture-domain', ...options });
  sdk._warmSession = async () => null;
  return { sdk, calls, touches: () => touches, close: () => new Promise(resolve => server.close(resolve)) };
}
function success(call) {
  return { body: { batch_request_id: call.body.batch_request_id,
    serviced_requests: call.body.rest_requests.map(item => ({ id: item.id, status_code: 200, body: encoded({ result: item.id }) })), unserviced_requests: [] } };
}
it('uses documented POST envelope, correlates unordered responses, and preserves partial failures without replay', async () => {
  const f = await fixture(call => ({ body: { batch_request_id: call.body.batch_request_id,
    serviced_requests: [
      { id: 'denied', status_code: 403, body: encoded({ error: { message: 'ACL denied' } }) },
      { id: 'read', status_code: 200, body: encoded({ result: { sys_id: 'record' } }) },
      { id: 'unauthorized', status_code: 401, body: encoded({ error: { message: 'Unauthorized' } }) },
    ], unserviced_requests: ['limited'] } }));
  try {
    const result = await f.sdk.batch(['read', 'denied', 'limited', 'unauthorized', 'missing'].map(id => ({ id, url: '/api/now/table/incident' })));
    assert.deepEqual(result.results.map(item => item.id), ['read', 'denied', 'limited', 'unauthorized', 'missing']);
    assert.equal(result.results[0].data.result.sys_id, 'record');
    assert.equal(result.results[1].status, 403); assert.equal(result.results[1].error.code, 'forbidden');
    assert.equal(result.results[2].error.code, 'batch_unserviced'); assert.equal(result.results[2].serviced, false);
    assert.equal(result.results[3].status, 401); assert.equal(result.results[4].serviced, null);
    assert.deepEqual(result.counts, { total: 5, successful: 1, failed: 4 });
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, '/api/now/v1/batch');
    assert.equal(f.calls[0].headers.authorization, 'Bearer fixture-token');
    assert.equal(f.calls[0].body.rest_requests[0].headers.find(item => item.name.toLowerCase() === 'x-now-domain').value, 'fixture-domain');
    assert.equal(f.touches(), 0);
  } finally { await f.close(); }
});
for (const status of [404, 405, 501]) {
  it(`falls back only for unsupported batch endpoint (${status}), preserves read statuses, and caches support`, async () => {
    const f = await fixture(call => call.method === 'POST' ? { status, body: { error: 'unsupported' } }
      : call.url.endsWith('/denied') ? { status: 403, body: { error: { message: 'ACL denied' } } } : { body: { result: 'record' } });
    try {
      const result = await f.sdk.batch([{ id: 'ok', url: '/api/now/table/incident' }, { id: 'bad', url: '/api/now/table/incident/denied' }]);
      assert.equal(result.transport, 'individual'); assert.equal(result.results[0].status, 200); assert.equal(result.results[1].status, 403);
      await f.sdk.batch([{ url: '/api/now/table/incident' }]);
      assert.equal(f.calls.filter(call => call.method === 'POST').length, 1); assert.equal(f.touches(), 0);
    } finally { await f.close(); }
  });
}
for (const status of [401, 403, 429, 500]) {
  it(`does not hide outer HTTP ${status} behind individual fallback`, async () => {
    const f = await fixture(() => ({ status, body: { error: { message: 'Rejected' } } }));
    try { await assert.rejects(f.sdk.batch([{ url: '/api/now/table/incident' }]), error => error.status === status); assert.equal(f.calls.length, 1); }
    finally { await f.close(); }
  });
}
it('can disable fallback and chunks explicitly without changing ordinary requests', async () => {
  const f = await fixture(success);
  try {
    const result = await f.sdk.batch(Array.from({ length: 5 }, (_, id) => ({ id, url: '/api/now/table/incident' })), { chunkSize: 2 });
    assert.equal(result.counts.successful, 5); assert.deepEqual(f.calls.map(call => call.body.rest_requests.length), [2, 2, 1]);
    assert.deepEqual(result.results.map(item => item.id), ['0', '1', '2', '3', '4']);
    assert.deepEqual(await f.sdk.batch([]), { transport: 'none', results: [], counts: { total: 0, successful: 0, failed: 0 } });
  } finally { await f.close(); }
  const unsupported = await fixture(() => ({ status: 404 }));
  try { await assert.rejects(unsupported.sdk.batch([{ url: '/api/now/table/incident' }], { fallback: false }), error => error.status === 404); assert.equal(unsupported.calls.length, 1); }
  finally { await unsupported.close(); }
});
it('validates all requests before sending any, rejects writes, cross-instance URLs and auth overrides', async () => {
  const f = await fixture(success);
  try {
    for (const requests of [
      [{ url: '/api/now/table/incident', method: 'POST' }], [{ url: '/api/now/table/incident', body: '' }],
      [{ url: 'https://other.invalid/api/now/table/incident' }], [{ url: '/api/now/table/incident', headers: { Authorization: 'bad' } }],
      [{ url: '/api/now/v1/batch' }], [{ id: 'same', url: '/api/now/table/incident' }, { id: 'same', url: '/api/now/table/incident' }],
      [{ url: '/api/now/table/incident' }, { url: '/not-an-api' }],
    ]) await assert.rejects(f.sdk.batch(requests), { code: 'usage_error' });
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
it('malformed envelopes never replay; malformed bodies remain per-item failures', async () => {
  const f = await fixture(call => ({ body: { batch_request_id: call.body.batch_request_id,
    serviced_requests: [{ id: 'a', status_code: 200, body: '@invalid' }], unserviced_requests: [] } }));
  try {
    const result = await f.sdk.batch([{ id: 'a', url: '/api/now/table/incident' }]);
    assert.equal(result.results[0].error.code, 'malformed_response'); assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
  const malformed = await fixture(() => ({ body: { serviced_requests: [], unserviced_requests: [] } }));
  try { await assert.rejects(malformed.sdk.batch([{ url: '/api/now/table/incident' }]), { code: 'malformed_response' }); assert.equal(malformed.calls.length, 1); }
  finally { await malformed.close(); }
});
it('preserves JSON, text and empty item bodies', async () => {
  const f = await fixture(call => ({ body: { batch_request_id: call.body.batch_request_id, serviced_requests: [
    { id: 'json', status_code: 200, body: encoded({ result: [1] }) },
    { id: 'xml', status_code: 200, body: Buffer.from('<result/>').toString('base64') },
    { id: 'empty', status_code: 204, body: '' },
  ], unserviced_requests: [] } }));
  try {
    const result = await f.sdk.batch(['json', 'xml', 'empty'].map(id => ({ id, url: '/api/now/table/incident' })));
    assert.deepEqual(result.results.map(item => item.data), [{ result: [1] }, '<result/>', null]);
  } finally { await f.close(); }
});
it('uses normal auth recovery only for a definitive outer rejection', async () => {
  let recoveries = 0;
  const f = await fixture((call, index) => index === 1 ? { status: 401 } : success(call), { recovery: {
    recover: async () => { recoveries++; return true; },
  } });
  try {
    const result = await f.sdk.batch([{ url: '/api/now/table/incident' }]);
    assert.equal(result.counts.successful, 1); assert.equal(recoveries, 1); assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].body.batch_request_id, f.calls[1].body.batch_request_id);
  } finally { await f.close(); }
});
for (const credentials of [
  { auth_method: 'basic', username: 'fixture', password: 'fixture-password' },
  { auth_method: 'gck', access_token: 'fixture-csrf', cookies: 'fixture=session' },
]) {
  it(`uses existing ${credentials.auth_method} auth for batch and does not embed auth in subrequests`, async () => {
    const f = await fixture(success, { credentials });
    try {
      await f.sdk.batch([{ url: '/api/now/table/incident' }]);
      assert.ok(f.calls[0].headers.authorization || f.calls[0].headers['x-usertoken']);
      assert.equal(f.calls[0].body.rest_requests[0].headers.some(item => /authorization|cookie|x-usertoken/i.test(item.name)), false);
    } finally { await f.close(); }
  });
}
it('does not replay timed-out aggregate reads or infer success from duplicate response IDs', async () => {
  const slow = await fixture(async call => { await new Promise(resolve => setTimeout(resolve, 80)); return success(call); });
  try {
    await assert.rejects(slow.sdk.batch([{ url: '/api/now/table/incident' }], { timeout: 20 }), { code: 'network_error' });
    assert.ok(slow.calls.length <= 1);
  } finally { await slow.close(); }
  const duplicate = await fixture(call => {
    const response = success(call); response.body.serviced_requests.push(response.body.serviced_requests[0]); return response;
  });
  try {
    await assert.rejects(duplicate.sdk.batch([{ url: '/api/now/table/incident' }]), { code: 'malformed_response' });
    assert.equal(duplicate.calls.length, 1);
  } finally { await duplicate.close(); }
});
