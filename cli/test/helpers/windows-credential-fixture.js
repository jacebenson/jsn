import assert from 'node:assert/strict';

// Synthetic targets only. Preserve the exercise failure and attempt every
// exact-target delete and absence read, even when another cleanup step failed.
export function withSyntheticCredentialCleanup(keys, operation, exercise) {
  let primary;
  let failed = false;
  try { exercise(); }
  catch (error) { primary = error; failed = true; }
  const cleanupErrors = [];
  for (const key of keys) {
    try { operation('delete', key); }
    catch (error) { cleanupErrors.push(error); }
    try { assert.equal(operation('read', key), null, 'Synthetic credential cleanup did not verify absence'); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) {
    throw new AggregateError(failed ? [primary, ...cleanupErrors] : cleanupErrors,
      failed ? 'Native credential test failed; cleanup also failed' : 'Synthetic credential cleanup failed',
      failed ? { cause: primary } : undefined);
  }
  if (failed) throw primary;
}
