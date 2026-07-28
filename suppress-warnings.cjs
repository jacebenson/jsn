// Suppresses the node:sqlite ExperimentalWarning on Node 22.x.
// Loaded via NODE_OPTIONS=--require before the main ESM entry point.

const original = process.emitWarning;
process.emitWarning = function emitWarning(warning, ...args) {
  const message = typeof warning === 'string'
    ? warning
    : (warning?.message || '');
  if (message.includes('SQLite')) {
    return;
  }
  return original.apply(this, [warning, ...args]);
};
