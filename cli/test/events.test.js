// Read paths of `jsn events`: list filtering, the show card (including the
// missing error reason), and backlog scheduled-vs-overdue math.
//
// Fixtures are synthetic sysevent/registry/consumer rows shaped from the live
// dictionary; the fake SDK interprets only the encoded-query terms this command
// builds, and records every call so a read path can be proven not to write.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { captureSubcommands, findCommand, wrapHandler } from './support/command-test-helpers.js';
import { eventsCmd } from '../src/commands/events.js';
import {
  BACKLOG_DEFAULT_SINCE, NO_ERROR_REASON, backlogQueries, buildEventQuery, describeEvent,
  formatBacklog, formatEventDetail, formatEventList, getBacklog, jobMatch, listEvents,
  normalizeCounts, sinceClause,
} from '../src/events.js';

const NOW = '2026-11-26 12:00:00';
const OVERDUE_ID = '1'.repeat(32);
const SCHEDULED_ID = '2'.repeat(32);
const UNSCHEDULED_ID = '3'.repeat(32);
const PROCESSED_ID = '4'.repeat(32);
const ERROR_ID = '5'.repeat(32);

const EVENTS = [
  {
    sys_id: OVERDUE_ID, name: 'flow.fire', queue: 'flow_engine', state: 'ready',
    process_on: '2026-11-26 11:00:00', sys_created_on: '2026-11-26 10:59:00', processed: '',
  },
  {
    sys_id: SCHEDULED_ID, name: 'asset.restock', queue: '', state: 'ready',
    process_on: '2026-11-26 13:00:00', sys_created_on: '2026-11-26 09:00:00', processed: '',
  },
  {
    sys_id: UNSCHEDULED_ID, name: 'login', queue: '', state: 'ready',
    process_on: '', sys_created_on: '2026-11-26 11:59:00', processed: '',
  },
  {
    sys_id: PROCESSED_ID, name: 'asset.restock', queue: '', state: 'processed',
    process_on: '2026-11-26 10:00:00', processed: '2026-11-26 10:00:04',
    sys_created_on: '2026-11-26 10:00:00', claimed_by: 'node-a', processing_duration: '148',
  },
  {
    sys_id: ERROR_ID, name: 'text_index', queue: 'text_index', state: 'error',
    process_on: '2026-11-26 10:00:00', processed: '2026-11-26 10:00:30',
    sys_created_on: '2026-11-26 10:00:00', claimed_by: 'node-a', processing_duration: '4',
  },
];

function terms(query) {
  return String(query || '').split('^').map(term => term.trim()).filter(term => term && term !== 'EQ');
}

function applyEventQuery(rows, query) {
  let out = [...rows];
  for (const term of terms(query)) {
    if (/^ORDERBY/i.test(term)) continue;
    if (term.startsWith('state=')) out = out.filter(row => row.state === term.slice(6));
    else if (term.startsWith('queue=')) out = out.filter(row => row.queue === term.slice(6));
    else if (term.startsWith('name=')) out = out.filter(row => row.name === term.slice(5));
    else if (term.startsWith('sys_id=')) out = out.filter(row => row.sys_id === term.slice(7).toLowerCase());
    else if (term.startsWith('sys_created_on>=')) continue; // window is the provider's clock
    else if (term === 'process_on<=javascript:gs.nowDateTime()') out = out.filter(row => row.process_on && row.process_on <= NOW);
    else if (term === 'process_on>javascript:gs.nowDateTime()') out = out.filter(row => row.process_on && row.process_on > NOW);
    else if (term === 'process_onISEMPTY') out = out.filter(row => !row.process_on);
    else throw new Error(`fixture does not understand query term: ${term}`);
  }
  if (/ORDERBYDESCsys_created_on/.test(query)) out.sort((a, b) => String(b.sys_created_on).localeCompare(String(a.sys_created_on)));
  if (/ORDERBYprocess_on/.test(query)) out.sort((a, b) => String(a.process_on).localeCompare(String(b.process_on)));
  return out;
}

function groupEvents(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.queue}\u0000${row.state}`;
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  return [...groups.entries()].map(([key, count]) => {
    const [queue, state] = key.split('\u0000');
    return {
      stats: { count: String(count) },
      groupby_fields: [{ field: 'queue', value: queue }, { field: 'state', value: state }],
    };
  });
}

function eventNameMatcher(query) {
  const equal = /event_name=([^^]+)/.exec(query);
  if (equal) return row => row.event_name === equal[1];
  const list = /event_nameIN([^^]+)/.exec(query);
  if (list) {
    const names = new Set(list[1].split(','));
    return row => names.has(row.event_name);
  }
  return () => true;
}

function makeSdk(overrides = {}) {
  const calls = [];
  const writes = [];
  const sdk = {
    calls,
    writes,
    async list(table, params = {}) {
      calls.push({ op: 'list', table, params });
      const query = String(params.sysparm_query || '');
      const limit = Number(params.sysparm_limit || 20);
      if (table === 'sysevent') return applyEventQuery(overrides.events || EVENTS, query).slice(0, limit);
      if (table === 'sysevent_register') return (overrides.registry || []).filter(eventNameMatcher(query)).slice(0, limit);
      if (table === 'sysevent_script_action') return (overrides.actions || []).filter(eventNameMatcher(query)).slice(0, limit);
      if (table === 'sysevent_email_action') return (overrides.notifications || []).filter(eventNameMatcher(query)).slice(0, limit);
      if (table === 'sys_email_log') return (overrides.emails || []).slice(0, limit);
      if (table === 'sys_trigger') return (overrides.jobs || []).slice(0, limit);
      if (table === 'sys_ui_action') return (overrides.uiActions || []).slice(0, limit);
      return [];
    },
    async aggregateCount(table, query) {
      calls.push({ op: 'aggregateCount', table, query });
      if (table === 'sysevent') return applyEventQuery(overrides.events || EVENTS, query).length;
      return 0;
    },
    async aggregate(table, options = {}) {
      calls.push({ op: 'aggregate', table, options });
      return { groups: groupEvents(applyEventQuery(overrides.events || EVENTS, options.query || '')) };
    },
    async get(table, id) {
      calls.push({ op: 'get', table, id });
      return (overrides.copies || {})[id] || null;
    },
    async create(...args) { writes.push(['create', args]); throw new Error('read path must not create'); },
    async update(...args) { writes.push(['update', args]); throw new Error('read path must not update'); },
    async delete(...args) { writes.push(['delete', args]); throw new Error('read path must not delete'); },
    async executeScript(...args) { writes.push(['executeScript', args]); throw new Error('read path must not execute scripts'); },
  };
  return sdk;
}

function makeApp(sdk) {
  return {
    sdk,
    config: { profiles: {}, activeProfile: null },
    requireInstance() {},
    getEffectiveInstance: () => 'https://dev.example.service-now.com',
    ok(data, opts) { this.lastOk = { data, opts }; },
  };
}

describe('events command registration', () => {
  it('exposes list, show, backlog and reprocess', () => {
    const commands = captureSubcommands(eventsCmd(wrapHandler));
    for (const name of ['list', 'show [sys-id]', 'backlog', 'reprocess [sys-id]']) {
      assert.ok(findCommand(commands, name), `missing subcommand ${name}`);
    }
  });
});

describe('events list filtering', () => {
  it('maps --state into the encoded query instead of filtering after the fact', async () => {
    const sdk = makeSdk();
    const data = await listEvents(sdk, { state: 'error', limit: 5 });
    assert.strictEqual(data.query, 'state=error^ORDERBYDESCsys_created_on');
    const list = sdk.calls.find(call => call.op === 'list');
    assert.match(list.params.sysparm_query, /^state=error\^/);
    assert.strictEqual(data.records.length, 1);
    assert.strictEqual(data.records[0].sys_id, ERROR_ID);
    // The count is the provider total for the same filter, not the page size.
    assert.strictEqual(data.total_matching, 1);
  });

  it('combines name, queue, table and record filters and rejects an orphan --record', () => {
    assert.strictEqual(
      buildEventQuery({ name: 'flow.fire', queue: 'flow_engine', table: 'sys_flow_context', record: 'A'.repeat(32) }),
      `name=flow.fire^queue=flow_engine^table=sys_flow_context^instance=${'a'.repeat(32)}`,
    );
    assert.strictEqual(buildEventQuery({ queue: '' }), 'queueISEMPTY');
    assert.strictEqual(buildEventQuery({}), '');
    assert.throws(() => buildEventQuery({ record: 'a'.repeat(32) }), /--record needs --table/);
    assert.throws(() => buildEventQuery({ state: 'ready;drop' }), /--state/);
    assert.throws(() => sinceClause('yesterday'), /--since/);
    assert.strictEqual(sinceClause('7d'), 'sys_created_on>=javascript:gs.daysAgoStart(7)');
    assert.strictEqual(sinceClause('24h'), 'sys_created_on>=javascript:gs.hoursAgoStart(24)');
  });

  it('renders a compact table and an honest fetched-of-matching line', () => {
    const text = formatEventList({
      records: [{ state: 'error', created: '2026-11-26 10:00:00', name: 'text_index', queue: 'text_index', process_on: '2026-11-26 10:00:00', sys_id: ERROR_ID }],
      total_matching: 501,
      has_more: true,
    });
    assert.match(text, /STATE\s+CREATED/);
    assert.match(text, /1 of 501 matching event\(s\); more exist/);
  });

  it('performs no writes on the list path', async () => {
    const sdk = makeSdk();
    const app = makeApp(sdk);
    await findCommand(captureSubcommands(eventsCmd(wrapHandler)), 'list').handler({
      app, state: 'error', limit: 5,
    });
    assert.strictEqual(sdk.writes.length, 0);
    assert.ok(app.lastOk.data.records.length >= 1);
  });
});

describe('events show', () => {
  const registry = [{ sys_id: 'a'.repeat(32), event_name: 'asset.restock', table: 'alm_asset', description: 'Sends an email' }];
  const actions = [{ sys_id: 'b'.repeat(32), event_name: 'asset.restock', active: 'true', condition_script: '' }];
  const notifications = [{ sys_id: 'c'.repeat(32), name: 'Asset Restocking', event_name: 'asset.restock', active: 'true', collection: 'alm_asset' }];
  const emails = [{
    sys_id: 'd'.repeat(32),
    notification: { value: 'c'.repeat(32), display_value: 'Asset Restocking' },
    email: { value: 'e'.repeat(32), display_value: 'Restocking Request' },
    sys_created_on: { value: '2026-11-22 09:00:04', display_value: '2026-11-22 01:00:04' },
  }];

  it('joins registry, script actions, notifications and emails by raw identity', async () => {
    const sdk = makeSdk({ registry, actions, notifications, emails });
    const data = await describeEvent(sdk, PROCESSED_ID);
    assert.strictEqual(data.event.sys_id, PROCESSED_ID);
    assert.strictEqual(data.registry[0].sys_id, 'a'.repeat(32));
    assert.strictEqual(data.script_actions[0].sys_id, 'b'.repeat(32));
    assert.strictEqual(data.notifications[0].name, 'Asset Restocking');
    assert.strictEqual(data.emails[0].email, 'e'.repeat(32));
    assert.strictEqual(data.emails[0].subject, 'Restocking Request');
    // Email rows are read with display values so the instance clock, not UTC, is shown.
    assert.strictEqual(data.emails[0].created, '2026-11-22 01:00:04');
    assert.strictEqual(data.timing.queued_seconds, 0);
    assert.strictEqual(data.error_reason, null);
  });

  it('says plainly that the platform kept no error reason', async () => {
    const sdk = makeSdk();
    const data = await describeEvent(sdk, ERROR_ID);
    assert.deepStrictEqual(data.error_reason, { available: false, explanation: NO_ERROR_REASON });
    assert.ok(data.notes.includes(NO_ERROR_REASON));
    const text = formatEventDetail(data);
    assert.match(text, /does not record why an event ended in error/);
    assert.doesNotMatch(text, /because the/i);
  });

  it('performs no writes on the show path', async () => {
    const sdk = makeSdk({ registry, actions, notifications, emails });
    const app = makeApp(sdk);
    await findCommand(captureSubcommands(eventsCmd(wrapHandler)), 'show [sys-id]').handler({
      app, 'sys-id': PROCESSED_ID,
    });
    assert.strictEqual(sdk.writes.length, 0);
    assert.strictEqual(app.lastOk.data.event.sys_id, PROCESSED_ID);
  });

  it('rejects a sys_id that is not an event identity', async () => {
    const sdk = makeSdk();
    const app = makeApp(sdk);
    await assert.rejects(
      findCommand(captureSubcommands(eventsCmd(wrapHandler)), 'show [sys-id]').handler({ app, 'sys-id': 'not-a-sys-id' }),
      /literal 32-hex/,
    );
    assert.strictEqual(sdk.calls.length, 0);
  });
});

describe('events backlog', () => {
  const jobs = [
    { sys_id: 'f'.repeat(32), name: 'Flow Processor', next_action: '2026-11-26 12:00:30', state: 'Ready', trigger_type: 'Repeat', script: "GlideEventManager('flow_engine').process();" },
    { sys_id: '0'.repeat(32), name: 'events process 0', next_action: '2026-11-26 12:00:40', state: 'Ready', trigger_type: 'Repeat', script: '' },
    { sys_id: '8'.repeat(32), name: 'text index events process', next_action: '2026-11-26 12:00:50', state: 'Ready', trigger_type: 'Interval', script: '' },
  ];

  it('asks the platform which ready events are overdue and which are scheduled', () => {
    const queries = backlogQueries('7d');
    assert.strictEqual(queries.overdue, 'sys_created_on>=javascript:gs.daysAgoStart(7)^state=ready^process_on<=javascript:gs.nowDateTime()');
    assert.strictEqual(queries.scheduled, 'sys_created_on>=javascript:gs.daysAgoStart(7)^state=ready^process_on>javascript:gs.nowDateTime()');
    assert.strictEqual(queries.unscheduled, 'sys_created_on>=javascript:gs.daysAgoStart(7)^state=ready^process_onISEMPTY');
    assert.strictEqual(backlogQueries(BACKLOG_DEFAULT_SINCE).overdue, queries.overdue);
  });

  it('counts a future process_on as scheduled, never as overdue', async () => {
    const data = await getBacklog(makeSdk({ jobs }), { since: '7d' });
    assert.strictEqual(data.ready.overdue.count, 1);
    assert.strictEqual(data.ready.overdue.oldest.sys_id, OVERDUE_ID);
    assert.strictEqual(data.ready.scheduled.count, 1);
    assert.strictEqual(data.ready.scheduled.next.sys_id, SCHEDULED_ID);
    assert.strictEqual(data.ready.missing_process_on.count, 1);
    // The scheduled row must not leak into the overdue answer.
    assert.notStrictEqual(data.ready.overdue.oldest.sys_id, SCHEDULED_ID);
    assert.strictEqual(data.totals.by_state.ready, 3);
    assert.match(data.ready.interpretation, /waiting on purpose, not stuck/);

    const text = formatBacklog(data);
    assert.match(text, /overdue 1, scheduled 1, no process_on 1/);
    assert.match(text, /Oldest overdue: 2026-11-26 11:00:00\s+flow\.fire/);
    assert.match(text, /Next scheduled:\s+2026-11-26 13:00:00\s+asset\.restock/);
  });

  it('attaches processors by script, by job name and for the blank default queue', async () => {
    const data = await getBacklog(makeSdk({ jobs }), { since: '7d' });
    const flow = data.processors.find(entry => entry.queue === 'flow_engine');
    assert.strictEqual(flow.processors[0].name, 'Flow Processor');
    assert.strictEqual(flow.processors[0].matched_by, 'script');
    assert.strictEqual(flow.processors[0].next_action, '2026-11-26 12:00:30');

    const fallback = data.processors.find(entry => entry.queue === '');
    assert.strictEqual(fallback.processors[0].name, 'events process 0');
    assert.match(fallback.note, /default queue/);

    const textIndex = data.processors.find(entry => entry.queue === 'text_index');
    assert.strictEqual(textIndex.processors[0].name, 'text index events process');
    assert.strictEqual(textIndex.processors[0].matched_by, 'job name mentions the queue');
  });

  it('reports a queue with no matching processor instead of inventing one', async () => {
    const data = await getBacklog(makeSdk({ jobs: [] }), { since: '7d' });
    const flow = data.processors.find(entry => entry.queue === 'flow_engine');
    assert.deepStrictEqual(flow.processors, []);
    assert.match(flow.note, /does not infer one/);
    assert.match(formatBacklog(data), /no processor job matched/);
  });

  it('performs no writes on the backlog path', async () => {
    const sdk = makeSdk({ jobs });
    const app = makeApp(sdk);
    await findCommand(captureSubcommands(eventsCmd(wrapHandler)), 'backlog').handler({ app, since: '7d' });
    assert.strictEqual(sdk.writes.length, 0);
    assert.strictEqual(app.lastOk.data.ready.scheduled.count, 1);
  });

  it('normalizes provider counts and refuses ambiguous job matches in order', () => {
    const counts = normalizeCounts([
      { stats: { count: '3' }, groupby_fields: [{ field: 'queue', value: 'b' }, { field: 'state', value: 'ready' }] },
      { stats: { count: '9' }, groupby_fields: [{ field: 'queue', value: 'a' }, { field: 'state', value: 'processed' }] },
    ]);
    assert.deepStrictEqual(counts.map(row => [row.queue, row.count]), [['a', 9], ['b', 3]]);
    assert.strictEqual(jobMatch({ script: 'GlideEventManager("q").process();' }, 'q'), 'script');
    assert.strictEqual(jobMatch({ name: 'events process q', script: '' }, 'q'), 'job name');
    assert.strictEqual(jobMatch({ name: 'unrelated job', script: '' }, 'q'), null);
  });
});
