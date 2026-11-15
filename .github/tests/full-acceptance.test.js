import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { stageHarness, runLocal } from '../scripts/run-acceptance.mjs';
import { guardFullContext, fullPlan } from '../scripts/acceptance/full-safety.mjs';

test('full immutable catalog plan makes no provider calls and exposes every prerequisite', async () => {
 const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'full-plan-test-'));
 try {
  const result = await runLocal({ plan:true, target:'vendor-1', output:path.join(root,'plan') });
  const plan = JSON.parse(fs.readFileSync(result.file));
  assert.equal(plan.mode,'pdi'); assert.equal(plan.scenarios.length,92);
  assert.ok(plan.scenarios.some(s=>s.id==='workflows.catalog-fulfillment' && s.blockedReason));
  assert.ok(plan.scenarios.some(s=>s.id==='auth.fixtures' && s.requires.includes('workflows.context')));
  assert.ok(plan.scenarios.some(s=>s.id==='resources.properties' && s.mutates));
 } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('guarded immutable context sends POST PATCH DELETE, finally cleans on failure and refuses unowned writes', async () => {
 const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(),'full-http-test-'));
 const id='a'.repeat(32), other='b'.repeat(32), requests=[]; let row;
 const server=http.createServer(async(req,res)=>{
  requests.push(req.method); let text=''; for await (const chunk of req) text+=chunk;
  if(req.method==='POST') row={...JSON.parse(text),sys_id:id};
  if(req.method==='PATCH') row={...row,...JSON.parse(text)};
  if(req.method==='DELETE') row=undefined;
  res.setHeader('content-type','application/json');res.end(JSON.stringify({result:req.method==='GET' ? req.url.includes('?') ? (row?[row]:[]) : row : row ?? {}}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 try {
  const harness=stageHarness(root,'5.5.5');
  const support=await import(pathToFileURL(path.join(harness,'cli/scripts/acceptance/support.mjs')));
  const {executeScenarios}=await import(pathToFileURL(path.join(harness,'cli/scripts/acceptance/run.mjs')));
  // HTTP transport fixture, not a claimed live or candidate CLI execution.
  const execute=async(node,args)=>{
   let url,method='GET',body;
   if(args[0]==='--input-type=module') {
    const m=args[2].match(/sdk\.request\(("(?:[^"\\]|\\.)*")\)/); assert.ok(m);url=JSON.parse(m[1]);
   } else {
    const a=args.slice(1), opt=k=>a[a.indexOf(k)+1];
    method=({create:'POST',update:'PATCH',delete:'DELETE'})[a[1]]||'GET';
    url=`${origin}/api/now/table/sys_properties${a[1]==='create'?'':`/${a[2]}`}`;
    if(a.includes('--data')) body=opt('--data');
   }
   const response=await fetch(url,{method,body,headers:{'content-type':'application/json'}}); const data=await response.json();
   return {exitCode:0,json:args[0]==='--input-type=module'?data:{ok:true,data:data.result},stdout:'',stderr:'',durationMs:1};
  };
  const ctx=support.createContext({profile:'acceptance',mode:'pdi',allowWrites:true,outputDir:path.join(root,'run')},{target:origin},{execute});
  const inventory=JSON.parse(fs.readFileSync(path.join(harness,'cli/test/acceptance/coverage.json')));
  const receipt=path.join(root,'cleanup.json');guardFullContext(ctx,{inventory,receiptFile:receipt,target:'vendor-1'});
  await assert.rejects(ctx.command(['properties','update',other,'--data','{"value":"bad"}','--json']),/unowned/);
  assert.throws(()=>ctx.registerArtifact({table:'sys_properties',id:other,kind:'unowned'}),/allocation/);
  assert.equal(requests.length,0);
  let restored=false;
  const scenario={id:'test.failure',modes:['pdi'],mutates:true,requires:[],run:async c=>{
   await c.command(['properties','create','--data',JSON.stringify({name:`jsn_acceptance_${c.runKey}_property`,value:'initial'}),'--json']);
   c.registerArtifact({table:'sys_properties',id,kind:'resource:properties',cleanupArgs:['properties','delete',id,'--force','--json']});
   await c.command(['properties','update',id,'--data','{"value":"updated"}','--json']);
   throw Error('deliberate failure');
  },cleanup:async()=>{restored=true;}};
  const report=await executeScenarios([scenario],ctx);
  assert.equal(report.results[0].status,'failed');assert.equal(restored,true);assert.equal(row,undefined);
  for(const verb of ['POST','PATCH','DELETE']) assert.ok(requests.includes(verb));
  const saved=JSON.parse(fs.readFileSync(receipt));assert.equal(saved.created,1);assert.equal(saved.deleted,1);assert.equal(saved.retained,0);
  assert.doesNotMatch(fs.readFileSync(receipt,'utf8'),/127\.0\.0\.1|token|username/);
 } finally { await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true}); }
});
