import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { SDKClient } from '../src/sdk.js';
import { createRelatedListReader } from '../src/related-lists.js';
it('uses bounded real aggregate reads, keeps ACL gaps distinct from zero, and does not retrieve related rows', async () => {
  const calls = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture'); calls.push(url);
    assert.equal(request.method, 'GET'); assert.equal(request.headers['x-usertoken'], 'fixture-token');
    assert.equal(url.searchParams.get('sysparm_count'), 'true');
    assert.equal(url.searchParams.get('sysparm_query'), 'parent=resolved_record^active=true');
    if (url.pathname === '/api/now/stats/task') {
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ result: { stats: { count: '2' } } }));
    } else if (url.pathname === '/api/now/stats/task_sla') {
      response.writeHead(403, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'ACL denied' } }));
    } else {
      response.writeHead(500); response.end('Unexpected eager record lookup');
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let touches = 0;
  const sdk = new SDKClient(`http://127.0.0.1:${server.address().port}`, {
    getCredentials: () => ({ auth_method: 'gck', access_token: 'fixture-token' }),
    touchLastSeen: () => { touches++; },
  });
  const reader = createRelatedListReader(sdk, { metadataReader: { read: async () => ({
    related_lists: ['task', 'task_sla'].map(table => ({ id: `${table}.parent`, table, reference_field: 'parent', query_status: 'reference', filter: 'active=true' })),
    coverage: { state: 'observed', warnings: [] },
  }) } });
  try {
    const output = await reader.read({ table: 'incident', recordId: 'resolved_record' });
    assert.equal(output.lists[0].count, 2); assert.equal(output.lists[1].count, null);
    assert.equal(output.lists[1].http_status, 403); assert.equal(output.coverage.state, 'partial');
    assert.equal(output.nonempty.length, 1); assert.equal(calls.length, 2); assert.equal(touches, 0);
    await reader.read({ table: 'incident', recordId: 'resolved_record' }); assert.equal(calls.length, 2);
    assert.ok(calls.every(url => url.pathname.startsWith('/api/now/stats/')));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
