/**
 * The polling engine behind `jsn logs follow`.
 *
 * Two behaviors matter here and neither is visible from the command handler:
 *
 *  1. One request in flight. A poll that outlives the interval must not start a
 *     second one; a chained timer delays the next tick until the current one
 *     finished instead of firing on a fixed grid.
 *  2. A continuation that cannot lose rows. sys_created_on has second
 *     precision, so `sys_created_on>watermark` silently drops every row created
 *     in the same second as the last one printed. The query uses `>=` and the
 *     duplicate that buys is filtered by a set of sys_ids at the current
 *     watermark second, which is also as large as the memory can get: the set is
 *     cleared every time the watermark moves to a newer second.
 */
import { getStringField } from './helpers.js';

/** Rows per request. Also the signal that a cycle should keep draining. */
export const PAGE_SIZE = 100;
/** How many pages one cycle may drain before waiting for the next tick. */
export const MAX_PAGES_PER_CYCLE = 5;

/** sys_created_on as the raw UTC `YYYY-MM-DD HH:mm:ss` the query compares against. */
export function queryTimestamp(value) {
  if (typeof value !== 'string') return value;
  return value.replace('T', ' ').replace(/\.\d{1,3}[Zz]?$/, '').replace(/[Zz]$/, '');
}

/** A row's creation stamp, preferring the raw value over the instance-local display. */
export function recordTimestamp(record) {
  const field = record?.sys_created_on;
  if (field && typeof field === 'object') {
    const value = field.value != null ? field.value : field.display_value;
    return value ? queryTimestamp(String(value)) : '';
  }
  return field ? queryTimestamp(String(field)) : '';
}

function dedupeKey(record, timestamp) {
  const id = getStringField(record, 'sys_id');
  if (id) return id;
  // syslog always has a sys_id; a fixture or proxy without one still must not
  // re-print the same line every second, so fall back to the content.
  return `noid:${timestamp}|${getStringField(record, 'source')}|${getStringField(record, 'message')}`;
}

export function createLogFollower({
  list,
  write,
  warn = () => {},
  intervalMs = 2000,
  pageSize = PAGE_SIZE,
  maxPagesPerCycle = MAX_PAGES_PER_CYCLE,
  baseQuery = '',
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let watermark = '';
  let seen = new Set();
  let timer = null;
  let running = false;
  let inFlight = false;
  let stopped = false;

  const queryNow = (order) => {
    const parts = [];
    if (baseQuery) parts.push(baseQuery);
    if (watermark) parts.push(`sys_created_on>=${watermark}`);
    parts.push(order);
    return parts.join('^');
  };

  const paramsFor = ({ order, limit }) => {
    const params = new URLSearchParams();
    params.set('sysparm_display_value', 'all');
    params.set('sysparm_fields', 'sys_created_on,level,source,message,sys_id');
    params.set('sysparm_limit', String(limit));
    params.set('sysparm_query', queryNow(order));
    return params;
  };

  /** Writes a row and returns true when it is new. */
  const emit = (record) => {
    const timestamp = recordTimestamp(record);
    if (timestamp && watermark && timestamp < watermark) return false;
    if (timestamp && timestamp > watermark) {
      watermark = timestamp;
      seen = new Set(); // nothing older than the new watermark can be returned again
    }
    const key = dedupeKey(record, timestamp);
    if (seen.has(key)) return false;
    seen.add(key);
    write(record);
    return true;
  };

  const readPage = async (limit) => {
    try {
      return await list(paramsFor({ order: 'ORDERBYsys_created_on', limit }));
    } catch (error) {
      warn(error);
      return null;
    }
  };

  /**
   * One cycle. Returns what happened so a caller (or a test) can assert it
   * without watching stdout.
   */
  const pollOnce = async () => {
    if (stopped) return { skipped: true, pages: 0, emitted: 0 };
    if (inFlight) return { skipped: true, pages: 0, emitted: 0 };
    inFlight = true;
    let pages = 0;
    let emitted = 0;
    try {
      while (pages < maxPagesPerCycle && !stopped) {
        const records = await readPage(pageSize);
        if (records == null) break;
        pages += 1;
        let fresh = 0;
        for (const record of records) {
          if (emit(record)) fresh += 1;
        }
        emitted += fresh;
        // A short page is the end of the backlog. A page with nothing new means
        // the continuation did not advance, so another request would repeat it.
        if (records.length < pageSize || fresh === 0) break;
      }
    } finally {
      inFlight = false;
    }
    return { skipped: false, pages, emitted };
  };

  /**
   * Show the newest `count` rows oldest-first, then continue from there. A zero
   * count still reads the newest row, unprinted, so following starts at now
   * instead of at the oldest retained row.
   */
  const backfill = async (count) => {
    const tail = count > 0;
    const params = new URLSearchParams();
    params.set('sysparm_display_value', 'all');
    params.set('sysparm_fields', 'sys_created_on,level,source,message,sys_id');
    params.set('sysparm_limit', String(tail ? count : 1));
    const order = 'ORDERBYDESCsys_created_on';
    // The start row needs no filter: an undated filtered read spans every rotation shard and can time out.
    params.set('sysparm_query', baseQuery && tail ? `${baseQuery}^${order}` : order);
    let records;
    try {
      records = await list(params);
    } catch (error) {
      warn(error);
      return { emitted: 0, failed: true, error };
    }
    if (!tail) {
      const [newest] = records;
      if (newest) {
        watermark = recordTimestamp(newest);
        seen = new Set([dedupeKey(newest, watermark)]);
      }
      return { emitted: 0 };
    }
    let emitted = 0;
    for (const record of [...records].reverse()) {
      if (emit(record)) emitted += 1;
    }
    return { emitted };
  };

  const tick = async () => {
    if (!running) return;
    await pollOnce();
    if (!running || stopped) return;
    timer = setTimer(tick, intervalMs);
  };

  const start = () => {
    if (running) return;
    running = true;
    void tick();
  };

  const stop = () => {
    stopped = true;
    running = false;
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
  };

  return {
    start,
    stop,
    pollOnce,
    backfill,
    get watermark() { return watermark; },
    get seenSize() { return seen.size; },
    get inFlight() { return inFlight; },
  };
}
