// Ordered results with at most four independent reads in flight. Callers must
// finish dependency discovery before scheduling; this helper never retries.
export async function boundedReads(items, read) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await read(items[index], index);
    }
  }));
  return results;
}
