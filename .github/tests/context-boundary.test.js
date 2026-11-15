import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stageHarness } from '../scripts/run-acceptance.mjs';
import { guardFullContext, runContextScenario } from '../scripts/acceptance/full-safety.mjs';

test('immutable context permits global run-owned create and exact restoration; rejects other context', async () => {
 const root=fs.mkdtempSync(path.join(process.env.TMPDIR,'context-boundary-'));
 try {
  const harness=stageHarness(root,'5.5.5');
  const {scenarios}=await import(pathToFileURL(path.join(harness,'cli/test/acceptance/workflows.mjs')));
  const scenario=scenarios.find(s=>s.id==='workflows.context');
  const inventory=JSON.parse(fs.readFileSync(path.join(harness,'cli/test/acceptance/coverage.json')));
  const originalId='a'.repeat(32), captureId='b'.repeat(32), originalApp='c'.repeat(32);
  let application=originalApp, updateset=originalId; const calls=[];
  const original={sys_id:originalId,name:'Original',application:originalApp,state:'in progress'};
  const ctx={mode:'pdi',allowWrites:true,runKey:'context_fixture_run',outputDir:root,state:new Map(),registerArtifact:()=>{},read:async(table,q)=>q.id === captureId ? {sys_id:captureId,name:'Owned capture',state:'in progress'} : q.id?original:[original],command:async(args)=>{
   calls.push(args);
   let data;
   if(args[0]==='rest') data={result:{current:args[1].endsWith('/application')?application:{sysId:updateset}}};
   else if(args[1]==='create') {application='global';updateset=captureId;data={sys_id:captureId};}
   else if(args[0]==='scopes') {application=args[2];data={};}
   else {updateset=originalId;data={};}
   return {exitCode:0,json:{ok:true,data}};
  }};
  guardFullContext(ctx,{inventory,receiptFile:path.join(root,'receipt.json'),target:'vendor-1'});
  await runContextScenario(ctx,scenario.run);
  assert.equal(application,'global');assert.equal(updateset,captureId);
  assert.equal(calls.filter(a=>a[1]==='create').length,1);
  await assert.rejects(ctx.command(['scopes','set','d'.repeat(32),'--json']),/snapshotted/);
  await assert.rejects(ctx.command(['updatesets','set','Unrelated','--json']),/snapshotted/);
  await scenario.cleanup(ctx);
  assert.equal(application,originalApp);assert.equal(updateset,originalId);
  assert.equal(ctx.state.has('workflows.context'),false);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('closed context diagnostics preserve prerequisite reason without arbitrary error text', async () => {
 for(const [message,reason] of [
  ['Original effective application/update-set cannot be restored exactly; no context writes performed','context.snapshot.invalid'],
  ['Original update-set name, scope or state cannot be restored exactly; no context writes performed','context.restore.invalid-record'],
  ['Original update-set name is ambiguous or unreadable; no context writes performed','context.restore.ambiguous-name'],
  ['https://private.example token=secret','context.operation.failed'],
 ]) {
  const command=async()=>{},read=async()=>{};
  const ctx={state:new Map(),command,read};
  await assert.rejects(runContextScenario(ctx,async()=>{throw Error(message);}));
  assert.deepEqual(ctx.state.get('safety.contextDiagnostic'),{stage:'context.snapshot.application',reason});
  assert.equal(ctx.command,command);assert.equal(ctx.read,read);
  assert.doesNotMatch(JSON.stringify(ctx.state.get('safety.contextDiagnostic')),/private|secret|token/);
 }
});
