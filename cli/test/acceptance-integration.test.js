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
import { scenarios as resources, denied } from './acceptance/resources.mjs';
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
  assert.equal(ids.size, 94);
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
  assert.equal(report.results.length, 94);
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

test('denial envelope journal rejects unknown codes, auth failures, prose and status-only failures', async t => {
  const failures = [
    { exitCode: 1, json: { ok: false, code: 'confirmation_required', error: 'approval marker' } },
    { exitCode: 1, json: { ok: false, code: 'usage_error', error: 'approval marker' } },
    { exitCode: 1, json: { ok: false, code: 'validation_error', error: 'approval marker' } },
    { exitCode: 0, json: { ok: false, code: 'confirmation_required', error: 'approval marker' } },
    { exitCode: 1, json: { ok: true, code: 'confirmation_required', error: 'approval marker' } },
    { exitCode: 1, json: { ok: false, code: 'confirmation_required', error: 'unrelated' } },
    { exitCode: 1, json: { ok: false, code: 'api_error', error: 'approval marker' } },
    { exitCode: 1, json: { ok: false, code: 'auth_error', error: 'HTTP 401 approval marker' } },
    { exitCode: 1, json: { ok: false, error: { code: 'confirmation_required', message: 'approval marker' } } },
    { exitCode: 1, json: { ok: false, status: 403, error: 'approval marker' } },
    { exitCode: 1, stderr: 'approval marker' },
  ];
  for (const [index, result] of failures.entries()) {
    let dispatches = 0;
    const ctx = context(t, async () => { dispatches++; return result; });
    const id = 'a'.repeat(32), captureId = 'b'.repeat(32), expected = index < 3;
    ctx.state.set('workflows.context', { captureId });
    ctx.read = async () => [{ sys_id: id }];
    const run = () => denied(ctx, ['properties', 'delete', id, '--json'], /approval marker/);
    if (expected) await run(); else await assert.rejects(run);
    const journal = JSON.parse(fs.readFileSync(path.join(ctx.outputDir, 'artifacts.json')));
    assert.equal(journal.writeIntents.at(-1).status, expected ? 'resolved' : 'uncertain', JSON.stringify(result));
    if (!expected) {
      await assert.rejects(ctx.command(['properties', 'delete', id, '--force', '--json']), /Unresolved/);
      await ctx.cleanup();
      assert.equal(ctx.state.get('cleanup.unresolvedChildren'), true);
      assert.equal(dispatches, 1, 'unrelated refusal must not authorize a second mutation');
    }
  }
});

// Ambiguity regressions exercise the real runner and command guard, offline only.
{
const cap='a'.repeat(32), prop='b'.repeat(32), original='c'.repeat(32);
const ok=data=>({exitCode:0,stdout:'',stderr:'',json:{ok:true,data}});
function fixture(t, mode) {
 const root=fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jsn-ambiguity-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let current=original, application='global', record=null, forcedDeletes=0;
 const events=[], dispatchJournals=[];
 const ctx=createContext({mode:'pdi',allowWrites:true,profile:'synthetic',outputDir:path.join(root,'run')},{target:'https://synthetic.invalid'},{execute:async(_exe,argv)=>{
  const args=argv.slice(1); events.push(args.slice(0,2).join(' '));
  dispatchJournals.push(JSON.parse(fs.readFileSync(path.join(root,'run','artifacts.json'))));
  if(args[0]==='rest')return ok({result:{current:args[1].endsWith('/application')?application:{sysId:current}}});
  if(args[0]==='updatesets'&&args[1]==='create'){current=cap;if(mode==='capture-timeout')return {exitCode:1,stdout:'',stderr:'lost capture response',timedOut:true};return ok({sys_id:cap});}
  if(args[0]==='updatesets'&&args[1]==='set'){assert.equal(args[2],'original_working_set');current=original;return ok({sys_id:original});}
  if(args[0]==='scopes'){application=args[2];return ok({});}
  if(args[0]==='properties'&&args[1]==='create'){
   record={sys_id:prop,...JSON.parse(args[args.indexOf('--data')+1])};
   if(mode==='create-timeout')return {exitCode:1,stdout:'',stderr:'timeout',timedOut:true};
   if(mode==='missing-create-id')return ok({});
   if(mode==='ambiguous-create')return {exitCode:1,stdout:'',stderr:'synthetic response lost'};
   return ok(record);
  }
  if(args[0]==='properties'&&args[1]==='update'){Object.assign(record,JSON.parse(args[args.indexOf('--data')+1]));return ok(record);}
  if(args[0]==='properties'&&args[1]==='show')return ok(record);
  if(args[0]==='properties'&&args[1]==='delete'){
   if(!args.includes('--force'))return {exitCode:1,stdout:'',stderr:'',json:{ok:false,code:'confirmation_required',error:'confirmation required'}};
   forcedDeletes++;
   if(mode==='delete-timeout')return {exitCode:1,stdout:'',stderr:'timeout',timedOut:true};
   if(mode==='delete-unreadable' || mode==='delete-present')return ok({deleted:true});
   if(mode==='delete-absent'){record=null;return {exitCode:1,stdout:'',stderr:'lost deletion response'};}
   if(mode==='normal'){record=null;return ok({deleted:true});}
   if(forcedDeletes===1)return {exitCode:1,stdout:'',stderr:'synthetic timeout after DELETE dispatch'};
   record=null;return ok({deleted:true});
  }
  throw Error('Unexpected synthetic dispatch');
 }});
 ctx.read=async(table,opts)=>{
  if(table==='sys_dictionary')return ['name','value','description'].map(element=>({element,mandatory:'false',read_only:'false'}));
  if(table==='sys_update_set'){
   const row=opts.id===cap?{sys_id:cap,name:'owned_capture',state:'in progress',application:'global'}:{sys_id:original,name:'original_working_set',state:'in progress',application:'global'};
   return opts.id?row:[row];
  }
  if(table==='sys_properties'){if(record && mode==='create-unreadable')throw Error('synthetic unreadable allocation');if(forcedDeletes && mode==='delete-unreadable')throw Error('synthetic unreadable verification');return opts.id?record:record?[record]:[];}
  throw Error('Unexpected synthetic read');
 };
 return {ctx,events,dispatchJournals,get forcedDeletes(){return forcedDeletes;},get record(){return record;},get current(){return current;}};
}
test('ambiguous property DELETE is dispatched once and retains capture',async t=>{
 const f=fixture(t,'ambiguous-delete');
 const report=await executeScenarios([...resources.filter(s=>s.id==='resources.properties'),workflows[0]],f.ctx);
 assert.equal(report.results.find(r=>r.id==='resources.properties').status,'failed');
 assert.equal(f.forcedDeletes,1);
 assert.equal(f.current,cap);
});
test('ambiguous create checkpoints identity intent and retains capture',async t=>{
 const f=fixture(t,'ambiguous-create');
 const report=await executeScenarios([...resources.filter(s=>s.id==='resources.properties'),workflows[0]],f.ctx);
 assert.equal(report.results.find(r=>r.id==='resources.properties').status,'failed');
 assert.ok(f.record);
 const manifest=JSON.parse(fs.readFileSync(path.join(f.ctx.outputDir,'artifacts.json')));
 assert.deepEqual(manifest.artifacts.map(a=>a.table),['sys_update_set']);
 assert.equal(f.ctx.state.get('cleanup.unresolvedChildren'),true);
 assert.ok(manifest.writeIntents.some(i=>i.table==='sys_properties' && i.status==='uncertain' && i.runKey===f.ctx.runKey));
 assert.equal(f.current,cap);
});
test('ambient unrelated credentials are not inherited by actual guarded launcher',async t=>{
 const root=fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jsn-ambiguity-env-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 process.env.SAFETY_REVIEW_SYNTHETIC_SECRET='not-a-real-secret';
 t.after(()=>delete process.env.SAFETY_REVIEW_SYNTHETIC_SECRET);
 let checked=false;
 const ctx=createContext({mode:'readonly',profile:'synthetic',outputDir:path.join(root,'run')},{target:'https://synthetic.invalid'},{execute:async(_exe,_argv,{env})=>{
  assert.equal(Object.hasOwn(env,'SAFETY_REVIEW_SYNTHETIC_SECRET'),false);
  assert.equal(Object.hasOwn(env,'SERVICENOW_OAUTH_TOKEN'),false);
  checked=true;return ok({});
 }});
 await ctx.command(['version']);assert.ok(checked);
});

const selected = [...resources.filter(s=>s.id==='resources.properties'), workflows[0]];
const manifest = f => JSON.parse(fs.readFileSync(path.join(f.ctx.outputDir,'artifacts.json')));
for (const mode of ['delete-timeout','delete-unreadable','delete-present']) test(`${mode}: no automatic second delete, including another cleanup call`,async t=>{
 const f=fixture(t,mode);
 await executeScenarios(selected,f.ctx);
 await f.ctx.cleanup();
 assert.equal(f.forcedDeletes,1);
 assert.equal(f.current,cap);
 assert.equal(f.ctx.state.get('cleanup.unresolvedChildren'),true);
 assert.ok((manifest(f).writeIntents || []).some(i=>i.action==='delete' && i.status==='uncertain' && i.id===prop));
});
for (const mode of ['create-timeout','missing-create-id','ambiguous-create']) test(`${mode}: blocks independent mutations but permits readonly diagnostics`,async t=>{
 const f=fixture(t,mode); let mutation=false, diagnostic=false;
 const report=await executeScenarios([...selected,
  {id:'probe.mutation',modes:['pdi'],requires:[],mutates:true,async run(){mutation=true;}},
  {id:'probe.read',modes:['pdi'],requires:[],mutates:false,async run(ctx){await ctx.command(['rest','/api/now/ui/concoursepicker/updateset','--method','GET','--json']);diagnostic=true;}}
 ],f.ctx);
 assert.equal(mutation,false); assert.equal(diagnostic,true);
 assert.equal(report.results.find(r=>r.id==='probe.mutation').status,'blocked-prerequisite');
 assert.equal(f.current,cap); assert.equal(f.forcedDeletes,0);
 await assert.rejects(f.ctx.command(['properties','update',prop,'--data','{"value":"retry"}','--json']),/Unresolved/);
 const intent=manifest(f).writeIntents.find(i=>i.table==='sys_properties');
 assert.equal(intent.name,`jsn_acceptance_${f.ctx.runKey}_properties`);
 assert.equal(intent.captureId,cap); assert.equal(intent.id,undefined);
});
test('capture allocation response loss journals intent before any session switch and holds restoration',async t=>{
 const f=fixture(t,'capture-timeout');
 await executeScenarios(selected,f.ctx);
 assert.equal(f.events.includes('updatesets set'),false);
 assert.equal(f.events.includes('scopes set'),false);
 assert.equal(f.current,cap);
 assert.ok((manifest(f).writeIntents || []).some(i=>i.table==='sys_update_set' && i.name.endsWith('_capture') && i.status==='uncertain'));
});
test('keep never deletes or restores after unresolved allocation, while private auth material is removed',async t=>{
 const f=fixture(t,'ambiguous-create'); f.ctx.keep=true;
 const root=path.join(f.ctx.outputDir,'auth-private');fs.mkdirSync(root);fs.writeFileSync(path.join(root,'create.json'),'synthetic-private');
 const user={password:'synthetic',env:{SN_PASSWORD:'synthetic'}};
 f.ctx.state.set('auth.fixtures',{root,users:[user]});
 await executeScenarios([{...auth[0],requires:[],async run(){}},...selected],f.ctx);
 assert.equal(f.current,cap); assert.equal(f.forcedDeletes,0);
 assert.equal(fs.existsSync(root),false);assert.equal(user.password,undefined);
 assert.equal(f.ctx.state.has('auth.fixtures'),false);
});
test('write intent exists on disk before create and delete dispatch, without payload or environment',async t=>{
 const f=fixture(t,'normal');
 await executeScenarios(selected,f.ctx);
 const propertyCreate=f.dispatchJournals.find(m=>m.writeIntents?.some(i=>i.table==='sys_properties' && i.action==='create' && i.status==='uncertain'));
 assert.ok(propertyCreate);
 assert.ok(f.dispatchJournals.some(m=>m.writeIntents?.some(i=>i.action==='delete' && i.id===prop && i.status==='uncertain')));
 for (const intent of manifest(f).writeIntents) assert.ok(Object.keys(intent).every(k=>['runKey','table','action','name','id','captureId','status'].includes(k)));
 assert.equal(f.current,original); assert.equal(f.forcedDeletes,1);
 assert.equal(f.ctx.state.get('writes.unresolved'),false);
});
test('independent exact-ID absence fulfills ambiguous deletion without another write',async t=>{
 const f=fixture(t,'delete-absent');
 await executeScenarios(selected,f.ctx);
 assert.equal(f.forcedDeletes,1); assert.equal(f.current,original);
 assert.equal(f.ctx.state.get('writes.unresolved'),false);
 assert.equal(manifest(f).artifacts.find(a=>a.id===prop).cleaned,true);
});

test('acknowledged allocation with failed independent readback holds known child and capture',async t=>{
 const f=fixture(t,'create-unreadable');
 await executeScenarios(selected,f.ctx);
 assert.equal(f.forcedDeletes,0);assert.equal(f.current,cap);
 assert.equal(f.ctx.state.get('cleanup.unresolvedChildren'),true);
 assert.ok((manifest(f).writeIntents || []).some(i=>i.table==='sys_properties' && i.id===prop && i.status==='uncertain'));
});
test('uncertain child deletion retains transitive ancestors and selected capture',async t=>{
 const f=fixture(t,'ambiguous-delete'), parent='d'.repeat(32), grand='e'.repeat(32);
 const scenario={id:'probe.chain',modes:['pdi'],requires:['workflows.context'],mutates:true,async run(ctx){
  for(const [id,dependsOn] of [[grand,[cap]],[parent,[grand]]])ctx.registerArtifact({table:'sys_user',id,kind:'owned-parent',dependsOn,cleanupArgs:['users','delete',id,'--force','--json']});
  const result=await ctx.command(['properties','create','--data',JSON.stringify({name:`${ctx.runKey}_child`}), '--json']);
  ctx.registerArtifact({table:'sys_properties',id:result.json.data.sys_id,kind:'owned-child',dependsOn:[parent],cleanupArgs:['properties','delete',prop,'--force','--json']});
  await ctx.command(['properties','delete',prop,'--force','--json']);
 }};
 await executeScenarios([scenario,workflows[0]],f.ctx);
 assert.equal(f.forcedDeletes,1);assert.equal(f.current,cap);
 assert.ok(manifest(f).artifacts.every(a=>a.cleaned===false));
 assert.equal(f.events.includes('users delete'),false);
});
}
