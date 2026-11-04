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
const ID = 'a'.repeat(32), REQUEST = 'b'.repeat(32), USER = 'c'.repeat(32), RITM = 'd'.repeat(32);
const VARIABLES = [
  { name: 'agree', label: 'I agree', type: 7, friendly_type: 'check_box', mandatory: false },
  { name: 'notes', label: 'Notes', type: 2, friendly_type: 'multi_line_text', mandatory: true },
];
function fixture({ variables = [], order, ritm, ritmThrows } = {}) {
  const calls = [], output = [];
  const app = { config: {}, sdk: { baseURL: 'https://example.invalid', request: async (url, options) => {
    calls.push({url, ...options});
    if (options.method === 'GET' && url.includes('/api/now/table/sc_req_item')) {
      if (ritmThrows) throw ritmThrows;
      if (ritm) return ritm;
      return { result: [{ sys_id: RITM, number: 'RITM001', cat_item: ID }] };
    }
    if (options.method === 'GET') return { result: { sys_id: ID, name: 'Laptop', sys_class_name: 'sc_cat_item', variables } };
    return order || { result: { request_id: REQUEST, request_number: 'REQ001', sys_id: REQUEST, number: 'REQ001', table: 'sc_request' } };
  } }, ok: (data, options) => output.push({data, options}) };
  return { app, calls, output, run: (verb,args) => catalogOrderCommands(fn=>fn).find(c=>c.command.startsWith(verb+' ')).handler({id:ID,quantity:1,limit:20,force:true,...args},app) };
}
const posts = f => f.calls.filter(c => c.method === 'POST');

test('catalog order submits once with typed variables and reports request plus requested-item identifiers', async () => {
  const f=fixture();
  await f.run('order',{variables:'{"agree":false,"count":0,"notes":"two words"}',requestedFor:USER,quantity:2,profile:'work'});
  assert.deepEqual(f.calls.map(c=>c.method),['GET','POST','GET']);
  assert.ok(f.calls[1].url.endsWith(`/items/${ID}/order_now`));
  assert.deepEqual(JSON.parse(f.calls[1].body),{sysparm_quantity:2,sysparm_requested_for:USER,variables:{agree:false,count:0,notes:'two words'}});
  assert.equal(f.output[0].data.request_id,REQUEST);
  assert.equal(f.output[0].data.request_number,'REQ001');
  assert.deepEqual(f.output[0].data.requested_items,[{sys_id:RITM,number:'RITM001'}]);
  assert.equal(f.output[0].data.requested_items_readable,true);
  assert.equal(f.output[0].data.submitted,true);
  assert.ok(f.output[0].options.breadcrumbs.some(h=>h.cmd.includes(`requests show RITM001`)));
  assert.ok(f.output[0].options.breadcrumbs.every(h=>h.cmd.endsWith(' --profile work')));
  assert.equal('variables' in f.output[0].data,false);
});

test('describe lists catalog variables with their types and required flags', async () => {
  const f=fixture({ variables: VARIABLES });
  await f.run('describe',{});
  assert.deepEqual(f.calls.map(c=>c.method),['GET']);
  const { data } = f.output[0];
  assert.deepEqual(data.variables.map(v=>[v.name,v.type,v.mandatory]),[['agree',7,false],['notes',2,true]]);
  assert.deepEqual(data.required_variables,['notes']);
  assert.equal(data.variables_reported,true);
});

test('preview validates a JSON file without submitting or echoing variable values', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'jsn-order-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'variables.json'); fs.writeFileSync(file,'{"secret":"private fixture","notes":"private fixture"}');
  const f=fixture({ variables: VARIABLES }); await f.run('order',{variablesFile:file,dryRun:true,force:false});
  assert.deepEqual(f.calls.map(c=>c.method),['GET']);
  assert.deepEqual(f.output[0].data.variable_names,['secret','notes']);
  assert.deepEqual(f.output[0].data.required_variables,['notes']);
  assert.equal(f.output[0].data.submitted,false);
  assert.ok(!JSON.stringify(f.output).includes('private fixture'));
});

test('missing required catalog variables refuse submission before confirmation or transport', async () => {
  const f=fixture({ variables: VARIABLES });
  await assert.rejects(f.run('order',{force:false,variables:'{"agree":true}'}),e=>e.code==='usage_error'&&e.message.includes('notes'));
  assert.deepEqual(f.calls.map(c=>c.method),['GET']);
  assert.equal(f.output.length,0);
});

test('unknown variable names are reported without blocking a valid order', async () => {
  const f=fixture({ variables: VARIABLES });
  await f.run('order',{variables:'{"notes":"ok","typo_name":"x"}'});
  assert.deepEqual(f.output[0].data.unknown_variable_names,['typo_name']);
  assert.equal(posts(f).length,1);
});

test('confirmation precedes POST and pins a complete rerun without echoing inline variables', async () => {
  const f=fixture({ variables: VARIABLES });
  await assert.rejects(f.run('order',{force:false,variables:'{"notes":"hidden"}',quantity:2,profile:'work'}),e=>e.code==='confirmation_required'&&e.hint.includes(ID)&&e.hint.includes('--quantity 2')&&!e.hint.includes('hidden'));
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
  for(const outcome of [new Error('timeout'),Object.assign(new Error('denied'),{status:403}),{result:{}},{result:{error:'failed',request_id:REQUEST,request_number:'REQ001'}},{result:{errMsg:'Mandatory variable missing',request_id:REQUEST,request_number:'REQ001'}}]) {
    const f=fixture(), request=f.app.sdk.request;
    f.app.sdk.request=async(url,options)=>{
      if(options.method==='GET') return request(url,options);
      f.calls.push({url,...options});
      if(outcome instanceof Error) throw outcome;
      return outcome;
    };
    await assert.rejects(f.run('order',{}));
    assert.equal(posts(f).length,1);
    assert.equal(f.output.length,0);
  }
});

test('an unreadable requested-item lookup still reports the placed order without resubmitting', async () => {
  const f=fixture({ ritmThrows: Object.assign(new Error('denied'),{status:403}) });
  await f.run('order',{});
  assert.equal(posts(f).length,1);
  assert.equal(f.output[0].data.submitted,true);
  assert.equal(f.output[0].data.request_id,REQUEST);
  assert.equal(f.output[0].data.requested_items_readable,false);
  assert.deepEqual(f.output[0].data.requested_items,[]);
});

test('catalog search and describe use native access-aware endpoints and strict result shapes', async () => {
  const f=fixture(); f.app.sdk.request=async(url,options)=>{f.calls.push({url,...options});return {result:[{sys_id:ID,name:'Laptop'}]};};
  await f.run('search',{text:'laptop & bag',limit:1,profile:'work'});
  assert.equal(new URL(f.calls[0].url).searchParams.get('sysparm_text'),'laptop & bag');
  assert.equal(f.output[0].data.possibly_truncated,true);
  assert.ok(f.output[0].options.breadcrumbs[0].cmd.includes('describe'));
  await assert.rejects(f.run('describe',{}),/readable item/);
});

test('describe reports only answerable questions and separates the instance-supplied Requested for', async () => {
  const variables = [
    { name: '', label: 'Options', type: 0, friendly_type: 'container_start', mandatory: false, children: [
      { name: 'agree', label: 'I agree', type: 7, friendly_type: 'check_box', mandatory: false },
    ] },
    { name: 'note', label: '<p>Read this</p>', type: 32, friendly_type: 'rich_text_label', mandatory: false },
    { name: 'rich_text', label: 'Name', type: 23, friendly_type: 'html', mandatory: false },
    { name: 'macro_widget', label: 'Widget', type: 14, friendly_type: 'macro', mandatory: false },
    { name: 'widget_dummy', label: 'Widget label', type: 17, friendly_type: 'macro_with_abel', mandatory: false },
    { name: 'requested_for', label: 'Requested for', type: 31, friendly_type: 'requested_for', mandatory: true },
  ];
  const f=fixture({ variables });
  await f.run('describe',{});
  const { data } = f.output[0];
  assert.deepEqual(data.variables.map(v=>v.name),['agree','requested_for']);
  assert.deepEqual(data.required_variables,[],'a layout entry or the instance-supplied requester is not an answer to build');
  assert.deepEqual(data.instance_supplied_variables,['requested_for']);
  assert.equal(data.variables.find(v=>v.name==='requested_for').instance_supplied,true);
  assert.equal(data.variables_reported,true);
});

test('a mandatory Requested for never blocks an order the instance can fill', async () => {
  const variables = [
    { name: 'requested_for', label: 'Requested for', type: 31, friendly_type: 'requested_for', mandatory: true },
    ...VARIABLES,
  ];
  const f=fixture({ variables });
  await f.run('order',{variables:'{"notes":"ok"}'});
  assert.deepEqual(f.calls.map(c=>c.method),['GET','POST','GET']);
  assert.equal(f.output[0].data.submitted,true);
  assert.equal(f.output[0].data.request_number,'REQ001');
  assert.deepEqual(f.output[0].data.unknown_variable_names,undefined);
});

test('a preview also accepts a mandatory Requested for without a payload value', async () => {
  const variables = [
    { name: 'requested_for', label: 'Requested for', type: 31, friendly_type: 'requested_for', mandatory: true },
    ...VARIABLES,
  ];
  const f=fixture({ variables });
  await f.run('order',{variables:'{"notes":"ok"}',dryRun:true,requestedFor:USER});
  assert.deepEqual(f.calls.map(c=>c.method),['GET']);
  assert.equal(f.output[0].data.submitted,false);
  assert.deepEqual(f.output[0].data.required_variables,['notes']);
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
