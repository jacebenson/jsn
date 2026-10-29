import { buildProfileCommand } from '../record-profiles.js';
import { getStringField } from '../helpers.js';
// Simple table-based commands — singular names passed for grammar
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

export { actionsCmd } from './actions.js';

export const includesCmd = (wrap) => buildProfileCommand('includes', wrap);

export const rulesCmd = (wrap) => buildProfileCommand('rules', wrap);

export const clientScriptsCmd = (wrap) => buildProfileCommand('clientscripts', wrap);

export const uiActionsCmd = (wrap) => buildProfileCommand('uiactions', wrap);

// NOTE: uipolicies has exactly ONE definition — the rich one in
// ./uipolicies.js (re-exported below at the bottom of this file). A plain
// buildDevCmd('uipolicies', ...) factory used to live here, but yargs keeps
// the LAST registration of a duplicate command name, and cli.js registers
// this module's uiPoliciesCmd before uipoliciesCmd — so the factory version
// was dead code shadowing nothing. Deleted; the re-export is the behavior.

export const tablesCmd = (wrap) => buildProfileCommand('tables', wrap, {
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

export { columnsCmd } from './columns.js';

// Read-only commands (Go only has list/show)
export { importCmd } from './import.js';
export const spPagesCmd = (wrap) => buildProfileCommand('sppages', wrap);
export const spWidgetsCmd = (wrap) => buildProfileCommand('spwidgets', wrap);
export const uiPagesCmd = (wrap) => buildProfileCommand('uipages', wrap);
export const appMenuCmd = (wrap) => buildProfileCommand('appmenu', wrap);

// Commands with full CRUD
export const aclsCmd = (wrap) => buildProfileCommand('acls', wrap);
export const rolesCmd = (wrap) => buildProfileCommand('roles', wrap);
export const propertiesCmd = (wrap) => buildProfileCommand('properties', wrap);

// New commands for scoped-app tables
export const relationshipsCmd = (wrap) => buildProfileCommand('relationships', wrap);
export const appmodulesCmd = (wrap) => buildProfileCommand('appmodules', wrap);
export const listcontrolsCmd = (wrap) => buildProfileCommand('listcontrols', wrap);
export const viewsCmd = (wrap) => buildProfileCommand('views', wrap);
export const privilegesCmd = (wrap) => buildProfileCommand('privileges', wrap);
export const uxscriptsCmd = (wrap) => buildProfileCommand('uxscripts', wrap);
export { aliasesCmd } from './aliases.js';
export const catalogscriptsCmd = (wrap) => buildProfileCommand('catalogscripts', wrap);

// ── Automation: Async ──
export const scriptactionsCmd = (wrap) => buildProfileCommand('scriptactions', wrap);
export const scheduledjobsCmd = (wrap) => buildProfileCommand('scheduledjobs', wrap);
export const asyncrulesCmd = (wrap) => buildProfileCommand('asyncrules', wrap);
export const triggersCmd = (wrap) => buildProfileCommand('triggers', wrap);

// ── Automation: In Memory ──

export const assignmentsCmd = (wrap) => buildProfileCommand('assignments', wrap);

// ── Automation: Inbound ──
export const emailCmd = (wrap) => buildProfileCommand('email', wrap);

// ── Automation: Outbound ──
export { restmessageCmd } from './restmessage.js';
export { soapmessagesCmd } from './soapmessages.js';

// ── UX: Core UI ──
export const uimacrosCmd = (wrap) => buildProfileCommand('uimacros', wrap);

// ── UX: Workspaces ──
export const uxlistsCmd = (wrap) => buildProfileCommand('uxlists', wrap);
export const uxapplicabilityCmd = (wrap) => buildProfileCommand('uxapplicability', wrap);
export { uipoliciesCmd } from './uipolicies.js';
export const cataloguipoliciesCmd = (wrap) => buildProfileCommand('cataloguipolicies', wrap);
