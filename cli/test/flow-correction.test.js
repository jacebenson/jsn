import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateFlowFromManifest } from '../src/flow-create.js';
import { readFlowPatch } from './helpers/flow-patch-fixture.js';
function fixture(mutate = d=>d, before = {flowId:'flow-review',scope:'scope-1',updated:'2020-01-01 00:00:00',actionInstances:[],flowLogicInstances:[],triggerInstances:[],flowVariables:[]}) {
 let saved=structuredClone(before), patch, lease=false, versions=0;
 const stats={patches:0,autosaves:0,leases:0};
 const sdk={
 async list(table) {
  if(table==='sys_hub_flow') return [{sys_id:'flow-review',name:'Review',scope:'scope-1',status:'draft',active:'false'}];
  if(table==='sys_hub_action_type_definition') return [{sys_id:'action-log',name:'Log',active:'true'}];
  if(table==='sys_hub_flow_version') return versions++ ? [{sys_id:'version-review',flow:'flow-review',type:'Autosave'}] : [];
  if(table==='sys_update_xml') return [{sys_id:'xml-review',payload:'flow-review'}];
  throw new Error(`Unhandled list ${table}`);
 },
 async request(url, opts={}) {
  if(opts.method==='GET') {
   if(url.includes('/action/action_types/')) return {result:{inputs:[{id:'message',name:'log_message',type:'string',mandatory:true}]}};
   assert.ok(url.includes('/processflow/flow/flow-review?'),url);
   return {result:{data:structuredClone(saved)}};
  }
  if(url.includes('/versioning/create_version?')) {stats.autosaves++; return {result:{sys_id:'version-review',type:'Autosave'}};}
  assert.ok(url.endsWith('/graphql'),url);
  const query=JSON.parse(opts.body).query;
  if(query.includes('safeEdit(')) {
   let safeEdit;
   if(query.includes('upsert:')) {stats.leases++;lease=true; safeEdit={status:{canUserEdit:true,currentEditor:null,clientFlowStale:null}};}
   else if(query.includes('delete:')) {lease=false;safeEdit={deleteResult:{deleteSuccess:true,id:'flow-review'}};}
   else safeEdit={status:{canUserEdit:lease,currentEditor:null}};
   return {data:{global:{snFlowDesigner:{safeEdit}}}};
  }
  patch=readFlowPatch(query);stats.patches++;
  for(const key of Object.keys(patch)) assert.ok(['flowId','actions','flowLogics','labelCache'].includes(key),`Unhandled patch field ${key}`);
  const response={};
  for(const [key,field] of [['actions','actionInstances'],['flowLogics','flowLogicInstances']]) {
   response[key]={inserts:[]};
   for(const op of Object.keys(patch[key]||{})) assert.ok(['insert','update'].includes(op),`Unhandled ${op}`);
   for(const step of patch[key]?.insert||[]) {
    assert.ok(step.flowSysId==='flow-review' && step.uiUniqueIdentifier && step.order!==undefined);
    saved[field].push({...structuredClone(step),id:`db-${step.uiUniqueIdentifier}`});
    response[key].inserts.push({sysId:`db-${step.uiUniqueIdentifier}`,uiUniqueIdentifier:step.uiUniqueIdentifier});
   }
   for(const update of patch[key]?.update||[]) {
    const target=saved[field].find(s=>s.uiUniqueIdentifier===update.uiUniqueIdentifier);assert.ok(target);
    for(const [k,v] of Object.entries(update)) {
     if(k==='inputs') for(const input of v) { const dest=target.inputs.find(i=>i.name===input.name);assert.ok(dest);Object.assign(dest,structuredClone(input)); }
     else if(!['type','uiUniqueIdentifier'].includes(k)) target[k]=structuredClone(v);
    }
   }
  }
  if(patch.labelCache) {assert.deepEqual(Object.keys(patch.labelCache),['insert']);saved.labelCacheAsJsonString=JSON.stringify(patch.labelCache.insert);}
  saved=mutate(saved,patch);
  return {data:{global:{snFlowDesigner:{flow:response}}}};
 }};
 return {sdk,stats,get patch(){return patch;}};
}

for (const [name, mutate] of Object.entries({
  mode: d => { d.actionInstances[0].inputs[0].value.schemaless = true; return d; },
  payload: d => { d.actionInstances[0].inputs[0].value.schemalessValue = 'evil'; return d; },
  schema: d => { d.actionInstances[0].inputs[0].parameter.type = 'integer'; return d; },
})) test(`ordinary inserted action ${name} drift rejects before Autosave`, async () => {
  const f = fixture(mutate);
  await assert.rejects(run(f, { actions: [{ order: 2, type: 'Log', inputs: { log_message: 'value' } }] }));
  assert.equal(f.stats.autosaves, 0);
});
const run = (f, manifest) => updateFlowFromManifest(f.sdk, 'https://offline.invalid', 'flow-review', manifest, { readUpdateSet: async () => ({ name: 'Review', sys_id: 'set-review' }) });
for (const [name, mutate] of Object.entries({
  dropped: d => { delete d.flowLogicInstances[0].flowVariables; return d; },
  value: d => { d.flowLogicInstances[0].flowVariables[0].value.value = 'wrong'; return d; },
  mode: d => { d.flowLogicInstances[0].flowVariables[0].value.schemaless = true; return d; },
  payload: d => { d.flowLogicInstances[0].flowVariables[0].value.schemalessValue = 'evil'; return d; },
})) test(`assignment ${name} corruption rejects before Autosave`, async () => {
  const f = fixture(mutate);
  await assert.rejects(run(f, { logic: [{ order: 2, type: 'set flow variables', values: { counter: '42' } }] }));
  assert.equal(f.stats.autosaves, 0);
});
for (const [name, manifest] of Object.entries({
  conditionOnTry: { logic: [{ order: 2, type: 'try', condition: 'active=true' }] },
  valuesOnIf: { logic: [{ order: 2, type: 'if', values: { x: '42' } }] },
  labelConflict: { logic: [{ order: 2, type: 'if', label: 'one', conditionName: 'two' }] },
  assignmentObject: { logic: [{ order: 2, type: 'set flow variables', values: { x: {} } }] },
  assignmentNull: { logic: [{ order: 2, type: 'set flow variables', values: { x: null } }] },
  twoCatches: { logic: [{ order: 2, type: 'try' }, { order: 3, type: 'catch', connectedToOrder: 2 }, { order: 4, type: 'catch', connectedToOrder: 2 }] },
  mixedCycle: { logic: [{ order: 2, type: 'try', parentOrder: 3 }, { order: 3, type: 'catch', connectedToOrder: 2 }] },
  differentParents: { logic: [{ order: 1, type: 'if' }, { order: 2, type: 'try', parentOrder: 1 }, { order: 3, type: 'catch', connectedToOrder: 2 }] },
  duplicateTopLevel: { logic: [{ order: 2, type: 'top level try' }, { order: 3, type: 'top level catch', connectedToOrder: 2 }], errorHandling: { actions: [] } },
})) test(`${name} rejects before lease or content writes`, async () => {
  const f = fixture();
  await assert.rejects(run(f, manifest));
  assert.deepEqual(f.stats, { patches: 0, autosaves: 0, leases: 0 });
});
test('assignment references resolve allocated action identities and register pills', async () => {
  const f = fixture();
  const result = await run(f, { actions: [{ order: 2, type: 'Log', inputs: { log_message: 'value' } }], logic: [{ order: 3, type: 'set flow variables', values: { message: '{{step_2.log_message}}' } }] });
  const ui = result.processflow.actionInstances[0].uiUniqueIdentifier;
  assert.equal(f.patch.flowLogics.insert[0].flowVariables[0].value.value, `{{${ui}.log_message}}`);
  assert.ok(f.patch.labelCache.insert.some(p => p.name === `${ui}.log_message`));
  assert.equal(f.stats.autosaves, 1);
});
test('second Catch for existing paired Try rejects before writes', async () => {
  const before = { flowId:'flow-review', scope:'scope-1', updated:'2020', actionInstances:[], triggerInstances:[], flowVariables:[], flowLogicInstances:[
    { id:'t', uiUniqueIdentifier:'tu', definitionId:'07223332de022010ec58424b73829721', order:'2', parent:'', parentUiId:'', inputs:[] },
    { id:'c', uiUniqueIdentifier:'cu', definitionId:'35d60003e6022010a5e40cdd1254dd21', order:'3', connectedTo:'tu', parent:'', parentUiId:'', inputs:[] },
  ] };
  const f = fixture(undefined, before);
  await assert.rejects(run(f, { logic: [{ order:4, type:'catch', connectedToOrder:2 }] }));
  assert.deepEqual(f.stats, { patches:0, autosaves:0, leases:0 });
});
