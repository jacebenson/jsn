// Local loopback fixture only: the real SDK and related reader use HTTP, while
// metadata descriptors are supplied in memory (not included in measurements).
import { createServer } from 'node:http';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { SDKClient } from '../../src/sdk.js';
import { createRelatedListReader } from '../../src/related-lists.js';

export async function measureRelatedReads({ mode, descriptors = 60, delayMs = 0 }) {
  const calls = [], operations = [];
  let active = 0, peak = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    calls.push({ method: request.method, path: url.pathname });
    active++; peak = Math.max(peak, active);
    response.setHeader('Content-Type', 'application/json');
    try {
      if (delayMs) await delay(delayMs);
      if (url.pathname === '/api/now/v1/batch') {
        if (mode === 'unsupported') { response.writeHead(404); response.end('{}'); return; }
        let text = ''; for await (const chunk of request) text += chunk;
        const batch = JSON.parse(text);
        const serviced = batch.rest_requests.map(item => {
          operations.push({ method: item.method, path: new URL(item.url, 'http://fixture.invalid').pathname });
          return { id: item.id, status_code: 200, body: Buffer.from(JSON.stringify({ result: { stats: { count: '1' } } })).toString('base64') };
        });
        response.end(JSON.stringify({ batch_request_id: batch.batch_request_id, serviced_requests: serviced.reverse(), unserviced_requests: [] }));
      } else {
        operations.push({ method: request.method, path: url.pathname });
        response.end(JSON.stringify({ result: { stats: { count: '1' } } }));
      }
    } finally { active--; }
  });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const sdk = new SDKClient(`http://127.0.0.1:${server.address().port}`, {
      getCredentials: () => ({ auth_method: 'gck', access_token: 'fixture-only' }),
    });
    if (mode === 'individual') sdk.batch = undefined;
    const reader = createRelatedListReader(sdk, { metadataReader: { read: async () => ({
      related_lists: Array.from({ length: descriptors }, (_, index) => ({
        id: `x_child.parent${index}`, table: 'x_child', reference_field: `parent${index}`, query_status: 'reference', filter: '',
      })), coverage: { state: 'observed', warnings: [] },
    }) } });
    const phases = [];
    for (const recordId of ['first', 'first', 'second']) {
      const before = calls.length, operationStart = operations.length, started = performance.now();
      const result = await reader.read({ table: 'x_parent', recordId });
      phases.push({ elapsed_ms: Number((performance.now() - started).toFixed(3)), http_requests: calls.length - before,
        aggregate_operations: operations.length - operationStart, available: result.lists.filter(item => item.status === 'available').length,
        unavailable: result.lists.filter(item => item.status === 'unavailable').length, coverage: result.coverage.state });
    }
    return { mode, descriptors, delay_ms_per_http_request: delayMs, peak_http_concurrency: peak,
      phases: { cold: phases[0], cached: phases[1], other_record: phases[2] },
      batch_attempts: calls.filter(call => call.path === '/api/now/v1/batch').length,
      only_aggregate_reads: operations.every(item => item.method === 'GET' && item.path === '/api/now/stats/x_child') };
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
}
