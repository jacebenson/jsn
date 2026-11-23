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
//     // Omitted means conservative customization; operational skips capture
//     // requirements, table follows sys_db_object ancestry to sys_metadata.
//     mutationContext: 'table', table: 'sys_script',
//     // Only declared flags are transaction overrides, not creation fields.
//     transactionScopeOption: 'scope',
//     // Command runs without a configured instance (joins the middleware
//     // skip-list for the instance guard).
//     noInstance: true,
//     // Skip the once-per-day npm-version / skill freshness checks and the
//     // interactive context header.
//     skipDailyChecks: true,
//     // Suppress the current instance header for profile management commands.
//     skipContextHeader: true,
//     // Remediation commands bypass mutation capture-context approval only.
//     mutationContextExemptSubcommands: ['create', 'set'],
//     // REST methods that are reads (read-only profile policy is separate).
//     mutationContextReadMethods: ['GET', 'HEAD', 'OPTIONS'],
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
// keyed by root command name. Eager factories declare during registration;
// lazy families declare in command-families.js, never in a deferred factory.
// The registry is complete once buildCLI() returns, before path resolution.

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
  REGISTRY.set(name, { ...caps });
  return caps;
}

/**
 * The collected capability registry: root command name → capabilities.
 * Includes the implicit declarations for yargs built-ins ('help') and the
 * local commands which have no factory to declare from.
 *
 * @returns {Map<string, object>}
 */
export function collectCapabilities() {
  const caps = new Map(REGISTRY);
  if (!caps.has('help')) caps.set('help', { noInstance: true, skipDailyChecks: true });
  if (!caps.has('version')) caps.set('version', { noInstance: true, skipDailyChecks: true });
  return caps;
}

/**
 * Derive the set of root command names that run without an instance.
 * Preserves the legacy skip-list semantics exactly: help, version,
 * setup, auth, skill, docs.
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
 * help, version, skill, docs (a subset of noInstanceCommands).
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

export function skipsContextHeader(argv, caps = collectCapabilities()) {
  return contextHeaderSkipCommands(caps).has(argv._?.[0])
    || caps.get(argv._?.[0])?.skipContextHeaderSubcommands?.includes(argv._?.[1]) === true;
}

export function contextHeaderSkipCommands(caps = collectCapabilities()) {
  const out = dailyCheckSkipCommands(caps);
  for (const [name, capability] of caps) {
    if (capability.skipContextHeader) out.add(name);
  }
  return out;
}

/**
 * Derive the mutation command-path list (argv._ token arrays) from the
 * capability registry. Each entry is a prefix pattern: an argv._ path that
 * begins with the pattern IS that mutation (trailing positionals like a
 * sys_id don't change intent).
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
    }
  }
  return paths;
}

/** Test hook: clear the registry between isolated buildCLI() runs. */
export function _resetCapabilities() {
  REGISTRY.clear();
}

// Verb -> operation class. Only verbs that the capability registry already
// declares as mutations can be classified; reads stay null. This is derived
// from the registry, not a second command-name allowlist.
const OPERATION_VERBS = new Map([
  ['create', 'create'], ['add', 'create'], ['upload', 'create'], ['clone', 'create'],
  ['copy', 'create'], ['install', 'create'], ['import', 'create'],
  ['update', 'update'], ['edit', 'update'], ['set', 'update'], ['publish', 'update'],
  ['complete', 'update'], ['commit', 'update'], ['preview', 'update'],
  ['parent', 'update'], ['ignore', 'update'], ['reopen', 'update'], ['process', 'update'],
  ['approve', 'update'], ['reject', 'update'], ['submit', 'update'], ['start', 'update'],
  ['stop', 'update'], ['validate', 'update'], ['execute', 'update'], ['activate', 'update'],
  ['deactivate', 'update'], ['add-check', 'update'], ['remove-check', 'update'],
  ['run', 'update'], ['run-suite', 'update'], ['test', 'update'], ['unlock', 'update'],
  ['delete', 'delete'], ['remove', 'delete'], ['delete-many', 'delete'],
]);

/**
 * Classify the operation a command performs for the preference guard.
 *
 * Derived from the mutation declarations in this registry:
 *   - a declared mutating subcommand maps its verb to create/update/delete;
 *   - a whole-command mutation (mutationSubcommands: ['']) uses its known
 *     method (`rest --method DELETE`) or is treated as update (`eval`);
 *   - read commands and unclassifiable mixed surfaces (`records bulk`) are null.
 *
 * This is a workflow opinion, not a security boundary: it only knows the
 * operations JSN itself performs.
 *
 * @param {object} argv — parsed argv with `_`
 * @param {Map<string, object>} [caps]
 * @returns {'create'|'update'|'delete'|null}
 */
export function operationOf(argv, caps = collectCapabilities()) {
  const path = argv?._ || [];
  const name = path[0];
  const capability = caps.get(name);
  if (!capability?.mutationSubcommands) return null;
  const sub = path[1];

  if (capability.mutationSubcommands.includes('')) {
    const method = String(argv.method || 'GET').toUpperCase();
    if (name === 'rest') {
      if (method === 'DELETE') return 'delete';
      if (['POST', 'PUT', 'PATCH'].includes(method)) return 'update';
      return null;
    }
    // eval and other arbitrary-code surfaces are classified as update: they
    // can change instance state, but they are not table create/delete verbs.
    return 'update';
  }

  if (typeof sub !== 'string' || !capability.mutationSubcommands.includes(sub)) return null;
  if (name === 'updatesets') {
    if (sub === 'create' || sub === 'import') return 'create';
    if (['set', 'complete', 'ignore', 'parent', 'preview', 'commit', 'reopen'].includes(sub)) return 'update';
    return null;
  }
  return OPERATION_VERBS.get(sub) || null;
}

/** Declared local-only previews bypass instance access, including context headers. */
export function isLocalPreview(argv, caps = collectCapabilities()) {
  return argv.dryRun === true && caps.get(argv._?.[0])?.localPreviewSubcommands?.includes(argv._?.[1]) === true;
}
