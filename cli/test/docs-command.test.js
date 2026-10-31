import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { docsCmd } from '../src/commands/docs/docs.js';
import { captureCommands } from './support/command-test-helpers.js';
import { searchHostedDocs, getHostedDoc, getHostedDocsStatus } from '../src/commands/docs/client.js';

async function fixture(t) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    const query = url.searchParams.get('q');
    if (query === 'unavailable') { res.writeHead(503); return res.end(JSON.stringify({ error: 'Index is being prepared.' })); }
    if (query === 'rate') { res.writeHead(429); return res.end('{"error":"Slow down."}'); }
    if (query === 'html') return res.end('<html>Not the docs service</html>');
    if (query === 'invalid') return res.end('{"results":[]}');
    if (url.searchParams.get('revision') === 'old') { res.writeHead(409); return res.end('{"error":"The index changed."}'); }
    if (url.pathname === '/api/docs/status') return res.end('{"state":"ready","documents":12,"revision":"rev123"}');
    if (url.pathname === '/api/docs/search') {
      const offset = Number(url.searchParams.get('offset') || 0);
      return res.end(JSON.stringify({ query, revision: 'rev123', total: 12, count: query === 'empty' ? 0 : 1, results: query === 'empty' ? [] : [{ id: 7, path: 'api/record.md', title: 'GlideRecord', summary: 'Query records.', snippet: '# Unformatted text' }], offset }));
    }
    if (url.pathname === '/api/docs/404') { res.writeHead(404); return res.end('{"error":"Document not found."}'); }
    if (url.pathname === '/api/docs/7' || url.pathname === '/api/docs/document') return res.end(JSON.stringify({ revision: 'rev123', document: { id: 7, path: 'api/record.md', title: 'GlideRecord', body: '# GlideRecord\nline two\nline three' } }));
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { requests, serviceUrl: `http://127.0.0.1:${server.address().port}` };
}
function cli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/jsn.js', ...args], { env: { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('exit', status => resolve({ status, stdout, stderr }));
  });
}
test('docs exposes hosted search, show and status, without local index commands', () => {
  assert.deepEqual(captureCommands(docsCmd(handler => handler)).map(command => command.command), ['search <query..>', 'show <id-or-path>', 'status']);
});
test('hosted client sends only public API requests and preserves pagination, paths and revisions', async t => {
  const fixtureServer = await fixture(t);
  const result = await searchHostedDocs({ ...fixtureServer, query: 'GlideRecord', limit: 3, offset: 4, bundle: 'api' });
  assert.equal(result.results[0].summary, 'Query records.');
  assert.equal(result.offset, 4);
  assert.equal(fixtureServer.requests[0].query.bundle, 'api');
  const doc = await getHostedDoc('api/record.md', fixtureServer);
  assert.equal(doc.body, '# GlideRecord\nline two\nline three');
  await getHostedDoc('7', { ...fixtureServer, revision: 'rev123' });
  assert.equal(fixtureServer.requests.at(-1).query.revision, 'rev123');
  assert.equal((await getHostedDocsStatus(fixtureServer)).state, 'ready');
  assert.ok(fixtureServer.requests.every(request => !request.authorization));
});
test('hosted client reports unavailable, rate-limited, stale, missing and malformed responses cleanly', async t => {
  const options = await fixture(t);
  for (const [query, code] of [['unavailable', 'api_error'], ['rate', 'rate_limited'], ['html', 'api_error'], ['invalid', 'api_error']]) {
    await assert.rejects(searchHostedDocs({ ...options, query }), error => error.code === code);
  }
  await assert.rejects(getHostedDoc('7', { ...options, revision: 'old' }), error => error.status === 409 && /Search again/.test(error.hint));
  await assert.rejects(getHostedDoc('404', options), error => error.code === 'not_found');
  await assert.rejects(searchHostedDocs({ ...options, query: 'word', limit: -1 }), error => error.code === 'usage_error');
  await assert.rejects(searchHostedDocs({ serviceUrl: 'file:///tmp', query: 'word' }), error => error.code === 'usage_error');
});
test('CLI uses hosted summaries, correct next offsets, full JSON bodies and --get without a local index', async t => {
  const options = await fixture(t);
  const dir = mkdtempSync(path.join(tmpdir(), 'jsn-hosted-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { JSN_DOCS_URL: options.serviceUrl, JSN_DATA_HOME: dir };
  let result = await cli(['docs', 'search', 'GlideRecord', '--offset', '4', '--limit', '3', '--styled'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Query records/);
  assert.match(result.stdout, /7 more results.*--offset 5/);
  assert.doesNotMatch(result.stdout, /Unformatted text/);
  result = await cli(['docs', 'search', 'GlideRecord', '--markdown'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Query records/);
  result = await cli(['docs', 'show', 'api/record.md', '--lines', '1', '--json'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).data.body, '# GlideRecord\nline two\nline three');
  result = await cli(['docs', 'search', 'GlideRecord', '--get', 'data.results.0.path'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /api\/record.md/);
  result = await cli(['docs', 'search', 'empty', '--json'], env);
  assert.equal(JSON.parse(result.stdout).data.count, 0);
  result = await cli(['docs', 'status', '--json'], env);
  assert.equal(JSON.parse(result.stdout).data.state, 'ready');
  result = await cli(['docs', 'GlideRecord', 'query', '--json'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).data.query, 'GlideRecord query');
  result = await cli(['docs', '--path', 'api/record.md', '--get', 'data.path'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /api\/record.md/);
  assert.equal(existsSync(path.join(dir, 'docs', 'docs.db')), false);
  assert.equal(existsSync(path.join(dir, 'docs', 'source')), false);
});
