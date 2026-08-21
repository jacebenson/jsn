// Command capability registry — the single source of truth for command
// metadata that middleware cares about.
//
// Each command module declares its capabilities ONCE at the definition site
// via declareCapabilities(name, caps):
//
//   {
//     // Subcommand verbs that mutate instance state. The mutation guard
//     // (src/mutations.js) derives its command-path list from these.
//     mutationSubcommands: ['create', 'update', 'delete'],
//     // Also registered under `jsn dev <name>` — derive both spellings.
//     devAlias: true,
//     // Command runs without a configured instance (joins the middleware
//     // skip-list for the instance guard).
//     noInstance: true,
//     // Skip the once-per-day npm-version / skill freshness checks and the
//     // interactive context header.
//     skipDailyChecks: true,
//   }
//
// cli.js derives every skip-list and the mutation guard's path list from
// this registry. Hand-maintained string lists of command names are a bug
// farm — see the catalogitems create read-only bypass that shipped because
// mutations.js listed `catalog create-item` while the real command is
// `catalogitems create`.
//
// Note: yargs strips custom properties off command modules when it
// registers them (only original/description/handler/builder survive in
// getCommandHandlers()), so declarations live in this module-level map,
// keyed by root command name. Declaration happens when the command module
// factory runs — i.e. during cli.js's registration chain — so the registry
// is complete once buildCLI() returns.

const REGISTRY = new Map();

/**
 * Declare a command's capabilities. Called by command factories and
 * hand-written command modules at definition time.
 *
 * @param {string} name — root command name (as typed: `jsn <name>`)
 * @param {object} caps — capability declaration (see module header)
 * @returns {object} the caps object (for convenient inline use)
 */
export function declareCapabilities(name, caps) {
  REGISTRY.set(name, { devAlias: false, ...caps });
  return caps;
}

/**
 * The collected capability registry: root command name → capabilities.
 * Includes the implicit declarations for yargs built-ins ('help') and the
 * shell plumbing ('completion') which have no factory to declare from.
 *
 * @returns {Map<string, object>}
 */
export function collectCapabilities() {
  const caps = new Map(REGISTRY);
  if (!caps.has('help')) caps.set('help', { noInstance: true, skipDailyChecks: true });
  if (!caps.has('version')) caps.set('version', { noInstance: true, skipDailyChecks: true });
  if (!caps.has('completion')) caps.set('completion', { noInstance: true, skipDailyChecks: true });
  return caps;
}

/**
 * Derive the set of root command names that run without an instance.
 * Preserves the legacy skip-list semantics exactly: help, version,
 * completion, setup, auth, skill, docs.
 *
 * @param {Map<string, object>} [caps] — from collectCapabilities()
 * @returns {Set<string>}
 */
export function noInstanceCommands(caps = collectCapabilities()) {
  const out = new Set();
  for (const [name, c] of caps) {
    if (c.noInstance) out.add(name);
  }
  return out;
}

/**
 * Derive the set of root command names that skip the daily npm-version /
 * skill checks and the interactive context header. Legacy semantics:
 * help, version, completion, skill, docs (a subset of noInstanceCommands).
 *
 * @param {Map<string, object>} [caps] — from collectCapabilities()
 * @returns {Set<string>}
 */
export function dailyCheckSkipCommands(caps = collectCapabilities()) {
  const out = new Set();
  for (const [name, c] of caps) {
    if (c.skipDailyChecks) out.add(name);
  }
  return out;
}

/**
 * Derive the mutation command-path list (argv._ token arrays) from the
 * capability registry. Each entry is a prefix pattern: an argv._ path that
 * begins with the pattern IS that mutation (trailing positionals like a
 * sys_id don't change intent).
 *
 * Commands with `devAlias: true` are also registered under `jsn dev <name>`,
 * so both spellings are emitted.
 *
 * A whole-command mutation surface (e.g. `jsn eval`, `jsn rest` — the
 * command itself is the mutation, there is no mutating sub-verb) declares
 * `mutationSubcommands: ['']`.
 *
 * @param {Map<string, object>} [caps] — from collectCapabilities()
 * @returns {Array<string[]>}
 */
export function mutationPaths(caps = collectCapabilities()) {
  const paths = [];
  for (const [name, c] of caps) {
    if (!c.mutationSubcommands) continue;
    for (const sub of c.mutationSubcommands) {
      const parts = sub === '' ? [] : sub.split(' ');
      paths.push([name, ...parts]);
      if (c.devAlias) paths.push(['dev', name, ...parts]);
    }
  }
  return paths;
}

/** Test hook: clear the registry between isolated buildCLI() runs. */
export function _resetCapabilities() {
  REGISTRY.clear();
}
