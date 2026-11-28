// Behavior of the `logs follow` polling engine: one request in flight, a
// continuation that loses no rows, and dedupe memory bounded to one second.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createLogFollower, queryTimestamp, recordTimestamp } from '../src/log-follow.js';

const rec = (id, value, message = id) => ({
  sys_id: { value: id, display_value: id },
  sys_created_on: { value, display_value: value.replace('T', ' ').replace('Z', '') },
  level: 'error',
  source: 'sys_script',
  message,
});

/** A follower wired to a scripted list and an array sink. */
function harness({ pages = [], pageSize = 100, defer, baseQuery } = {}) {
  const written = [];
  const warnings = [];
  const queries = [];
  let call = 0;
  const list = async (params) => {
    queries.push(params.get('sysparm_query'));
    const page = pages[Math.min(call, pages.length - 1)];
    call += 1;
    if (defer) await defer(call);
    return typeof page === 'function' ? page(params) : (page ?? []);
  };
  const follower = createLogFollower({
    list,
    write: (record) => written.push(record.sys_id.value),
    warn: (error) => warnings.push(error.message),
    pageSize,
    baseQuery,
  });
  return { follower, written, warnings, queries };
}

describe('log follow timestamps', () => {
  it('normalises a raw UTC stamp to the query form', () => {
    assert.strictEqual(queryTimestamp('2026-11-26T05:00:01Z'), '2026-11-26 05:00:01');
    assert.strictEqual(queryTimestamp('2026-11-26T05:00:01.123Z'), '2026-11-26 05:00:01');
  });

  it('prefers the raw value over the server-local display value', () => {
    assert.strictEqual(
      recordTimestamp({ sys_created_on: { value: '2026-11-26T05:00:01Z', display_value: '2026-11-25 23:00:01' } }),
      '2026-11-26 05:00:01',
    );
  });
});

describe('log follow polling', () => {
  it('does not start a second request while one is in flight', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { follower } = harness({ pages: [[rec('a', '2026-11-26T05:00:01Z')]], defer: () => gate });

    const first = follower.pollOnce();
    const second = await follower.pollOnce();
    assert.strictEqual(second.skipped, true);
    assert.strictEqual(follower.inFlight, true);

    release();
    await first;
    assert.strictEqual(follower.inFlight, false);
  });

  it('uses a >= continuation so rows in the last printed second are not lost', async () => {
    const { follower, written, queries } = harness({
      pages: [
        [rec('a', '2026-11-26T05:00:01Z')],
        [rec('a', '2026-11-26T05:00:01Z'), rec('b', '2026-11-26T05:00:01Z')],
      ],
    });

    await follower.pollOnce();
    await follower.pollOnce();

    assert.deepStrictEqual(written, ['a', 'b']);
    assert.match(queries[1], /sys_created_on>=2026-11-26 05:00:01/);
  });

  it('never prints the same row twice across polls', async () => {
    const rows = [rec('a', '2026-11-26T05:00:01Z'), rec('b', '2026-11-26T05:00:02Z')];
    const { follower, written } = harness({ pages: [rows, rows, rows] });

    await follower.pollOnce();
    await follower.pollOnce();
    await follower.pollOnce();

    assert.deepStrictEqual(written, ['a', 'b']);
  });

  it('keeps dedupe memory to the rows of the current second', async () => {
    const { follower, written } = harness({
      pages: [
        [rec('a', '2026-11-26T05:00:01Z'), rec('b', '2026-11-26T05:00:01Z')],
        [rec('c', '2026-11-26T05:00:02Z')],
      ],
    });

    await follower.pollOnce();
    assert.strictEqual(follower.seenSize, 2);
    await follower.pollOnce();
    assert.strictEqual(follower.seenSize, 1);
    assert.deepStrictEqual(written, ['a', 'b', 'c']);
  });

  it('drains a full page in the same cycle and stops on a short one', async () => {
    const { follower, written, queries } = harness({
      pageSize: 2,
      pages: [
        [rec('a', '2026-11-26T05:00:01Z'), rec('b', '2026-11-26T05:00:01Z')],
        [rec('c', '2026-11-26T05:00:02Z')],
      ],
    });

    const result = await follower.pollOnce();

    assert.strictEqual(queries.length, 2);
    assert.strictEqual(result.pages, 2);
    assert.deepStrictEqual(written, ['a', 'b', 'c']);
  });

  it('stops draining when a page adds nothing new', async () => {
    const row = rec('a', '2026-11-26T05:00:01Z');
    const { follower, queries, written } = harness({ pageSize: 1, pages: [[row], [row], [row]] });

    const result = await follower.pollOnce();

    // The first page was full, so the cycle drained once more; the repeat added
    // nothing, which is what ends the cycle instead of looping on it.
    assert.strictEqual(result.pages, 2);
    assert.strictEqual(queries.length, 2);
    assert.deepStrictEqual(written, ['a']);
  });

  it('skips a row stamped before the watermark', async () => {
    const { follower, written } = harness({
      pages: [
        [rec('b', '2026-11-26T05:00:05Z')],
        [rec('a', '2026-11-26T05:00:01Z'), rec('c', '2026-11-26T05:00:06Z')],
      ],
    });

    await follower.pollOnce();
    await follower.pollOnce();

    assert.deepStrictEqual(written, ['b', 'c']);
  });

  it('reports a failed poll without throwing, and clears the in-flight flag', async () => {
    const { follower, warnings } = harness({
      pages: [() => { throw new Error('network down'); }],
    });

    const result = await follower.pollOnce();

    assert.strictEqual(result.pages, 0);
    assert.deepStrictEqual(warnings, ['network down']);
    assert.strictEqual(follower.inFlight, false);
  });
});

describe('log follow backfill', () => {
  it('prints the newest rows oldest-first and continues from the last of them', async () => {
    const { follower, written, queries } = harness({
      pages: [
        [rec('new', '2026-11-26T05:00:03Z'), rec('old', '2026-11-26T05:00:01Z')],
        [rec('newest', '2026-11-26T05:00:04Z')],
      ],
    });

    await follower.backfill(2);
    assert.deepStrictEqual(written, ['old', 'new']);
    assert.strictEqual(follower.watermark, '2026-11-26 05:00:03');

    await follower.pollOnce();
    assert.deepStrictEqual(written, ['old', 'new', 'newest']);
    assert.match(queries[1], /sys_created_on>=2026-11-26 05:00:03/);
  });

  it('starts a zero tail count at the newest row without printing it', async () => {
    const limits = [];
    const { follower, written, queries } = harness({
      pages: [
        (params) => { limits.push(params.get('sysparm_limit')); return [rec('newest', '2026-11-26T05:00:03Z')]; },
        [rec('newest', '2026-11-26T05:00:03Z'), rec('same-second', '2026-11-26T05:00:03Z'), rec('later', '2026-11-26T05:00:04Z')],
      ],
    });

    assert.deepStrictEqual(await follower.backfill(0), { emitted: 0 });
    assert.deepStrictEqual(written, []);
    assert.deepStrictEqual(limits, ['1']);
    assert.strictEqual(queries[0], 'ORDERBYDESCsys_created_on');
    assert.strictEqual(follower.watermark, '2026-11-26 05:00:03');

    await follower.pollOnce();
    assert.match(queries[1], /^sys_created_on>=2026-11-26 05:00:03\^ORDERBYsys_created_on$/);
    assert.deepStrictEqual(written, ['same-second', 'later']);
  });

  it('reads the start row without the filter, which only the dated poll can use cheaply', async () => {
    const { follower, queries } = harness({ baseQuery: 'level=2', pages: [[rec('newest', '2026-11-26T05:00:03Z')], []] });

    await follower.backfill(0);
    await follower.pollOnce();

    assert.deepStrictEqual(queries, ['ORDERBYDESCsys_created_on', 'level=2^sys_created_on>=2026-11-26 05:00:03^ORDERBYsys_created_on']);
  });

  it('follows from the first row when the table starts empty', async () => {
    const { follower, written, queries } = harness({ pages: [[], [rec('first', '2026-11-26T05:00:01Z')]] });

    await follower.backfill(0);
    assert.strictEqual(follower.watermark, '');
    await follower.pollOnce();

    assert.strictEqual(queries[1], 'ORDERBYsys_created_on');
    assert.deepStrictEqual(written, ['first']);
  });

  it('warns on a failed backfill', async () => {
    const failed = harness({ pages: [() => { throw new Error('backfill down'); }] });
    const result = await failed.follower.backfill(5);
    assert.strictEqual(result.failed, true);
    assert.strictEqual(result.error.message, 'backfill down');
    assert.deepStrictEqual(failed.warnings, ['backfill down']);
  });
});

describe('log follow lifecycle', () => {
  it('chains the next poll only after the current one finishes', async () => {
    const timers = [];
    const written = [];
    let active = 0;
    let peak = 0;
    let call = 0;
    const follower = createLogFollower({
      list: async () => {
        active += 1;
        peak = Math.max(peak, active);
        call += 1;
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return [rec(`r${call}`, `2026-11-26T05:00:0${call}Z`)];
      },
      write: (record) => written.push(record.sys_id.value),
      intervalMs: 10,
      setTimer: (fn) => { timers.push(fn); return timers.length; },
      clearTimer: () => {},
    });

    follower.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(peak, 1);
    assert.strictEqual(timers.length, 1);

    await timers[0]();
    assert.strictEqual(peak, 1);
    assert.strictEqual(timers.length, 2);
    assert.deepStrictEqual(written, ['r1', 'r2']);
  });

  it('stops polling and clears its timer on stop', async () => {
    const timers = [];
    let cleared = 0;
    const wrapped = createLogFollower({
      list: async () => [rec('a', '2026-11-26T05:00:01Z')],
      write: () => {},
      intervalMs: 10,
      setTimer: (fn) => { timers.push(fn); return timers.length; },
      clearTimer: () => { cleared += 1; },
    });

    wrapped.start();
    await new Promise((resolve) => setImmediate(resolve));
    wrapped.stop();

    assert.strictEqual(timers.length, 1);
    assert.strictEqual(cleared, 1);
    const result = await wrapped.pollOnce();
    assert.strictEqual(result.skipped, true);
  });
});
