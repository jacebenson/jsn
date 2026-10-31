import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { catalogOrderCommands } from '../src/commands/catalog-order.js';
import { catalogCmd } from '../src/commands/catalog.js';
import { captureCommands } from './support/command-test-helpers.js';
import { isMutationCommand, refreshMutationCommands } from '../src/mutations.js';
const ID = 'a'.repeat(32), REQUEST = 'b'.repeat(32), USER = 'c'.repeat(32);
function fixture() {
  const calls = [], output = [];
  const app = { config: {}, sdk: { baseURL: 'https://example.invalid', request: async (url, options) => {
    calls.push({url, ...options});
    if (options.method === 'GET') return { result: { sys_id: ID, name: 'Laptop', sys_class_name: 'sc_cat_item', variables: [] } };
    return { result: { request_id: REQUEST, request_number: 'REQ001' } };
  } }, ok: (data, options) => output.push({data, options}) };
  return { app, calls, output, run: (verb,args) => catalogOrderCommands(fn=>fn).find(c=>c.command.startsWith(verb+' ')).handler({id:ID,quantity:1,limit:20,force:true,...args},app) };
}
test('catalog order submits exactly once with typed variables and reports request/item tracking hints', async () => {
  const f=fixture();
  await f.run('order',{variables:'{"agree":false,"count":0,"notes":"line1\\nline2"}',requestedFor:USER,quantity:2,profile:'work'});
  assert.deepEqual(f.calls.map(c=>c.method),['GET','POST']);
  assert.ok(f.calls[1].url.endsWith(`/items/${ID}/order_now`));
  assert.deepEqual(JSON.parse(f.calls[1].body),{sysparm_quantity:2,sysparm_requested_for:USER,variables:{agree:false,count:0,notes:'line1\nline2'}});
  assert.equal(f.output[0].data.request_id,REQUEST);
  assert.equal(f.output[0].data.submitted,true);
  assert.ok(f.output[0].options.breadcrumbs.every(h=>h.cmd.endsWith(' --profile work')));
  assert.equal('variables' in f.output[0].data,false);
});
test('preview validates a JSON file without submitting or echoing variable values', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'jsn-order-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'variables.json'); fs.writeFileSync(file,'{"secret":"private fixture"}');
  const f=fixture(); await f.run('order',{variablesFile:file,dryRun:true,force:false});
  assert.deepEqual(f.calls.map(c=>c.method),['GET']);
  assert.deepEqual(f.output[0].data.variable_names,['secret']);
  assert.equal(f.output[0].data.submitted,false);
  assert.ok(!JSON.stringify(f.output).includes('private fixture'));
});
test('confirmation precedes POST and pins a complete rerun without echoing inline variables', async () => {
  const f=fixture();
  await assert.rejects(f.run('order',{force:false,variables:'{"secret":"hidden"}',quantity:2,profile:'work'}),e=>e.code==='confirmation_required'&&e.hint.includes(ID)&&e.hint.includes('--quantity 2')&&!e.hint.includes('hidden'));
  assert.deepEqual(f.calls.map(c=>c.method),['GET']);
});
test('malformed input and unsupported item types cannot submit', async () => {
  for(const args of [{id:'../item'},{quantity:0},{quantity:1.5},{variables:'[]'},{variables:'{bad'},{requestedFor:'bad'},{variables:'{}',variablesFile:'both.json'}]) {
    const f=fixture(); await assert.rejects(f.run('order',args)); assert.equal(f.calls.length,0);
  }
  const f=fixture(); f.app.sdk.request=async()=>({result:{sys_id:ID,sys_class_name:'sc_cat_item_producer'}});
  await assert.rejects(f.run('order',{}),/record producers/);
});
test('uncertain/rejected/malformed submission outcomes never trigger a second order', async () => {
  for(const outcome of [new Error('timeout'),Object.assign(new Error('denied'),{status:403}),{result:{}},{result:{error:'failed',request_id:REQUEST,request_number:'REQ001'}}]) {
    const f=fixture(), request=f.app.sdk.request;
    f.app.sdk.request=async(url,options)=>{
      if(options.method==='GET') return request(url,options);
      f.calls.push({url,...options});
      if(outcome instanceof Error) throw outcome;
      return outcome;
    };
    await assert.rejects(f.run('order',{}));
    assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
    assert.equal(f.output.length,0);
  }
});
test('catalog search and describe use native access-aware endpoints and strict result shapes', async () => {
  const f=fixture(); f.app.sdk.request=async(url,options)=>{f.calls.push({url,...options});return {result:[{sys_id:ID,name:'Laptop'}]};};
  await f.run('search',{text:'laptop & bag',limit:1,profile:'work'});
  assert.equal(new URL(f.calls[0].url).searchParams.get('sysparm_text'),'laptop & bag');
  assert.equal(f.output[0].data.possibly_truncated,true);
  assert.ok(f.output[0].options.breadcrumbs[0].cmd.includes('describe'));
  await assert.rejects(f.run('describe',{}),/readable item/);
});
test('real CLI blocks both canonical and alias ordering for a read-only profile before transport', t => {
  catalogCmd(fn=>fn); refreshMutationCommands();
  assert.equal(isMutationCommand({_:['catalogitems','order']}),true);
  assert.ok(captureCommands(catalogCmd(fn=>fn)).some(c=>c.command==='describe <id>'));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'jsn-order-ro-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'servicenow'));
  fs.writeFileSync(path.join(root,'servicenow','config.json'),JSON.stringify({activeProfile:'ro',profiles:{ro:{instance_url:'https://example.invalid',read_only:true}}}));
  const cli=new URL('../bin/jsn.js',import.meta.url);
  for(const command of ['catalogitems','ci']) {
    const r=spawnSync(process.execPath,[fileURLToPath(cli),command,'order',ID,'--profile','ro','--json'],{encoding:'utf8',cwd:root,env:{...process.env,XDG_CONFIG_HOME:root,JSN_NO_VERSION_CHECK:'1',JSN_NO_SKILL_CHECK:'1'}});
    assert.notEqual(r.status,0);assert.match(r.stdout+r.stderr,/read.only/i);
  }
});
