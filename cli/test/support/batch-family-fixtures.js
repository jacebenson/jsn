// Explicit expected payloads, independent of adapter implementations.
const ref = name => ({ $ref: `steps.${name}.sys_id` });
export const families = [
  { name: 'catalog variables', steps: [
    { name: 'item', type: 'catalog_item', fields: { name: 'Batch fixture', active: false }, payload: { name: 'Batch fixture', short_description: '', active: false, type: 'item' } },
    { name: 'variable', type: 'catalog_variable', parent: ['cat_item', 'item'], fields: { cat_item: ref('item'), label: 'CPU' }, payload: { name: 'cpu', question_text: 'CPU', type: 6, cat_item: ref('item'), mandatory: false, order: 100, active: true } },
  ] },
  { name: 'catalog UI policies and actions', steps: [
    { name: 'item', type: 'catalog_item', fields: { name: 'Batch fixture', active: false }, payload: { name: 'Batch fixture', short_description: '', active: false, type: 'item' } },
    { name: 'policy', type: 'catalog_ui_policy', parent: ['catalog_item', 'item'], fields: { short_description: 'Batch policy', catalog_item: ref('item'), active: false } },
    { name: 'variable', type: 'catalog_variable', parent: ['cat_item', 'item'], fields: { cat_item: ref('item'), label: 'CPU' }, payload: { name: 'cpu', question_text: 'CPU', type: 6, cat_item: ref('item'), mandatory: false, order: 100, active: true } },
    { name: 'action', type: 'catalog_ui_policy_action', parent: ['ui_policy', 'policy'], fields: { ui_policy: ref('policy'), catalog_variable: { $ref: 'steps.variable.catalog_variable' }, mandatory: 'true' } },
  ] },
  { name: 'catalog client scripts', steps: [
    { name: 'item', type: 'catalog_item', fields: { name: 'Batch fixture', active: false }, payload: { name: 'Batch fixture', short_description: '', active: false, type: 'item' } },
    { name: 'script', type: 'catalog_client_script', parent: ['cat_item', 'item'], fields: { cat_item: ref('item'), name: 'Batch script', type: 'onLoad', script: 'function onLoad() {}', active: false } },
  ] },
  { name: 'ACL roles', steps: [
    { name: 'acl', type: 'acl', fields: { name: 'incident', operation: 'read', type: 'record', active: false } },
    { name: 'role', type: 'acl_role', parent: ['sys_security_acl', 'acl'], fields: { sys_security_acl: ref('acl'), sys_user_role: 'a'.repeat(32) } },
  ] },
  { name: 'UI policy actions', steps: [
    { name: 'policy', type: 'ui_policy', fields: { short_description: 'Batch policy', table: 'incident', active: false } },
    { name: 'action', type: 'ui_policy_action', parent: ['ui_policy', 'policy'], fields: { ui_policy: ref('policy'), field: 'short_description', mandatory: 'true' } },
  ] },
  { name: 'data policy rules', steps: [
    { name: 'policy', type: 'data_policy', fields: { model_table: 'incident', short_description: 'Batch policy', active: false } },
    { name: 'rule', type: 'data_policy_rule', parent: ['sys_data_policy', 'policy'], fields: { sys_data_policy: ref('policy'), table: 'incident', field: 'short_description', mandatory: 'true' } },
  ] },
  { name: 'Service Portal layout and instances', steps: [
    { name: 'page', type: 'sp_page', fields: { id: 'jsn_batch_fixture', title: 'Batch page', public: false } },
    { name: 'container', type: 'sp_container', parent: ['sp_page', 'page'], fields: { sp_page: ref('page'), name: 'Batch container', order: 100 } },
    { name: 'row', type: 'sp_row', parent: ['sp_container', 'container'], fields: { sp_container: ref('container'), order: 100 } },
    { name: 'column', type: 'sp_column', parent: ['sp_row', 'row'], fields: { sp_row: ref('row'), size: 12 } },
    { name: 'instance', type: 'sp_instance', parent: ['sp_column', 'column'], fields: { sp_column: ref('column'), sp_widget: 'b'.repeat(32), title: 'Batch instance', active: false } },
  ] },
];

export function familyDocument(family, operation = 'create') {
  return { version: 1, steps: family.steps.map((step, index) => ({
    name: step.name, type: step.type, operation,
    fields: operation === 'delete' ? Object.fromEntries(Object.entries(step.fields).filter(([, value]) => value?.$ref)) : structuredClone(step.fields),
    ...(operation !== 'create' ? { target: { sys_id: (index + 1).toString(16).padStart(32, '0') } } : {}),
  })) };
}
