import { tableAdapter, string as s, boolean as b, integer as i, parent } from './table.js';

const policy = { short_description: s(true), table: s(), active: b, conditions: s(), on_load: b, reverse_if_false: b, order: i };
const action = { field: s(true), table: s(), mandatory: s(), visible: s(), disabled: s(), cleared: b };

export const familyBatchAdapters = [
  tableAdapter({ type: 'catalog_ui_policy', table: 'catalog_ui_policy', fields: {
    ...policy, catalog_item: parent('catalog_item'), catalog_conditions: s(), applies_catalog: b,
  } }),
  // ui_policy is inherited from sys_ui_policy_action; it references the base
  // sys_ui_policy table, which includes catalog_ui_policy subclass records.
  tableAdapter({ type: 'catalog_ui_policy_action', table: 'catalog_ui_policy_action', fields: {
    ...action, field: s(), ui_policy: parent('catalog_ui_policy'),
    catalog_variable: { type: 'string', parent: true, ref: ['catalog_variable'], refOutput: 'catalog_variable', requiredOnCreate: true }, order: i,
  } }),
  tableAdapter({ type: 'catalog_client_script', table: 'catalog_script_client', targetField: 'name', fields: {
    cat_item: parent('catalog_item'), name: s(true), type: s(true), script: s(true), active: b,
    order: i, field: s(), ui_type: i, applies_catalog: b, applies_req_item: b, applies_sc_task: b,
  } }),
  tableAdapter({ type: 'acl', table: 'sys_security_acl', targetField: 'name', fields: {
    name: s(true), operation: s(true), type: s(true), active: b, description: s(), script: s(),
    condition: s(), advanced: b, admin_overrides: b,
  } }),
  tableAdapter({ type: 'acl_role', table: 'sys_security_acl_role', fields: {
    sys_security_acl: parent('acl'), sys_user_role: s(true),
  } }),
  tableAdapter({ type: 'ui_policy', table: 'sys_ui_policy', fields: policy }),
  tableAdapter({ type: 'ui_policy_action', table: 'sys_ui_policy_action', fields: {
    ...action, ui_policy: parent('ui_policy'),
  } }),
  tableAdapter({ type: 'data_policy', table: 'sys_data_policy2', fields: {
    model_table: s(true), short_description: s(), description: s(), conditions: s(), active: b,
    inherit: b, reverse_if_false: b, apply_import_set: b, apply_soap: b, enforce_ui: b,
  } }),
  tableAdapter({ type: 'data_policy_rule', table: 'sys_data_policy_rule', fields: {
    sys_data_policy: parent('data_policy'), table: s(true), field: s(true), mandatory: s(), disabled: s(),
  } }),
  tableAdapter({ type: 'sp_page', table: 'sp_page', targetField: 'id', fields: {
    id: s(true), title: s(), short_description: s(), public: b, draft: b, css: s(),
  } }),
  tableAdapter({ type: 'sp_container', table: 'sp_container', fields: {
    sp_page: parent('sp_page'), name: s(), title: s(), order: i, width: s(), class_name: s(),
  } }),
  tableAdapter({ type: 'sp_row', table: 'sp_row', fields: {
    sp_container: parent('sp_container'), order: i, class_name: s(),
  } }),
  tableAdapter({ type: 'sp_column', table: 'sp_column', fields: {
    sp_row: parent('sp_row'), order: i, size: i, size_xs: i, size_sm: i, size_lg: i, class_name: s(),
  } }),
  tableAdapter({ type: 'sp_instance', table: 'sp_instance', fields: {
    sp_column: parent('sp_column'), sp_widget: s(true), title: s(), order: i, active: b, css: s(),
  } }),
];
