// Offline developer measurements. No timing threshold and no live credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import Database from '../../src/sqlite.js';
import { startDocumentationServer } from '../../src/commands/docs/server.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../bin/jsn.js', import.meta.url));
const fixturePath = new URL('../fixtures/bounded-baseline/fixture.json', import.meta.url);
export const budgetPath = new URL('../fixtures/bounded-baseline/bytes.json', import.meta.url);
export const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
export function statistics(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return { median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1] };
}
// CSV RFC-style quoting, including embedded delimiters, quotes and newlines.
export function cells(text, format) {
  if (format === 'tsv') return text.slice(0, -1).split('\n').map(line => line.split('\t').map(cell =>
    cell.replace(/\\([\\tnr])/g, (_, c) => ({ '\\': '\\', t: '\t', n: '\n', r: '\r' })[c])));
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (c === ',' || c === '\n')) {
      row.push(cell); cell = ''; if (c === '\n') { rows.push(row); row = []; }
    } else cell += c;
  }
  assert.equal(quoted, false, 'unterminated CSV');
  assert.equal(cell, ''); assert.deepEqual(row, []);
  return rows;
}
export function checkBudgets(cases, budgets) {
  assert.deepEqual(Object.keys(budgets.cases).sort(), cases.map(c => c.id).sort(), 'budget case inventory');
  for (const c of cases) for (const sample of c.samples) {
    for (const key of ['stdout_bytes', 'stderr_bytes']) assert.ok(sample[key] <= budgets.cases[c.id][key],
      `${c.id} ${key}: ${sample[key]} exceeds fixture ceiling ${budgets.cases[c.id][key]}`);
  }
}

export async function measureBaseline({ repetitions = 5, budgets } = {}) {
  assert.ok(Number.isInteger(repetitions) && repetitions >= 3, 'at least three repetitions');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-bounded-'));
  const calls = [], violations = [];
  let docs;
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture');
      calls.push({ method: req.method, path: url.pathname });
      assert.equal(req.method, 'GET');
      if (url.pathname === '/api/now/table/sys_user') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ result: [] })); }
      if (url.pathname === '/api/now/table/sys_db_object' || url.pathname === '/api/now/table/sys_dictionary') {
        const query = url.searchParams.get('sysparm_query');
        const target = fixture.tables.find(t => query === `name=${t.table}` || query === `nameIN${t.table}^elementISNOTEMPTY`);
        assert.ok(target, 'metadata stays table-scoped');
        const result = url.pathname.endsWith('/sys_db_object') ? [{ sys_id: 'a'.repeat(32), name: target.table, super_class: '' }]
          : [...new Set([...target.fields, 'active', 'priority'])].map(element => ({ name: target.table, element, internal_type: 'string', reference: '' }));
        res.setHeader('X-Total-Count', String(result.length)); res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ result }));
      }
      const table = fixture.tables.find(t => url.pathname.endsWith('/' + t.table));
      assert.ok(table, 'known table only');
      assert.equal(url.searchParams.get('sysparm_query'), table.query);
      let result;
      if (url.pathname === '/api/now/stats/' + table.table) {
        assert.equal(url.searchParams.get('sysparm_count'), 'true');
        result = { stats: { count: '7' } };
      } else {
        assert.equal(url.pathname, '/api/now/table/' + table.table);
        assert.deepEqual([...new Set(url.searchParams.get('sysparm_fields').split(','))], table.fields);
        assert.equal(url.searchParams.get('sysparm_limit'), '2');
        assert.equal(url.searchParams.get('sysparm_offset'), '0');
        assert.equal(url.searchParams.get('sysparm_display_value'), 'false');
        assert.equal(url.searchParams.get('sysparm_exclude_reference_link'), 'true');
        result = table.rows;
      }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ result }));
    } catch (error) { violations.push(error.message); res.writeHead(500); res.end(JSON.stringify({ error: { message: error.message } })); }
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const instance = `http://127.0.0.1:${server.address().port}`;
    const preload = path.join(root, 'auth.mjs');
    fs.writeFileSync(preload, `import { AuthManager } from ${JSON.stringify(new URL('../../src/auth.js', import.meta.url).href)};
AuthManager.prototype.createProfileProvider = () => ({ getCredentials: async () => ({ auth_method: 'gck', access_token: 'offline-fixture' }) });
const original = globalThis.fetch;
globalThis.fetch = (request, options) => {
 const url = new URL(request.url || request);
 if ((request.method || options?.method || 'GET') !== 'GET') throw new Error('Offline GET-only boundary');
 if (url.origin === 'https://fixture.example.test') return original(new Request(${JSON.stringify(instance)} + url.pathname + url.search, request), options);
 if (url.hostname !== '127.0.0.1') throw new Error('Offline host boundary');
 return original(request, options);
};`);
    const d = fixture.document;
    const db = new Database(path.join(root, 'docs.sqlite3'));
    db.exec('CREATE TABLE meta(key TEXT, value TEXT); CREATE TABLE docs(id INTEGER, path TEXT, title TEXT, bundle TEXT, doc_type TEXT, release TEXT, body TEXT)');
    db.prepare('INSERT INTO meta VALUES(?, ?)').run('source_revision', d.revision);
    db.prepare('INSERT INTO docs VALUES(1, ?, ?, NULL, NULL, ?, ?)').run(d.path, d.title, d.release, d.body);
    db.close();
    docs = await startDocumentationServer({ storage: root, refresh: false });
    const docCalls = [];
    docs.server.on('request', req => docCalls.push({ method: req.method, path: new URL(req.url, 'http://fixture').pathname }));
    // Deliberately do not inherit user auth, NODE_OPTIONS, proxy, or provider configuration.
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, TMPDIR: root,
      XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root, JSN_CONFIG_HOME: root, JSN_DATA_HOME: root,
      JSN_DOCS_URL: docs.url, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1', JSN_NO_HEADER: '1' };
    const cases = [];
    async function measure(id, args, validate, requestLog, expectedCalls, rowCount) {
      const samples = [];
      for (let n = 0; n < repetitions; n++) {
        const before = requestLog.length, start = performance.now();
        const { stdout, stderr } = await exec(process.execPath, ['--import', pathToFileURL(preload).href, cli, ...args],
          { env, cwd: root, timeout: 15000, maxBuffer: 1024 * 1024 });
        const elapsed = performance.now() - start;
        validate(stdout, stderr);
        assert.deepEqual(violations, []);
        const allRequests = requestLog.slice(before);
        const validationRequests = allRequests.filter(r => /^\/api\/now\/table\/sys_(?:user|db_object|dictionary)$/.test(r.path));
        if (!id.startsWith('docs/')) assert.equal(validationRequests.length, 3, 'bounded identity and table metadata reads');
        const requests = allRequests.filter(r => !validationRequests.includes(r));
        assert.equal(requests.length, expectedCalls, id + ' request count');
        assert.ok(requests.every(r => r.method === 'GET'));
        samples.push({ elapsed_ms: elapsed, stdout_bytes: Buffer.byteLength(stdout), stderr_bytes: Buffer.byteLength(stderr),
          rows: rowCount, http_calls: requests.length, count_calls: requests.filter(r => r.path.startsWith('/api/now/stats/')).length });
      }
      cases.push({ id, command: ['node', 'cli/bin/jsn.js', ...args.map(a => a === instance ? '<loopback-instance>' : a)],
        elapsed_ms: statistics(samples.map(s => s.elapsed_ms)), samples });
    }
    for (const t of fixture.tables) for (const count of [false, true]) for (const format of ['json', 'csv', 'tsv']) {
      const id = `${t.table}/${count ? 'count' : 'no-count'}/${format}`;
      await measure(id, ['records', 'list', '--instance', 'https://fixture.example.test', '--table', t.table, '--fields', t.fields.join(','),
        '--query', t.query, '--offset', '0', '--limit', '2', '--display-values', 'raw', count ? '--count' : '--no-count', '--format', format],
      (stdout, stderr) => {
        if (format === 'json') {
          const output = JSON.parse(stdout); assert.equal(output.ok, true);
          assert.deepEqual(output.data.records, t.rows); assert.deepEqual(output.data.columns, t.fields);
          assert.equal(output.data.pagination.total, count ? 7 : undefined);
        } else assert.deepEqual(cells(stdout, format), [t.fields, ...t.rows.map(row => t.fields.map(f => row[f]))]);
        assert.equal(stderr, count && format !== 'json' ? `${format.toUpperCase()} pagination: returned 2 of 7 records; more available; next offset 2.\n` : '');
      }, calls, count ? 2 : 1, t.rows.length);
    }
    for (const mode of ['full', 'outline', 'section']) {
      await measure(`docs/${mode}`, ['docs', '--path', d.path, '--json', ...(mode === 'full' ? [] : [mode === 'outline' ? '--outline' : '--section', ...(mode === 'section' ? [d.section] : [])])],
        (stdout, stderr) => {
          assert.equal(stderr, ''); const result = JSON.parse(stdout); assert.equal(result.ok, true);
          const data = result.data; assert.equal(data.revision, d.revision); assert.equal(data.release, d.release);
          assert.equal(Object.hasOwn(data, '_formatted'), false);
          if (mode === 'full') assert.equal(data.body, d.body);
          else {
            assert.equal(data.retrieval.semantic_completeness, 'unknown');
            assert.equal(data.retrieval.document_complete, false); assert.equal(data.retrieval.truncated, false);
            assert.equal(data.retrieval.execution, 'service'); assert.equal(data.retrieval.full_document_transferred, false);
            if (mode === 'outline') { assert.equal(Object.hasOwn(data, 'body'), false); assert.deepEqual(data.outline.map(h => h.title), d.outline_titles); }
            else { assert.equal(data.body, d.expected_section_body); assert.equal(data.retrieval.subtree_complete, true); }
          }
        }, docCalls, 1, 1);
    }
    const fixtureHash = createHash('sha256').update(fs.readFileSync(fixturePath)).digest('hex');
    if (budgets) {
      assert.equal(fixtureHash, budgets.fixture_sha256, 'fixture changes require deliberate rebaseline');
      checkBudgets(cases, budgets);
    }
    const countOverhead = fixture.tables.map(t => {
      const median = count => cases.find(c => c.id === `${t.table}/${count}/json`).elapsed_ms.median;
      return { table: t.table, median_count_minus_no_count_ms: median('count') - median('no-count'), extra_http_calls: 1 };
    });
    return { schema_version: 1, status: 'pass', provider: 'offline-loopback-fixture', process: 'cold fresh CLI per sample',
      cache: 'OS caches uncontrolled; HTTP fixture service warm; no warm CLI mode', repetitions,
      timing: 'monotonic CLI end-to-end including startup, fixture auth, HTTP, parsing, output and exit; not backend latency; measurement only',
      tokenizer: { status: 'unavailable', reason: 'No existing tokenizer dependency; bytes are not tokens' },
      version: JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url))).version, node: process.version,
      fixture_sha256: createHash('sha256').update(fs.readFileSync(fixturePath)).digest('hex'),
      live_dual_vendor: 'not exercised; integration pending PR490', cases, count_overhead: countOverhead };
  } finally {
    if (docs) await new Promise(resolve => docs.server.close(resolve));
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
