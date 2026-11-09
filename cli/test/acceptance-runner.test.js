import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, preflight, selectScenarios, summarize, createContext, runProcess, classifyCommand, assertCommand, poll, publicProjection } from '../scripts/acceptance/support.mjs';
import { executeScenarios, coverageGaps } from '../scripts/acceptance/run.mjs';
import { scenarios as readonlyScenarios } from './acceptance/read-only.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

test('target and arguments fail closed before any executor exists', () => {
  assert.throws(() => parseArgs(['--surprise']), /Unknown/);
  assert.throws(() => preflight({ mode: 'readonly' }, { profiles: {} }, {}), /profile/);
  assert.throws(() => preflight({ mode: 'readonly', profile: 'p', expectedHost: 'other.example' }, { profiles: { p: { instance_url: 'https://right.example' } } }, {}), /target/);
  assert.throws(() => preflight({ mode: 'pdi', profile: 'p', expectedHost: 'right.example' }, { profiles: { p: { instance_url: 'https://right.example' } } }, {}), /allow-writes/);
});
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'acceptance-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function context(t, overrides = {}, execute) {
  return createContext({ mode: 'readonly', profile: 'fixture', outputDir: temporary(t), ...overrides }, { target: 'http://127.0.0.1:1' }, execute ? { execute } : {});
}
test('readonly refuses unclassified mutations, GET-shaped Store and target overrides without dispatch', async t => {
  let calls = 0;
  const ctx = context(t, {}, async () => { calls++; });
  for (const args of [['records', 'create'], ['store', 'install'], ['rest', '/stats.do'], ['records', 'list', '--profile=other'], ['records', 'list', '-i', 'elsewhere']]) await assert.rejects(ctx.command(args));
  await assert.rejects(ctx.command(['version'], { env: { SERVICENOW_INSTANCE_URL: 'https://evil.example' } }));
  assert.equal(calls, 0);
});
test('stale environment target and runtime injection rejected before HTTP', () => {
  const args = { mode: 'readonly', profile: 'fixture', expectedHost: 'right.example' };
  const config = { profiles: { fixture: { instance_url: 'https://right.example' } } };
  for (const key of ['SERVICENOW_INSTANCE_URL', 'NODE_OPTIONS', 'HTTPS_PROXY']) assert.throws(() => preflight(args, config, { [key]: 'stale' }), /environment/);
  assert.throws(() => preflight({ ...args, profile: 'unknown' }, config, {}), /profile/);
  assert.throws(() => parseArgs(['--profile']), /Missing/);
});
test('real asynchronous subprocess supports a same-process loopback HTTP fixture', async t => {
  let requests = 0;
  const server = http.createServer((req, res) => { requests++; res.end('{"synthetic":true}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const result = await runProcess(process.execPath, ['-e', `fetch(${JSON.stringify(url)}).then(r=>r.text()).then(console.log)`]);
  assertCommand(result, { json: true }); assert.equal(result.json.synthetic, true); assert.equal(requests, 1);
});
test('timeout, invalid JSON, ACL and unavailable capability are distinct outcomes', async () => {
  const timeout = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 30 });
  assert.throws(() => classifyCommand(timeout), e => e.status === 'failed-timeout');
  assert.throws(() => assertCommand({ exitCode: 0, stdout: 'not json' }, { json: true }), /invalid JSON/);
  assert.throws(() => classifyCommand({ exitCode: 1, stderr: 'HTTP 403 forbidden', stdout: '' }), e => e.status === 'blocked-access');
  assert.throws(() => classifyCommand({ exitCode: 1, stderr: 'HTTP 404 not installed', stdout: '' }), e => e.status === 'blocked-capability');
});
test('failed and blocked reports persist privately; public projection drops raw target and details', async t => {
  const ctx = context(t);
  const report = await executeScenarios([{ id: 'blocked', modes: ['readonly'], mutates: false, requires: [], async run() { throw Object.assign(new Error('private password'), { status: 'blocked-access' }); } }], ctx);
  assert.equal(report.summary.complete, false);
  assert.equal(fs.statSync(path.join(ctx.outputDir, 'private-report.json')).mode & 0o777, 0o600);
  const publicText = fs.readFileSync(path.join(ctx.outputDir, 'public-summary.json'), 'utf8');
  assert.ok(!/password|127\.0\.0\.1|fixture/.test(publicText));
  const projected = publicProjection({ ...report, provenance: { cliPath: '/private/home', version: '1.2.3' } });
  assert.equal(projected.provenance.cliPath, undefined);
});
test('dependent scenarios do not run after failed prerequisite; missing bindings never count as coverage', async t => {
  let ran = false;
  const scenarios = [
    { id: 'a', modes: ['readonly'], mutates: false, requires: [], async run() { throw new Error('expected failure'); } },
    { id: 'b', modes: ['readonly'], mutates: false, requires: ['a'], async run() { ran = true; } },
  ];
  const report = await executeScenarios(scenarios, context(t));
  assert.equal(ran, false); assert.equal(report.results[1].status, 'blocked-prerequisite');
  assert.deepEqual(coverageGaps(null, [], [], 'readonly'), ['coverage inventory missing or empty']);
  assert.ok(coverageGaps({ entries: [{ path: 'version', mode: 'readonly', effectiveOptions: ['$root --json'], acceptance: { requirements: ['scripted-success'] } }] }, [{ id: 'v', modes: ['readonly'], commandPaths: ['version'] }], ['v'], 'readonly').includes('option:version:$root --json:explicit-value'));
});
test('artifact registration checkpoints exact IDs and refuses broad ownership; cleanup bounded and dependent-first', async t => {
  const calls = [];
  const ctx = context(t, { mode: 'pdi', allowWrites: true }, async (_exe, args) => {
    calls.push(args);
    const json = calls.length % 3 === 1 ? { result: [{ sys_id: calls.length === 1 ? child : parent }] } : { result: [] };
    return { exitCode: 0, stdout: JSON.stringify(json), stderr: '', json, durationMs: 1 };
  });
  const parent = 'a'.repeat(32), child = 'b'.repeat(32);
  assert.throws(() => ctx.registerArtifact({ table: 'sys_user', id: '*', kind: 'bad' }), /Exact/);
  assert.throws(() => ctx.registerArtifact({ table: 'sys_user', id: parent, kind: 'bad', cleanupArgs: ['records', 'delete', '--query', 'nameLIKEacceptance'] }), /exact owned/);
  ctx.registerArtifact({ table: 'sys_user', id: parent, kind: 'fixture', cleanupArgs: ['records', 'delete', parent, '--table', 'sys_user'] });
  ctx.registerArtifact({ table: 'sys_user', id: child, kind: 'fixture', dependsOn: [parent], cleanupArgs: ['records', 'delete', child, '--table', 'sys_user'] });
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.outputDir, 'artifacts.json'))).artifacts.length, 2);
  assert.deepEqual(await ctx.cleanup(), []);
  assert.equal(calls[1][3], child);
  assert.equal(calls[4][3], parent);
  assert.equal(calls.length, 6);
  assert.deepEqual(await ctx.cleanup(), []); assert.equal(calls.length, 6);
});
test('poll does not exceed retry budget and rejects invalid bounds', async () => {
  let attempts = 0;
  await assert.rejects(poll(() => { attempts++; return false; }, { attempts: 3, intervalMs: 0 }), /exhausted/);
  assert.equal(attempts, 3);
  await assert.rejects(poll(() => true, { attempts: 1000 }), /Invalid/);
});
test('actual CLI local acceptance scenarios run with isolated synthetic config and zero HTTP', async t => {
  let requests = 0;
  const server = http.createServer((_req, res) => { requests++; res.statusCode = 500; res.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const dir = temporary(t), configDir = path.join(dir, 'servicenow');
  fs.mkdirSync(configDir);
  const target = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ profiles: { fixture: { instance_url: target } } }));
  const ctx = createContext({ mode: 'readonly', profile: 'fixture', outputDir: path.join(dir, 'results') }, { target }, {
    execute: (exe, args, opts) => runProcess(exe, args, { ...opts, env: { ...opts.env, XDG_CONFIG_HOME: dir, HOME: dir } }),
  });
  for (const s of readonlyScenarios.filter(s => s.id.startsWith('local.') && s.modes.includes('readonly'))) await s.run(ctx);
  assert.equal(requests, 0);
});

test('actual bounded records scenario and independent SDK readback use loopback only', async t => {
  const requests = [];
  const id = 'c'.repeat(32);
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    res.setHeader('Content-Type', 'application/json');
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === `/api/now/table/sys_db_object/${id}`) res.end(JSON.stringify({ result: { sys_id: id, name: 'sys_user' } }));
    else if (url.pathname === '/api/now/table/sys_db_object') res.end(JSON.stringify({ result: [{ sys_id: id, name: 'sys_user' }] }));
    else res.end(JSON.stringify({ result: [] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const dir = temporary(t), target = `http://127.0.0.1:${server.address().port}`;
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ profiles: { fixture: { instance_url: target, auth_method: 'oauth' } } }));
  const ctx = createContext({ mode: 'readonly', profile: 'fixture', outputDir: path.join(dir, 'results') }, { target }, {
    execute: (exe, args, opts) => runProcess(exe, args, { ...opts, env: { ...opts.env, XDG_CONFIG_HOME: dir, HOME: dir, SERVICENOW_OAUTH_TOKEN: 'synthetic-loopback-token' } }),
  });
  await readonlyScenarios.find(s => s.id === 'readonly.records').run(ctx);
  const reads = requests.filter(r => r.url.startsWith('/api/now/table/sys_db_object'));
  assert.ok(reads.length >= 4);
  assert.ok(reads.every(r => r.method === 'GET'));
  assert.ok(reads.some(r => r.url.includes('sysparm_limit=1')));
});

test('keep retains fixtures but always restores attempted scenario context', async t => {
  const ctx = context(t); ctx.keep = true;
  let restored = 0, cleaned = 0;
  ctx.cleanup = async () => { cleaned++; return []; };
  await executeScenarios([{ id: 'context', modes: ['readonly'], mutates: false, requires: [], async run() {}, async cleanup() { restored++; } }], ctx);
  assert.equal(restored, 1); assert.equal(cleaned, 0);
});
test('failed dependent cleanup prevents deleting its parent and never retries writes', async t => {
  let writes = 0;
  const parent = 'd'.repeat(32), child = 'e'.repeat(32);
  const ctx = context(t, { mode: 'pdi', allowWrites: true }, async (_exe, args) => {
    if (args.includes('delete')) { writes++; return { exitCode: 1, stdout: '', stderr: 'ambiguous synthetic network failure' }; }
    return { exitCode: 0, stdout: '{}', stderr: '', json: { result: [{ sys_id: child }] } };
  });
  ctx.registerArtifact({ table: 'sys_user', id: parent, kind: 'parent', cleanupArgs: ['records', 'delete', parent, '--table', 'sys_user'] });
  ctx.registerArtifact({ table: 'sys_user', id: child, kind: 'child', dependsOn: [parent], cleanupArgs: ['records', 'delete', child, '--table', 'sys_user'] });
  assert.equal((await ctx.cleanup()).length, 2);
  assert.equal(writes, 1);
});
test('fresh output directory required and unbounded Table reads refused before dispatch', async t => {
  const ctx = context(t);
  assert.throws(() => createContext({ mode: 'readonly', profile: 'fixture', outputDir: ctx.outputDir }, { target: ctx.expectedHost }), /already owns/);
  await assert.rejects(ctx.read('sys_user', { limit: 1000 }), /Unbounded/);
  await assert.rejects(ctx.read('../sys_user'), /Invalid/);
});
test('actual runner rejects missing/wrong target and unknown flags with zero HTTP', async t => {
  let requests = 0;
  const server = http.createServer((_req, res) => { requests++; res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const dir = temporary(t);
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}` } } }));
  const env = { ...process.env, XDG_CONFIG_HOME: dir, HOME: dir };
  for (const key of Object.keys(env)) if (/PROXY|^NODE_OPTIONS$|^SERVICENOW_INSTANCE_URL$/i.test(key)) delete env[key];
  for (const args of [[], ['--profile', 'unknown', '--expected-host', 'wrong.example'], ['--profile', 'fixture', '--expected-host', 'wrong.example'], ['--surprise']]) {
    const result = await runProcess(process.execPath, [new URL('../scripts/acceptance/run.mjs', import.meta.url).pathname, ...args], { env, cwd: dir });
    assert.notEqual(result.exitCode, 0);
  }
  const result = await runProcess(process.execPath, [new URL('../scripts/acceptance/run.mjs', import.meta.url).pathname, '--profile', 'fixture', '--expected-host', `http://127.0.0.1:${server.address().port}`, '--preflight', '--output-dir', path.join(dir, 'preflight')], { env, cwd: dir });
  assert.equal(result.exitCode, 2); assert.equal(JSON.parse(result.stdout).complete, false);
  assert.equal(requests, 0);
});

test('fixture identity environment is confined to owned paths and the exact selected host', async t => {
  let launched = 0;
  const ctx = context(t, {}, async (_exe, args, opts) => {
    launched++;
    assert.equal(opts.env.SN_PASSWORD, 'synthetic-private');
    assert.ok(args.includes('--profile'));
    return { exitCode: 0, stdout: '{}', stderr: '', json: {} };
  });
  const root = path.join(ctx.outputDir, 'actor');
  const config = path.join(root, 'config');
  fs.mkdirSync(path.join(config, 'servicenow'), { recursive: true });
  const file = path.join(config, 'servicenow/config.json');
  fs.writeFileSync(file, JSON.stringify({ profiles: { fixture: { instance_url: ctx.expectedHost, username: 'fixture-user' } } }));
  await ctx.command(['auth', 'status', '--json'], { env: { HOME: root, XDG_CONFIG_HOME: config, PATH: path.join(root, 'empty'), SN_PASSWORD: 'synthetic-private' } });
  assert.equal(launched, 1);
  assert.ok(!fs.readFileSync(path.join(ctx.outputDir, 'command-1.json'), 'utf8').includes('synthetic-private'));
  fs.writeFileSync(file, JSON.stringify({ profiles: { fixture: { instance_url: 'https://other.example' } } }));
  await assert.rejects(ctx.command(['auth', 'status'], { env: { XDG_CONFIG_HOME: config } }), /selected target/);
  await assert.rejects(ctx.command(['version'], { env: { HOME: '/outside' } }), /private run/);
  assert.equal(launched, 1);
});
test('returned block is not a pass and unattempted prerequisite cleanup does not execute', async t => {
  let cleanup = 0;
  const report = await executeScenarios([
    { id: 'a', modes: ['readonly'], mutates: false, requires: [], async run() { return { status: 'blocked', reason: 'synthetic missing fixture' }; } },
    { id: 'b', modes: ['readonly'], mutates: false, requires: ['a'], async run() { assert.fail('must not run'); }, async cleanup() { cleanup++; } },
  ], context(t));
  assert.equal(report.results[0].status, 'blocked-prerequisite');
  assert.equal(report.summary.complete, false); assert.equal(cleanup, 0);
});

test('zero and all blocked cannot pass', () => {
  assert.equal(summarize([]).complete, false);
  assert.equal(summarize([{ status: 'blocked-access' }]).complete, false);
});
test('patch source selection includes dependency closure and fails closed on unknown', () => {
  const scenarios = [
    { id: 'setup', sources: ['cli/src/commands/setup.js'], requires: [] },
    { id: 'record', sources: ['cli/src/commands/records.js'], requires: ['setup'] },
  ];
  assert.deepEqual(selectScenarios(scenarios, { release: 'patch', changed: ['cli/src/commands/records.js'] }).ids, ['setup', 'record']);
  assert.deepEqual(selectScenarios(scenarios, { scenarios: ['record'] }).ids, ['setup', 'record']);
  assert.equal(selectScenarios(scenarios, { scenarios: ['setup'] }).full, false);
  assert.throws(() => selectScenarios(scenarios, { scenarios: ['unknown'] }), /Unknown/);
  assert.deepEqual(parseArgs(['--scenario', 'setup', '--scenario', 'record']).scenarios, ['setup', 'record']);
  assert.equal(selectScenarios(scenarios, { release: 'patch', changed: ['unmapped.js'] }).full, true);
  assert.equal(selectScenarios(scenarios, { release: 'patch', changed: ['cli/src/auth.js'] }).full, true);
  assert.equal(selectScenarios(scenarios, { release: 'patch', changed: ['cli/src/commands/_generic.js'] }).full, true);
  assert.equal(selectScenarios(scenarios, { release: 'patch', changed: [] }).full, true);
  assert.equal(selectScenarios(scenarios, { release: 'minor', changed: ['cli/src/commands/records.js'] }).full, true);
  assert.equal(selectScenarios(scenarios, { release: 'patch', full: true, changed: ['cli/src/commands/records.js'] }).full, true);
  assert.equal(selectScenarios([{ id: 'bad', sources: ['mapped.js'], requires: ['missing'] }], { release: 'patch', changed: ['mapped.js'] }).full, true);
});
