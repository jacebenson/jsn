// Reproducible fixture measurement, not a ServiceNow or before/after benchmark.
import { measureRelatedReads } from '../test/support/records-performance.js';
const samples = [];
for (const mode of ['batch', 'individual', 'unsupported']) {
  for (let sample = 1; sample <= 3; sample++) samples.push({ sample, ...await measureRelatedReads({ mode, delayMs: 5 }) });
}
console.log(JSON.stringify({ schema_version: 1, measured_at: new Date().toISOString(), node: process.version,
  scope: 'Loopback HTTP SDK + related-list reader; supplied metadata; no CLI startup, live instance, auth renewal or writes',
  notes: '60 unique descriptors; default cap 50. Fixed 5ms response delay per outer HTTP request, not per batch subrequest. Timing is informational; request counts are regression-tested. No historical baseline measured.',
  samples }, null, 2));
