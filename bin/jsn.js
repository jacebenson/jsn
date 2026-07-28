#!/usr/bin/env node

// Suppress the node:sqlite experimental warning on Node 22.x.
// SQLite is stable in Node 24+. The patch must be applied before any
// module imports node:sqlite, so we use a dynamic import after patching.
const originalEmitWarning = process.emitWarning;
process.emitWarning = function emitWarning(warning, ...args) {
  const message = typeof warning === 'string'
    ? warning
    : (warning?.message || '');
  if (message.includes('SQLite')) {
    return;
  }
  return originalEmitWarning.apply(this, [warning, ...args]);
};

import('../src/cli.js').then((m) => m.cli.parse());
