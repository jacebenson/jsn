// Centralized mutation command registry
// Used by the read-only profile middleware to block mutation commands.
// Each entry is a command path array matching argv._ tokens.

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
  // Dev flows
  ['dev', 'flows', 'create'],
  ['dev', 'flows', 'update'],
  ['dev', 'flows', 'delete'],
  // Dev scopes
  ['dev', 'scopes', 'create'],
  ['dev', 'scopes', 'set'],
  // Dev eval
  ['dev', 'eval'],
  // Dev updatesets
  ['dev', 'updatesets', 'set'],
  ['dev', 'updatesets', 'create'],
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
