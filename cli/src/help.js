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

const COMMON_COMMANDS = [
  'incidents', 'requests', 'tasks', 'changes', 'approvals', 'knowledge', 'records', 'setup', 'discover',
];

const CONCISE_FLAGS = ['instance', 'profile', 'json'];

const CONCISE_EXAMPLES = [
  'jsn incidents list --query "active=true" --limit 5',
  'jsn records list --table incident --limit 5 --json',
  'jsn discover catalog',
];

const CONCISE_MORE = [
  { label: 'jsn <command> <action> --help', description: 'Options for one command or action' },
  { label: 'jsn discover <word>', description: 'Find commands by task words' },
  { label: 'jsn discover --table <table>', description: 'Find commands configured for a table' },
  { label: 'jsn --all-commands --help', description: 'Every registered command and global flag' },
  { label: 'jsn --json', description: 'Registered command surface as JSON' },
];

function renderGroup(name, commands, width = helpWidth()) {
  const lines = [`\n${name}`];
  lines.push('─'.repeat(50));
  let rows = [];
  const flush = () => {
    if (!rows.length) return;
    lines.push(renderRows(rows, { width, indent: 2 }));
    rows = [];
  };
  for (const cmd of commands) {
    if (cmd.divider) {
      flush();
      lines.push('');
      lines.push(`  ${cmd.divider}`);
      continue;
    }
    rows.push({
      label: cmd.name,
      description: cmd.desc,
      note: cmd.alias ? `(${cmd.alias})` : '',
    });
  }
  flush();
  return lines.join('\n');
}

const CORE_COMMANDS = [
  { name: 'knowledge', alias: 'kb', desc: 'Search and read knowledge articles' },
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

function renderFlags(options, { full = false, width = helpWidth() } = {}) {
  // Derived from the registered global options, so a new global flag cannot be
  // missing from the full reference (--get and --csv were, along with the csv
  // format choice). The concise page shows only the flags needed to point a
  // command at an instance and choose machine output.
  const rows = [];
  const specs = full
    ? options
    : CONCISE_FLAGS.map((name) => options.find((spec) => spec.name === name)).filter(Boolean);
  for (const spec of specs) {
    if (spec.name === 'help') continue;
    const alias = spec.alias.map(name => `${name.length === 1 ? '-' : '--'}${name}`).join(', ');
    const label = `${alias ? `${alias}, ` : ''}--${spec.name}`;
    const suffix = spec.name === 'format' && spec.choices.length
      ? `[string: ${spec.choices.join(', ')}]`
      : `[${spec.type}]`;
    rows.push({ label, description: spec.description, note: suffix });
  }
  rows.push({ label: '--help', description: 'Show help', note: '[boolean]' });
  return `\nFLAGS\n${renderRows(rows, { width, indent: 2 })}`;
}

/**
 * The ordinary root page: common task commands, a few flags, runnable
 * examples, and pointers to the exhaustive reference and local discovery.
 */
function renderConciseHelp(config, registry, width) {
  const commands = Array.isArray(registry?.commands) ? registry.commands : [];
  const byName = new Map(commands.map((command) => [command.name, command]));
  const common = COMMON_COMMANDS
    .map((name) => byName.get(name))
    .filter((command) => command && !isCapabilityHidden(command.name, config))
    .map((command) => ({
      name: command.name,
      desc: command.summary || command.description || '',
    }));

  return [
    'Usage: jsn <command> [options]',
    '',
    'Command-line interface for ServiceNow',
    renderGroup('COMMON COMMANDS', common, width),
    '',
    'EXAMPLES',
    ...CONCISE_EXAMPLES.map((example) => `  ${example}`),
    renderFlags(Array.isArray(registry?.options) ? registry.options : [], { width }),
    '',
    'MORE',
    renderRows(CONCISE_MORE, { width, indent: 2 }),
    '',
  ].join('\n');
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
  Use "jsn <command> <action> --help" for options on one command or action
  "jsn --json" prints the registered command surface as JSON for scripts and agents

LEARN MORE
  Some list commands offer a picker in an interactive terminal with automatic output.
  Arrow keys browse (10 visible items); type to search; scroll to load more; Enter selects; Esc cancels.
  Picker eligibility and search fields vary by command. Explicit output formats (including --json) skip pickers.
  Use "jsn <command> --help" for more information about a command.`;
}

/**
 * Render root help.
 *
 * The ordinary page is a concise task directory. `full: true` (used by
 * `--all-commands --help`) renders the exhaustive grouped reference: every
 * visible registered command and every registered global option, plus the
 * tips and picker details that would crowd the short page.
 *
 * @param {object} config — profile config (capability-conditioned hiding)
 * @param {{commands: Array, options: Array}} [registry] — from
 *   `cli.commandRegistry()`. Without it only the hint tables render, which is
 *   the fallback for callers that have no registry (unit tests).
 * @param {{full?: boolean, width?: number}} [opts]
 */
export function renderHelp(config, registry = null, { full = false, width = helpWidth() } = {}) {
  if (!full) return renderConciseHelp(config, registry, width);

  const commands = Array.isArray(registry?.commands) ? registry.commands : [];
  const byName = new Map(commands.map((command) => [command.name, command]));
  const used = new Set();

  const sections = Object.entries(COMMAND_GROUPS)
    .map(([name, hint]) => [name, rowsFor(hint, byName, used, config)])
    .filter(([, rows]) => rows.some((row) => !row.divider))
    .map(([name, rows]) => renderGroup(name, rows, width));

  // Anything registered that the hint tables don't place. This is the safety
  // net that keeps help complete as commands are added at the root.
  const unplaced = commands
    .filter((command) => !used.has(command.name) && !isCapabilityHidden(command.name, config))
    .map((command) => ({ name: command.name, alias: command.aliases[0] || '', desc: command.description || '' }));
  if (unplaced.length) sections.push(renderGroup('MORE', unplaced, width));

  return [
    'Usage: jsn <command> [options]',
    '',
    'Command-line interface for ServiceNow',
    '',
    ...sections,
    '',
    renderFlags(Array.isArray(registry?.options) ? registry.options : [], { full: true, width }),
    renderTips(),
    '',
  ].join('\n');
}

// Subcommand pages (`jsn flows --help`) used to print one unbroken line per
// entry. A description written for a command's own page — `flows update` is
// ~700 characters — became an 801-column line that the terminal cut off, so the
// list advertised a command nobody could read and options lost their aliases,
// types and defaults. These helpers wrap the text to the terminal instead.

const HELP_WIDTH_FALLBACK = 100;

/**
 * Columns available to help text. A piped run has no `columns`, and a very wide
 * terminal should not stretch prose to 200 columns, so cap it.
 */
export function helpWidth(stream = process.stdout) {
  const columns = Number(stream?.columns);
  if (!Number.isFinite(columns) || columns <= 0) return HELP_WIDTH_FALLBACK;
  return Math.min(columns, HELP_WIDTH_FALLBACK);
}

/**
 * Wrap `text` into lines no wider than `width`, indenting `firstIndent` spaces
 * on the first line and `indent` on the rest. A word longer than the available
 * width stays whole: a split alias or sys_id reads as a different token.
 */
export function wrapText(text, { width, firstIndent = 0, indent = firstIndent } = {}) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const limit = Number.isFinite(width) && width > 0 ? width : HELP_WIDTH_FALLBACK;
  const lines = [];
  let line = '';
  let prefix = ' '.repeat(firstIndent);
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && prefix.length + candidate.length > limit) {
      lines.push(prefix + line);
      line = word;
      prefix = ' '.repeat(indent);
    } else {
      line = candidate;
    }
  }
  lines.push(prefix + line);
  return lines;
}

/**
 * Render help rows as one padded label column plus a wrapped description.
 *
 * @param {Array<{label: string, description?: string, note?: string}>} rows
 *   `note` is appended verbatim (already bracketed) — aliases, option type and
 *   default — so the description itself stays plain prose.
 * @param {{width?: number, indent?: number}} [opts]
 */
export function renderRows(rows, { width = helpWidth(), indent = 2 } = {}) {
  if (!rows.length) return '';
  const labelWidth = Math.max(...rows.map(row => row.label.length));
  const descriptionIndent = indent + labelWidth + 2;
  const available = Math.max(20, width - descriptionIndent);
  const lines = [];
  for (const row of rows) {
    const head = `${' '.repeat(indent)}${row.label.padEnd(labelWidth)}`.padEnd(descriptionIndent);
    const wrapped = wrapText(row.description, { width: available });
    // The note (aliases, type, default) is one token: splitting `[aliases: runs,
    // contexts]` across lines leaves a bracket fragment that reads as prose.
    if (row.note) {
      const last = wrapped.at(-1);
      if (last !== undefined && last.length + 1 + row.note.length <= available) wrapped[wrapped.length - 1] = `${last} ${row.note}`;
      else wrapped.push(row.note);
    }
    if (!wrapped.length) {
      lines.push(head.trimEnd());
      continue;
    }
    lines.push(`${head}${wrapped[0]}`);
    for (const line of wrapped.slice(1)) lines.push(`${' '.repeat(descriptionIndent)}${line}`);
  }
  return lines.join('\n');
}

/**
 * Render one command page: usage, description, subcommands, options, epilogue.
 * Sections are separated by a blank line so the list is skimmable in a
 * terminal; nothing is emitted for an empty section. The epilogue is authored
 * text and prints verbatim: it is where command examples live, and breaking
 * `jsn records watch --table incident` at a flag boundary turns one
 * copy-pasteable command into two wrong ones.
 */
export function renderSubcommandHelp({ usage, description, commands = [], options = [], epilogue, width = helpWidth() }) {
  const blocks = [usage];
  if (description) blocks.push(description);
  if (commands.length) blocks.push(`Commands:\n${renderRows(commands, { width })}`);
  if (options.length) blocks.push(`Options:\n${renderRows(options, { width })}`);
  if (epilogue) blocks.push(epilogue);
  return `${blocks.join('\n\n')}\n`;
}

