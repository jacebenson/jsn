import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {preserveRecovery} from '../scripts/acceptance/recovery.mjs';
import {guardFullContext} from '../scripts/acceptance/full-safety.mjs';
test('unresolved cleanup retains exact recovery IDs and snapshot, excluding secrets',async()=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'recovery-test-'));
 try {
 const a='a'.repeat(32),b='b'.repeat(32),c='c'.repeat(32);
 const ctx={runKey:'acceptance_test',outputDir:dir,state:new Map([['workflows.originalContext',{application:'global',updateset:a,username:'SECRET_USER'}],['workflows.context',{captureId:b}]]),command:async()=>{throw Error('No mutation allowed');},registerArtifact:()=>{},reconcileWrites:async()=>true};
 fs.writeFileSync(path.join(dir,'artifacts.json'),JSON.stringify({expectedHost:'https://SECRET_HOST',artifacts:[{table:'sys_update_set',id:b,kind:'capture-set',token:'SECRET_TOKEN'}],writeIntents:[{table:'sys_hub_flow',action:'create',id:c,status:'uncertain',name:'SECRET_NAME',env:{password:'SECRET_PASSWORD'}}]}));
 guardFullContext(ctx,{inventory:{entries:[]},receiptFile:path.join(dir,'cleanup-receipt.json'),target:'vendor-1'});
 assert.deepEqual(await ctx.cleanup(),['unresolved-write-intent']);
 const receipt=JSON.parse(fs.readFileSync(path.join(dir,'cleanup-receipt.json')));
 assert.equal(receipt.originalSnapshot.updateset,a);assert.equal(receipt.captureId,b);assert.equal(receipt.writeIntents[0].id,c);assert.equal(receipt.sessionRestoration,'unresolved');
 const text=fs.readFileSync(path.join(dir,'recovery-manifest.json'),'utf8');assert.ok(!text.includes('SECRET'));assert.equal(fs.statSync(path.join(dir,'recovery-manifest.json')).mode&0o777,0o600);
 fs.unlinkSync(path.join(dir,'artifacts.json'));
 assert.equal(preserveRecovery(ctx,dir,'vendor-1').journalStatus,'unavailable');
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'recovery-manifest.json'))).originalSnapshot.updateset,a);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
