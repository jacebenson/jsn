// Record watch session contract.
//
// src/record-watch.js owns bounded observation, cancellation, state
// separation, reconnect backoff and gap reporting. These tests drive it with
// a fake AMB client and a fake clock, so every bound is deterministic and no
// test can hang waiting on a real long-poll.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/errors.js';
import { AmbError } from '../src/amb.js';
import { watchRecord, notificationHasDetail } from '../src/record-watch.js';

const SYS_ID = '0123456789abcdef0123456789abcdef';
const OTHER_ID = 'fedcba9876543210fedcba9876543210';
const CHANNEL = `/rw/default/incident/${Buffer.from(`sys_id=${SYS_ID}`).toString('base64').replace(/=/g, '-')}`;

/** A client whose `next()` runs a scripted sequence. */
function scriptedClient(steps, { startError = null } = {}) {
  let index = 0;
  const calls = { start: 0, next: 0, stop: 0, channels: null };
  return {
    calls,
    async start(channels) {
      calls.start += 1;
      calls.channels = channels;
      if (startError) throw startError;
      return { clientId: 'fake', sessionStatus: 'session.logged.in' };
    },
    async next({ signal } = {}) {
      calls.next += 1;
      if (signal?.aborted) throw new AmbError('network_error', 'cancelled');
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      if (typeof step === 'function') return step({ signal, index });
      if (step instanceof Error) throw step;
      return step ?? [];
    },
    async stop() { calls.stop += 1; },
  };
}

/** A clock whose sleeps move it forward, so bounds are deterministic. */
function fakeClock(start = 1_700_000_000_000) {
  let time = start;
  return {
    now: () => time,
    sleep: async ms => { time += ms; },
    advance: ms => { time += ms; },
  };
}

/** A `next()` step that consumes `hold` ms of fake time and yields messages. */
function after(clock, hold, messages) {
  return async () => { clock.advance(hold); return messages; };
}

const changeMessage = (overrides = {}) => ({
  channel: CHANNEL,
  id: 'evt-1',
  data: {
    table: 'incident',
    sys_id: SYS_ID,
    display_value: 'INC0010001',
    operation: 'update',
    changes: [{ field: 'assigned_to', value: 'user-1', display_value: 'Ada Lovelace', previous_value: '' }],
    ...overrides,
  },
});

const bareMessage = (overrides = {}) => ({
  channel: CHANNEL,
  id: 'evt-2',
  data: { table: 'incident', sys_id: SYS_ID, operation: 'update', ...overrides },
});

describe('notificationHasDetail', () => {
  it('treats a changes list or embedded record as sufficient detail', () => {
    assert.equal(notificationHasDetail({ changes: [{ field: 'state' }] }), true);
    assert.equal(notificationHasDetail({ record: { sys_id: SYS_ID } }), true);
    assert.equal(notificationHasDetail({ changes: [] }), false);
    assert.equal(notificationHasDetail({}), false);
  });
});

describe('watchRecord', () => {
  it('emits the notification and attaches fetched state separately', async () => {
    const clock = fakeClock();
    const client = scriptedClient([after(clock, 10, [bareMessage()])]);
    const statuses = [];
    const events = [];
    const summary = await watchRecord({
      client,
      table: 'incident',
      sysID: SYS_ID,
      maxEvents: 1,
      now: clock.now,
      sleep: clock.sleep,
      fetchState: async () => ({ sys_id: SYS_ID, state: '2', assigned_to: 'user-1' }),
      onStatus: status => statuses.push(status),
      onEvent: event => events.push(event),
    });

    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event.type, 'record_change');
    assert.equal(event.operation, 'updated');
    assert.equal(event.changes, undefined, 'the notification carried no changes');
    assert.equal(event.state.source, 'fetched');
    assert.equal(event.state.record.state, '2');
    assert.ok(event.state.fetched_at);
    assert.equal(event.record, undefined, 'fetched state must not be mixed into the event payload');

    assert.deepEqual(statuses.map(s => s.type), ['connecting', 'subscribed', 'unsubscribed']);
    assert.equal(statuses[1].channel, CHANNEL);
    assert.equal(summary.reason, 'max_events');
    assert.equal(summary.events, 1);
    assert.equal(summary.gaps, 0);
    assert.equal(summary.complete, true);
    assert.equal(client.calls.stop, 1);
    assert.deepEqual(client.calls.channels, [CHANNEL]);
  });

  for (const [policy, message, expectFetch] of [
    ['auto', changeMessage(), false],
    ['auto', bareMessage(), true],
    ['always', changeMessage(), true],
    ['never', bareMessage(), false],
  ]) {
    it(`honors --state ${policy} (${expectFetch ? 'fetches' : 'does not fetch'})`, async () => {
      const clock = fakeClock();
      const client = scriptedClient([after(clock, 10, [message])]);
      let fetches = 0;
      const events = [];
      await watchRecord({
        client,
        table: 'incident',
        sysID: SYS_ID,
        maxEvents: 1,
        statePolicy: policy,
        now: clock.now,
        sleep: clock.sleep,
        fetchState: async () => { fetches += 1; return { sys_id: SYS_ID }; },
        onEvent: event => events.push(event),
      });
      assert.equal(fetches, expectFetch ? 1 : 0);
      assert.equal(Boolean(events[0].state), expectFetch);
    });
  }

  it('keeps a failed state read separate from the change event', async () => {
    const clock = fakeClock();
    const client = scriptedClient([after(clock, 10, [bareMessage()])]);
    const events = [];
    await watchRecord({
      client,
      table: 'incident',
      sysID: SYS_ID,
      maxEvents: 1,
      now: clock.now,
      sleep: clock.sleep,
      fetchState: async () => { throw new AppError('forbidden', 'Access forbidden (HTTP 403).'); },
      onEvent: event => events.push(event),
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].state, null);
    assert.equal(events[0].state_error.code, 'forbidden');
    assert.match(events[0].state_error.message, /403/);
  });

  it('ignores events for a different record on the same table', async () => {
    const clock = fakeClock();
    const client = scriptedClient([
      after(clock, 10, [changeMessage({ sys_id: OTHER_ID }), changeMessage()]),
    ]);
    const events = [];
    const summary = await watchRecord({
      client, table: 'incident', sysID: SYS_ID, maxEvents: 1,
      statePolicy: 'never', now: clock.now, sleep: clock.sleep,
      onEvent: event => events.push(event),
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].sys_id, SYS_ID);
    assert.equal(summary.events, 1);
  });

  it('reports a gap across a reconnect and never claims completeness', async () => {
    const clock = fakeClock();
    const transportError = new AmbError('network_error', 'socket closed');
    const client = scriptedClient([
      after(clock, 100, [changeMessage()]),
      transportError,
      after(clock, 100, [changeMessage({ operation: 'change' })]),
    ]);
    const statuses = [];
    const events = [];
    const summary = await watchRecord({
      client, table: 'incident', sysID: SYS_ID, maxEvents: 2,
      statePolicy: 'never', now: clock.now, sleep: clock.sleep,
      reconnectDelays: [500, 1000],
      onStatus: status => statuses.push(status),
      onEvent: event => events.push(event),
    });

    const gap = statuses.find(s => s.type === 'gap');
    assert.ok(gap, 'a dropped connection is reported as a gap');
    assert.equal(gap.since, events[0].received_at);
    assert.match(gap.reason, /socket closed/);
    const reconnected = statuses.find(s => s.type === 'reconnected');
    assert.equal(reconnected.may_have_missed_events, true);
    assert.equal(reconnected.gaps, 1);
    assert.equal(client.calls.start, 2, 'a reconnect re-subscribes');
    assert.equal(summary.gaps, 1);
    assert.equal(summary.complete, false);
    assert.equal(summary.events, 2);
  });

  it('fails fast with --no-reconnect instead of retrying', async () => {
    const clock = fakeClock();
    const failure = new AmbError('network_error', 'socket closed');
    const client = scriptedClient([failure]);
    await assert.rejects(watchRecord({
      client, table: 'incident', sysID: SYS_ID, reconnect: false,
      statePolicy: 'never', now: clock.now, sleep: clock.sleep,
    }), /socket closed/);
    assert.equal(client.calls.stop, 1, 'the partial subscription is released');
  });

  it('does not retry a fatal auth rejection', async () => {
    const clock = fakeClock();
    const client = scriptedClient([], { startError: new AmbError('auth_error', 'AMB handshake was rejected.', 'Reauthenticate.') });
    await assert.rejects(watchRecord({
      client, table: 'incident', sysID: SYS_ID,
      statePolicy: 'never', now: clock.now, sleep: clock.sleep,
    }), /handshake/);
    assert.equal(client.calls.start, 1);
  });

  it('stops at the timeout bound and reports it', async () => {
    const clock = fakeClock();
    const client = scriptedClient([after(clock, 1000, [])]);
    const summary = await watchRecord({
      client, table: 'incident', sysID: SYS_ID, timeoutMs: 3000,
      statePolicy: 'never', now: clock.now, sleep: clock.sleep,
    });
    assert.equal(summary.reason, 'timeout');
    assert.equal(summary.events, 0);
    assert.equal(summary.complete, true);
    assert.equal(summary.duration_ms, 3000);
    assert.equal(client.calls.stop, 1);
  });

  it('cancels cleanly when the caller aborts', async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    const client = scriptedClient([
      after(clock, 10, [changeMessage()]),
      async () => {
        controller.abort();
        throw new AmbError('network_error', 'aborted');
      },
    ]);
    const events = [];
    const statuses = [];
    const summary = await watchRecord({
      client, table: 'incident', sysID: SYS_ID, signal: controller.signal,
      statePolicy: 'never', now: clock.now, sleep: clock.sleep,
      onStatus: status => statuses.push(status),
      onEvent: event => events.push(event),
    });
    assert.equal(summary.reason, 'cancelled');
    assert.equal(events.length, 1);
    assert.equal(statuses.at(-1).type, 'unsubscribed');
    assert.equal(client.calls.stop, 1);
  });

  it('validates its bounds before opening a connection', async () => {
    const client = scriptedClient([]);
    await assert.rejects(watchRecord({ client, table: 'incident', sysID: SYS_ID, timeoutMs: -1 }), /negative/);
    await assert.rejects(watchRecord({ client, table: 'incident', sysID: SYS_ID, statePolicy: 'sometimes' }), /Unknown state policy/);
    await assert.rejects(watchRecord({ client, table: 'incident' }), /sys_id/);
    assert.equal(client.calls.start, 0);
  });
});
