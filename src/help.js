// Custom grouped help renderer
// Organized by ServiceNow domain model with subgroup dividers

function renderGroup(name, commands) {
  const lines = [`\n${name}`];
  lines.push('─'.repeat(50));
  for (const cmd of commands) {
    if (cmd.divider) {
      lines.push('');
      lines.push(`  ${cmd.divider}`);
      continue;
    }
    const aliasPart = cmd.alias ? ` (${cmd.alias})` : '';
    const padded = `  jsn ${cmd.name}`.padEnd(22);
    const status = cmd.status ? ` ${cmd.status}` : '';
    lines.push(`${padded}${cmd.desc}${aliasPart}${status}`);
  }
  return lines.join('\n');
}

const CORE_COMMANDS = [
  { name: 'incidents', alias: 'inc', desc: 'Manage incidents' },
  { name: 'changes', alias: 'chg', desc: 'Manage change requests' },
  { name: 'requests', alias: 'req', desc: 'Manage service catalog requests' },
  { name: 'tasks', alias: 'task', desc: 'Manage catalog tasks' },
];

const AUTOMATION_COMMANDS = [
  { divider: '── Async ──' },
  { name: 'flows', alias: 'flow', desc: 'Flow Designer flows' },
  { name: 'actions', alias: 'action', desc: 'Flow action definitions' },
  { name: 'scriptactions', desc: 'Script actions' },
  { name: 'scheduledjobs', desc: 'Scheduled jobs' },
  { name: 'triggers', desc: 'Event triggers' },
  { name: 'asyncrules', desc: 'Asynchronous business rules' },

  { divider: '── In Memory ──' },
  { name: 'rules', alias: 'br', desc: 'Business rules (create, update, delete)' },
  { name: 'decisiontables', desc: 'Decision tables' },
  { name: 'assignments', desc: 'Assignment rules' },

  { divider: '── Inbound ──' },
  { name: 'scrapi', desc: 'Scripted REST APIs' },
  { name: 'email', desc: 'Inbound email actions' },

  { divider: '── Outbound ──' },
  { name: 'restmessage', alias: 'rm', desc: 'REST Messages (sys_rest_message)' },
  { name: 'soapmessages', desc: 'SOAP Messages' },
];

const ACCESS_COMMANDS = [
  { name: 'acls', alias: 'acl', desc: 'Access controls' },
  { name: 'b4rules', alias: 'b4r', desc: 'Before-query business rules (see also Automation)' },
  { name: 'roles', alias: 'role', desc: 'Roles' },
  { name: 'privileges', alias: 'priv', desc: 'Scope privileges' },
  { name: 'securitytypes', alias: 'st', desc: 'Custom security types' },
  { name: 'aliases', alias: 'als', desc: 'Connection & credential aliases' },
  { name: 'groups', alias: 'group', desc: 'Manage groups' },
  { name: 'groupmembers', alias: 'gm', desc: 'Group memberships' },
  { name: 'grouproles', alias: 'gr', desc: 'Group roles' },
  { name: 'users', alias: 'user', desc: 'Manage users' },
];

const UX_COMMANDS = [
  { divider: '── Shared (across all experiences) ──' },
  { name: 'forms', desc: 'Form layouts' },
  { name: 'lists', desc: 'List layouts' },
  { name: 'clientscripts', alias: 'cs', desc: 'Client scripts' },
  { name: 'uipolicies', alias: 'up', desc: 'UI policies' },
  { name: 'uiactions', alias: 'ua', desc: 'UI actions (buttons, links, context menus)' },
  { name: 'views', alias: 'vw', desc: 'Views' },
  { name: 'catalogitems', alias: 'ci', desc: 'Service Catalog items + variables' },
  { name: 'catalogscripts', desc: 'Catalog client scripts' },
  { name: 'cataloguipolicies', alias: 'cup', desc: 'Catalog UI policies' },

  { divider: '── Core UI ──' },
  { name: 'uipages', desc: 'UI pages' },
  { name: 'uimacros', desc: 'UI macros' },
  { name: 'listcontrols', alias: 'lc', desc: 'List controls' },

  { divider: '── Service Portal ──' },
  { name: 'sppages', desc: 'Service Portal pages' },
  { name: 'spwidgets', desc: 'Service Portal widgets' },

  { divider: '── Next Experience (Workspaces) ──' },
  { name: 'uxscripts', alias: 'ux', desc: 'UX source scripts' },
  { name: 'uxlists', desc: 'Workspace lists (sys_ux_list)' },
  { name: 'uxapplicability', desc: 'Workspace applicability (m2m)' },

  { divider: '── Navigation ──' },
  { name: 'appmenu', desc: 'Application menus' },
  { name: 'appmodules', alias: 'am', desc: 'Application modules' },
];

const DATA_COMMANDS = [
  { divider: '── DB Schema ──' },
  { name: 'tables', alias: 't', desc: 'Table definitions' },
  { name: 'columns', alias: 'col', desc: 'Column definitions' },
  { name: 'relationships', alias: 'rel', desc: 'Table relationships' },

  { divider: '── Shared Code, Transforms, Logs ──' },
  { name: 'includes', alias: 'si', desc: 'Script includes' },
  { name: 'import', desc: 'Import sets' },
  { name: 'logs', desc: 'System logs' },
  { name: 'properties', alias: 'prop', desc: 'System properties' },

  { name: 'records', desc: 'Generic Table API (any table)' },
];

const CONFIG_COMMANDS = [
  { name: 'setup', desc: 'Interactive first-time setup' },
  { name: 'auth', desc: 'OAuth authentication' },
  { name: 'profiles', alias: 'profile', desc: 'Instance profiles' },
  { name: 'updatesets', desc: 'Update sets (set, yolo, export, import)' },
  { name: 'scopes', desc: 'Application scopes' },
];

const DEVELOPER_COMMANDS = [
  { name: 'eval', desc: 'Run server-side JavaScript' },
  { name: 'rest', desc: 'Raw REST API calls' },
  { name: 'skill', desc: 'AI agent skill file (show, fetch, install)' },
  { name: 'version', desc: 'Version info (--check for npm updates)' },
];

const COMMAND_GROUPS = {
  'CORE': CORE_COMMANDS,
  'AUTOMATION': AUTOMATION_COMMANDS,
  'ACCESS': ACCESS_COMMANDS,
  'USER EXPERIENCE': UX_COMMANDS,
  'DATA': DATA_COMMANDS,
  'CONFIGURATION': CONFIG_COMMANDS,
  'DEVELOPER': DEVELOPER_COMMANDS,
};

function renderFlags() {
  return `
FLAGS
  --instance    ServiceNow instance URL (e.g., https://dev12345.service-now.com)  [string]
  -p, --profile Configuration profile to use                                      [string]
  --format      Output format: auto, json, markdown, styled, quiet                [string]
  --json        Output in JSON format                                            [boolean]
  -q, --quiet   Output only data, no envelope                                    [boolean]
  --styled      Force styled output                                              [boolean]
  --markdown    Output in Markdown format                                        [boolean]
  --help        Show help                                                        [boolean]`;
}

function renderTips() {
  return `
TIPS
  --query is available on every list command (e.g. "incidents list --query priority=1")
  Use "jsn <command> --help" for details, or "jsn <command> list --help" for list options

LEARN MORE
  Use "jsn <command> --help" for more information about a command.`;
}

export function renderHelp() {
  const sections = Object.entries(COMMAND_GROUPS).map(([name, cmds]) => renderGroup(name, cmds));

  return [
    'Usage: jsn <command> [options]',
    '',
    `Command-line interface for ServiceNow`,
    '',
    ...sections,
    '',
    renderFlags(),
    renderTips(),
    '',
  ].join('\n');
}
