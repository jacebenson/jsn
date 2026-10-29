// Custom grouped help renderer
// Organized by ServiceNow domain model with subgroup dividers
//
// The command rows are generated from the LIVE command registry
// (`cli.commandRegistry()`): every registered root command appears, with the
// description its own registration declares. The tables below are placement
// hints only — group order, dividers, and a fallback description for a command
// that declares none. A command that is registered but not hinted lands in the
// trailing "MORE" group, so help can never silently drop a command again
// (`approvals`, `cmdb`, `docs`, `perf`, `platform`, … were missing from the
// hand-written list while being fully registered).

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
  { name: 'tickets', desc: 'Query generic tickets' },
  { name: 'approvals', desc: 'Approval requests (list, approve, reject, submit, history)' },
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
  { name: 'cmdb', desc: 'CMDB: CI lookup and relationship traversal (read-only)' },

  { divider: '── Shared Code, Transforms, Logs ──' },
  { name: 'includes', alias: 'si', desc: 'Script includes' },
  { name: 'import', desc: 'Import sets' },
  { name: 'logs', desc: 'System logs' },
  { name: 'properties', alias: 'prop', desc: 'System properties' },

  { name: 'records', desc: 'Generic Table API (any table)' },
  { name: 'transactions', desc: 'Client transaction timings' },
  { name: 'snippets', desc: 'Saved query snippets' },
];

const CONFIG_COMMANDS = [
  { name: 'setup', desc: 'Set up and manage instances (interactive: add, switch, remove, modify)' },
  { name: 'auth', desc: 'Authentication (login, refresh, status)' },
  { name: 'updatesets', desc: 'Update sets (set, create, export)' },
  { name: 'scopes', desc: 'Application scopes' },
  { name: 'domains', desc: 'Domains (domain separation)' },
  { name: 'midservers', desc: 'MID Servers and MID-run commands' },
  { name: 'platform', desc: 'Platform health and node statistics (read-only)' },
  { name: 'completion', desc: 'Shell completion script' },
];

const DEVELOPER_COMMANDS = [
  { name: 'scan', desc: 'Instance Scan checks, suites, explicit targets, progress and findings' },
  { name: 'atf', desc: 'Automated Test Framework (list, suites, run, results)' },
  { name: 'eval', desc: 'Run server-side JavaScript' },
  { name: 'rest', desc: 'Raw REST API calls' },
  { name: 'graphql', desc: 'GraphQL queries' },
  { name: 'codesearch', desc: 'Search code across ServiceNow artifacts' },
  { name: 'docs', desc: 'Local ServiceNow documentation search' },
  { name: 'diff', desc: 'Compare records across configured profiles' },
  { name: 'perf', desc: 'Read-only performance capture and comparison' },
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

/**
 * Domain separation is an optional plugin — only advertise `domains` when the
 * active profile's capability probe found it installed.
 */
function isCapabilityHidden(name, config) {
  if (name !== 'domains') return false;
  const activeName = config?.activeProfile || config?.defaultProfile;
  return !(activeName && config?.profiles?.[activeName]?.domain_separation);
}

/**
 * Group rows for one domain: registry first (alias/description from the
 * command's own registration), hint text only as a fallback description.
 */
function rowsFor(hint, byName, used, config) {
  const rows = [];
  for (const entry of hint) {
    if (entry.divider) { rows.push(entry); continue; }
    const node = byName.get(entry.name);
    if (!node || isCapabilityHidden(node.name, config)) continue;
    used.add(node.name);
    rows.push({
      name: node.name,
      alias: node.aliases[0] || entry.alias || '',
      desc: node.description || entry.desc || '',
    });
  }
  return rows;
}

function renderFlags(options) {
  // Derived from the registered global options, so a new global flag cannot be
  // missing from help (--get and --csv were, along with the csv format choice).
  const lines = [];
  for (const spec of options) {
    if (spec.name === 'help') continue;
    const alias = spec.alias.length ? `-${spec.alias.join(', -')}, ` : '';
    const suffix = spec.name === 'format' && spec.choices.length
      ? ` [string: ${spec.choices.join(', ')}]`
      : ` [${spec.type}]`;
    lines.push(`  ${`${alias}--${spec.name}`.padEnd(24)}${spec.description}${suffix}`);
  }
  lines.push(`  ${'--help'.padEnd(24)}Show help${' [boolean]'}`);
  return `\nFLAGS\n${lines.join('\n')}`;
}

export function renderTips() {
  return `
TIPS
  Show every command, including admin and developer tools: "jsn --all-commands --help"
  Command visibility follows the selected profile at authentication; explicit commands still use ServiceNow ACLs.
  Find commands by task words: "jsn discover catalog"; by configured table: "jsn discover --table incident"
  Cross-table task searches and custom tables: "jsn records list --help"
  Specialized commands offer configured columns, lookup, and table-specific views; inspect discovery results for details
  Raw endpoints when needed: "jsn rest --help"; examples and intent guidance: "jsn discover --help"
  Use "jsn <command> --help" for details, or "jsn <command> list --help" for list options
  "jsn --json" prints the registered command surface as JSON for scripts and agents

LEARN MORE
  Some list commands offer a picker in an interactive terminal with automatic output.
  Arrow keys browse (10 visible items); type to search; scroll to load more; Enter selects; Esc cancels.
  Picker eligibility and search fields vary by command. Explicit output formats (including --json) skip pickers.
  Use "jsn <command> --help" for more information about a command.`;
}

/**
 * Render the grouped root help.
 *
 * @param {object} config — profile config (capability-conditioned hiding)
 * @param {{commands: Array, options: Array}} [registry] — from
 *   `cli.commandRegistry()`. Without it only the hint tables render, which is
 *   the fallback for callers that have no registry (unit tests).
 */
export function renderHelp(config, registry = null) {
  const commands = Array.isArray(registry?.commands) ? registry.commands : [];
  const byName = new Map(commands.map((command) => [command.name, command]));
  const used = new Set();

  const sections = Object.entries(COMMAND_GROUPS)
    .map(([name, hint]) => [name, rowsFor(hint, byName, used, config)])
    .filter(([, rows]) => rows.some((row) => !row.divider))
    .map(([name, rows]) => renderGroup(name, rows));

  // Anything registered that the hint tables don't place. This is the safety
  // net that keeps help complete as commands are added at the root.
  const unplaced = commands
    .filter((command) => !used.has(command.name) && !isCapabilityHidden(command.name, config))
    .map((command) => ({ name: command.name, alias: command.aliases[0] || '', desc: command.description || '' }));
  if (unplaced.length) sections.push(renderGroup('MORE', unplaced));

  return [
    'Usage: jsn <command> [options]',
    '',
    'Command-line interface for ServiceNow',
    '',
    ...sections,
    '',
    renderFlags(Array.isArray(registry?.options) ? registry.options : []),
    renderTips(),
    '',
  ].join('\n');
}
