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
test('non-JSON stderr preserves only closed exception, transport and runtime evidence', () => {
  for (const [stderr, expected] of [
    ['TypeError: private payload https://private.invalid/token', {exceptionType:'TypeError'}],
    ['Error: connect ECONNREFUSED private-host:443 token=secret', {exceptionType:'Error',transportCode:'ECONNREFUSED'}],
    ['Error: Could not locate the bindings file. private/path', {reason:'runtime.native-binding-missing'}],
    ['Error: Flow abc creation incomplete and left orphan draft flow abc: secret', {failurePhase:'parent-allocated-content-incomplete'}],
  ]) {
    const diagnostic=flowCommandDiagnostic(['flows','create'],{exitCode:1,stdout:'',stderr});
    for(const [key,value] of Object.entries(expected)) assert.equal(diagnostic[key],value);
    assert.doesNotMatch(JSON.stringify(diagnostic),/private|secret|payload|https|abc/);
  }
  const diagnostic=flowCommandDiagnostic(['flows','create'],{exitCode:1,stderr:'CustomSecretError: secret SECRET_TRANSPORT token'});
  assert.equal(diagnostic.exceptionType,null);
  assert.equal(diagnostic.transportCode,null);
});
