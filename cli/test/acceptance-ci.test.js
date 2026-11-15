import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import test from 'node:test';
import { load } from 'js-yaml';
import { validateProjection, publishResults } from '../../scripts/acceptance/publish.mjs';
import { runAndPublish } from '../../scripts/acceptance/ci.mjs';
import { prepare, HARNESS_SHA } from '../../scripts/acceptance/prepare.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sha = 'a'.repeat(40), token = 'private-mock-token-'.repeat(3);
const fixture = (failed = false) => ({ schemaVersion: 1, runKey: `acceptance_${'b'.repeat(32)}`, mode: 'readonly',
  provenance: { sourceSHA: sha, version: '5.4.0', node: process.version, binarySHA256: 'c'.repeat(64), sourceDirty: false },
  platform: 'linux', environment: { domainSeparation: 'UNKNOWN' }, selection: { full: false, selected: ['readonly.records'] },
  summary: { total: 1, counts: { [failed ? 'failed' : 'passed']: 1 }, complete: !failed, missingCount: 0 }, performance: null,
  results: [{ id: 'readonly.records', status: failed ? 'failed' : 'passed', durationMs: 12.5 }],
});
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-ci-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function server(t, handler) {
  const s = http.createServer(handler);
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { s.closeAllConnections(); s.close(resolve); }));
  return `http://127.0.0.1:${s.address().port}/api/acceptance/runs`;
}
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }

test('closed projection rejects raw provider data and dishonest status/counts', () => {
  validateProjection(fixture());
  for (const change of [p => { p.hostname = 'private'; }, p => { p.results[0].script = 'private'; }, p => { p.summary.complete = false; }, p => { p.results[0].id = 'readonly.unknown'; }, p => { p.provenance.version = 'private.service-now.com'; }]) {
    const p = fixture(); change(p); assert.throws(() => validateProjection(p));
  }
});

test('HTTP auth, exact-key duplicate retry, failed-run publication, conflict and readback', async t => {
  const dir = temporary(t), file = path.join(dir, 'projection.json');
  const p = fixture(true); fs.writeFileSync(file, JSON.stringify(p));
  const posts = [], reads = [];
  let persisted;
  const url = await server(t, async (req, res) => {
    if (req.method === 'GET') {
      reads.push(req.headers.authorization);
      assert.equal(req.url, `/results/${p.runKey}`);
      res.end(`${sha} 5.4.0`); return;
    }
    let body = ''; for await (const chunk of req) body += chunk;
    if (req.headers.authorization !== `Bearer ${token}`) { json(res, 401, { error: 'unauthorized' }); return; }
    posts.push(body); validateProjection(JSON.parse(body));
    if (!persisted) { persisted = body; req.socket.destroy(); return; } // persisted but response lost
    if (persisted !== body) { json(res, 409, { error: 'run key conflict' }); return; }
    json(res, 200, { status: 'duplicate', runKey: p.runKey });
  });
  assert.equal((await publishResults({ file, url, token: 'wrong'.repeat(10) })).httpStatus, 401);
  const outcome = await publishResults({ file, url, token });
  assert.equal(outcome.result, 'duplicate'); assert.equal(outcome.ok, true);
  assert.equal(posts.length, 2); assert.equal(posts[0], posts[1]);
  assert.deepEqual(reads, [undefined]); assert.equal(JSON.parse(persisted).results[0].status, 'failed');
  assert.ok(!persisted.includes(token));
  const changed = fixture(); fs.writeFileSync(file, JSON.stringify(changed));
  assert.equal((await publishResults({ file, url, token })).result, 'conflict');
});

test('HTTP rejection, redirects and transport errors stay visible without token leakage', async t => {
  const dir = temporary(t), file = path.join(dir, 'projection.json');
  fs.writeFileSync(file, JSON.stringify(fixture()));
  let status = 422, count = 0;
  const url = await server(t, (req, res) => { count++; res.writeHead(status, { Location: '/stolen' }); res.end('private response'); });
  assert.equal((await publishResults({ file, url, token })).httpStatus, 422);
  assert.equal(count, 1);
  status = 302; count = 0;
  assert.equal((await publishResults({ file, url, token })).ok, false);
  assert.equal(count, 3); // original endpoint retried, redirect never followed
  await assert.rejects(() => publishResults({ file, url: 'https://user:secret@example.com', token }));
  await assert.rejects(() => publishResults({ file, url: 'http://example.com', token }));
  status = 503; count = 0;
  const failed = await publishResults({ file, url, token });
  assert.equal(failed.httpStatus, 503); assert.equal(count, 3);
});

test('accepted response needs matching run key and actual public revision readback', async t => {
  const dir = temporary(t), file = path.join(dir, 'projection.json');
  const p = fixture(); fs.writeFileSync(file, JSON.stringify(p));
  let read = false, key = p.runKey;
  const url = await server(t, (req, res) => {
    if (req.method === 'GET') { res.end(read ? `${sha} 5.4.0` : 'stale'); return; }
    json(res, 201, { status: 'accepted', runKey: key });
  });
  assert.equal((await publishResults({ file, url, token })).result, 'readback-failed');
  read = true; assert.equal((await publishResults({ file, url, token })).result, 'accepted');
  key = 'wrong'; assert.equal((await publishResults({ file, url, token })).result, 'rejected');
});

test('nonzero or thrown suite still uploads partial, restores pass, refuses missing evidence', async t => {
  const dir = temporary(t), file = path.join(dir, 'private.json');
  let published = 0;
  const runCase = async (name, run) => runAndPublish({ run, file, publicFile: path.join(dir, `${name}.json`), expectedSHA: sha,
    publish: async ({ file: f }) => { const p = validateProjection(JSON.parse(fs.readFileSync(f))); assert.equal(p.results[0].status, name === 'restored' ? 'passed' : 'failed'); published++; return { ok: true, result: 'accepted' }; } });
  fs.writeFileSync(file, JSON.stringify(fixture(true)));
  assert.equal(await runCase('failed', () => 1), 1);
  assert.equal(await runCase('thrown', () => { throw new Error('private'); }), 1);
  fs.writeFileSync(file, JSON.stringify(fixture()));
  assert.equal(await runCase('restored', () => 0), 0);
  assert.equal(published, 3);
  assert.equal(await runAndPublish({ run: () => 0, file, publicFile: path.join(dir, 'rejected.json'), expectedSHA: sha, publish: async () => ({ ok: false, result: 'rejected', httpStatus: 422 }) }), 1);
  const partial = fixture(); partial.summary.complete = false; partial.summary.missingCount = 1;
  fs.writeFileSync(file, JSON.stringify(partial));
  assert.equal(await runAndPublish({ run: () => 2, file, publicFile: path.join(dir, 'partial.json'), expectedSHA: sha, publish: async () => ({ ok: true, result: 'accepted' }) }), 2);
  assert.equal(await runAndPublish({ run: () => 0, file, publicFile: path.join(dir, 'wrong-sha.json'), expectedSHA: 'f'.repeat(40), publish: async () => { throw new Error('must not publish'); } }), 1);
  fs.rmSync(file); assert.equal(await runCase('absent', () => 1), 1); assert.equal(published, 3);
});

// Verify genuine producer integration without contacting an instance. These are
// injected runner tests, never uploaded or described as live acceptance.
test('immutable real producer executes failing scenarios and restored passing scenarios', async t => {
  const dir = temporary(t);
  execFileSync('git', ['clone', '--quiet', '--shared', '--no-hardlinks', root, dir]);
  // Ordinary PR tests must stay offline and work with CI's shallow checkout.
  try { execFileSync('git', ['-C', dir, 'cat-file', '-e', HARNESS_SHA], { stdio: 'ignore' }); }
  catch { t.skip('Pinned historical producer absent in shallow checkout; run full-history integration locally'); return; }
  prepare(dir);
  fs.symlinkSync(path.join(root, 'cli/node_modules'), path.join(dir, 'cli/node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const { executeScenarios } = await import(pathToFileURL(path.join(dir, 'cli/scripts/acceptance/run.mjs')).href);
  const allowed = new Set(fs.readFileSync(path.join(root, 'site/config/acceptance_scenario_ids.txt'), 'utf8').split('\n'));
  const catalog = [];
  for (const name of ['read-only', 'read-only-catalog', 'resources', 'workflows', 'auth']) {
    const module = await import(pathToFileURL(path.join(dir, `cli/test/acceptance/${name}.mjs`)).href);
    catalog.push(...module.scenarios);
  }
  for (const scenario of catalog) assert.ok(allowed.has(scenario.id), `Producer scenario not accepted by current site: ${scenario.id}`);
  const { selectScenarios } = await import(pathToFileURL(path.join(dir, 'cli/scripts/acceptance/support.mjs')).href);
  const readonly = catalog.filter(s => s.modes.includes('readonly')).map(s => s.id);
  const selection = selectScenarios(catalog, { scenarios: readonly });
  assert.equal(selection.full, false); assert.deepEqual(selection.ids, readonly);
  for (const fails of [true, false]) {
    const outputDir = path.join(dir, fails ? 'fail' : 'pass');
    const ctx = { runKey: fixture().runKey, mode: 'readonly', profile: 'mock', expectedHost: 'https://unused.invalid', outputDir, state: new Map(), cleanup: async () => [] };
    const scenarios = [{ id: 'readonly.records', modes: ['readonly'], mutates: false, requires: [], run: async () => { assert.equal(fails, false, 'deliberate regression'); } }];
    const report = await executeScenarios(scenarios, ctx, { provenance: fixture().provenance });
    assert.equal(report.summary.complete, !fails);
    const result = validateProjection(JSON.parse(fs.readFileSync(path.join(outputDir, 'public-summary.json'))));
    assert.equal(result.results[0].status, fails ? 'failed' : 'passed');
    assert.ok(result.results[0].durationMs >= 0);
  }
});

test('projection matches actual Rails-owned schema when Ruby is available', t => {
  if (spawnSync('ruby', ['--version']).status !== 0) { t.skip('Ruby unavailable; website CI owns Rails tests'); return; }
  const ruby = "require 'json'; require 'pathname'; module Rails; def self.root; Pathname.new(ARGV[0]); end; end; require ARGV[0] + '/app/services/acceptance_projection'; p = AcceptanceProjection.parse(STDIN.read); puts p.run_key";
  const result = spawnSync('ruby', ['-e', ruby, path.join(root, 'site')], { input: JSON.stringify(fixture()), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), fixture().runKey);
});

function workflowGuard(w) {
  assert.deepEqual(Object.keys(w.on).sort(), ['push', 'release', 'workflow_dispatch']);
  assert.deepEqual(w.on.push.branches, ['main']); assert.equal(w.concurrency['cancel-in-progress'], false);
  assert.equal(w.jobs.acceptance.if, "needs.configuration.outputs.ready == 'true'");
  assert.match(w.jobs.configuration.if, /github.repository == 'jacebenson\/jsn'/);
  assert.match(w.jobs.configuration.steps[0].run, /required_reviewers/);
  assert.match(w.jobs.configuration.steps[0].run, /ready=false/);
  assert.equal(w.jobs.acceptance.steps.find(s => s.uses?.startsWith('actions/checkout')).with['persist-credentials'], false);
  assert.ok(!JSON.stringify(w).includes('pull_request_target'));
  assert.ok(w.jobs.acceptance.steps.some(s => s.run === 'node scripts/acceptance/ci.mjs'));
  assert.equal(w.jobs.acceptance.steps.find(s => s.uses?.startsWith('actions/upload-artifact')).with.path, 'acceptance-public.json');
}
test('trusted workflow rejects unsafe trigger/regression and restores pass', () => {
  const w = load(fs.readFileSync(path.join(root, '.github/workflows/acceptance.yml'), 'utf8'));
  workflowGuard(w);
  for (const mutate of [x => { x.on.pull_request = {}; }, x => { x.jobs.acceptance.if = 'always()'; }, x => { x.concurrency['cancel-in-progress'] = true; }]) {
    const changed = structuredClone(w); mutate(changed); assert.throws(() => workflowGuard(changed)); workflowGuard(w);
  }
  const release = load(fs.readFileSync(path.join(root, '.github/workflows/release-prod.yml'), 'utf8'));
  const dispatch = release.jobs.release.steps.find(s => s.run?.includes('gh workflow run acceptance.yml'));
  assert.match(dispatch.run, /--ref "\$TAG"/); assert.equal(dispatch['continue-on-error'], true);
});
