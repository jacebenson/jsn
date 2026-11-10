// Deterministic public-service transport for real CLI subprocesses.
import fs from 'node:fs';
globalThis.fetch = async input => {
  const url = new URL(input);
  fs.appendFileSync(process.env.DOCS_TEST_REQUESTS, url.href + '\n');
  const scenario = JSON.parse(fs.readFileSync(process.env.DOCS_TEST_SCENARIO, 'utf8'));
  if (scenario.offline) throw new Error('offline fixture');
  if (scenario.status) return Response.json({ error: scenario.error, hint: scenario.hint }, { status: scenario.status });
  if (url.pathname.endsWith('manifest.json')) {
    if (scenario.legacy && url.pathname.includes('/releases/')) return Response.json({}, { status: 404 });
    return Response.json(scenario.manifest);
  }
  if (url.pathname.endsWith('.gz')) return new Response(fs.readFileSync(scenario.artifact));
  const release = scenario.responseRelease === undefined ? {} : { release: scenario.responseRelease };
  if (url.pathname === '/api/docs/search') return Response.json({ ...release, revision: 'abcdef0', total: 1, count: 1, results: [{ id: 1, path: 'record.md', title: 'Record' }] });
  if (url.pathname === '/api/docs/status') return Response.json({ ...release, state: 'ready' });
  return Response.json({ ...release, revision: 'abcdef0', document: { id: 1, path: 'record.md', title: 'Record', body: 'Documentation body' } });
};
