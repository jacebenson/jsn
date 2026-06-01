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
  'DATA & ADMIN': [
    { name: 'records', desc: 'Generic Table API for any table' },
    { name: 'users', alias: 'user', desc: 'Manage ServiceNow users' },
    { name: 'groups', alias: 'group', desc: 'Manage groups' },
    { name: 'groupmembers', alias: 'gm', desc: 'Manage group memberships' },
    { name: 'grouproles', alias: 'gr', desc: 'Manage group roles' },
  ],
  'DEVELOPMENT': [
    { name: 'dev', desc: 'Manage development artifacts (flows, includes, rules, ACLs, etc.)' },
  ],
  'CONFIGURATION': [
    { name: 'setup', desc: 'Interactive first-time setup' },
    { name: 'auth', desc: 'Manage OAuth authentication' },
    { name: 'profiles', alias: 'profile', desc: 'Manage instance profiles' },
  ],
};

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
  const utilitySection = renderGroup('UTILITY', UTILITY_COMMANDS);

  return [
    'Usage: jsn <command> [options]',
    '',
    `Command-line interface for ServiceNow`,
    '',
    ...sections,
    '',
    utilitySection,
    '',
    renderFlags(),
    renderTips(),
    '',
  ].join('\n');
}
