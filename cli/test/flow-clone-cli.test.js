import { test } from 'node:test';
import { contextArgs, contextResponse } from './helpers/intended-context.js';
import { credentialFixtureArgs } from './helpers/fake-keyring.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { sourceFlow, clonedFlow, sourceId, cloneId, setId } from './fixtures/flow-clone.js';
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
const args = (alias = 'clone') => ['flows', alias, sourceId, '--name', 'New flow', '--force', '--json'];
async function fixture(scenario, operation) {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'jsn-clone-'));
  const requests = [];
  let allocated = false, captures = 0, released = false, versionCreated = false;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://localhost'), query = url.searchParams.get('sysparm_query');
    requests.push({ method: req.method, path: url.pathname, query, scope: url.searchParams.get('sysparm_transaction_scope'), body: body.startsWith('{') ? JSON.parse(body) : body });
    let result = contextResponse(url, { set: setId, name: scenario.defaultSet ? 'Default' : 'Fixture' }) || { result: [] };
    if (url.pathname.endsWith('/table/sys_hub_flow')) result.result = query?.startsWith('name=New flow') ? scenario.collision ? [{ sys_id: cloneId }] : [] : [{ sys_id: sourceId, sys_scope: 'global', name: 'Source' }];
    if (url.pathname.endsWith('/concoursepicker/updateset')) result = { result: { current: { sysId: scenario.misaligned || allocated && scenario.changedContext ? 'f'.repeat(32) : setId, name: 'Fixture' } } };
    if (url.pathname === `/api/now/processflow/flow/${sourceId}`) {
      const source = sourceFlow();
      if (scenario.sourceMissingPointer) source.versionRecordId = '';
      if (scenario.unsupported) source.stages = { stage: { id: 'e'.repeat(32) } };
      if (allocated && scenario.sourceChanged) source.description = 'changed';
      result = { result: { data: source } };
    }
    if (url.pathname.endsWith('/copy')) {
      allocated = true;
      if (scenario.disconnect) { req.socket.destroy(); return; }
      result = { result: { data: scenario.badEnvelope ? { id: cloneId } : cloneId } };
    }
    if (url.pathname.endsWith('/table/sys_hub_flow_safe_edit')) result.result = released ? [] : [{sys_id: 'd'.repeat(32), flow: cloneId, user: scenario.foreignLease ? 'f'.repeat(32) : 'e'.repeat(32)}];
    if (url.pathname === '/api/now/graphql') {
      const release = JSON.parse(body).query.startsWith('mutation');
      if (release) released = true;
      result = {data:{global:{snFlowDesigner:{safeEdit: release ? {deleteResult:{deleteSuccess:true,id:cloneId}} : {status:{canUserEdit:!released,currentEditor:null}}}}}};
    }
    if (url.pathname === '/api/now/processflow/flow' && scenario.saveFailure) result = {error:{message:'native save rejected'}};
    if (url.pathname.endsWith('/versioning/create_version')) {versionCreated = true;result = {result:{sys_id:'6'.repeat(32)}};}
    if (url.pathname === `/api/now/processflow/flow/${cloneId}`) {
      const copy = clonedFlow();
      if (scenario.provisionalPointer && !versionCreated) copy.versionRecordId = '';
      if (versionCreated) copy.versionRecordId = '6'.repeat(32);
      if (scenario.active) copy.active = true;
      if (scenario.badPill) copy.actionInstances[0].inputs[0].value = '{{33333333333333333333333333333333.current}}';
      result = { result: { data: copy } };
    }
    if (url.pathname.endsWith('/table/sys_hub_flow_version')) {
      const flow = query.includes(`flow=${sourceId}`) ? sourceFlow() : clonedFlow();
      if (versionCreated && flow.id === cloneId) flow.versionRecordId = '6'.repeat(32);
      result.result = allocated && scenario.noVersion ? [] : [{ sys_id: flow.versionRecordId, flow: flow.id, type: versionCreated ? 'Save' : 'update', payload: JSON.stringify(flow) }];
    }
    if (url.pathname.endsWith('/table/sys_update_xml')) {
      captures++;
      result.result = scenario.delayedCapture && captures < 3 ? [] : [{ sys_id: '9'.repeat(32), name: `sys_hub_flow_${cloneId}`, action: 'INSERT_OR_UPDATE', update_set: setId, payload: `<record_update><sys_hub_flow><sys_id>${cloneId}</sys_id><version_record>${scenario.nullCapture ? '' : '6'.repeat(32)}</version_record></sys_hub_flow></record_update>` }];
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const configDir = path.join(dir, 'config'); await fs.mkdir(path.join(configDir, 'servicenow'), { recursive: true });
    await fs.writeFile(path.join(configDir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: !!scenario.readOnly } } }));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SN_|SERVICENOW_|JSN_|XDG_)/i.test(key)));
    Object.assign(env, { HOME: dir, XDG_CONFIG_HOME: configDir, XDG_CACHE_HOME: configDir, JSN_DATA_HOME: path.join(dir, 'data'), JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', SN_USERNAME: 'fixture', SN_PASSWORD: 'synthetic-fixture-only' });
    const run = async argv => {
      try { return { code: 0, ...await exec(process.execPath, [...credentialFixtureArgs, cli, ...argv, ...contextArgs.slice(0, 2), '--expect-update-set', setId], { env, timeout: 20000 }) }; }
      catch (error) { return { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' }; }
    };
    await operation(run, requests);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); }
}
test('provisional native graph reaches save then version creation before strict readback', () => fixture({provisionalPointer:true}, async(run,requests)=>{
  const result=await run(args()); assert.equal(result.code,0,result.stdout+result.stderr);
  const timeline=requests.filter(r=>r.path.endsWith('/copy')||r.path===`/api/now/processflow/flow/${cloneId}`||r.path==='/api/now/processflow/flow'||r.path.endsWith('/create_version')).map(r=>[r.method,r.path]);
  assert.deepEqual(timeline,[['POST',`/api/now/processflow/flow/${sourceId}/copy`],['GET',`/api/now/processflow/flow/${cloneId}`],['PUT','/api/now/processflow/flow'],['GET',`/api/now/processflow/flow/${cloneId}`],['POST','/api/now/processflow/versioning/create_version'],['GET',`/api/now/processflow/flow/${cloneId}`],['PUT','/api/now/processflow/flow'],['GET',`/api/now/processflow/flow/${cloneId}`]]);
  assert.equal(requests.find(r=>r.method==='PUT').body.versionRecordId,'');
}));
test('source missing saved pointer refuses before any allocation',()=>fixture({sourceMissingPointer:true},async(run,requests)=>{
  const result=await run(args());assert.notEqual(result.code,0);assert.match(JSON.parse(result.stdout).error,/saved version pointer/);
  assert.equal(requests.filter(r=>r.path.endsWith('/copy')||r.method==='PUT').length,0);
}));
test('post-completion null XML version fails strictly retaining allocated identity',()=>fixture({provisionalPointer:true,nullCapture:true},async(run,requests)=>{
  const result=await run(args());assert.equal(result.code,1);assert.match(JSON.parse(result.stdout).error,new RegExp(cloneId));assert.match(JSON.parse(result.stdout).error,/XML capture/);
  assert.equal(requests.filter(r=>r.path.endsWith('/copy')).length,1);assert.equal(requests.filter(r=>r.path.endsWith('/create_version')).length,1);
  assert.equal(requests.filter(r=>r.path==='/api/now/graphql'&&r.body.query.startsWith('mutation')).length,1);
}));
for (const alias of ['clone', 'copy']) {
  test(`${alias} actual CLI native allocation and persisted graph/capture readback`, () => fixture({}, async (run, requests) => {
    const result = await run(args(alias)); assert.equal(result.code, 0, result.stdout + result.stderr);
    const data = JSON.parse(result.stdout).data;
    assert.equal(data.flow.id, cloneId); assert.equal(data.source.before_digest, data.source.after_digest);
    assert.equal(data.context_unchanged, true);
    assert.deepEqual(requests.filter(r => r.method !== 'GET' && r.path !== '/angular.do' && r.path !== '/api/now/graphql').map(r => [r.method,r.path]), [
      ['POST', `/api/now/processflow/flow/${sourceId}/copy`], ['PUT','/api/now/processflow/flow'], ['POST','/api/now/processflow/versioning/create_version'],
      ['PUT','/api/now/processflow/flow'],
    ]);
    const mutation = requests.filter(r => r.path === '/api/now/graphql' && r.body.query.startsWith('mutation'));
    assert.equal(mutation.length,1);assert.match(mutation[0].body.query,new RegExp(`delete:"${cloneId}"`));
    assert.deepEqual(requests.find(r => r.path.endsWith('/create_version')).body,{item_sys_id:cloneId,type:'Save',annotation:'',favorite:false});
  }));
  test(`${alias} standard read-only guard emits JSON and performs no writes`, () => fixture({ readOnly: true }, async (run, requests) => {
    const result = await run(args(alias)); assert.notEqual(result.code, 0);
    assert.equal(JSON.parse(result.stdout).ok, false); assert.equal(requests.filter(r => r.method !== 'GET' && r.path !== '/angular.do').length, 0);
  }));
  test(`${alias} confirmation required in automation before writes`, () => fixture({}, async (run, requests) => {
    const result = await run(args(alias).filter(arg => arg !== '--force'));
    assert.equal(JSON.parse(result.stdout).code, 'confirmation_required'); assert.equal(requests.filter(r => r.method !== 'GET' && r.path !== '/angular.do').length, 0);
  }));
}
for (const [name, scenario, argv] of [
  ['name required', {}, ['flows', 'clone', sourceId, '--force', '--json']],
  ['source required', {}, ['flows', 'clone', '--name', 'New flow', '--force', '--json']],
  ['collision', { collision: true }, args()], ['unsupported graph', { unsupported: true }, args()],
  ['Default set', { defaultSet: true }, args()], ['unaligned context', { misaligned: true }, args()],
]) test(`clone preflight ${name}: JSON error with zero writes`, () => fixture(scenario, async (run, requests) => {
  const result = await run(argv); assert.notEqual(result.code, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, false); assert.equal(requests.filter(r => r.method !== 'GET' && r.path !== '/angular.do').length, 0);
}));
for (const scenario of [{ active: true }, { badPill: true }, { sourceChanged: true }, { changedContext: true }, { noVersion: true }, { badEnvelope: true }, { disconnect: true }]) {
  test(`clone partial failure preserves recovery receipt and never retries: ${JSON.stringify(scenario)}`, () => fixture(scenario, async (run, requests) => {
    const result = await run(args()); assert.equal(result.code, 1, result.stdout + result.stderr);
    const envelope = JSON.parse(result.stdout); assert.equal(envelope.ok, false);
    assert.match(envelope.error, scenario.badEnvelope || scenario.disconnect ? /allocation outcome uncertain/ : new RegExp(cloneId));
    assert.match(envelope.hint, /No automatic retry/);
    assert.equal(requests.filter(r => r.path.endsWith('/copy')).length, 1);
  }));
}
test('native save failure releases only positively owned lease and retains allocated ID', () => fixture({saveFailure:true},async(run,requests)=>{
  const result=await run(args());assert.equal(result.code,1);assert.match(JSON.parse(result.stdout).error,new RegExp(cloneId));
  assert.equal(requests.filter(r=>r.path.endsWith('/copy')).length,1);
  assert.equal(requests.filter(r=>r.path.endsWith('/create_version')).length,0);
  assert.equal(requests.filter(r=>r.path==='/api/now/graphql'&&r.body.query.startsWith('mutation')).length,1);
  assert.equal(requests.at(-1).path,'/api/now/table/sys_hub_flow_safe_edit');
}));
test('foreign lease refuses save and release without takeover',()=>fixture({foreignLease:true},async(run,requests)=>{
  const result=await run(args());assert.equal(result.code,1);assert.match(JSON.parse(result.stdout).error,/ownership is unconfirmed/);
  assert.equal(requests.filter(r=>r.method==='PUT'||r.path.endsWith('/create_version')||(r.path==='/api/now/graphql'&&r.body.query.startsWith('mutation'))).length,0);
}));
test('delayed capture only polls GETs and --get extracts native clone identity', () => fixture({ delayedCapture: true }, async (run, requests) => {
  const result = await run([...args().filter(arg => arg !== '--json'), '--get', 'data.flow.id']);
  assert.equal(result.code, 0, result.stdout + result.stderr); assert.match(result.stdout, new RegExp(cloneId));
  assert.equal(requests.filter(r => r.path.endsWith('/sys_update_xml')).length, 3);
  assert.equal(requests.filter(r => r.path.endsWith('/copy')).length, 1);
}));
