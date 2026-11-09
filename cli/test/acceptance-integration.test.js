import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createContext, cliRoot, verifyCliArtifact, privateJSON, provenance, runProcess } from '../scripts/acceptance/support.mjs';
import { executeScenarios } from '../scripts/acceptance/run.mjs';
import { coverageDetails, bindScenarios } from '../scripts/acceptance/bindings.mjs';
import { beginSuite, endSuite } from './acceptance/performance.mjs';
import { scenarios as local } from './acceptance/read-only.mjs';
import { scenarios as resources } from './acceptance/resources.mjs';
import { scenarios as workflows } from './acceptance/workflows.mjs';
import { scenarios as auth, loadAuthConfig } from './acceptance/auth.mjs';
import { scenarios as catalog } from './acceptance/read-only-catalog.mjs';

const all = bindScenarios([...local, ...catalog, ...resources, ...workflows, ...auth]);
const inventory = JSON.parse(fs.readFileSync(path.join(cliRoot, 'test/acceptance/coverage.json')));
function context(t, execute = async () => { throw new Error('No network allowed'); }) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'acceptance-integration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createContext({ mode: 'pdi', allowWrites: true, profile: 'fixture', outputDir: path.join(dir, 'run') }, { target: 'https://fixture.invalid' }, { execute });
}
const record = (ctx, id, dependsOn = [], kind = 'fixture', cleanupArgs = ['records', 'delete', id, '--table', 'sys_user']) => ctx.registerArtifact({ id, table: 'sys_user', kind, dependsOn, cleanupArgs });
const cap = number => ({ capture_schema_version: 1, run_id: `20261108T12000${number}Z`, status: 'complete',
  collectors: ['platform_health', 'transactions', 'error_warning_summary', 'event_queue', 'ecc_queue', 'flow_executions', 'record_counts', 'scheduled_and_cleanup'].map(name => ({ name, status: 'success' })), privateSecret: 'synthetic-secret' });

function perfAdapter(ctx, events) {
  const captures = [];
  ctx.read = async () => [];
  ctx.command = async args => {
    events.push(args.slice(0, 2).join(' '));
    let data;
    if (args[1] === 'capture') { data = cap(captures.length); captures.push(data); }
    if (args[1] === 'show') data = captures.find(c => c.run_id === args[2]);
    if (args[1] === 'list') data = { runs: captures, count: captures.length };
    if (args[1] === 'compare') data = { baseline: captures[0], new: captures[1] };
    return { exitCode: 0, json: { ok: true, data } };
  };
}

test('all four modules have real dependency/target/source joins; honest inventory has no undefined options', () => {
  const ids = new Set(all.map(s => s.id));
  assert.equal(ids.size, 92);
  for (const s of all) {
    assert.equal(typeof s.run, 'function');
    for (const dependency of s.requires) assert.ok(ids.has(dependency), 'unknown dependency');
    for (const source of s.sources) assert.ok(fs.existsSync(path.join(cliRoot, '..', source)), `missing implementation source ${source}`);
  }
  assert.ok(auth[0].requires.includes('workflows.context'));
  const full = coverageDetails(inventory, all, [...ids], 'pdi');
  const read = coverageDetails(inventory, all, [...ids], 'readonly');
  assert.ok(full.counts.incomplete > 0 && read.counts.incomplete > 0);
  assert.ok(read.counts.outOfMode > 0);
  assert.ok(!full.gaps.some(g => /undefined|unknown-command/.test(g)));
  assert.ok(full.gaps.some(g => g.startsWith('option:version:$root --json:')));
  assert.ok(full.gaps.includes('unbound:flows create'));
});

test('bindings credit only explicit assertions, not matching command paths, options or generic factories', () => {
  const coverage = { entries: [{ path: 'version', mode: 'readonly', effectiveOptions: ['$root --json'], acceptance: { requirements: ['scripted-success'] } }], optionDefinitions: { '$root --json': { requiredAssertions: ['explicit-value', 'omitted-default'] } } };
  const s = { id: 'probe', modes: ['readonly'], commandPaths: ['version'] };
  assert.equal(coverageDetails(coverage, [s], ['probe'], 'readonly').counts.bound, 0);
  s.coverageBindings = { version: { requirements: ['scripted-success'], options: { '$root --json': ['explicit-value'] } } };
  const partial = coverageDetails(coverage, [s], ['probe'], 'readonly');
  assert.deepEqual(partial.gaps, ['option:version:$root --json:omitted-default']);
  assert.equal(partial.counts.incomplete, 1);
});

test('suite hooks bracket scenario failure and preserve actual-schema captures with closed public perf', async t => {
  const ctx = context(t), events = [];
  perfAdapter(ctx, events);
  const report = await executeScenarios([{ id: 'probe.failure', modes: ['pdi'], requires: [], mutates: false, async run() { events.push('scenario'); throw new Error('synthetic-secret'); } }], ctx, { suiteHooks: { beginSuite, endSuite } });
  assert.deepEqual(events, ['perf capture', 'perf show', 'scenario', 'perf capture', 'perf show', 'perf list', 'perf compare']);
  assert.equal(report.summary.complete, false);
  assert.equal(report.performance.coverage.compare, 'passed');
  const publicText = fs.readFileSync(path.join(ctx.outputDir, 'public-summary.json'), 'utf8');
  assert.ok(!/synthetic-secret|fixture.invalid|20261108|run_id/.test(publicText));
  assert.equal(JSON.parse(publicText).performance.releaseGate, false);
  assert.ok(fs.existsSync(path.join(ctx.outputDir, 'performance-private/after-show.json')));
});

test('all actual scenarios resolve through shared context; denied capabilities never fabricate a pass', async t => {
  const ctx = context(t);
  const report = await executeScenarios(all, ctx);
  assert.equal(report.results.length, 92);
  assert.equal(report.results.filter(r => r.status === 'passed').length, 0);
  assert.equal(report.summary.complete, false);
  assert.equal(report.results.find(r => r.id === 'auth.fixtures').status, 'blocked-prerequisite');
});

test('planned absent IDs are read once without DELETE, even without cleanup route', async t => {
  const ctx = context(t), id = 'a'.repeat(32);
  let reads = 0;
  ctx.read = async () => { reads++; return []; };
  record(ctx, id, [], 'planned', null);
  assert.deepEqual(await ctx.cleanup(), []);
  assert.deepEqual(await ctx.cleanup(), []);
  assert.equal(reads, 1);
});

test('transitive uncleanable children retain ancestors and selected capture context', async t => {
  const ctx = context(t), parent = 'a'.repeat(32), child = 'b'.repeat(32), grandchild = 'c'.repeat(32), events = [];
  ctx.state.set('workflows.context', { captureId: parent });
  ctx.command = async args => { events.push(args[0]); return { exitCode: 0, json: { data: { result: { current: { sysId: parent } } } } }; };
  ctx.read = async (_table, options) => [{ sys_id: options.query.slice(7) }];
  record(ctx, parent, [], 'capture-set'); record(ctx, child, [parent]); record(ctx, grandchild, [child], 'unimplemented', null);
  const report = await executeScenarios([{ id: 'workflows.context', modes: ['pdi'], requires: [], mutates: true, async run() {}, async cleanup() { events.push('restore'); } }], ctx);
  assert.equal(ctx.state.get('cleanup.unresolvedChildren'), true);
  assert.ok(!events.includes('records') && !events.includes('restore'));
  assert.ok(report.summary.missing.includes('cleanup:context-retained-for-unresolved-children'));
  const manifest = JSON.parse(fs.readFileSync(path.join(ctx.outputDir, 'artifacts.json')));
  assert.ok(manifest.artifacts.every(a => !a.cleaned));
});

test('child cleanup is under owned capture, restoration last, active capture set never deleted', async t => {
  const ctx = context(t), capture = 'a'.repeat(32), child = 'b'.repeat(32), events = [];
  let absent = false;
  ctx.state.set('workflows.context', { captureId: capture });
  ctx.read = async () => absent ? [] : [{ sys_id: child }];
  ctx.command = async args => {
    if (args[0] === 'rest') { events.push('capture-check'); return { exitCode: 0, json: { data: { result: { current: { sysId: capture } } } } }; }
    assert.ok(args.includes(child)); assert.ok(!args.includes(capture));
    events.push('delete-child'); absent = true; return { exitCode: 0 };
  };
  record(ctx, capture, [], 'capture-set'); record(ctx, child, [capture]);
  const report = await executeScenarios([{ id: 'workflows.context', modes: ['pdi'], requires: [], mutates: true, async run() {}, async cleanup() { events.push('restore'); } }], ctx);
  assert.deepEqual(events, ['capture-check', 'delete-child', 'restore']);
  assert.ok(report.summary.missing.some(g => g.includes('retained-capture')));
  assert.equal(report.summary.complete, false);
});

test('wrong manifest ownership, capture drift and unknown/mutation-shaped args refuse before deletion', async t => {
  let dispatched = 0;
  const ctx = context(t, async () => { dispatched++; return { exitCode: 0, json: {} }; });
  for (const args of [['records', 'list', '--query', 'sys_id=javascript:gs.deleteAll()'], ['version', '--unknown'], ['rest', '/stats.do', '--method', 'GET'], ['records', 'create', '--help', '--unknown']]) await assert.rejects(ctx.command(args));
  for (const env of [{ NODE_PATH: '/outside' }, { XDG_DATA_HOME: '/outside' }, { JSN_NO_PROMPTS: '0' }, { SERVICENOW_OAUTH_TOKEN: 'forged' }]) await assert.rejects(ctx.command(['version'], { env }));
  assert.equal(dispatched, 0);
  record(ctx, 'a'.repeat(32));
  const file = path.join(ctx.outputDir, 'artifacts.json'), manifest = JSON.parse(fs.readFileSync(file));
  manifest.runKey = 'other_run'; privateJSON(file, manifest);
  assert.equal((await ctx.cleanup()).length, 1); assert.equal(dispatched, 0);
});

test('keep restores context without object delete and removes private generated credentials', async t => {
  const ctx = context(t); ctx.keep = true;
  const root = path.join(ctx.outputDir, 'auth-private'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'create.json'), 'synthetic private payload');
  const user = { password: 'synthetic', env: { SN_PASSWORD: 'synthetic' } };
  ctx.state.set('auth.fixtures', { root, users: [user] });
  let restored = false;
  await executeScenarios([{ id: 'workflows.context', modes: ['pdi'], requires: [], mutates: true, async run() {}, async cleanup() { restored = true; } }, { ...auth[0], requires: ['workflows.context'], async run() {} }], ctx);
  assert.equal(restored, true); assert.equal(fs.existsSync(root), false); assert.equal(user.password, undefined);
});

test('interruption keeps before/after captures and checkpoints non-green run', async t => {
  const ctx = context(t), events = []; perfAdapter(ctx, events);
  const report = await executeScenarios([{ id: 'probe.interrupt', modes: ['pdi'], requires: [], mutates: false, async run() { process.emit('SIGINT'); } }, { id: 'probe.not-run', modes: ['pdi'], requires: [], mutates: false, async run() { assert.fail('interrupted'); } }], ctx, { suiteHooks: { beginSuite, endSuite } });
  assert.equal(report.interrupted, true); assert.equal(report.summary.complete, false);
  assert.equal(report.performance.coverage.after, 'complete');
  assert.ok(fs.existsSync(path.join(ctx.outputDir, 'artifacts.json')));
});

test('external source-identical artifact accepted, forged revision/source rejected; version independent of cwd', t => {
  const ctx = context(t), packed = path.join(ctx.outputDir, 'package'); fs.mkdirSync(packed);
  for (const relative of ['src', 'bin', 'package.json']) fs.cpSync(path.join(cliRoot, relative), path.join(packed, relative), { recursive: true });
  const cli = path.join(packed, 'bin/jsn.js');
  verifyCliArtifact(cli);
  const before = provenance(cli);
  assert.equal(before.version, JSON.parse(fs.readFileSync(path.join(cliRoot, 'package.json'))).version);
  fs.appendFileSync(path.join(packed, 'src/app.js'), '\n// forged source\n');
  assert.throws(() => verifyCliArtifact(cli), /provenance/);
});

test('actor config symlink and ambient secret inheritance are denied without serializing environments', async t => {
  const key = 'ACCEPTANCE_SYNTHETIC_SECRET_SENTINEL';
  process.env[key] = 'synthetic-only'; t.after(() => { delete process.env[key]; });
  let launches = 0;
  const ctx = context(t, async (_exe, _args, opts) => {
    launches++; assert.equal(Object.hasOwn(opts.env, key), false);
    return { exitCode: 0, stdout: '{}', stderr: '', json: {} };
  });
  await ctx.command(['version']);
  const config = path.join(ctx.outputDir, 'actor/config'); fs.mkdirSync(path.join(config, 'servicenow'), { recursive: true });
  const outside = path.join(path.dirname(ctx.outputDir), 'outside-config.json');
  fs.writeFileSync(outside, JSON.stringify({ profiles: { fixture: { instance_url: ctx.expectedHost } } }));
  fs.symlinkSync(outside, path.join(config, 'servicenow/config.json'));
  await assert.rejects(ctx.command(['auth', 'status'], { env: { XDG_CONFIG_HOME: config } }), /symlink/);
  await assert.rejects(ctx.read('sys_user', { query: 'sys_id=javascript:gs.deleteAll()' }), /Executable/);
  assert.equal(launches, 1);
});

test('auth configuration is private, least-privilege and bound to exact profile/target before allocation', async t => {
  const ctx = context(t), file = path.join(ctx.outputDir, 'auth-config.json');
  privateJSON(file, { profile: ctx.profile, expectedHost: ctx.expectedHost, domain: 'global', roles: [] });
  await loadAuthConfig(ctx, file);
  assert.equal(ctx.state.get('auth.config').domain, 'global');
  privateJSON(file, { profile: 'other', expectedHost: ctx.expectedHost, roles: [] });
  await assert.rejects(loadAuthConfig(ctx, file), /mismatch/);
  privateJSON(file, { profile: ctx.profile, expectedHost: ctx.expectedHost, roles: ['admin'] });
  await assert.rejects(loadAuthConfig(ctx, file), /Administrative/);
});

test('cleanup rejects counterfeit exact-ID placement, foreign tables and context drift with zero DELETE', async t => {
  const ctx = context(t), id = 'd'.repeat(32), other = 'e'.repeat(32);
  for (const args of [['records', 'delete', other, '--table', 'sys_user', '--reason', id], ['records', 'delete', id, '--table', 'incident'], ['users', 'delete', other, id]]) assert.throws(() => record(ctx, id, [], 'fixture', args), /exact owned/);
  record(ctx, id);
  ctx.state.set('workflows.context', { captureId: other });
  let commands = 0;
  ctx.command = async args => { commands++; assert.equal(args[0], 'rest'); return { exitCode: 0, json: { data: { result: { current: { sysId: id } } } } }; };
  assert.equal((await ctx.cleanup()).length, 1);
  assert.equal(commands, 1);
});

test('shared readonly guard permits the exact 66 reviewed paths, not requests/tables show or new families', async t => {
  const base = context(t, async () => ({ exitCode: 0, stdout: '{}', json: {} }));
  base.mode = 'readonly';
  for (const s of catalog) {
    const [family, action] = s.commandPaths[0].split(' ');
    await base.command(action === 'list' ? [family, action, '--query', 'sys_idISNOTEMPTY', '--columns', 'sys_id,sys_updated_on', '--limit', '1', '--display-values', 'raw', '--json'] : [family, action, 'a'.repeat(32), '--identifier-field', 'sys_id', '--display-values', 'raw', ...(family === 'uipolicies' ? ['--no-essential'] : []), '--json']);
  }
  for (const args of [['requests', 'show', 'a'.repeat(32)], ['tables', 'show', 'sys_user'], ['users', 'list'], ['includes', 'delete', 'a'.repeat(32)], ['includes', 'list', '--help', '--unknown']]) await assert.rejects(base.command(args));
});

test('actual catalog list/show run through shared target/env/SDK guard against loopback', async t => {
  const base = context(t), id = 'f'.repeat(32), requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture'); requests.push([req.method, url.pathname]);
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && url.pathname === '/angular.do' && url.searchParams.get('sysparm_type') === 'get_user') { res.setHeader('x-usertoken-response', 'synthetic'); res.end('{}'); return; }
    if (req.method !== 'GET') { res.statusCode = 405; res.end('{}'); return; }
    let row = { sys_id: id, sys_updated_on: '2026-01-01 00:00:00', name: 'Synthetic' };
    const fields = url.searchParams.get('sysparm_fields')?.split(',');
    if (fields) row = Object.fromEntries(Object.entries(row).filter(([key]) => fields.includes(key)));
    res.end(JSON.stringify({ result: url.pathname.endsWith(`/${id}`) ? row : [row] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const target = `http://127.0.0.1:${server.address().port}`, config = path.join(base.outputDir, 'primary-config');
  fs.mkdirSync(path.join(config, 'servicenow'), { recursive: true });
  privateJSON(path.join(config, 'servicenow/config.json'), { profiles: { fixture: { instance_url: target, auth_method: 'oauth', read_only: true } } });
  const ctx = createContext({ mode: 'readonly', profile: 'fixture', outputDir: path.join(base.outputDir, 'catalog-run') }, { target }, {
    execute: (exe, args, opts) => runProcess(exe, args, { ...opts, env: { ...opts.env, HOME: config, XDG_CONFIG_HOME: config, SERVICENOW_OAUTH_TOKEN: 'synthetic-loopback-token' } }),
  });
  const selected = catalog.filter(s => s.commandPaths[0].startsWith('includes '));
  const report = await executeScenarios(selected, ctx);
  assert.equal(report.results.length, 2);
  assert.ok(report.results.every(r => r.status === 'passed'));
  assert.ok(requests.filter(([method]) => method !== 'GET').every(([method, route]) => method === 'POST' && route === '/angular.do'));
});
