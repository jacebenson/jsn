// Closed report: never propagate command arguments, raw output or provider IDs.
export function taskReport(measured, catalog, catalogSHA256, sourceSHA) {
  if (measured.status !== 'pass') throw new Error('Verified baseline required');
  const tasks = catalog.tasks.map(task => {
    const entry = measured.cases.find(c => c.id === task.id);
    if (!entry || !entry.samples.length) throw new Error(`Missing measured task ${task.id}`);
    return { id: task.id, verdict: 'passed', outputMode: task.output,
      samples: entry.samples.map(s => ({ durationMs: s.elapsed_ms, stdoutBytes: s.stdout_bytes,
        stderrBytes: s.stderr_bytes, rows: s.rows,
        requestCount: { status: 'measured', value: s.http_calls, source: 'loopback HTTP server request listener' },
        outputTokens: { status: 'unavailable', value: null, provider: null, encoding: null,
          reason: 'No tokenizer installed; bytes are not tokens' } })) };
  });
  return { schemaVersion: 1, tasksetVersion: catalog.version, catalogSHA256, sourceSHA,
    testedPackage: { version: measured.version }, harness: { sourceSHA },
    target: { label: 'offline-fixture', family: null, build: null }, fixtureSHA256: measured.fixture_sha256,
    environment: { node: measured.node, process: measured.process, cache: measured.cache }, timing: measured.timing,
    cleanup: 'not-required', publicationReadback: 'unknown',
    agentGeneratedTokens: { status: 'not-collected', value: null }, cost: { status: 'not-collected', value: null },
    scope: 'six fixture tasks only; not live, cross-SDK, or full acceptance', tasks };
}
