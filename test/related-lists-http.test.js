import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { SDKClient } from '../src/sdk.js';
import { createRelatedListReader } from '../src/related-lists.js';
for (const batched of [false, true]) {
  it(`uses real ${batched ? 'batched' : 'individual'} aggregate reads, keeps ACL gaps distinct from zero, and never retrieves related rows`, async () => {
    const calls = [], aggregateQueries = [];
    const resultFor = url => {
      aggregateQueries.push(url);
      assert.equal(url.searchParams.get('sysparm_count'), 'true');
      assert.equal(url.searchParams.get('sysparm_query'), 'parent=resolved_record^active=true');
      if (url.pathname === '/api/now/stats/task') return { status: 200, body: { result: { stats: { count: '2' } } } };
      if (url.pathname === '/api/now/stats/task_sla') return { status: 403, body: { error: { message: 'ACL denied' } } };
      return { status: 500, body: { error: 'Unexpected eager record lookup' } };
    };
    const server = createServer(async (request, response) => {
      const url = new URL(request.url, 'http://fixture'); calls.push(url);
      assert.equal(request.headers['x-usertoken'], 'fixture-token');
      if (url.pathname === '/api/now/v1/batch') {
        assert.equal(request.method, 'POST');
        let text = ''; for await (const chunk of request) text += chunk;
        const body = JSON.parse(text);
        const serviced = body.rest_requests.map(item => {
          assert.equal(item.method, 'GET');
          const result = resultFor(new URL(item.url, 'http://fixture'));
          return { id: item.id, status_code: result.status, body: Buffer.from(JSON.stringify(result.body)).toString('base64') };
        });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ batch_request_id: body.batch_request_id, serviced_requests: serviced, unserviced_requests: [] }));
      } else {
        assert.equal(request.method, 'GET'); const result = resultFor(url);
        response.writeHead(result.status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result.body));
      }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    let touches = 0;
    const sdk = new SDKClient(`http://127.0.0.1:${server.address().port}`, {
      getCredentials: () => ({ auth_method: 'gck', access_token: 'fixture-token' }),
      touchLastSeen: () => { touches++; },
    });
    if (!batched) sdk.batch = undefined;
    const reader = createRelatedListReader(sdk, { metadataReader: { read: async () => ({
      related_lists: ['task', 'task_sla'].map(table => ({ id: `${table}.parent`, table, reference_field: 'parent', query_status: 'reference', filter: 'active=true' })),
      coverage: { state: 'observed', warnings: [] },
    }) } });
    try {
      const output = await reader.read({ table: 'incident', recordId: 'resolved_record' });
      assert.equal(output.lists[0].count, 2); assert.equal(output.lists[1].count, null);
      assert.equal(output.lists[1].http_status, 403); assert.equal(output.coverage.state, 'partial');
      assert.equal(output.nonempty.length, 1); assert.equal(calls.length, batched ? 1 : 2); assert.equal(touches, 0);
      await reader.read({ table: 'incident', recordId: 'resolved_record' }); assert.equal(calls.length, batched ? 1 : 2);
      assert.equal(aggregateQueries.length, 2); assert.ok(aggregateQueries.every(item => item.pathname.startsWith('/api/now/stats/')));
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
}
