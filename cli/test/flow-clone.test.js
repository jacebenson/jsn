import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCloneSource, verifyClonedFlow, verifyClonedVersions } from '../src/flow-clone.js';
import { verifyCopyCapture } from '../src/flow-clone-capture.js';
import { sourceFlow, clonedFlow, cloneId } from './fixtures/flow-clone.js';

test('native clone verifies independent graph pair with remapped pill and unchanged literal IDs/scripts/maps/schema', () => {
  assert.equal(verifyClonedFlow(sourceFlow(), clonedFlow(), 'New flow').verified, true);
});
for (const [name, change] of [
  ['stale pill', flow => { flow.actionInstances[0].inputs[0].value = '{{33333333333333333333333333333333.current}}'; }],
  ['changed literal script', flow => { flow.actionInstances[0].inputs[1].value = "return 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'"; }],
  ['changed literal key', flow => { flow.actionInstances[0].inputs[2].value = { bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }; }],
  ['choice drop', flow => { flow.actionInstances[0].inputs[0].parameter.choices = []; }],
  ['condition drop', flow => { flow.triggerInstances[0].inputs[0].value = ''; }],
  ['schema default', flow => { flow.actionInstances[0].inputs[0].parameter.defaultValue = 'b'; }],
  ['description', flow => { flow.description = 'changed'; }],
  ['security policy', flow => { flow.access = 'private'; }],
  ['domain', flow => { flow.domainId = 'other'; }],
  ['reused model', flow => { flow.flowCatalogVariableModelId = '2'.repeat(32); }],
  ['reused action', flow => { flow.actionInstances[0].id = '4'.repeat(32); }],
  ['missing scope', flow => { delete flow.scope; }],
]) test(`clone rejects ${name}`, () => {
  const destination = clonedFlow(); change(destination);
  assert.throws(() => verifyClonedFlow(sourceFlow(), destination, 'New flow'));
});
for (const key of ['flowLogicInstances', 'subFlowInstances', 'flowVariables', 'flowCatalogVariables', 'stages', 'connection_configurations']) {
  test(`preflight refuses unsupported ${key} rather than dropping it`, () => {
    const source = sourceFlow(); source[key] = [{ id: 'e'.repeat(32) }];
    assert.throws(() => validateCloneSource(source), /No clone allocated/);
  });
}
for (const [name, change] of [
  ['unknown top field', source => { source.newGraphDomain = []; }],
  ['unknown component relation', source => { source.actionInstances[0].newParentRelation = '4'.repeat(32); }],
  ['nested logic', source => { source.actionInstances[0].parent = '4'.repeat(32); }],
  ['error handler', source => { source.startingIndexOfErrorHandlingInstances = 0; }],
  ['embedded pill', source => { source.actionInstances[0].inputs[0].value = 'prefix {{33333333333333333333333333333333.current}}'; }],
  ['active source', source => { source.active = true; }],
  ['missing access', source => { delete source.security.can_write; }],
]) test(`preflight rejects ${name}`, () => {
  const source = sourceFlow(); change(source);
  assert.throws(() => validateCloneSource(source), /No clone allocated/);
});
test('serialized versions preserve full schema and unknown serialized content without replacing literals', () => {
  assert.equal(verifyClonedVersions(sourceFlow(), clonedFlow()), true);
  const changed = clonedFlow();
  changed.actionInstances[0].inputs[0].parameter.choices[0].label = 'Dropped schema meaning';
  assert.throws(() => verifyClonedVersions(sourceFlow(), changed), /content\/schema/);
  const other = clonedFlow(); other.unexpectedSavedGraph = {};
  assert.throws(() => verifyClonedVersions(sourceFlow(), other), /content\/schema/);
  // A fresh draft save is uncompiled; any other engine version is not accepted.
  const compiled = sourceFlow(), draft = clonedFlow();
  compiled.engineVersion = 2; draft.engineVersion = 0;
  assert.equal(verifyClonedVersions(compiled, draft), true);
  draft.engineVersion = 1;
  assert.throws(() => verifyClonedVersions(compiled, draft), /content\/schema/);
  // Empty choice lists are serialization-equivalent; real choices are not.
  const emptyChoiceSource = structuredClone(sourceFlow()), emptyChoiceSave = structuredClone(clonedFlow());
  for (const flow of [emptyChoiceSource, emptyChoiceSave]) for (const input of flow.actionInstances[0].inputs) input.parameter.choices = [];
  for (const input of emptyChoiceSave.actionInstances[0].inputs) delete input.parameter.choices;
  assert.equal(verifyClonedVersions(emptyChoiceSource, emptyChoiceSave), true);
  const otherChoices = structuredClone(emptyChoiceSave);
  otherChoices.actionInstances[0].inputs[0].parameter.choices = [{ label: 'B', value: 'b' }];
  assert.throws(() => verifyClonedVersions(emptyChoiceSource, otherChoices), /content\/schema/);
});

test('editor-added provider type label is accepted only at its exact derived value', () => {
  // Live-measured: the native save re-materializes attributes.uiTypeLabel on
  // FlowDesignVariableMapper variables whose source omitted it. Any other value
  // must still fail, and pre-existing authored labels are still compared exactly.
  const variable = (id, type_label) => ({ id, name: 'current', type: 'document_id', type_label, children: [],
    attributes: { element_mapping_provider: 'com.glide.flow_design.action.data.FlowDesignVariableMapper', uiType: 'document_id' } });
  const source = sourceFlow(), destination = clonedFlow();
  source.inputs.push(variable('0a'.repeat(16), 'Document ID'));
  destination.inputs.push(variable('0b'.repeat(16), 'Document ID'));
  assert.equal(verifyClonedFlow(source, destination, 'New flow').verified, true);
  destination.inputs[0].attributes.uiTypeLabel = 'Document ID';
  assert.equal(verifyClonedFlow(source, destination, 'New flow').verified, true);
  destination.inputs[0].attributes.uiTypeLabel = 'Unrelated Label';
  assert.throws(() => verifyClonedFlow(source, destination, 'New flow'), /miswired inputs/);
});

test('capture validates actual XML parent and version, not unrelated string matches', () => {
  const version = '5'.repeat(32);
  assert.equal(verifyCopyCapture(`<record_update><sys_hub_flow><sys_id>${cloneId}</sys_id><version_record>${version}</version_record></sys_hub_flow></record_update>`, cloneId, version), true);
  for (const xml of [`<record_update><unrelated>${cloneId}${version}</unrelated></record_update>`, `<sys_hub_flow><sys_id>${cloneId}</sys_id><version_record>wrong</version_record></sys_hub_flow>`, '<!DOCTYPE a><a/>', '<broken>']) assert.equal(verifyCopyCapture(xml, cloneId, version), false);
});
