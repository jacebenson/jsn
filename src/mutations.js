// Centralized mutation command registry
// Used by the read-only profile middleware to block mutation commands.
// Each entry is a command path array matching argv._ tokens.

// Dev commands that expose create/update/delete via buildDevCmd.
// Each generates the root form (`jsn <name> create`) and the legacy dev form
// (`jsn dev <name> create`), so read-only profiles block both spellings.
const DEV_CRUD_COMMANDS = [
  'actions', 'includes', 'rules', 'clientscripts', 'uiactions', 'uipolicies',
  'tables', 'uipages', 'appmenu', 'acls', 'roles', 'properties', 'relationships',
  'appmodules', 'listcontrols', 'views', 'privileges', 'uxscripts',
  'catalogscripts', 'scriptactions', 'scheduledjobs', 'asyncrules', 'triggers',
  'email', 'restmethods', 'restmessage', 'soapmessages', 'uimacros',
  'cataloguipolicies', 'aliases', 'columns', 'flows', 'scrapi',
];

function devCrudPaths(name) {
  return [
    [name, 'create'],
    [name, 'update'],
    [name, 'delete'],
    ['dev', name, 'create'],
    ['dev', name, 'update'],
    ['dev', name, 'delete'],
  ];
}

export const MUTATION_COMMANDS = [
  // Incidents
  ['incidents', 'create'],
  ['incidents', 'update'],
  ['incidents', 'delete'],
  // Changes
  ['changes', 'create'],
  ['changes', 'update'],
  ['changes', 'delete'],
  // Records
  ['records', 'create'],
  ['records', 'update'],
  ['records', 'delete'],
  // Requests
  ['requests', 'create'],
  ['requests', 'update'],
  ['requests', 'delete'],
  // Tasks
  ['tasks', 'create'],
  ['tasks', 'update'],
  ['tasks', 'delete'],
  // Tickets
  ['tickets', 'create'],
  ['tickets', 'update'],
  ['tickets', 'delete'],
  // Users
  ['users', 'create'],
  ['users', 'update'],
  ['users', 'delete'],
  // Groups
  ['groups', 'create'],
  ['groups', 'update'],
  ['groups', 'delete'],
  // Catalog
  ['catalog', 'create-item'],
  // Dev CRUD commands (root + `jsn dev` forms)
  ...DEV_CRUD_COMMANDS.flatMap(devCrudPaths),
  // Dev eval (no sub-action) — both spellings must be gated:
  // `jsn eval` (root) and legacy `jsn dev eval`
  ['eval'],
  ['dev', 'eval'],
  // Raw REST passthrough — can hit any endpoint with any method,
  // so the whole command is a mutation surface on read-only profiles
  ['rest'],
  ['dev', 'rest'],
  // Scopes: create + set (root + dev forms)
  ['scopes', 'create'],
  ['scopes', 'set'],
  ['dev', 'scopes', 'create'],
  ['dev', 'scopes', 'set'],
  // Update sets: create, set, complete, delete, parent (root + dev forms)
  ['updatesets', 'create'],
  ['updatesets', 'set'],
  ['updatesets', 'complete'],
  ['updatesets', 'delete'],
  ['updatesets', 'parent'],
  ['dev', 'updatesets', 'create'],
  ['dev', 'updatesets', 'set'],
  ['dev', 'updatesets', 'complete'],
  ['dev', 'updatesets', 'delete'],
  ['dev', 'updatesets', 'parent'],
];

/**
 * Check if the parsed argv matches any mutation command pattern.
 * @param {object} argv — yargs parsed argv with `_` array
 * @returns {boolean}
 */
export function isMutationCommand(argv) {
  const cmd = argv._ || [];
  for (const pattern of MUTATION_COMMANDS) {
    if (pattern.length !== cmd.length) continue;
    let match = true;
    for (let i = 0; i < pattern.length; i++) {
      if (pattern[i] !== cmd[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}
