// `jsn records watch` command contract.
//
// The handler is exercised with a fake App (SDK + captured output) against a
// local mock of /amb, so the test pins the command surface: argument
// resolution, newline-delimited JSON events through app.output, the fetched
// state side channel, and the terminating watch_summary. A spawned-CLI check
// covers help text and the missing-identifier usage error.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { OutputWriter, FormatJSON, FormatStyled } from '../src/output.js';
import { recordsCmd } from '../src/commands/records.js';

const require = createRequire(import.meta.url);
const CLI_DIR = path.resolve(path.dirname(require.resolve('../package.json')));

const SYS_ID = '0123456789abcdef0123456789abcdef';
const CHANNEL = `/rw/default/incident/${Buffer.from(`sys_id=${SYS_ID}`).toString('base64').replace(/=/g, '-')}`;

async function mockAmb({ onConnect } = {}) {
  const calls = [];
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const url = new URL(request.url, 'http://fixture');
    const messages = text ? JSON.parse(text) : [];
    calls.push({ path: url.pathname, messages, headers: request.headers });
    const json = body => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/amb/handshake') {
      json([{ channel: '/meta/handshake', successful: true, clientId: 'c1', ext: { 'glide.session.status': 'session.logged.in' } }]);
      return;
    }
    if (messages[0]?.channel === '/meta/subscribe') { json([{ channel: '/meta/subscribe', successful: true }]); return; }
    if (messages[0]?.channel === '/meta/connect') {
      if (onConnect) return onConnect({ response, json, calls });
      json([{ channel: CHANNEL, id: 'evt-1', data: { table: 'incident', sys_id: SYS_ID, display_value: 'INC0010001', operation: 'update' } }]);
      return;
    }
    json([{ channel: messages[0]?.channel || '/meta/disconnect', successful: true }]);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

async function watchHandler() {
  const cmd = recordsCmd(wrap => wrap);
  const subcommands = [];
  const y = {
    command: (definition) => { subcommands.push(definition); return y; },
  };
  cmd.builder(y);
  const watch = subcommands.find(s => s.command === 'watch');
  return { watch, subcommands };
}

/** Fake App whose SDK answers record lookups and record reads locally. */
function fakeApp({ chunks, rows = [], ambSession, format = FormatJSON } = {}) {
  return {
    output: new OutputWriter({ format, writer: { write: text => chunks.push(text), isTTY: false } }),
    getEffectiveInstance: () => globalThis.__watchInstanceUrl,
    sdk: {
      ambSession: ambSession || (async () => ({ cookies: 'glide_session_store=abc', userToken: 'tok' })),
      list: async (table, params) => {
        const query = String(params?.get?.('sysparm_query') || params);
        if (query.includes(`sys_id=${SYS_ID}`)) {
          // The lookup asks for sys_id; the state read asks for everything.
          return rows.length ? rows : [{ sys_id: SYS_ID, number: 'INC0010001' }];
        }
        return [];
      },
    },
  };
}

const argvFor = overrides => ({
  _: ['records', 'watch'],
  table: 'incident',
  'sys-id': SYS_ID,
  timeout: 0,
  maxEvents: 1,
  state: 'auto',
  reconnect: true,
  pollTimeout: 1000,
  fields: undefined,
  identifier: undefined,
  identifierField: undefined,
  ...overrides,
});

describe('records watch subcommand', () => {
  it('is registered on the records family with an AMB-aware description', async () => {
    const { watch, subcommands } = await watchHandler();
    assert.ok(watch, 'watch is registered');
    assert.match(watch.describe, /AMB/);
    assert.ok(subcommands.some(s => s.command === 'list'), 'sibling commands survive');
  });

  it('streams NDJSON events with fetched state kept in a side channel', async () => {
    const server = await mockAmb();
    const chunks = [];
    globalThis.__watchInstanceUrl = server.baseUrl;
    try {
      const { watch } = await watchHandler();
      await watch.handler(argvFor({}), fakeApp({
        chunks,
        rows: [{ sys_id: SYS_ID, number: 'INC0010001', state: { value: '2', display_value: 'In Progress' } }],
      }));
    } finally {
      await server.close();
    }

    const lines = chunks.join('').split('\n').filter(Boolean).map(line => JSON.parse(line));
    const types = lines.map(l => l.type);
    assert.deepEqual(types, ['connecting', 'subscribed', 'record_change', 'unsubscribed', 'watch_summary']);
    const event = lines.find(l => l.type === 'record_change');
    assert.equal(event.sys_id, SYS_ID);
    assert.equal(event.operation, 'updated');
    assert.equal(event.state.source, 'fetched');
    assert.equal(event.state.record.number, 'INC0010001');
    assert.equal(event.record, undefined);
    const summary = lines.at(-1);
    assert.equal(summary.reason, 'max_events');
    assert.equal(summary.events, 1);
    assert.equal(summary.gaps, 0);
  });

  it('renders the changed fields the live platform sends, not only a bare operation', async () => {
    // The live payload carries a `record` map of the changed fields plus
    // sys_* audit fields; it does not carry the `changes` array the mock
    // originally used. Human output must not degrade to "updated" alone.
    const server = await mockAmb({
      onConnect: ({ json }) => json([{
        channel: CHANNEL,
        id: 'evt-live-1',
        data: {
          operation: 'update',
          display_value: 'INC0010001',
          record: {
            short_description: { value: 'after', display_value: 'after' },
            sys_updated_on: { value: '2026-11-04 18:00:45', display_value: '2026-11-04 10:00:45' },
            sys_updated_by: { value: 'admin', display_value: 'admin' },
          },
        },
      }]),
    });
    const chunks = [];
    globalThis.__watchInstanceUrl = server.baseUrl;
    try {
      const { watch } = await watchHandler();
      await watch.handler(argvFor({}), fakeApp({ chunks, format: FormatStyled }));
    } finally {
      await server.close();
    }

    const text = chunks.join('');
    assert.match(text, /INC0010001 updated/);
    assert.match(text, /short_description: after/);
    assert.doesNotMatch(text, /sys_updated_on/, 'audit fields are not change detail');
    assert.match(text, /unsubscribed \(max_events\)/, 'the stop reason is named');
  });

  it('says when an update takes a record out of the query, and names withheld fields', async () => {
    const server = await mockAmb({
      onConnect: ({ json }) => json([
        { channel: CHANNEL, id: 'evt-exit', data: { display_value: 'INC0010393', sys_id: SYS_ID, operation: 'update', action: 'exit', changes: ['priority'], record: { priority: { value: '4', display_value: '4 - Low' } } } },
        { channel: CHANNEL, id: 'evt-stub', data: { metadata: { display_value: 'INC0010394', sys_id: SYS_ID, operation: 'update', action: 'change', changes: ['short_description'] }, record: { sys_id: SYS_ID, table: 'incident' } } },
      ]),
    });
    const chunks = [];
    globalThis.__watchInstanceUrl = server.baseUrl;
    try {
      const { watch } = await watchHandler();
      await watch.handler(argvFor({ maxEvents: 2, state: 'never' }), fakeApp({ chunks, format: FormatStyled }));
    } finally {
      await server.close();
    }
    const text = chunks.join('');
    assert.match(text, /INC0010393 updated \(no longer matches\) \u2014 priority: 4 - Low/);
    assert.match(text, /INC0010394 updated \u2014 short_description\n/);
    assert.doesNotMatch(text, /\? → \?/, 'no invented transitions');
  });

  it('reports a usage error when none of --sys-id, --identifier or --query is given', async () => {
    const { watch } = await watchHandler();
    await assert.rejects(
      watch.handler(argvFor({ 'sys-id': undefined }), fakeApp({ chunks: [] })),
      /Supply exactly one of --sys-id, --identifier or --query/,
    );
  });

  it('watches every record matching --query and reads each changed record by its own sys_id', async () => {
    const query = 'priority=1^active=true';
    const queryChannel = `/rw/default/incident/${Buffer.from(query).toString('base64').replace(/=/g, '-')}`;
    const server = await mockAmb({
      onConnect: ({ json }) => json([
        { channel: queryChannel, id: 'evt-u', data: { sys_id: SYS_ID, display_value: 'INC0010001', operation: 'update' } },
        { channel: queryChannel, id: 'evt-q', data: { sys_id: SYS_ID, display_value: 'INC0010001', operation: 'insert' } },
      ]),
    });
    const chunks = [];
    const reads = [];
    globalThis.__watchInstanceUrl = server.baseUrl;
    try {
      const { watch } = await watchHandler();
      const app = fakeApp({ chunks });
      app.queryValidation = { table: 'incident', query, state: 'valid', diagnostics: [] };
      const list = app.sdk.list;
      app.sdk.list = async (table, params) => { reads.push(String(params?.get?.('sysparm_query'))); return list(table, params); };
      // --timeout bounds the test if --operation were mis-mapped and dropped everything.
      await watch.handler(argvFor({ 'sys-id': undefined, query, operation: 'insert', timeout: 5 }), app);
    } finally {
      await server.close();
    }
    const subscribe = server.calls.find(call => call.messages[0]?.channel === '/meta/subscribe');
    assert.equal(subscribe.messages[0].subscription, queryChannel);
    assert.deepEqual(reads, [`sys_id=${SYS_ID}`], 'no up-front record lookup; one state read for the changed record');
    const lines = chunks.join('').split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.equal(lines[0].query, query);
    const changes = lines.filter(l => l.type === 'record_change');
    assert.deepEqual(changes.map(e => e.event_id), ['evt-q'], '--operation insert drops the update');
    assert.equal(changes[0].sys_id, SYS_ID);
    assert.equal(changes[0].operation, 'created');
    assert.equal(lines.at(-1).query, query);
  });

  for (const [label, overrides, pattern] of [
    ['--query with --sys-id', { query: 'active=true' }, /cannot be combined/],
    ['--query with --identifier', { 'sys-id': undefined, identifier: 'INC0010001', query: 'active=true' }, /cannot be combined/],
    ['a blank --query', { 'sys-id': undefined, query: '  ' }, /--query needs an encoded query/],
    ['a malformed --query', { 'sys-id': undefined, query: '=1' }, /Read refused/],
    ['an empty --on-change', { 'on-change': ' , ' }, /--on-change needs at least one field/],
  ]) {
    it(`rejects ${label} before any lookup or AMB call`, async () => {
      const { watch } = await watchHandler();
      const app = fakeApp({ chunks: [] });
      let reads = 0;
      app.sdk.list = async () => { reads += 1; return []; };
      app.sdk.ambSession = async () => { throw new Error('must not open AMB'); };
      const originalFetch = globalThis.fetch;
      let fetched = 0;
      globalThis.fetch = async () => { fetched += 1; throw new Error('must not reach the network'); };
      try {
        await assert.rejects(watch.handler(argvFor(overrides), app), pattern);
      } finally {
        globalThis.fetch = originalFetch;
      }
      assert.equal(reads, 0);
      assert.equal(fetched, 0);
    });
  }

  it('turns an inaccessible record into an actionable not_found error before subscribing', async () => {
    const { watch } = await watchHandler();
    const app = fakeApp({ chunks: [] });
    app.sdk.list = async () => [];
    let subscribed = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { subscribed = true; throw new Error('must not open AMB for a missing record'); };
    try {
      await assert.rejects(watch.handler(argvFor({}), app), (error) => {
        assert.equal(error.code, 'not_found');
        assert.match(error.hint, /ACLs/);
        return true;
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(subscribed, false);
  });
});

describe('records watch CLI surface', () => {
  function run(args) {
    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-watch-'));
    const result = spawnSync(process.execPath, [path.join(CLI_DIR, 'bin', 'jsn.js'), ...args], {
      cwd: CLI_DIR,
      encoding: 'utf8',
      timeout: 60000,
      env: {
        ...process.env,
        JSN_NO_VERSION_CHECK: '1',
        JSN_NO_SKILL_CHECK: '1',
        SERVICENOW_INSTANCE_URL: '',
        XDG_CONFIG_HOME: configHome,
      },
    });
    fs.rmSync(configHome, { recursive: true, force: true });
    return result;
  }

  it('documents streaming, bounds, cancellation and gap behavior in --help', () => {
    const result = run(['records', 'watch', '--help']);
    assert.equal(result.status, 0, result.stderr);
    const help = `${result.stdout}${result.stderr}`;
    assert.match(help, /--timeout/);
    assert.match(help, /--max-events/);
    assert.match(help, /--no-reconnect/);
    assert.match(help, /newline-delimited JSON/i);
    assert.match(help, /does not replay missed events/);
    assert.match(help, /--query/);
    assert.match(help, /--operation .*\[string: insert, update, delete\]/);
    assert.match(help, /--on-change/);
    assert.doesNotMatch(help, /jsn auth login --browser/, 'basic and OAuth profiles also open the UI session AMB needs');
  });

  it('exits 2 with the identifier requirement for a missing record selector', () => {
    const result = run(['records', 'watch', '--table', 'incident']);
    assert.equal(result.status, 2);
    // Piped output selects JSON, so the usage failure is the standard
    // machine-consumable envelope on stdout rather than prose on stderr.
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, 'usage_error');
    assert.match(envelope.error, /Supply exactly one of --sys-id, --identifier or --query/);
  });
});
