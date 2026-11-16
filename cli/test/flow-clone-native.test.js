import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { verifyClonedFlow, verifyClonedVersions, validateCloneSource, serializeNativeClone, flowCloneDigest } from '../src/flow-clone.js';
import { sourceFlow, clonedFlow } from './fixtures/flow-clone.js';

const capture = JSON.parse(fs.readFileSync(new URL('./fixtures/flow-clone-native-capture.json', import.meta.url)));
test('source digest ignores JSON map insertion order but preserves array order and authored values', () => {
  assert.equal(flowCloneDigest({b:2,a:{z:1,y:3}}),flowCloneDigest({a:{y:3,z:1},b:2}));
  assert.notEqual(flowCloneDigest([1,2]),flowCloneDigest([2,1]));
  assert.notEqual(flowCloneDigest({value:'authored'}),flowCloneDigest({value:'changed'}));
});
test('sanitized retained native allocation preserves full authored graph and serialized version', () => {
  assert.equal(verifyClonedFlow(capture.source,capture.destination,capture.destination.name).verified,true);
  assert.equal(verifyClonedVersions(capture.sourceVersion,capture.destinationVersion),true);
  const body=serializeNativeClone(capture.destination);
  assert.deepEqual(body.triggerInstances,capture.destination.triggerInstances);
  assert.deepEqual(body.inputs,capture.destination.inputs);
  assert.deepEqual(body.outputs,capture.destination.outputs);
  assert.deepEqual(body.actionInstances[0].inputs,capture.destination.actionInstances[0].inputs);
  assert.equal(body.actionInstances[0].compiledSnapshot,capture.destination.actionInstances[0].compiledSnapshot);
  assert.equal(body.actionInstances[0].actionType.inputs,undefined);
  assert.deepEqual(capture.destination.actionInstances[0].actionType.inputs,capture.source.actionInstances[0].actionType.inputs);
  const bad=structuredClone(capture.destinationVersion);
  bad.triggerInstances[0].outputs[1].parameter.attributes.unverified='corruption';
  assert.throws(()=>verifyClonedVersions(capture.sourceVersion,bad),/content\/schema/);
});

test('choice omission is limited to native trigger input parameter lists, never authored payloads', () => {
  const source = structuredClone(capture.sourceVersion), destination = structuredClone(capture.destinationVersion);
  for (const input of destination.triggerInstances[0].inputs) {
    delete input.parameter.choices;
    delete input.parameter.defaultChoices;
  }
  assert.equal(verifyClonedVersions(source, destination), true);
  for (const field of ['choices', 'defaultChoices']) for (const locate of [
    flow => flow.actionInstances[0].inputs[0].parameter,
    flow => flow.triggerInstances[0].inputs[0].parameter,
    flow => flow.actionInstances[0],
  ]) {
    const a = structuredClone(source), b = structuredClone(destination);
    locate(a).defaultValue = { [field]: [], keep: 'authored schema default' };
    locate(b).defaultValue = { [field]: [], keep: 'authored schema default' };
    assert.equal(verifyClonedVersions(a, b), true);
    delete locate(b).defaultValue[field];
    assert.throws(() => verifyClonedVersions(a, b), /content\/schema/);
  }
  for (const field of ['choices', 'defaultChoices']) {
    const a = structuredClone(source), b = structuredClone(destination);
    a.unknownPayload = { parameter: { name: 'fake', type: 'choice', [field]: [] } };
    b.unknownPayload = { parameter: { name: 'fake', type: 'choice' } };
    assert.throws(() => verifyClonedVersions(a, b), /content\/schema/);
    b.triggerInstances[0].inputs[0].parameter.name = 'not-the-input';
    delete a.unknownPayload;
    delete b.unknownPayload;
    assert.throws(() => verifyClonedVersions(a, b), /content\/schema/);
  }
});

// Structural shape observed in native copy followed by a real Designer Save.
// No provider payload, instance identity or user content is retained here.
function nativePair() {
  const source = sourceFlow(), destination = clonedFlow();
  const a = source.actionInstances[0], b = destination.actionInstances[0];
  a.compiledSnapshot = '';
  a.actionType.id = a.actionTypeSysId;
  b.actionType.id = b.actionTypeSysId;
  b.uiUniqueIdentifier = a.uiUniqueIdentifier;
  b.compiledSnapshot = b.actionType.id;
  return { source, destination };
}
test('native copy preserves flow-local UI identity and derives published-action snapshot', () => {
  const { source, destination } = nativePair();
  assert.equal(verifyClonedFlow(source, destination, destination.name).verified, true);
  assert.equal(verifyClonedVersions(source, destination), true);
  assert.throws(() => validateCloneSource(destination), /runtime/);
});
test('native serialized fId/fState schema is preserved without flattening', () => {
  const { source, destination } = nativePair();
  for (const flow of [source, destination]) {
    const action = flow.actionInstances[0];
    action.actionType = { fId: action.actionType.id, fState: 'published', fInputs: [{ name: 'input', attributes: { element_mapping_provider: 'provider' } }] };
  }
  assert.equal(verifyClonedVersions(source, destination), true);
  delete destination.actionInstances[0].actionType.fInputs[0].attributes.element_mapping_provider;
  assert.throws(() => verifyClonedVersions(source, destination), /content\/schema/);
});

for (const [name, change] of [
  ['unrelated snapshot', f => { f.actionInstances[0].compiledSnapshot = 'f'.repeat(32); }],
  ['mismatched reusable definition', f => { f.actionInstances[0].actionType.id = 'f'.repeat(32); }],
  ['runtime snapshot', f => { f.actionInstances[0].snapshot = 'f'.repeat(32); }],
  ['changed authored input', f => { f.actionInstances[0].inputs[0].value = 'corrupted'; }],
  ['changed schema', f => { f.actionInstances[0].inputs[0].parameter.choices = []; }],
  ['reused database identity', f => { f.actionInstances[0].id = sourceFlow().actionInstances[0].id; }],
]) test(`native copy rejects ${name}`, () => {
  const { source, destination } = nativePair(); change(destination);
  assert.throws(() => verifyClonedFlow(source, destination, destination.name));
  assert.throws(() => verifyClonedVersions(source, destination));
});
