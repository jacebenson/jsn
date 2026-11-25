// Independently authored provider-shaped pair. No ID-string replacement.
export const sourceId = 'a'.repeat(32), cloneId = 'b'.repeat(32), setId = 'c'.repeat(32);
const parameter = { id: 'd'.repeat(32), name: 'message', type: 'string', children: [], choices: [{ label: 'A', value: 'a' }], attributes: { preserved: 'yes' }, defaultValue: 'a' };
const common = {
  type: 'flow', active: false, status: 'draft', deleted: false, scope: 'global', description: 'Description with literal aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  security: { can_read: true, can_write: true }, domainId: 'global', domainName: 'global', access: 'public', protection: '', runAs: 'user', runWithRoles: { value: '', valueAsList: [] },
  startingIndexOfErrorHandlingInstances: -1, flowLogicInstances: [], subFlowInstances: [], flowVariables: [], flowCatalogVariables: [], stages: {}, connection_configurations: [],
  inputs: [], outputs: [], attributes: { arbitrary: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
};
export function sourceFlow() {
  return structuredClone({ ...common, id: sourceId, name: 'Source', copiedFrom: '', versionRecordId: '1'.repeat(32), flowCatalogVariableModelId: '2'.repeat(32),
    triggerInstances: [{ id: '3'.repeat(32), flowSysId: sourceId, type: 'record_create_or_update', deleted: false, inputs: [{ name: 'condition', value: 'active=true', parameter }], outputs: [] }],
    actionInstances: [{ id: '4'.repeat(32), flowSysId: sourceId, uiUniqueIdentifier: '44444444-4444-4444-4444-444444444444', order: '1', parent: '', deleted: false, actionTypeSysId: 'd'.repeat(32), actionType: { state: 'published' },
      comment: 'literal aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', inputs: [{ name: 'record', value: '{{33333333333333333333333333333333.current}}', parameter }, { name: 'script', value: "return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'", scriptActive: true, parameter }, { name: 'map', value: { aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, parameter }] }],
  });
}
export function clonedFlow() {
  return structuredClone({ ...common, id: cloneId, name: 'New flow', copiedFrom: sourceId, versionRecordId: '5'.repeat(32), flowCatalogVariableModelId: '6'.repeat(32),
    triggerInstances: [{ id: '7'.repeat(32), flowSysId: cloneId, type: 'record_create_or_update', deleted: false, inputs: [{ name: 'condition', value: 'active=true', parameter }], outputs: [] }],
    actionInstances: [{ id: '8'.repeat(32), flowSysId: cloneId, uiUniqueIdentifier: '88888888-8888-8888-8888-888888888888', order: '1', parent: '', deleted: false, actionTypeSysId: 'd'.repeat(32), actionType: { state: 'published' },
      comment: 'literal aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', inputs: [{ name: 'record', value: '{{77777777777777777777777777777777.current}}', parameter }, { name: 'script', value: "return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'", scriptActive: true, parameter }, { name: 'map', value: { aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, parameter }] }],
  });
}
