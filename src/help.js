// Custom grouped help renderer
// Mirrors the Go version's custom Cobra help template

const COMMAND_GROUPS = {
  'CORE COMMANDS': [
    { name: 'incidents', alias: 'inc', desc: 'Manage incidents' },
    { name: 'changes', alias: 'chg', desc: 'Manage change requests' },
    { name: 'requests', alias: 'req', desc: 'Manage service catalog requests' },
    { name: 'tasks', alias: 'task', desc: 'Manage catalog tasks' },
    { name: 'tickets', alias: 'ticket', desc: 'Query generic tickets' },
  ],
  'AUTOMATION': [
    { name: 'flows', desc: 'Manage Flow Designer flows' },
    { name: 'actions', alias: 'action', desc: 'Manage flow actions (sys_hub_action_type_definition)' },
    { name: 'rules', alias: 'br', desc: 'Manage business rules' },
    { name: 'scrapi', desc: 'Manage Scripted REST APIs' },
    { name: 'updatesets', desc: 'Manage update sets (set, yolo, export, import)' },
    { name: 'eval', desc: 'Run server-side JavaScript' },
    { name: 'rest', desc: 'Make raw REST API calls' },
  ],
  'ACCESS': [
    { name: 'acls', alias: 'acl', desc: 'Manage access controls' },
    { name: 'roles', alias: 'role', desc: 'Manage roles' },
    { name: 'scopes', desc: 'Manage application scopes' },
    { name: 'properties', alias: 'prop', desc: 'Manage system properties' },
    { name: 'privileges', alias: 'priv', desc: 'Manage scope privileges' },
    { name: 'securitytypes', alias: 'st', desc: 'Manage security types' },
    { name: 'aliases', alias: 'als', desc: 'Manage table aliases' },
  ],
  'USER EXPERIENCE': [
    { name: 'forms', desc: 'Manage form layouts' },
    { name: 'lists', desc: 'Manage list layouts' },
    { name: 'clientscripts', alias: 'cs', desc: 'Manage client scripts' },
    { name: 'uipolicies', alias: 'up', desc: 'Manage UI policies' },
    { name: 'uiactions', alias: 'ua', desc: 'Manage UI actions' },
    { name: 'sppages', desc: 'Manage Service Portal pages' },
    { name: 'spwidgets', desc: 'Manage Service Portal widgets' },
    { name: 'uipages', desc: 'Manage UI pages' },
    { name: 'appmenu', desc: 'Manage application menus' },
    { name: 'listcontrols', alias: 'lc', desc: 'Manage list controls' },
    { name: 'views', alias: 'vw', desc: 'Manage views' },
    { name: 'uxscripts', alias: 'ux', desc: 'Manage UX source scripts' },
    { name: 'catalogscripts', desc: 'Manage catalog client scripts' },
    { name: 'cataloguipolicies', alias: 'cup', desc: 'Manage catalog UI policies' },
  ],
  'DATA': [
    { name: 'records', desc: 'Generic Table API for any table' },
    { name: 'tables', alias: 't', desc: 'Manage table definitions (sys_db_object)' },
    { name: 'columns', alias: 'col', desc: 'Manage column definitions (sys_dictionary)' },
    { name: 'includes', alias: 'si', desc: 'Manage script includes' },
    { name: 'import', desc: 'Manage import sets' },
    { name: 'logs', desc: 'View system logs' },
    { name: 'users', alias: 'user', desc: 'Manage ServiceNow users' },
    { name: 'groups', alias: 'group', desc: 'Manage groups' },
    { name: 'groupmembers', alias: 'gm', desc: 'Manage group memberships' },
    { name: 'grouproles', alias: 'gr', desc: 'Manage group roles' },
    { name: 'relationships', alias: 'rel', desc: 'Manage table relationships' },
    { name: 'appmodules', alias: 'am', desc: 'Manage application modules' },
  ],
};

const CONFIGURATION_COMMANDS = [
  { name: 'setup', desc: 'Interactive first-time setup' },
  { name: 'auth', desc: 'Manage OAuth authentication' },
  { name: 'profiles', alias: 'profile', desc: 'Manage instance profiles' },
  { name: 'dev', desc: '[DEPRECATED] All dev subcommands are now top-level — use jsn flows, jsn acls, etc.' },
];

const UTILITY_COMMANDS = [
  { name: 'skill', desc: 'Manage the jsn AI agent skill file (show, fetch, install)' },
  { name: 'version', desc: 'Show version information (--check for npm updates)' },
];

function renderGroup(name, commands) {
  const lines = [`\n${name}`];
  lines.push('─'.repeat(50));
  for (const cmd of commands) {
    const aliasPart = cmd.alias ? ` (${cmd.alias})` : '';
    const padded = `  jsn ${cmd.name}`.padEnd(22);
    lines.push(`${padded}${cmd.desc}${aliasPart}`);
  }
  return lines.join('\n');
}

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
  const configSection = renderGroup('CONFIGURATION', CONFIGURATION_COMMANDS);
  const utilitySection = renderGroup('UTILITY', UTILITY_COMMANDS);

  return [
    'Usage: jsn <command> [options]',
    '',
    `Command-line interface for ServiceNow`,
    '',
    ...sections,
    '',
    configSection,
    '',
    utilitySection,
    '',
    renderFlags(),
    renderTips(),
    '',
  ].join('\n');
}
