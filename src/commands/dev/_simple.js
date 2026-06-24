import { buildDevCmd } from './_generic.js';
import { getStringField } from '../../helpers.js';

// Simple table-based dev commands — singular names passed for grammar
// Default columns and aliases match the Go version exactly

async function fetchExtensionChain(sdk, record) {
  const chain = [];
  let current = record;
  let depth = 0;
  const maxDepth = 10;

  while (current && depth < maxDepth) {
    const name = getStringField(current, 'name');
    if (name) {
      chain.push(name);
    }

    const superClass = current.super_class;
    if (!superClass) break;

    let superClassSysId;
    if (typeof superClass === 'object' && superClass != null) {
      superClassSysId = superClass.value;
    } else if (typeof superClass === 'string') {
      superClassSysId = superClass;
    } else {
      break;
    }

    if (!superClassSysId) break;

    const params = new URLSearchParams();
    params.set('sysparm_query', `sys_id=${superClassSysId}`);
    params.set('sysparm_limit', '1');
    params.set('sysparm_fields', 'name,super_class');
    params.set('sysparm_display_value', 'all');

    const records = await sdk.list('sys_db_object', params);
    if (records.length === 0) break;

    current = records[0];
    depth++;
  }

  return chain;
}

export const actionsCmd = (wrap) => buildDevCmd('actions', 'sys_hub_action_type_definition', ['action'], ['name', 'active', 'sys_scope', 'sys_updated_on'], wrap, { singular: 'action', scopeValidation: true });

export const includesCmd = (wrap) => buildDevCmd('includes', 'sys_script_include', ['include', 'si'], ['name', 'api_name', 'active', 'sys_scope'], wrap, { singular: 'script include', scopeValidation: true });

export const rulesCmd = (wrap) => buildDevCmd('rules', 'sys_script', ['rule', 'br'], ['name', 'collection', 'active', 'order', 'sys_scope'], wrap, { singular: 'business rule', scopeValidation: true });

export const clientScriptsCmd = (wrap) => buildDevCmd('clientscripts', 'sys_script_client', ['clientscript', 'cs'], ['name', 'table', 'active', 'type', 'sys_scope'], wrap, { singular: 'client script', scopeValidation: true });

export const uiActionsCmd = (wrap) => buildDevCmd('uiactions', 'sys_ui_action', ['uiaction', 'ua'], ['name', 'table', 'active', 'order', 'sys_scope'], wrap, { singular: 'UI action', scopeValidation: true });

export const uiPoliciesCmd = (wrap) => buildDevCmd('uipolicies', 'sys_ui_policy', ['uipolicy', 'up'], ['short_description', 'table', 'active', 'order', 'sys_scope'], wrap, { singular: 'UI policy', scopeValidation: true });

export const tablesCmd = (wrap) => buildDevCmd('tables', 'sys_db_object', ['table', 't'], ['name', 'label', 'super_class', 'create_access_controls'], wrap, {
  singular: 'table',
  scopeValidation: true,
  showFields: ['name', 'label', 'super_class', 'create_access_controls', 'sys_scope', 'sys_created_on', 'sys_updated_on', 'sys_created_by', 'sys_updated_by', 'is_extendable'],
  async onShow(record, app) {
    const tableName = getStringField(record, 'name');
    const [count, extChain] = await Promise.all([
      app.sdk.aggregateCount('sys_dictionary', 'name=' + tableName),
      fetchExtensionChain(app.sdk, record),
    ]);
    record._column_count = count;
    record._extension_info = { chain: extChain };
  },
});

export const columnsCmd = (wrap) => buildDevCmd('columns', 'sys_dictionary', ['column', 'col'], ['element', 'column_label', 'internal_type', 'mandatory', 'max_length', 'active'], wrap, { singular: 'column', scopeValidation: true });

// Read-only commands (Go only has list/show)
export const importCmd = (wrap) => buildDevCmd('import', 'sys_import_set', ['imports', 'imp'], ['sys_import_set', 'sys_import_row', 'sys_target_table', 'sys_target_sys_id'], wrap, { singular: 'import set', readOnly: true });
export const spPagesCmd = (wrap) => buildDevCmd('sppages', 'sp_page', ['sp-pages', 'pages'], ['id', 'title', 'sys_scope'], wrap, { singular: 'Service Portal page', readOnly: true });
export const spWidgetsCmd = (wrap) => buildDevCmd('spwidgets', 'sp_widget', ['sp-widget', 'widgets'], ['id', 'name', 'sys_scope'], wrap, { singular: 'Service Portal widget', readOnly: true });
export const uiPagesCmd = (wrap) => buildDevCmd('uipages', 'sys_ui_page', ['ui-page', 'pages'], ['name', 'sys_scope'], wrap, { singular: 'UI page', scopeValidation: true });
export const appMenuCmd = (wrap) => buildDevCmd('appmenu', 'sys_app_application', ['app-menu', 'menu'], ['name', 'active', 'sys_scope'], wrap, { singular: 'application menu', scopeValidation: true });
export const scRAPICmd = (wrap) => buildDevCmd('scrapi', 'sys_ws_operation', ['scripted-rest', 'rest-api'], ['name', 'sys_ws_definition', 'sys_scope'], wrap, { singular: 'scripted REST API', readOnly: true });

// Commands with full CRUD
export const aclsCmd = (wrap) => buildDevCmd('acls', 'sys_security_acl', ['acl'], ['name', 'operation', 'type', 'active', 'sys_scope'], wrap, { singular: 'ACL', scopeValidation: true });
export const rolesCmd = (wrap) => buildDevCmd('roles', 'sys_user_role', ['role', 'r'], ['name', 'description', 'elevated_privilege', 'sys_scope'], wrap, { singular: 'role', scopeValidation: true });
export const propertiesCmd = (wrap) => buildDevCmd('properties', 'sys_properties', ['property', 'prop'], ['name', 'value', 'description', 'sys_scope'], wrap, { singular: 'property', scopeValidation: true });

// New commands for scoped-app tables
export const relationshipsCmd = (wrap) => buildDevCmd('relationships', 'sys_relationship', ['relationship', 'rel'], ['name', 'sys_scope'], wrap, { singular: 'relationship', scopeValidation: true });
export const appmodulesCmd = (wrap) => buildDevCmd('appmodules', 'sys_app_module', ['appmodule', 'am'], ['name', 'active', 'sys_scope'], wrap, { singular: 'application module', scopeValidation: true });
export const listcontrolsCmd = (wrap) => buildDevCmd('listcontrols', 'sys_ui_list_control', ['listcontrol', 'lc'], ['name', 'active', 'sys_scope'], wrap, { singular: 'list control', scopeValidation: true });
export const viewsCmd = (wrap) => buildDevCmd('views', 'sys_ui_view', ['view', 'vw'], ['name', 'title', 'sys_scope'], wrap, { singular: 'view', scopeValidation: true });
export const privilegesCmd = (wrap) => buildDevCmd('privileges', 'sys_scope_privilege', ['privilege', 'priv'], ['name', 'status', 'sys_scope'], wrap, { singular: 'privilege', scopeValidation: true });
export const securitytypesCmd = (wrap) => buildDevCmd('securitytypes', 'sys_security_type', ['securitytype', 'st'], ['name', 'active', 'sys_scope'], wrap, { singular: 'security type', scopeValidation: true });
export const uxscriptsCmd = (wrap) => buildDevCmd('uxscripts', 'sys_ux_lib_source_script', ['uxscript', 'ux'], ['name', 'active', 'sys_scope'], wrap, { singular: 'UX script', scopeValidation: true });
export const aliasesCmd = (wrap) => buildDevCmd('aliases', 'sys_alias', ['alias', 'als'], ['name', 'table', 'sys_scope'], wrap, { singular: 'alias', scopeValidation: true });
export const catalogscriptsCmd = (wrap) => buildDevCmd('catalogscripts', 'catalog_script_client', ['catalogscript', 'cs'], ['name', 'table', 'active', 'sys_scope'], wrap, { singular: 'catalog script', scopeValidation: true });
export const cataloguipoliciesCmd = (wrap) => buildDevCmd('cataloguipolicies', 'catalog_ui_policy', ['cataloguipolicy', 'cup'], ['short_description', 'table', 'active', 'sys_scope'], wrap, { singular: 'catalog UI policy', scopeValidation: true });
