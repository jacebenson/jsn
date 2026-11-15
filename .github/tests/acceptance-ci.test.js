import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import test from 'node:test';
import { createRequire } from 'node:module';
const { load } = createRequire(new URL('../../cli/package.json', import.meta.url))('js-yaml');
import { validateProjection, publishResults, projectionDigest } from '../scripts/acceptance/publish.mjs';
import { environmentOAuth } from '../scripts/oauth-environment.mjs';
import { runAndPublish, seedProfile } from '../scripts/acceptance/ci.mjs';
import { selectTargets, selectTarget, authorizeMode, instanceConfiguration, producerEnvironment } from '../scripts/acceptance/config.mjs';
import { prepare, HARNESS_SHA, FILES } from '../scripts/acceptance/prepare.mjs';

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

test('target defaults, independent missing configuration and explicit mutation authorization', () => {
  assert.equal(selectTarget(), 'vendor-1');
  assert.deepEqual(selectTargets(), ['vendor-1', 'vendor-2']);
  assert.deepEqual(selectTargets('both'), ['vendor-1', 'vendor-2']);
  assert.deepEqual(selectTargets('pdi'), ['pdi']);
  assert.equal(selectTarget('vendor-2', 'pdi'), 'vendor-2');
  assert.throws(() => selectTargets('typo'));
  const env = { ACCEPTANCE_TARGET: 'vendor-1', JSN_VERIFY_ENABLED: 'true', SERVICENOW_INSTANCE_URL: 'https://mock.invalid', SERVICENOW_OAUTH_TOKEN: token };
  const config = instanceConfiguration(env);
  assert.equal(config.profile.read_only, true);
  assert.deepEqual(config.credentials, { auth_method: 'oauth', access_token: token });
  for (const key of ['JSN_VERIFY_ENABLED', 'SERVICENOW_INSTANCE_URL', 'SERVICENOW_OAUTH_TOKEN']) {
    assert.throws(() => instanceConfiguration({ ...env, [key]: '' }), /NOT CONFIGURED/);
  }
  assert.throws(() => instanceConfiguration({ ...env, ACCEPTANCE_TARGET: 'pdi', SERVICENOW_OAUTH_TOKEN: '' }));
  assert.equal(instanceConfiguration(env).target, 'vendor-1');
  for (const target of ['pdi', 'vendor-1', 'vendor-2']) {
    for (const approved of ['false', 'true']) for (const reviewers of ['false', 'true']) {
      const input = { target, mode: 'pdi', approved, reviewers };
      if (target === 'pdi' && approved === 'true' && reviewers === 'true') authorizeMode(input);
      else assert.throws(() => authorizeMode(input));
    }
  }
  assert.equal(instanceConfiguration({ ...env, ACCEPTANCE_TARGET: 'pdi', ACCEPTANCE_MODE: 'pdi', ACCEPTANCE_DISPOSABLE_APPROVED: 'true', ACCEPTANCE_REVIEWERS_VERIFIED: 'true' }).profile.read_only, false);
  assert.equal(instanceConfiguration(env).profile.read_only, true);
  const clean = producerEnvironment({ ...env, GH_TOKEN: token, JSN_ACCEPTANCE_INGEST_TOKEN: token, NODE_OPTIONS: token, HTTPS_PROXY: token }, '/private', '/private/config');
  assert.ok(!JSON.stringify(clean).includes(token));
  assert.equal(clean.HOME, '/private');
});

test('scenario allowlist accepts LF and Windows CRLF without weakening unknown-ID rejection', async t => {
  for (const newline of ['\n', '\r\n']) {
    const dir = temporary(t);
    fs.mkdirSync(path.join(dir, '.github/scripts/acceptance'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'site/config'), { recursive: true });
    const modulePath = path.join(dir, '.github/scripts/acceptance/publish.mjs');
    fs.copyFileSync(path.join(root, '.github/scripts/acceptance/publish.mjs'), modulePath);
    fs.writeFileSync(path.join(dir, 'site/config/acceptance_scenario_ids.txt'), `readonly.records${newline}`);
    const { validateProjection: validate } = await import(pathToFileURL(modulePath).href);
    validate(fixture());
    const unknown = fixture(); unknown.selection.selected = ['readonly.unknown'];
    assert.throws(() => validate(unknown), /Invalid selected scenario/);
  }
});

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
      res.end(`${sha} 5.4.0 data-run-key="${p.runKey}" data-payload-digest="${projectionDigest(p)}"`); return;
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
    if (req.method === 'GET') { res.end(read ? `${sha} 5.4.0 data-run-key="${p.runKey}" data-payload-digest="${projectionDigest(p)}"` : `${sha} 5.4.0 data-run-key="${p.runKey}" data-payload-digest="${'0'.repeat(64)}"`); return; }
    json(res, 201, { status: 'accepted', runKey: key });
  });
  assert.equal((await publishResults({ file, url, token })).result, 'readback-failed');
  read = true; assert.equal((await publishResults({ file, url, token })).result, 'accepted');
  key = 'wrong'; assert.equal((await publishResults({ file, url, token })).result, 'rejected');
});

test('nonzero or thrown suite still uploads partial, restores pass, refuses missing evidence', async t => {
  const dir = temporary(t), file = path.join(dir, 'private.json');
  const evidenceFile = path.join(dir, 'executed.jsonl');
  fs.writeFileSync(evidenceFile, JSON.stringify({runKey: fixture().runKey, id: 'readonly.records'}) + '\n');
  let published = 0;
  const runCase = async (name, run) => runAndPublish({ run, file, publicFile: path.join(dir, `${name}.json`), expectedSHA: sha, evidenceFile,
    publish: async ({ file: f }) => { const p = validateProjection(JSON.parse(fs.readFileSync(f))); assert.equal(p.results[0].status, name === 'restored' ? 'passed' : 'failed'); published++; return { ok: true, result: 'accepted' }; } });
  fs.writeFileSync(file, JSON.stringify(fixture(true)));
  assert.equal(await runCase('failed', () => 1), 0);
  assert.equal(await runCase('thrown', () => { throw new Error('private'); }), 0);
  fs.writeFileSync(file, JSON.stringify(fixture()));
  assert.equal(await runCase('restored', () => 0), 0);
  assert.equal(published, 3);
  assert.equal(await runAndPublish({ run: () => 0, file, publicFile: path.join(dir, 'rejected.json'), expectedSHA: sha, publish: async () => ({ ok: false, result: 'rejected', httpStatus: 422 }) }), 1);
  const partial = fixture(); partial.summary.complete = false; partial.summary.missingCount = 1;
  fs.writeFileSync(file, JSON.stringify(partial));
  assert.equal(await runAndPublish({ run: () => 2, file, publicFile: path.join(dir, 'partial.json'), expectedSHA: sha, evidenceFile, publish: async () => ({ ok: true, result: 'accepted' }) }), 0);
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
  for (const file of FILES) {
    const pinned = execFileSync('git', ['show', `${HARNESS_SHA}:${file}`], { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
    assert.deepEqual(fs.readFileSync(path.join(dir, file)), pinned, `Staged producer must remain byte-for-byte immutable: ${file}`);
  }
  fs.symlinkSync(path.join(root, 'cli/node_modules'), path.join(dir, 'cli/node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const { executeScenarios } = await import(pathToFileURL(path.join(dir, 'cli/scripts/acceptance/run.mjs')).href);
  const allowed = new Set(fs.readFileSync(path.join(root, 'site/config/acceptance_scenario_ids.txt'), 'utf8').split('\n'));
  const catalog = [];
  for (const name of ['read-only', 'read-only-catalog', 'resources', 'workflows', 'auth']) {
    const module = await import(pathToFileURL(path.join(dir, `cli/test/acceptance/${name}.mjs`)).href);
    catalog.push(...module.scenarios);
  }
  for (const scenario of catalog) assert.ok(allowed.has(scenario.id), `Producer scenario not accepted by current site: ${scenario.id}`);
  const { selectScenarios, createContext, preflight } = await import(pathToFileURL(path.join(dir, 'cli/scripts/acceptance/support.mjs')).href);
  // Exercise the pinned adapter's real CLI launch and SDK read with the exact
  // ephemeral file auth contract. Loopback only, no credential env inheritance.
  let requests = 0, acceptCredentials = true;
  const origin = new URL(await server(t, (req, res) => {
    if (req.url === '/oauth_token.do') {
      assert.equal(req.method, 'POST');
      json(res, 200, { access_token: token, expires_in: 300 }); return;
    }
    requests++;
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    assert.equal(req.method, 'GET');
    if (!acceptCredentials) { json(res, 401, { error: { message: 'mock authentication rejected' } }); return; }
    json(res, 200, { result: [{ sys_id: 'd'.repeat(32), name: 'incident' }] });
  })).origin;
  const privateRoot = path.join(dir, 'private'); fs.mkdirSync(privateRoot);
  const refreshed = await environmentOAuth({ SERVICENOW_INSTANCE_URL: origin, SERVICENOW_OAUTH_REFRESH_TOKEN: 'fake-refresh' }, { allowLocal: true });
  const configHome = await seedProfile(privateRoot, { profile: { instance_url: origin, read_only: true }, credentials: { auth_method: 'oauth', access_token: refreshed.accessToken } });
  const isolated = producerEnvironment(process.env, privateRoot, configHome);
  // Spawn the producer boundary itself: merging isolated paths back into each
  // CLI child below would hide a regression in the pinned environment filter.
  // A rejected token must not emit authenticated scenario evidence; recovery
  // must work with the same seeded file credentials and no session bootstrap.
  const { runProcess: launchProducer } = await import(pathToFileURL(path.join(dir, 'cli/scripts/acceptance/support.mjs')).href);
  for (const [index, accepts] of [true, false, true].entries()) {
    acceptCredentials = accepts;
    const outputDir = path.join(dir, `isolated-producer-${index}`);
    const script = `
      import fs from 'node:fs';
      import { createContext, preflight } from ${JSON.stringify(pathToFileURL(path.join(dir, 'cli/scripts/acceptance/support.mjs')).href)};
      import { observeScenario } from ${JSON.stringify(pathToFileURL(path.join(root, '.github/scripts/acceptance/execute.mjs')).href)};
      const options = ${JSON.stringify({ profile: 'acceptance-ci', expectedHost: origin, mode: 'readonly', outputDir })};
      const config = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(configHome, 'servicenow/config.json'))}, 'utf8'));
      const ctx = createContext(options, preflight(options, config));
      const scenario = observeScenario({ id: 'readonly.records', run: async c => {
        const rows = await c.read('sys_db_object', { fields: ['sys_id', 'name'] });
        if (rows.length !== 1) throw Error('mock read mismatch');
        const result = await c.command(['records', 'list', '--table', 'sys_db_object', '--fields', 'sys_id,name', '--limit', '1', '--json']);
        if (result.exitCode !== 0 || result.json?.ok !== true) throw Error('mock CLI rejection');
      }});
      let ok = false;
      try { await scenario.run(ctx); ok = true; } catch { /* closed status only */ }
      console.log(JSON.stringify({ ok, evidence: fs.existsSync(${JSON.stringify(path.join(outputDir, 'executed.jsonl'))}) }));
    `;
    const before = requests;
    const result = await launchProducer(process.execPath, ['--input-type=module', '-e', script], { env: isolated });
    assert.equal(result.exitCode, 0, 'isolated producer must complete without private diagnostics');
    assert.deepEqual(result.json, { ok: accepts, evidence: accepts });
    assert.ok(requests > before, 'actual producer children must reach the mock provider');
    assert.ok(!result.stdout.includes(token));
    assert.ok(!result.stderr.includes(token));
  }
  const configuration = JSON.parse(fs.readFileSync(path.join(configHome, 'servicenow/config.json')));
  assert.equal(configuration.auth_method, 'oauth');
  assert.deepEqual(Object.keys(configuration.profiles), ['acceptance-ci']);
  const options = { profile: 'acceptance-ci', expectedHost: origin, mode: 'readonly', outputDir: path.join(dir, 'adapter-run') };
  assert.throws(() => preflight({ ...options, allowWrites: true }, configuration, {}), /refuses/);
  const ctx = createContext(options, preflight(options, configuration, {}), {
    execute: async (exe, args, opts) => {
      // Inject only the same isolated parent paths the production producer sees.
      const { runProcess } = await import(pathToFileURL(path.join(dir, 'cli/scripts/acceptance/support.mjs')).href);
      return runProcess(exe, args, { ...opts, env: { ...opts.env, ...isolated } });
    },
  });
  assert.deepEqual(await ctx.read('sys_db_object', { fields: ['sys_id', 'name'] }), [{ sys_id: 'd'.repeat(32), name: 'incident' }]);
  // Start the pinned producer inside the seeded parent environment. Do not
  // reinject paths into its children: exercise its real environment filter.
  const { runProcess: launchSeeded } = await import(pathToFileURL(path.join(dir, 'cli/scripts/acceptance/support.mjs')).href);
  const supportURL = pathToFileURL(path.join(dir, 'cli/scripts/acceptance/support.mjs')).href;
  const seeded = await launchSeeded(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import {createContext,preflight} from ${JSON.stringify(supportURL)};
    const options = ${JSON.stringify({ ...options, outputDir: path.join(dir, 'seeded-producer-run') })};
    const config = JSON.parse(fs.readFileSync(process.env.XDG_CONFIG_HOME + '/servicenow/config.json'));
    const ctx = createContext(options, preflight(options,config,{}));
    await ctx.read('sys_db_object',{fields:['sys_id','name']});
    const result = await ctx.command(['records','list','--table','sys_db_object','--limit','1','--no-count','--json']);
    if(result.exitCode !== 0 || result.json?.ok !== true) process.exitCode=1;
  `], { env: isolated });
  assert.equal(seeded.exitCode, 0, seeded.stderr.replaceAll(token, '[redacted]'));
  assert.ok(!(seeded.stdout + seeded.stderr).includes(token));
  // Invoke the relocated wrapper itself from an unrelated cwd against the real
  // unmodified pinned producer, not just an imported observer function.
  const wrapper = path.join(dir, '.github/scripts/acceptance/execute.mjs');
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.copyFileSync(path.join(root, '.github/scripts/acceptance/execute.mjs'), wrapper);
  const invokedOutput = path.join(dir, 'invoked-producer-run');
  const invoked = await launchSeeded(process.execPath, [wrapper, '--profile', 'acceptance-ci', '--expected-host', origin,
    '--mode', 'readonly', '--scenario', 'readonly.records', '--output-dir', invokedOutput], { cwd: privateRoot, env: isolated });
  assert.ok([0, 1, 2].includes(invoked.exitCode), invoked.stderr);
  const invokedProjection = validateProjection(JSON.parse(fs.readFileSync(path.join(invokedOutput, 'public-summary.json'))));
  assert.ok(invokedProjection.results.some(r => r.id === 'readonly.records'));
  const invokedEvidence = fs.readFileSync(path.join(invokedOutput, 'executed.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(invokedEvidence.some(e => e.id === 'readonly.records' && e.runKey === invokedProjection.runKey));
  assert.ok(!(invoked.stdout + invoked.stderr).includes(token));
  const readCount = requests;
  await assert.rejects(() => ctx.command(['records', 'create', '--table', 'incident', '--data', '{}']), /refused/);
  assert.equal(requests, readCount);
  // CLI's independent profile guard must reject writes without the harness too.
  const { runProcess } = await import(pathToFileURL(path.join(dir, 'cli/scripts/acceptance/support.mjs')).href);
  const refused = await runProcess(process.execPath, [path.join(dir, 'cli/bin/jsn.js'), 'records', 'create', '--table', 'incident', '--data', '{}', '--profile', 'acceptance-ci', '--json'], { env: isolated });
  assert.notEqual(refused.exitCode, 0);
  assert.match(refused.stdout + refused.stderr, /read.only/i);
  assert.equal(requests, readCount);
  const second = createContext({ ...options, outputDir: path.join(dir, 'second-target') }, preflight(options, configuration, {}));
  assert.notEqual(ctx.runKey, second.runKey, 'Producer UUID keys must not collide across anonymized target contexts');
  const providerContext = ctx;
  const { observeScenario } = await import('../scripts/acceptance/execute.mjs');
  const readonly = catalog.filter(s => s.modes.includes('readonly')).map(s => s.id);
  const selection = selectScenarios(catalog, { scenarios: readonly });
  assert.equal(selection.full, false); assert.deepEqual(selection.ids, readonly);
  for (const fails of [true, false]) {
    const outputDir = path.join(dir, fails ? 'fail' : 'pass');
    const ctx = { runKey: fixture().runKey, mode: 'readonly', profile: 'mock', expectedHost: 'https://unused.invalid', outputDir, state: new Map(), cleanup: async () => [] };
    ctx.read = providerContext.read; ctx.command = providerContext.command;
    const scenarios = [observeScenario({ id: 'readonly.records', modes: ['readonly'], mutates: false, requires: [], run: async c => { await c.read('sys_db_object', { fields: ['sys_id', 'name'] }); assert.equal(fails, false, 'deliberate regression'); } })];
    const report = await executeScenarios(scenarios, ctx, { provenance: fixture().provenance });
    assert.equal(report.summary.complete, !fails);
    const result = validateProjection(JSON.parse(fs.readFileSync(path.join(outputDir, 'public-summary.json'))));
    assert.equal(result.results[0].status, fails ? 'failed' : 'passed');
    assert.ok(result.results[0].durationMs >= 0);
    const file = path.join(outputDir, 'public-summary.json');
    const evidenceFile = path.join(outputDir, 'executed.jsonl');
    let stored;
    const url = await server(t, async (req, res) => {
      if (req.method === 'GET') { res.end(`${sha} 5.4.0 data-run-key="${stored.runKey}" data-payload-digest="${projectionDigest(stored)}"`); return; }
      let raw = ''; for await (const chunk of req) raw += chunk;
      stored = validateProjection(JSON.parse(raw));
      json(res, 201, { status: 'accepted', runKey: stored.runKey });
    });
    assert.equal(await runAndPublish({ run: () => fails ? 1 : 0, file, publicFile: path.join(outputDir, 'published.json'), expectedSHA: sha, evidenceFile, publish: async ({ file: f }) => {
      const actual = JSON.parse(fs.readFileSync(f));
      assert.equal(actual.results[0].status, fails ? 'failed' : 'passed');
      assert.equal(actual.summary.complete, !fails);
      return publishResults({ file: f, url, token });
    } }), 0);
    assert.equal(stored.results[0].status, fails ? 'failed' : 'passed');
    assert.equal(await runAndPublish({ run: () => 0, file, publicFile: path.join(outputDir, 'no-evidence.json'), expectedSHA: sha, publish: async () => ({ok:true, result:'accepted'}) }), 1);
  }
});

test('projection matches actual Rails-owned schema when Ruby is available', t => {
  if (spawnSync('ruby', ['--version']).status !== 0) { t.skip('Ruby unavailable; website CI owns Rails tests'); return; }
  const ruby = "require 'json'; require 'digest'; require 'pathname'; module Rails; def self.root; Pathname.new(ARGV[0]); end; end; require ARGV[0] + '/app/services/acceptance_projection'; p = AcceptanceProjection.parse(STDIN.read); puts p.run_key; puts p.canonical_digest";
  for (const duration of [12.5, 1, 0.00001, 0.0000001234, 0.0001]) {
    const p = fixture(); p.results[0].durationMs = duration;
    const result = spawnSync('ruby', ['-e', ruby, path.join(root, 'site')], { input: JSON.stringify(p), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    // Ruby puts uses CRLF on Windows; compare records, not transport newlines.
    for (const output of [result.stdout, result.stdout.replace(/\r?\n/g, '\r\n')]) {
      assert.deepEqual(output.trim().split(/\r?\n/), [p.runKey, projectionDigest(p)], `duration ${duration}`);
    }
  }
});

function workflowGuard(w) {
  assert.deepEqual(Object.keys(w.on).sort(), ['push', 'release', 'workflow_dispatch']);
  assert.deepEqual(w.on.push.branches, ['main']); assert.equal(w.concurrency['cancel-in-progress'], false);
  assert.equal(w.jobs.delivery.if, 'always()');
  assert.deepEqual(w.jobs.delivery.needs, ['selection', 'vendor-1', 'vendor-2', 'pdi']);
  for (const target of ['vendor-1', 'vendor-2']) assert.deepEqual(w.jobs[target].needs, 'selection');
  const target = load(fs.readFileSync(path.join(root, '.github/workflows/acceptance-target.yml'), 'utf8'));
  w = { ...w, jobs: { ...w.jobs, acceptance: target.jobs.acceptance } };
  assert.match(w.jobs.selection.if, /github.repository == 'jacebenson\/jsn'/);
  assert.match(w.jobs.selection.steps[1].run, /merge-base.*--is-ancestor/);
  const protection = w.jobs.acceptance.steps.find(s => s.id === 'protection');
  assert.match(protection.run, /required_reviewers/);
  assert.match(protection.run, /APPROVED.*true/);
  assert.match(protection.run, /TARGET.*pdi/);
  assert.match(protection.run, /protected.*true/);
  assert.equal(w.jobs.acceptance.steps.find(s => s.run === 'node .github/scripts/acceptance/ci.mjs').env.ACCEPTANCE_REVIEWERS_VERIFIED, '${{ steps.protection.outputs.verified }}');
  assert.equal(w.jobs.acceptance.environment, '${{ inputs.target }}');
  assert.deepEqual(w.on.workflow_dispatch.inputs.target.options, ['both', 'pdi', 'vendor-1', 'vendor-2']);
  assert.ok(!JSON.stringify(w).includes('PROFILE_JSON'));
  assert.equal(w.jobs.acceptance['continue-on-error'], true);
  assert.equal(w.jobs.acceptance.steps.find(s => s.uses?.startsWith('actions/checkout')).with['persist-credentials'], false);
  assert.ok(!JSON.stringify(w).includes('pull_request_target'));
  assert.ok(w.jobs.acceptance.steps.some(s => s.run === 'node .github/scripts/acceptance/ci.mjs'));
  assert.equal(w.jobs.acceptance.steps.find(s => s.uses?.startsWith('actions/upload-artifact')).with.path, 'acceptance-public.json');
}
test('actual mutation shell gate fails closed and restores approved reviewed PDI', t => {
  const target = load(fs.readFileSync(path.join(root, '.github/workflows/acceptance-target.yml'), 'utf8'));
  const script = target.jobs.acceptance.steps.find(s => s.id === 'protection').run;
  const dir = temporary(t);
  const gh = path.join(dir, process.platform === 'win32' ? 'gh.exe' : 'gh');
  if (process.platform === 'win32') { t.skip('bash protection gate tested on Linux'); return; }
  fs.writeFileSync(gh, '#!/bin/sh\nprintf "%s\\n" "$MOCK_REVIEWERS"\n', { mode: 0o700 });
  const run = overrides => spawnSync('bash', ['-eo', 'pipefail', '-c', script], { encoding: 'utf8', env: {
    PATH: `${dir}${path.delimiter}${process.env.PATH}`, GITHUB_OUTPUT: path.join(dir, 'output'),
    MODE: 'pdi', TARGET: 'pdi', APPROVED: 'true', DEFAULT_BRANCH: 'main', GITHUB_REF: 'refs/heads/main', MOCK_REVIEWERS: 'true', ...overrides,
  } });
  assert.equal(run({}).status, 0);
  for (const overrides of [{ APPROVED: 'false' }, { TARGET: 'vendor-1' }, { TARGET: 'vendor-2' }, { MOCK_REVIEWERS: 'false' }, { MOCK_REVIEWERS: '' }, { GITHUB_REF: 'refs/tags/v1' }]) {
    assert.notEqual(run(overrides).status, 0, JSON.stringify(overrides));
    assert.equal(run({}).status, 0);
  }
  assert.equal(run({ MODE: 'readonly', TARGET: 'vendor-1', APPROVED: 'false', MOCK_REVIEWERS: 'false' }).status, 0);
});

test('trusted workflow rejects unsafe trigger/regression and restores pass', () => {
  const w = load(fs.readFileSync(path.join(root, '.github/workflows/acceptance.yml'), 'utf8'));
  workflowGuard(w);
  for (const mutate of [x => { x.on.pull_request = {}; }, x => { x.jobs.delivery.if = 'success()'; }, x => { x.concurrency['cancel-in-progress'] = true; }]) {
    const changed = structuredClone(w); mutate(changed); assert.throws(() => workflowGuard(changed)); workflowGuard(w);
  }
  const release = load(fs.readFileSync(path.join(root, '.github/workflows/release-prod.yml'), 'utf8'));
  const dispatch = release.jobs.release.steps.find(s => s.run?.includes('gh workflow run acceptance.yml'));
  assert.match(dispatch.run, /--ref "\$TAG"/); assert.equal(dispatch['continue-on-error'], true);
});
