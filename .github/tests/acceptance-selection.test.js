import test from 'node:test';
import assert from 'node:assert/strict';
import {selectExactScenario} from '../scripts/acceptance/select.mjs';
import {parseOptions} from '../scripts/run-acceptance.mjs';

test('exact Flow selection preserves context dependency and excludes unrelated scenarios', () => {
  const scenarios=[{id:'unrelated'}, {id:'workflows.context',requires:[]}, {id:'workflows.flow-lifecycle',requires:['workflows.context']}];
  assert.deepEqual(selectExactScenario(scenarios,'workflows.flow-lifecycle').map(s=>s.id),['workflows.context','workflows.flow-lifecycle']);
  assert.equal(selectExactScenario(scenarios),scenarios);
  assert.throws(()=>selectExactScenario(scenarios,'workflows.flow'),/exact scenario/);
  assert.throws(()=>selectExactScenario(scenarios.slice(2),'workflows.flow-lifecycle'),/dependency/);
  assert.throws(()=>selectExactScenario([{id:'a',requires:['b']},{id:'b',requires:['a']}],'a'),/cyclic/);
});
test('scenario option is exact, singular and compatible with ordinary target selection', () => {
  const args=['--profile','vendor','--target','vendor1','--scenario','workflows.flow-lifecycle'];
  assert.equal(parseOptions(args).scenario,'workflows.flow-lifecycle');
  assert.throws(()=>parseOptions([...args,'--scenario','other']));
  assert.throws(()=>parseOptions(['--result','file','--publish','--scenario','other']));
});
