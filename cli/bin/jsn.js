#!/usr/bin/env node

// A pipeline consumer may exit before JSN finishes writing. Treat that
// expected closed-pipe condition as a clean CLI exit, not an unhandled error.
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

import('../src/cli.js').then(async (m) => {
  try {
    await m.cli.parse();
  } finally {
    m.cancelBackgroundChecks();
  }
});
