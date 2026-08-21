// Mutation guard — the public face is isMutationCommand(argv), used by the
// read-only-profile middleware in cli.js. The command-path data is DERIVED
// from the capability registry (src/capabilities.js) at call time — command
// modules declare their mutating subcommands once, at the definition site.
//
// The registry used to be a hand-maintained list here, and it rotted: it
// gated `catalog create-item` while the real command is `catalogitems
// create` (read-only bypass), and listed `restmethods`, a command that was
// never registered. Derived data can't drift that way.

import { mutationPaths } from './capabilities.js';

/**
 * Back-compat export: the derived mutation path list, refreshed by
 * refreshMutationCommands() — cli.js calls it at the end of buildCLI(),
 * so the data is generated at CLI build time, not hand-maintained.
 * Prefer isMutationCommand().
 */
export const MUTATION_COMMANDS = [];

export function refreshMutationCommands() {
  MUTATION_COMMANDS.length = 0;
  MUTATION_COMMANDS.push(...mutationPaths());
  return MUTATION_COMMANDS;
}

function currentPaths(paths) {
  return paths || refreshMutationCommands();
}

/**
 * Check if the parsed argv matches any mutation command pattern.
 * Prefix match: a command whose argv._ path begins with a mutation pattern
 * IS that mutation (trailing positionals like a sys_id or file path don't
 * change the intent). This lets positional mutation subcommands (e.g.
 * `records attachments <id> add <file>`) be gated on read-only profiles.
 *
 * @param {object} argv — yargs parsed argv with `_` array
 * @param {Array<string[]>} [paths] — mutation path patterns; defaults to
 *   the paths derived from the capability registry. (Tests pass explicit
 *   paths; production callers should let it derive.)
 * @returns {boolean}
 */
export function isMutationCommand(argv, paths) {
  const cmd = argv._ || [];
  for (const pattern of currentPaths(paths)) {
    if (pattern.length > cmd.length) continue;
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
