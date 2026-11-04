// AMB / Bayeux client contract.
//
// These tests run the real HTTP client against a local mock of ServiceNow's
// /amb endpoint. They pin: the record-watcher channel encoding, handshake and
// subscribe framing, session cookie + X-UserToken handling, bounded
// long-polls, cancellation, and actionable errors for rejected sessions and
// missing AMB support. No live instance is involved.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AmbClient, AmbError, recordWatcherChannel, normalizeRecordWatcherEvent } from '../src/amb.js';

const SYS_ID = '0123456789abcdef0123456789abcdef';

/** A mock /amb endpoint driven by a per-test handler. */
async function ambServer(handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const url = new URL(request.url, 'http://fixture');
    const messages = text ? JSON.parse(text) : [];
    requests.push({ url, headers: request.headers, messages });
    await handler({ url, request, response, messages, requests });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

function sendJson(response, body, headers = {}) {
  response.writeHead(200, { 'Content-Type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

const sessions = { cookies: 'glide_session_store=abc; JSESSIONID=xyz', userToken: 'token-1' };

describe('record watcher channel', () => {
  it('encodes the encoded query as ServiceNow expects', () => {
    const channel = recordWatcherChannel('incident', `sys_id=${SYS_ID}`);
    const [, prefix, action, table, encoded] = channel.split('/');
    assert.equal(prefix, 'rw');
    assert.equal(action, 'default');
    assert.equal(table, 'incident');
    assert.ok(!encoded.includes('='), 'padding must be replaced so the channel segment stays valid');
    assert.equal(Buffer.from(encoded.replace(/-/g, '='), 'base64').toString(), `sys_id=${SYS_ID}`);
  });

  it('pads and re-decodes a query whose base64 length needs it', () => {
    const query = 'active=true^u_ab=cd';
    const channel = recordWatcherChannel('task', query);
    const encoded = channel.split('/').at(-1);
    assert.ok(encoded.includes('-'), 'padding characters become -');
    assert.equal(Buffer.from(encoded.replace(/-/g, '='), 'base64').toString(), query);
  });

  it('rejects an empty query or invalid table before any request', () => {
    assert.throws(() => recordWatcherChannel('incident', ''), /non-empty encoded query/);
    assert.throws(() => recordWatcherChannel('in cident', 'active=true'), /Invalid table/);
  });
});

describe('AMB client protocol', () => {
  it('handshakes, subscribes, and returns a normalized record event', async () => {
    const channel = recordWatcherChannel('incident', `sys_id=${SYS_ID}`);
    const server = await ambServer(({ url, messages, response }) => {
      if (url.pathname === '/amb/handshake') {
        sendJson(response, [{
          channel: '/meta/handshake', successful: true, clientId: 'client-1',
          ext: { 'glide.session.status': 'session.logged.in' },
        }], { 'Set-Cookie': 'BAYEUX_BROWSER=node-1; Path=/amb', 'X-UserToken': 'token-2' });
        return;
      }
      if (messages[0].channel === '/meta/subscribe') {
        sendJson(response, [{ channel: '/meta/subscribe', successful: true, subscription: messages[0].subscription }]);
        return;
      }
      sendJson(response, [{
        channel,
        id: 'evt-1',
        data: { table: 'incident', sys_id: SYS_ID, display_value: 'INC0010001', operation: 'update',
          changes: [{ field: 'state', value: '2', display_value: 'In Progress', previous_value: '1' }] },
      }]);
    });

    const client = new AmbClient({ baseUrl: server.baseUrl, session: async () => sessions });
    try {
      const started = await client.start([channel]);
      assert.equal(started.clientId, 'client-1');
      assert.equal(started.sessionStatus, 'session.logged.in');
      const events = await client.next({ timeoutMs: 2000 });
      assert.equal(events.length, 1);
      const normalized = normalizeRecordWatcherEvent(events[0], { table: 'incident', sysID: SYS_ID });
      assert.equal(normalized.operation, 'updated');
      assert.equal(normalized.table, 'incident');
      assert.equal(normalized.sys_id, SYS_ID);
      assert.equal(normalized.display_value, 'INC0010001');
      assert.deepEqual(normalized.changes, [
        { field: 'state', value: '2', display_value: 'In Progress', previous_value: '1' },
      ]);
      assert.equal(normalized.event_id, 'evt-1');

      // The seeded session cookies and token go out on the first handshake;
      // cookies the server sets (BAYEUX_BROWSER) and its X-UserToken are kept
      // for later requests, which is what makes subscribe authorized.
      const handshake = server.requests[0];
      assert.match(handshake.headers.cookie, /glide_session_store=abc/);
      assert.equal(handshake.headers['x-usertoken'], 'token-1');
      const subscribe = server.requests.find(r => r.messages[0].channel === '/meta/subscribe');
      assert.equal(subscribe.messages[0].subscription, channel);
      assert.match(subscribe.headers.cookie, /BAYEUX_BROWSER=node-1/);
      assert.equal(subscribe.headers['x-usertoken'], 'token-2');
    } finally {
      await server.close();
    }
  });

  it('keeps the live record-watcher payload shape (record map, no changes/sys_id)', () => {
    // Captured from dev366743 on 2026-11-04: the platform sends a `record`
    // map of changed fields plus sys_* audit fields, and omits sys_id/table.
    const normalized = normalizeRecordWatcherEvent({
      channel: '/rw/default/incident/c3lzX2lkPTcwZDViYzJlOTM5MDkzNTAxNmM4ZmQxOGRkMDNkNjI2',
      id: 'b836fc2e935c535016c8fd18dd03d611',
      data: {
        operation: 'update',
        display_value: 'INC0010004',
        record: {
          short_description: { display_value: 'probe second update', value: 'probe second update' },
          sys_updated_on: { display_value: '2026-11-04 10:00:45', value: '2026-11-04 18:00:45' },
        },
      },
    }, { table: 'incident', sysID: SYS_ID });

    assert.equal(normalized.operation, 'updated');
    assert.equal(normalized.action, 'update');
    assert.equal(normalized.sys_id, SYS_ID, 'identity comes from the subscription');
    assert.equal(normalized.table, 'incident');
    assert.equal(normalized.changes, undefined);
    assert.equal(normalized.record.short_description.value, 'probe second update');
    assert.equal(normalized.event_id, 'b836fc2e935c535016c8fd18dd03d611');
  });

  it('returns an empty batch when the long-poll hits the local timeout', async () => {
    const server = await ambServer(({ url, messages, response }) => {
      if (url.pathname === '/amb/handshake') {
        sendJson(response, [{ channel: '/meta/handshake', successful: true, clientId: 'client-1' }]);
        return;
      }
      if (messages[0].channel === '/meta/subscribe') {
        sendJson(response, [{ channel: '/meta/subscribe', successful: true }]);
        return;
      }
      // Hold the connect request like a real instance does.
    });
    const client = new AmbClient({ baseUrl: server.baseUrl, session: async () => sessions });
    try {
      await client.start([recordWatcherChannel('incident', `sys_id=${SYS_ID}`)]);
      const startedAt = Date.now();
      const events = await client.next({ timeoutMs: 150 });
      assert.deepEqual(events, []);
      assert.ok(Date.now() - startedAt < 5000, 'a bounded poll must not hang');
    } finally {
      await server.close();
    }
  });

  it('stops an in-flight long-poll with a cancelled error when the caller aborts', async () => {
    const server = await ambServer(({ url, messages, response }) => {
      if (url.pathname === '/amb/handshake') {
        sendJson(response, [{ channel: '/meta/handshake', successful: true, clientId: 'client-1' }]);
        return;
      }
      if (messages[0].channel === '/meta/subscribe') {
        sendJson(response, [{ channel: '/meta/subscribe', successful: true }]);
      }
      // /meta/connect hangs.
    });
    const client = new AmbClient({ baseUrl: server.baseUrl, session: async () => sessions });
    const controller = new AbortController();
    try {
      await client.start([recordWatcherChannel('incident', `sys_id=${SYS_ID}`)]);
      const pending = client.next({ timeoutMs: 60000, signal: controller.signal });
      setTimeout(() => controller.abort(), 50);
      await assert.rejects(pending, (error) => {
        assert.ok(error instanceof AmbError);
        assert.equal(error.cancelled, true);
        return true;
      });
    } finally {
      await server.close();
    }
  });

  it('unsubscribes and disconnects on stop', async () => {
    const channel = recordWatcherChannel('incident', `sys_id=${SYS_ID}`);
    const server = await ambServer(({ url, messages, response }) => {
      if (url.pathname === '/amb/handshake') {
        sendJson(response, [{ channel: '/meta/handshake', successful: true, clientId: 'client-1' }]);
        return;
      }
      sendJson(response, [{ channel: messages[0].channel, successful: true }]);
    });
    const client = new AmbClient({ baseUrl: server.baseUrl, session: async () => sessions });
    try {
      await client.start([channel]);
      await client.stop([channel]);
      const channels = server.requests.map(r => r.messages[0].channel);
      assert.ok(channels.includes('/meta/unsubscribe'));
      assert.ok(channels.includes('/meta/disconnect'));
      const unsubscribe = server.requests.find(r => r.messages[0].channel === '/meta/unsubscribe');
      assert.equal(unsubscribe.messages[0].subscription, channel);
    } finally {
      await server.close();
    }
  });

  it('surfaces a rejected handshake as an actionable auth error', async () => {
    const server = await ambServer(({ response }) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify([{ channel: '/meta/handshake', successful: false, error: '403::Unknown client' }]));
    });
    const client = new AmbClient({ baseUrl: server.baseUrl, session: async () => sessions });
    try {
      await assert.rejects(client.start([]), (error) => {
        assert.equal(error.code, 'auth_error');
        assert.equal(error.fatal, true);
        assert.match(error.message, /handshake/);
        assert.match(error.hint, /auth login --browser/);
        return true;
      });
    } finally {
      await server.close();
    }
  });

  it('explains a missing /amb endpoint instead of retrying forever', async () => {
    const server = await ambServer(({ response }) => {
      response.writeHead(404, { 'Content-Type': 'text/html' });
      response.end('<html>not found</html>');
    });
    const client = new AmbClient({ baseUrl: server.baseUrl, session: async () => sessions });
    try {
      await assert.rejects(client.start([]), (error) => {
        assert.equal(error.code, 'api_error');
        assert.equal(error.fatal, true);
        assert.match(error.message, /AMB endpoint not found/);
        assert.match(error.hint, /\/amb/);
        return true;
      });
    } finally {
      await server.close();
    }
  });

  it('reports a refused subscription with the channel and access guidance', async () => {
    const channel = recordWatcherChannel('incident', `sys_id=${SYS_ID}`);
    const server = await ambServer(({ url, messages, response }) => {
      if (url.pathname === '/amb/handshake') {
        sendJson(response, [{ channel: '/meta/handshake', successful: true, clientId: 'client-1' }]);
        return;
      }
      assert.equal(messages[0].channel, '/meta/subscribe');
      sendJson(response, [{ channel: '/meta/subscribe', successful: false, error: '404::message_deleted' }]);
    });
    const client = new AmbClient({ baseUrl: server.baseUrl, session: async () => sessions });
    try {
      await assert.rejects(client.start([channel]), (error) => {
        assert.equal(error.code, 'api_error');
        assert.match(error.message, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(error.hint, /accessible|enabled/);
        return true;
      });
    } finally {
      await server.close();
    }
  });

  it('refuses to start without session cookies instead of sending an unauthorized handshake', async () => {
    let contacted = false;
    const client = new AmbClient({
      baseUrl: 'http://127.0.0.1:1',
      session: async () => ({ cookies: '', userToken: '' }),
      fetchImpl: async () => { contacted = true; throw new Error('should not be called'); },
    });
    await assert.rejects(client.start([]), (error) => {
      assert.equal(error.code, 'auth_error');
      assert.match(error.hint, /UI session/);
      return true;
    });
    assert.equal(contacted, false);
  });
});

describe('normalizeRecordWatcherEvent', () => {
  it('keeps unknown notification shapes honest', () => {
    const event = normalizeRecordWatcherEvent({ channel: '/rw/default/task/abc', data: { foo: 'bar' } }, {}, '2026-11-04T00:00:00.000Z');
    assert.equal(event.operation, 'unknown');
    assert.equal(event.table, 'task');
    assert.equal(event.sys_id, null);
    assert.equal(event.changes, undefined);
  });

  it('normalizes delete and positional change payloads', () => {
    const event = normalizeRecordWatcherEvent({
      channel: '/rw/default/incident/abc',
      data: { sys_id: SYS_ID, action: 'delete', changes: [['state', '2', '7']] },
    }, {}, '2026-11-04T00:00:00.000Z');
    assert.equal(event.operation, 'deleted');
    assert.deepEqual(event.changes, [{ field: 'state', previous_value: '2', value: '7' }]);
  });
});
