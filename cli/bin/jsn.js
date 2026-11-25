#!/usr/bin/env node

// A pipeline consumer may exit before JSN finishes writing. Treat that
// expected closed-pipe condition as a clean CLI exit, not an unhandled error.
// An --impersonate command finishes first, so its session still ends.
let loaded;
process.stdout.on('error', (err) => {
  if (err.code !== 'EPIPE') throw err;
  if (!loaded?.impersonating()) process.exit(0);
});

import('../src/cli.js').then(async (m) => {
  loaded = m;
  try {
    await m.cli.parse();
  } finally {
    m.cancelBackgroundChecks();
  }
});
