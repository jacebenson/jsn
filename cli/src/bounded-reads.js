// Ordered results with at most four independent reads in flight. Callers must
// finish dependency discovery before scheduling; this helper never retries.
export const BOUNDED_READ_LIMIT = 4;

export async function boundedReads(items, read) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(BOUNDED_READ_LIMIT, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await read(items[index], index);
    }
  }));
  return results;
}

/**
 * Invocation-local read deduplication. Create one per invocation and drop it
 * when that invocation ends: it holds results (and failures) for its lifetime
 * only, so nothing is shared or cached across invocations. The first caller
 * per key starts the read; every later caller awaits that same outcome.
 */
export function createReadDeduper() {
  const reads = new Map();
  return function readOnce(key, read) {
    if (!reads.has(key)) {
      const pending = Promise.resolve().then(read);
      // Every caller awaits this promise; keep a late rejection from being
      // reported as unhandled when a caller chooses not to read it.
      pending.catch(() => {});
      reads.set(key, pending);
    }
    return reads.get(key);
  };
}
