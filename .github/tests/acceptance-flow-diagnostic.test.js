import test from 'node:test';
import assert from 'node:assert/strict';
import {flowCommandDiagnostic} from '../scripts/acceptance/flow-diagnostic.mjs';
test('Flow diagnostics retain closed reason and shape, never provider strings or arbitrary codes/keys', () => {
  const result={exitCode:1,stderr:'private-host secret-token Flow trigger insert returned no trigger identity',json:{ok:false,error:{code:'secret-token'},data:{flow:{},'private_host':'secret-token'}}};
  const diagnostic=flowCommandDiagnostic(['flows','create','--data','secret-token'],result);
  assert.equal(diagnostic.reason,'trigger.insert.missing-identity');
  assert.equal(diagnostic.outcome,'cli-failure');
  assert.deepEqual(diagnostic.dataKeys,['flow']);
  assert.equal(diagnostic.errorCode,null);
  assert.ok(!JSON.stringify(diagnostic).includes('private'));
  assert.ok(!JSON.stringify(diagnostic).includes('secret'));
  assert.equal(flowCommandDiagnostic(['flows','create'],{exitCode:0,json:{ok:true,data:{flow:{}}}}).reason,null);
  assert.equal(flowCommandDiagnostic(['flows','create'],{exitCode:1,stderr:'unexpected private provider message'}).reason,'cli.failure.unclassified');
});
