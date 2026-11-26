// Tests for `jsn email queue` / `jsn email why` (issue #659).
//
// Provider responses are synthetic; live verification is separate. The suite
// pins the honesty rules: counts come from provider aggregates, a failed read
// is unavailable evidence (never zero), and no write path is reachable.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEmailQueue, buildEmailWhy, parseEmailWindow, describeAge, parseInstanceTimestamp,
} from '../src/email-analysis.js';
import { formatEmailQueue, formatEmailWhy } from '../src/email-report.js';
import { emailCmd } from '../src/commands/_simple.js';

const EMAIL_ID = 'a'.repeat(32);
const INCIDENT_ID = 'b'.repeat(32);
const NO_WRITES = () => assert.fail('unexpected write');

function providerError(status = 403) {
  return Object.assign(new Error(`Access forbidden (HTTP ${status}).`), { status, code: 'forbidden' });
}

function groups(field, pairs) {
  return { groups: pairs.map(([value, count]) => ({
    stats: { count: String(count) },
    groupby_fields: [{ field, value }],
  })) };
}

/** Small Stats/Table API fixture keyed by table + query. */
function sdkFixture({ aggregates = {}, counts = {}, lists = {}, failures = {} } = {}) {
  const calls = [];
  const fail = (key) => {
    const status = failures[key];
    if (status) throw providerError(status);
  };
  const sdk = {
    async aggregate(table, options = {}) {
      calls.push({ op: 'aggregate', table, options });
      fail(`aggregate:${table}:${options.groupBy?.[0] || 'min'}`);
      const key = `${table}:${options.groupBy?.[0] || 'min'}`;
      return aggregates[key] ?? { groups: [] };
    },
    async aggregateCount(table, query = '') {
      calls.push({ op: 'count', table, query });
      fail(`count:${table}:${query}`);
      return counts[`${table}:${query}`] ?? 0;
    },
    async list(table, params = {}) {
      const query = params.get?.('sysparm_query') || '';
      calls.push({ op: 'list', table, query });
      fail(`list:${table}:${query}`);
      const handler = lists[`${table}:${query}`] ?? lists[table];
      if (typeof handler === 'function') return handler(params);
      return handler ?? [];
    },
    create: NO_WRITES,
    update: NO_WRITES,
    delete: NO_WRITES,
  };
  return { sdk, calls };
}

function queueFixture(overrides = {}) {
  return sdkFixture({
    aggregates: {
      'sys_email:type': groups('type', [['send-ready', 12], ['received', 3], ['send-failed', 1]]),
      'sys_email:state': groups('state', [['ready', 12], ['processed', 3], ['error', 1]]),
      'sys_email:mailbox': groups('mailbox', [['outbox', 12], ['', 3], ['failed', 1]]),
      'sys_email:min': { stats: { count: '12', min: { sys_created_on: '2026-11-01 10:00:00' } } },
      ...overrides.aggregates,
    },
    counts: { 'sys_email:sys_created_on>=javascript:gs.daysAgo(7)': 16, ...overrides.counts },
    lists: {
      'sys_email:type=send-ready^ORDERBYsys_created_on': [{
        sys_id: 'c'.repeat(32), type: 'send-ready', state: 'ready', mailbox: 'outbox',
        direct: 'someone@example.com', subject: 'Stuck message', sys_created_on: '2026-11-01 10:00:00',
      }],
      sys_mailbox: [{ sys_id: 'outbox', name: 'Outbox' }, { sys_id: 'failed', name: 'Failed' }],
      'sys_properties:nameINglide.email.smtp.active,glide.email.read.active': [
        { name: 'glide.email.smtp.active', value: 'false' },
        { name: 'glide.email.read.active', value: 'true' },
      ],
      'sys_email_account:active=true': [],
      ...overrides.lists,
    },
    failures: overrides.failures || {},
  });
}

describe('email window parsing', () => {
  it('translates relative windows to server-evaluated encoded queries', () => {
    assert.equal(parseEmailWindow('24h').query, 'sys_created_on>=javascript:gs.hoursAgo(24)');
    assert.equal(parseEmailWindow('7d').query, 'sys_created_on>=javascript:gs.daysAgo(7)');
    assert.equal(parseEmailWindow('2w').query, 'sys_created_on>=javascript:gs.daysAgo(14)');
    assert.equal(parseEmailWindow('1m').query, 'sys_created_on>=javascript:gs.monthsAgo(1)');
    assert.equal(parseEmailWindow('7d').kind, 'relative');
  });

  it('passes absolute dates through with the instance time-zone caveat', () => {
    const window = parseEmailWindow('2026-11-01');
    assert.equal(window.query, 'sys_created_on>=2026-11-01');
    assert.match(window.resolution, /instance system time zone/);
    assert.equal(parseEmailWindow('2026-11-01 08:30').query, 'sys_created_on>=2026-11-01 08:30');
  });

  it('rejects empty, zero and malformed windows before any provider call', () => {
    for (const value of ['', '0d', '-1d', '7', 'week', '2026-13-99x']) {
      assert.throws(() => parseEmailWindow(value), /--since/);
    }
  });
});

describe('queue composition', () => {
  it('reports provider aggregates, total and the oldest send-ready age', async () => {
    const { sdk } = queueFixture();
    const data = await buildEmailQueue(sdk, { since: '7d', now: new Date('2026-11-12T10:00:00Z') });
    assert.equal(data.total, 16);
    assert.deepEqual(data.by_type, [
      { value: 'send-ready', count: 12 },
      { value: 'received', count: 3 },
      { value: 'send-failed', count: 1 },
    ]);
    assert.equal(data.type_groups_sum, 16);
    assert.deepEqual(data.zero_types_in_window, ['send-translation-ready', 'sent', 'send-ignored', 'received-ignored']);
    assert.deepEqual(data.by_mailbox[0], { mailbox: 'outbox', name: 'Outbox', count: 12 });
    assert.equal(data.oldest_send_ready.sys_id, 'c'.repeat(32));
    assert.equal(data.oldest_send_ready.age_seconds, 11 * 86400);
    assert.equal(data.oldest_send_ready.age, '11d 0h');
    assert.equal(data.oldest_send_ready.sys_created_on_source, 'UTC');
  });

  it('reports switches and mail accounts without exposing credentials', async () => {
    const { sdk, calls } = queueFixture({ lists: {
      'sys_email_account:active=true': [{ sys_id: 'd'.repeat(32), name: 'SMTP', type: 'SMTP', server: 'smtp.example.com',
        port: '587', from: 'noreply@example.com', enable_tls: 'true', enable_ssl: 'false', connection_security: 'TLS',
        servicenow_configured: 'true' }],
    }, counts: {
      'sys_email:sys_created_on>=javascript:gs.daysAgo(7)': 16,
      'sys_email_account:': 2,
      'sys_email_account:active=true': 1,
    } });
    const data = await buildEmailQueue(sdk, { since: '7d', now: new Date('2026-11-12T10:00:00Z') });
    assert.deepEqual(data.switches, {
      'glide.email.smtp.active': false, 'glide.email.read.active': true, source: 'sys_properties',
    });
    assert.equal(data.email_accounts.total, 2);
    assert.equal(data.email_accounts.active, 1);
    assert.equal(data.email_accounts.rows[0].server, 'smtp.example.com');
    assert.equal(data.email_accounts.rows_complete, true);
    const requested = calls.filter(call => call.op === 'list' && call.table === 'sys_email_account')
      .map(call => call.query);
    assert.ok(requested.every(query => !/password/i.test(query)));
  });

  it('treats a denied source as unavailable evidence, not zero', async () => {
    const { sdk } = queueFixture({ failures: {
      'aggregate:sys_email:type': 403,
      'list:sys_properties:nameINglide.email.smtp.active,glide.email.read.active': 403,
      'list:sys_email_account:active=true': 403,
    } });
    const data = await buildEmailQueue(sdk, { since: '7d', now: new Date('2026-11-12T10:00:00Z') });
    assert.equal(data.by_type, null);
    assert.equal(data.switches, null);
    assert.equal(data.total, 16);
    const denied = data.unavailable.map(entry => entry.table);
    assert.ok(denied.includes('sys_email'));
    assert.ok(denied.includes('sys_properties'));
    assert.ok(denied.includes('sys_email_account'));
    assert.ok(data.unavailable.every(entry => entry.status === 403));
  });

  it('warns when type groups do not sum to the provider total', async () => {
    const { sdk } = queueFixture({ aggregates: {
      'sys_email:type': groups('type', [['send-ready', 10]]),
    } });
    const data = await buildEmailQueue(sdk, { since: '7d', now: new Date('2026-11-12T10:00:00Z') });
    assert.equal(data.type_groups_sum, 10);
    assert.match(data.warnings.join(' '), /sum to 10 but the window total is 16/);
  });

  it('never infers a total from the by-type groups', async () => {
    const { sdk } = queueFixture({ failures: {
      'count:sys_email:sys_created_on>=javascript:gs.daysAgo(7)': 403,
    } });
    const data = await buildEmailQueue(sdk, { since: '7d', now: new Date('2026-11-12T10:00:00Z') });
    assert.equal(data.total, null);
    assert.equal(data.by_type.length, 3);
    assert.match(formatEmailQueue(data), /Total: unavailable/);
  });
});

describe('why composition', () => {
  const inboundEmail = {
    sys_id: EMAIL_ID, type: 'received-ignored', state: 'Ignored', status: '', mailbox: '',
    subject: 'RE: Printer down', direct: 'user@example.com', recipients: 'helpdesk@example.com',
    error_string: '', message_id: 'm1@example.com', receive_type: 'Reply', notification_type: 'SMTP',
    checkpoint: '1', sys_created_on: { display_value: '2026-11-20 08:00:00', value: '2026-11-20 16:00:00' },
    sys_updated_on: { display_value: '2026-11-20 08:00:05', value: '2026-11-20 16:00:05' },
  };

  function whyFixture(overrides = {}) {
    return sdkFixture({ counts: {
      [`sys_watermark:email=${EMAIL_ID}`]: 1,
      [`sys_email_log:email=${EMAIL_ID}`]: 1,
    }, lists: {
      [`sys_email:sys_id=${EMAIL_ID}`]: [inboundEmail],
      'sys_email:message_id=m1@example.com': [inboundEmail],
      [`sys_watermark:email=${EMAIL_ID}`]: [{
        sys_id: 'e'.repeat(32), number: 'MSG0001_abc', source_id: INCIDENT_ID, source_table: 'incident',
        sys_created_on: '2026-11-20 08:00:01',
      }],
      [`incident:sys_id=${INCIDENT_ID}`]: [{ sys_id: INCIDENT_ID, number: 'INC0010037', short_description: 'Printer down' }],
      'sysevent_in_email_action:event_name=email.read': [
        { sys_id: '1'.repeat(32), name: 'Update Incident', active: 'true', type: 'Reply', event_name: 'email.read' },
        { sys_id: '2'.repeat(32), name: 'Create Incident', active: 'true', type: 'New', event_name: 'email.read' },
        { sys_id: '3'.repeat(32), name: 'Old Reply', active: 'false', type: 'Reply', event_name: 'email.read' },
      ],
      [`sys_email_log:email=${EMAIL_ID}^ORDERBYsys_created_on`]: [{
        sys_id: '4'.repeat(32), notification: '5'.repeat(32), event: '6'.repeat(32), sys_created_on: '2026-11-20 08:00:02',
      }],
      [`sysevent_email_action:sys_id=${'5'.repeat(32)}`]: [{ sys_id: '5'.repeat(32), name: 'Incident commented', active: 'true', type: 'EMAIL', event_name: 'incident.commented' }],
      [`sysevent:sys_id=${'6'.repeat(32)}`]: [{ sys_id: '6'.repeat(32), name: 'incident.commented', state: 'processed', processed: '2026-11-20 08:00:03', processing_duration: '250', table: 'incident' }],
      ...overrides.lists,
    }, failures: overrides.failures || {} });
  }

  it('joins the watermark to its source record and lists log evidence', async () => {
    const { sdk } = whyFixture({ failures: { [`list:syslog_email:email=${EMAIL_ID}`]: 403 } });
    const data = await buildEmailWhy(sdk, EMAIL_ID, { now: new Date('2026-11-22T16:00:00Z') });
    assert.equal(data.email.direction, 'inbound');
    assert.equal(data.email.age, '2d 0h');
    assert.equal(data.watermarks[0].number, 'MSG0001_abc');
    assert.equal(data.watermarks[0].source.label, 'INC0010037');
    assert.equal(data.watermarks[0].source.table, 'incident');
    assert.equal(data.inbound_actions.expected_type, 'Reply');
    assert.equal(data.inbound_actions.expected_type_source, 'receive_type');
    assert.deepEqual(data.inbound_actions.matched.map(row => row.name), ['Update Incident', 'Old Reply']);
    assert.equal(data.email_log[0].notification.name, 'Incident commented');
    assert.equal(data.email_log[0].event.state, 'processed');
    assert.equal(data.watermarks_total, 1);
    assert.equal(data.email_log_total, 1);
    assert.equal(data.watermarks_truncated, false);
    assert.equal(data.syslog_email.available, false);
    assert.equal(data.syslog_email.status, 403);
    assert.ok(data.unavailable.some(entry => entry.table === 'syslog_email'));
    assert.match(data.notes.join(' '), /skip reason is unconfirmed|not proof that an action ran/);
  });

  it('resolves an exact message_id and reports a stable match field', async () => {
    const { sdk } = whyFixture();
    const data = await buildEmailWhy(sdk, 'm1@example.com');
    assert.equal(data.email.sys_id, EMAIL_ID);
    assert.equal(data.identifier.matched_on, 'message_id');
  });

  it('reports no watermark as an observable state with an unconfirmed cause', async () => {
    const { sdk } = whyFixture({ lists: {
      [`sys_watermark:email=${EMAIL_ID}`]: [],
    } });
    const data = await buildEmailWhy(sdk, EMAIL_ID);
    assert.deepEqual(data.watermarks, []);
    assert.match(data.notes.join(' '), /No sys_watermark row references this email/);
  });

  it('explains outbound mail without inbound candidates', async () => {
    const { sdk } = whyFixture({ lists: {
      [`sys_email:sys_id=${EMAIL_ID}`]: [{ ...inboundEmail, type: 'send-failed', state: 'Error',
        error_string: '550 mailbox unavailable', receive_type: '' }],
    } });
    const data = await buildEmailWhy(sdk, EMAIL_ID);
    assert.equal(data.email.direction, 'outbound');
    assert.equal(data.inbound_actions, null);
    assert.equal(data.email.error_string, '550 mailbox unavailable');
    assert.match(formatEmailWhy(data), /not applicable: outbound email/);
  });

  it('fails cleanly for missing and ambiguous messages', async () => {
    const missing = whyFixture({ lists: { [`sys_email:sys_id=${EMAIL_ID}`]: [] } });
    await assert.rejects(buildEmailWhy(missing.sdk, EMAIL_ID), err => err.code === 'not_found');
    const ambiguous = whyFixture({ lists: { [`sys_email:message_id=m1@example.com`]: [inboundEmail, inboundEmail] } });
    await assert.rejects(buildEmailWhy(ambiguous.sdk, 'm1@example.com'), /More than one email matches/);
  });

  it('rejects query-control characters before any provider call', async () => {
    const { sdk, calls } = whyFixture();
    for (const value of ['', '   ', 'abc^state=1', 'abc=def', 'line\nbreak']) {
      await assert.rejects(buildEmailWhy(sdk, value), /identifier|needs a sys_email/i);
    }
    assert.equal(calls.length, 0);
  });
});

describe('timestamp and age helpers', () => {
  it('parses raw instance timestamps as UTC and describes age', () => {
    assert.equal(parseInstanceTimestamp('2026-11-01 10:00:00'), Date.parse('2026-11-01T10:00:00Z'));
    assert.equal(parseInstanceTimestamp('not a date'), null);
    assert.equal(parseInstanceTimestamp({ value: '2026-11-01 10:00:00' }), Date.parse('2026-11-01T10:00:00Z'));
    assert.equal(describeAge(90), '1m');
    assert.equal(describeAge(3660), '1h 1m');
    assert.equal(describeAge(90061), '1d 1h');
  });
});

describe('command surface', () => {
  function collectCommands(command) {
    const commands = [];
    const stub = new Proxy({}, {
      get(_target, prop) {
        if (prop === 'command') return (child) => { commands.push(child); return stub; };
        return () => stub;
      },
    });
    command.builder(stub);
    return commands;
  }

  it('adds queue and why without dropping the existing record commands', () => {
    const names = collectCommands(emailCmd((fn) => fn)).map(command => command.command);
    for (const expected of ['list', 'show <identifier>', 'create', 'update <identifier>', 'delete <identifier>', 'queue', 'why <identifier>']) {
      assert.ok(names.includes(expected), `missing subcommand: ${expected}`);
    }
  });

  it('queue handler returns data with a non-enumerable styled view', async () => {
    const { sdk } = queueFixture();
    const queue = collectCommands(emailCmd((fn) => fn)).find(command => command.command === 'queue');
    let captured;
    const app = {
      sdk,
      requireInstance: () => {},
      getEffectiveInstance: () => 'https://dev.example.com',
      ok: (data, options) => { captured = { data, options }; },
    };
    await queue.handler({ since: '7d' }, app);
    assert.equal(captured.data.total, 16);
    assert.equal(JSON.stringify(captured.data).includes('_formatted'), false);
    assert.match(captured.data._formatted, /Email queue — https:\/\/dev\.example\.com/);
    assert.match(captured.options.summary, /16 email/);
  });

  it('why handler surfaces the not-found error code', async () => {
    const { sdk } = sdkFixture({ lists: { [`sys_email:sys_id=${EMAIL_ID}`]: [] } });
    const why = collectCommands(emailCmd((fn) => fn)).find(command => command.command === 'why <identifier>');
    const app = { sdk, requireInstance: () => {}, getEffectiveInstance: () => 'https://dev.example.com', ok: () => {} };
    await assert.rejects(why.handler({ identifier: EMAIL_ID }, app), err => err.code === 'not_found');
  });
});
