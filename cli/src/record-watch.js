// Record watching: bounded observation of one ServiceNow record over AMB.
//
// The AMB client (src/amb.js) owns the wire protocol. This module owns the
// observation session: what counts as an event, when to fetch the record to
// fill in detail the notification omitted, bounded duration, cancellation,
// reconnect backoff and — most importantly — honest gap reporting.
//
// A record-watcher subscription is best-effort delivery, not a durable
// stream. After a disconnect the platform does not replay what was missed,
// so this module reports a gap instead of pretending the event list is
// complete.

import { AppError, CodeUsage } from './errors.js';
import { normalizeRecordWatcherEvent, recordWatcherChannel } from './amb.js';

export const DEFAULT_RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}

/** Does the notification carry enough detail that a follow-up read is redundant? */
export function notificationHasDetail(event) {
  return Boolean(event?.record) || (Array.isArray(event?.changes) && event.changes.length > 0);
}

/**
 * Watch one record until a bound is reached, the caller cancels, or a fatal
 * error occurs.
 *
 * @param {object} opts
 * @param {{ start: Function, next: Function, stop: Function }} opts.client
 * @param {string} opts.table
 * @param {string} opts.sysID
 * @param {string} [opts.query] — encoded query; defaults to `sys_id=<sysID>`
 * @param {number} [opts.timeoutMs] — 0 means "until cancelled"
 * @param {number} [opts.maxEvents] — 0 means unlimited
 * @param {AbortSignal} [opts.signal]
 * @param {'auto'|'always'|'never'} [opts.statePolicy]
 * @param {() => Promise<object|null>} [opts.fetchState]
 * @param {(event: object) => any} [opts.onEvent]
 * @param {(status: object) => any} [opts.onStatus]
 * @param {boolean} [opts.reconnect]
 * @param {number[]} [opts.reconnectDelays]
 * @param {() => number} [opts.now]
 * @param {Function} [opts.sleep]
 */
export async function watchRecord({
  client,
  table,
  sysID,
  query,
  timeoutMs = 0,
  maxEvents = 0,
  signal,
  statePolicy = 'auto',
  fetchState,
  onEvent = () => {},
  onStatus = () => {},
  reconnect = true,
  reconnectDelays = DEFAULT_RECONNECT_DELAYS,
  now = () => Date.now(),
  sleep = defaultSleep,
}) {
  if (!client) throw new AppError(CodeUsage, 'Record watch needs an AMB client.');
  if (!table) throw new AppError(CodeUsage, 'Record watch needs a table.');
  if (!sysID) throw new AppError(CodeUsage, 'Record watch needs a record sys_id.');
  if (!['auto', 'always', 'never'].includes(statePolicy)) {
    throw new AppError(CodeUsage, `Unknown state policy: ${statePolicy}`);
  }
  if (timeoutMs < 0 || maxEvents < 0) throw new AppError(CodeUsage, 'Watch bounds cannot be negative.');
  if (statePolicy !== 'never' && typeof fetchState !== 'function') {
    throw new AppError(CodeUsage, 'State fetching is enabled but no record reader was supplied.');
  }

  const channel = recordWatcherChannel(table, query || `sys_id=${sysID}`);
  const startedAt = now();
  const startedISO = new Date(startedAt).toISOString();
  const deadline = timeoutMs > 0 ? startedAt + timeoutMs : Infinity;

  let events = 0;
  let gaps = 0;
  let attempts = 0;
  let lastEventAt = null;
  let connected = false;
  let reason = 'timeout';

  const finish = async (why) => {
    reason = why;
    try { await client.stop([channel]); } catch { /* unsubscription is best effort */ }
    onStatus({ type: 'unsubscribed', reason: why });
    const endedAt = now();
    return {
      type: 'watch_summary',
      table,
      sys_id: sysID,
      channel,
      reason: why,
      events,
      gaps,
      reconnects: Math.max(0, gaps),
      complete: gaps === 0 && reason !== 'error',
      started_at: startedISO,
      ended_at: new Date(endedAt).toISOString(),
      duration_ms: Math.max(0, endedAt - startedAt),
      last_event_at: lastEventAt,
    };
  };

  onStatus({ type: 'connecting', table, sys_id: sysID, channel });

  try {
    while (true) {
      const remaining = deadline - now();
      if (remaining <= 0) return await finish('timeout');
      if (signal?.aborted) return await finish('cancelled');

      if (!connected) {
        const session = await client.start([channel]);
        connected = true;
        attempts = 0;
        const resumed = gaps > 0;
        onStatus({
          type: resumed ? 'reconnected' : 'subscribed',
          channel,
          ...(session?.sessionStatus ? { session_status: session.sessionStatus } : {}),
          // State the limitation, do not imply the stream was continuous.
          ...(resumed ? { may_have_missed_events: true, gaps } : {}),
        });
      }

      let messages;
      try {
        messages = await client.next({ timeoutMs: Math.min(remaining, 60000), signal });
      } catch (error) {
        if (signal?.aborted) return await finish('cancelled');
        if (deadline - now() <= 0) return await finish('timeout');
        if (error?.fatal === true || !reconnect) throw error;

        // A dropped connection is a real gap in observation, not a retry note.
        gaps += 1;
        const gapStart = lastEventAt || startedISO;
        const gapAt = new Date(now()).toISOString();
        onStatus({
          type: 'gap',
          at: gapAt,
          since: gapStart,
          reason: error?.message || String(error),
          code: error?.code || null,
        });
        connected = false;
        const wait = reconnectDelays[Math.min(attempts, reconnectDelays.length - 1)];
        attempts += 1;
        const waitedUntil = now() + wait;
        while (now() < waitedUntil && !signal?.aborted && now() < deadline) {
          await sleep(Math.min(wait, Math.max(1, waitedUntil - now())), signal);
        }
        continue;
      }

      for (const message of messages) {
        if (signal?.aborted) return await finish('cancelled');
        const event = normalizeRecordWatcherEvent(message, { table, sysID }, new Date(now()).toISOString());
        // The channel query scopes delivery to this record. The live payload
        // does not carry a sys_id (jsn fills it from the subscription), so this
        // guard only bites on an instance that does send one — for example a
        // table-level channel returning a different record.
        if (event.sys_id && sysID && event.sys_id !== sysID) continue;

        const shouldFetch = statePolicy === 'always'
          || (statePolicy === 'auto' && !notificationHasDetail(event));
        if (shouldFetch) {
          try {
            const record = await fetchState();
            event.state = { source: 'fetched', fetched_at: new Date(now()).toISOString(), record };
          } catch (error) {
            // Never let a failed follow-up read masquerade as a failed or
            // complete event; keep the notification and record the problem.
            event.state = null;
            event.state_error = {
              code: error?.code || null,
              message: error?.message || String(error),
            };
          }
        }

        events += 1;
        lastEventAt = event.received_at;
        await onEvent(event);
        if (maxEvents > 0 && events >= maxEvents) return await finish('max_events');
      }
    }
  } catch (error) {
    await finish('error');
    throw error;
  }
}
