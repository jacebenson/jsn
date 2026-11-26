import { accessAnalyzerCmd, deferredFamily, flowsCmd, workflowsCmd, midserversCmd, subscriptionsCmd, customizationsCmd, skippedUpdatesCmd, docsCmd, perfCmd } from './command-families.js';
import { visibleCommandRegistry } from './command-audience.js';
// Root CLI using the local yargs-compatible adapter

import yargs, { hideBin } from './cli-adapter.js';
import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig, globalConfigDir } from './config.js';
import { App } from './app.js';
import { resolveSession, applySession } from './session.js';
import { renderHelp, renderTips } from './help.js';
import { isMutationCommand, refreshMutationCommands } from './mutations.js';
import { impersonationRefusal, confirmImpersonatedWrite, runImpersonated } from './impersonation.js';
import { maybeShowHome } from './welcome.js';
import { isLocalPreview, noInstanceCommands, dailyCheckSkipCommands, collectCapabilities } from './capabilities.js';
import { guardExit, exitWithError, AppError, CodeUsage, errUsageHint } from './errors.js';
import { writesCustomization } from './mutation-context.js';
import { formatCommandList } from './helpers.js';

// Command modules. Families register through command-families.js and load
// their implementation on path resolution; only the modules cli.js itself uses
// at build time (discover, version, skill) are imported eagerly.
import { discoverCmd } from './commands/discover.js';

import { versionCmd } from './commands/version.js';

import { skillCmd, checkSkill } from './commands/skill.js';
import { getVersion, checkLatest, getReleaseChannel, getInstallCommand } from './commands/version.js';

// Table and platform commands registered at root level for progressive disclosure

/**
 * The output format the caller asked for, resolved from PARSED argv.
 *
 * One policy, two callers: the format middleware applies it once a command
 * parses, and the parse-time failure handler applies it when parsing fails.
 * They used to disagree — the failure path re-scanned the raw tokens (any
 * `--json` anywhere, first `--format` match, no option termination, no values
 * consumed by string options, no `--no-` negation), so the stream and the shape
 * of a failure depended on which layer rejected the command instead of on the
 * command line the caller typed.
 *
 * Precedence is the middleware's, unchanged: the shortcut flags beat `--format`,
 * and among the shortcuts the one applied last wins
 * (tsv > csv > markdown > styled > quiet > json).
 */
export function resolveRequestedFormat(argv) {
  if (!argv) return '';
  if (argv.tsv) return 'tsv';
  if (argv.csv) return 'csv';
  if (argv.markdown) return 'markdown';
  if (argv.styled) return 'styled';
  if (argv.quiet) return 'quiet';
  if (argv.json) return 'json';
  return typeof argv.format === 'string' ? argv.format : '';
}

/**
 * Parent commands owned by another change. The adapter's discovery fallback
 * (which gives a handler-less parent its child list instead of a silent exit 0)
 * is skipped for these families so their own fix owns the behavior.
 */
const DISCOVERY_OWNED_ELSEWHERE = new Set(['auth', 'perf', 'skill', 'groupmembers', 'grouproles']);

import { validateReadQuery, assertWriteQuery } from './query-validate.js';

function wrap(handler) {
  return async (argv) => {
    try {
      const app = argv.app;
      if (!app) {
        process.stderr.write('Error: App context not initialized.\n');
        process.exit(1);
      }
      if (argv.impersonate !== undefined) await confirmImpersonatedWrite(app, argv);
      const caps = collectCapabilities().get(argv._?.[0]) || {};
      app.queryValidation = null;
      if (((typeof argv.query === 'string' && argv.query.trim()) || caps.filteredMutationSubcommands?.includes(argv._?.[1]))
        && !caps.noInstance && caps.encodedQuery !== false) {
        const target = typeof caps.queryTable === 'function' ? caps.queryTable(argv) : caps.queryTable || caps.table || argv.table;
        const options = { table: target, query: argv.query, refresh: argv['refresh-metadata'] };
        app.queryValidation = await (isMutationCommand(argv) ? assertWriteQuery : validateReadQuery)(app, options);
      }
      if (argv.impersonate === undefined) {
        await app.guardMutationContext(argv);
        await handler(argv, app);
      } else {
        // A record write to a sys_metadata table is customization; ancestry is read as the real user, since the target may not read sys_db_object.
        if (await writesCustomization(app.sdk, argv)) throw errUsageHint(`"jsn ${argv._.join(' ')}" cannot run with --impersonate: it writes customization, which would be captured in that user's update set.`, 'Make customization changes as yourself; --impersonate writes ordinary records.');
        await runImpersonated(app, argv.impersonate.trim(), () => handler(argv, app));
      }
    } catch (err) {
      // All error rendering goes through the unified renderer in
      // src/errors.js — exit codes, stream choice, and the JSON envelope
      // for confirmation_required live there, not here.
      const identifier = argv._.slice(1).join(' ') || argv.id || argv.name || argv.sysID || '';
      exitWithError(err, { app: argv.app, argv, identifier });
    }
  };
}

export function buildCLI() {
  const cfg = loadConfig();
  const app = new App(cfg);

  const cliInstance = yargs(hideBin(process.argv))
    .scriptName('jsn')
    .usage('Usage: jsn <command> [options]')
    .middleware([
      // Attach App instance to every command
      (argv) => {
        argv.app = app;
      },
    ])
    .options({
      'refresh-metadata': { type: 'boolean', describe: 'Refresh query metadata instead of reusing the five-minute cache' },
      'all-commands': { type: 'boolean', describe: 'Show the full command list, including admin and developer tools' },

      'expect-scope': { type: 'string', description: 'Intended customization scope, exact scope/name or sys_id' },
      'expect-update-set': { type: 'string', description: 'Intended in-progress capture set, exact name or sys_id' },
      'expect-domain': { type: 'string', description: 'Intended domain; refuses writes when effective domain cannot be proven' },
      force: {
        type: 'boolean',
        description: 'Approve Global + Default mutation context only after user approval; delete commands also use this for their separate confirmation',
      },
      instance: {
        type: 'string',
        description: 'ServiceNow instance URL',
        alias: 'i',
      },
      profile: {
        type: 'string',
        description: 'Configuration profile to use',
        alias: 'p',
      },
      format: {
        type: 'string',
        description: 'Output format: auto, json, markdown, styled, quiet, csv, tsv',
        choices: ['auto', 'json', 'markdown', 'styled', 'quiet', 'csv', 'tsv'],
      },
      json: {
        type: 'boolean',
        description: 'Output in JSON format (shortcut for --format=json)',
      },
      csv: {
        type: 'boolean',
        description: 'CSV output for compact, flat record lists',
      },
      tsv: {
        type: 'boolean',
        description: 'TSV output for compact, tab-separated record lists',
      },
      get: {
        alias: 'select',
        type: 'string',
        description: 'Extract a JSON path from the output envelope (e.g. --get "data.records.0.number"); no jq needed',
      },
      quiet: {
        type: 'boolean',
        description: 'Output only data, no envelope (shortcut for --format=quiet)',
        alias: 'S',
      },
      verbose: { type: 'boolean', description: 'Keep machine-output coaching and pretty-print JSON' },
      raw: { type: 'boolean', description: 'Print extracted strings without JSON quotes' },
      'include-reference-links': { type: 'boolean', description: 'Include Table API reference links on reads' },
      impersonate: { type: 'string', description: 'Run this command as another user (user_name or sys_id) on a private session' },
      'impersonate-writes': { type: 'boolean', description: 'Allow a write under --impersonate once your user has approved it' },
      styled: {
        type: 'boolean',
        description: 'Force styled output even when piped',
      },
      markdown: {
        type: 'boolean',
        description: 'Output in Markdown table format',
      },
    })
    .middleware([
      // Apply format option overrides. The resolution lives in
      // resolveRequestedFormat so the parse-time failure path applies the
      // identical policy instead of approximating it from raw tokens.
      (argv) => {
        app.output.verbose = argv.verbose === true;
        app.output.raw = argv.raw === true;
        const requested = resolveRequestedFormat(argv);
        if (requested) {
          argv.format = requested;
          app.output.setFormat(requested);
        }
        if (argv.get) {
          app.output.setJqFilter(argv.get);
          if (!requested || requested === 'auto') {
            app.output.setFormat('json');
            argv.format = 'json';
          }
        }
      },
      // --profile / --instance resolve through the SESSION (src/session.js).
      // resolveSession is pure; applySession is the ONLY place cfg.activeProfile
      // / app._overrideInstance change — no more argv._overrideInstance mirror
      // or duplicated --instance branches across middlewares.
      (argv) => {
        try {
          const session = resolveSession(argv, cfg);
          if (session.unknownProfile) {
            guardExit(argv, {
              code: 'unknown_profile',
              message: `Unknown profile "${session.unknownProfile}"`,
              hint: 'Run "jsn auth status" to list profiles.',
            });
          }
          app._authArgv = argv;
          applySession(app, session);
          if (app.sdk) app.sdk.includeReferenceLinks = argv.includeReferenceLinks === true;
        } catch (err) {
          guardExit(argv, { code: err.code || 'usage', message: err.message, hint: err.hint });
        }
      },
      // Guard mutation commands: require an instance, block read-only profiles
      (argv) => {
        const cmd = (argv._[0] || '').toString();
        // Skip-list is derived from command capability declarations
        // (noInstance: true), not a hand-maintained name list.
        if (!cmd || noInstanceCommands().has(cmd)) {
          return;
        }
        if (isMutationCommand(argv)) {
          try {
            app.requireInstance();
          } catch (err) {
            // requireInstance throws errUsage; format it cleanly (the yargs
            // fail handler re-throws middleware errors, which would print a
            // raw stack trace).
            guardExit(argv, { code: err.code || 'usage', message: err.message, hint: err.hint });
          }
          if (app.session?.readOnly === true) {
            guardExit(argv, {
              code: 'read_only',
              message: `Profile "${app.session.profileName}" is read-only. Mutations are blocked.`,
              hint: 'Switch to a write-enabled profile first:\n  jsn auth switch <name>',
            });
          }
        }
      },
      (argv) => {
        const refusal = argv.impersonate === undefined ? null : impersonationRefusal(argv);
        if (refusal) guardExit(argv, { code: 'usage', message: `"jsn ${argv._.join(' ')}" cannot run with --impersonate: ${refusal}.`, hint: 'Impersonation runs one instance command as another user, for example: jsn records list --table incident --impersonate abel.tuter' });
      },
    ])
    .middleware(async (argv) => {
      // Session (incl. --instance/--profile overrides) was already applied
      // by the middleware above — nothing to re-apply here.
      if (isLocalPreview(argv)) return;
      const cmd = (argv._[0] || '').toString();
      // Daily-check + context-header skip-list is derived from command
      // capability declarations (skipDailyChecks: true).
      const dailySkips = dailyCheckSkipCommands();

      // Daily npm version check (fire-and-forget, non-blocking)
      // Checks npm for newer jsn releases, at most once per 24 hours.
      const skipNpmCheck = dailySkips.has(cmd)
        || process.env.JSN_NO_VERSION_CHECK === '1'
        || argv.json
        || argv.quiet;

      // Auto-check skill on every command (once per 24h, non-blocking)
      const skipSkillCheck = dailySkips.has(cmd)
        || process.env.JSN_NO_SKILL_CHECK === '1'
        || argv['no-skill-check'];
      if (!skipSkillCheck) {
        const skillCacheFile = path.join(globalConfigDir(), '.last-skill-check');
        let shouldCheckSkill = true;
        try {
          const mtime = fs.statSync(skillCacheFile).mtimeMs;
          if (Date.now() - mtime < 86400000) shouldCheckSkill = false;
        } catch {
          // File doesn't exist — check
        }

        if (shouldCheckSkill) {
          try {
            checkSkill();
          } catch {
            // Non-fatal — don't crash the CLI if skill check fails
          }

          try {
            fs.mkdirSync(globalConfigDir(), { recursive: true });
            fs.writeFileSync(skillCacheFile, String(Date.now()), 'utf-8');
          } catch {
            // Non-fatal
          }
        }
      }
      if (!skipNpmCheck) {
        const cacheFile = path.join(globalConfigDir(), `.last-npm-check-${getReleaseChannel()}`);
        let shouldCheck = true;
        try {
          const mtime = fs.statSync(cacheFile).mtimeMs;
          const elapsed = Date.now() - mtime;
          // Only check if >= 24 hours since last check
          if (elapsed < 86400000) shouldCheck = false;
        } catch {
          // File doesn't exist — check
        }

        if (shouldCheck) {
          const version = getVersion();
          checkLatest({ background: true, version }).then(latest => {
            if (latest && version !== latest) {
              process.stderr.write(`\n⚠ jsn ${latest} available (you have ${version}) — run "${getInstallCommand(version)}" to update\n\n`);
            }
          }).catch(() => {});

          // Stamp the cache file (write async, don't block)
          try {
            fs.mkdirSync(globalConfigDir(), { recursive: true });
            fs.writeFileSync(cacheFile, String(Date.now()), 'utf-8');
          } catch {
            // Non-fatal
          }
        }
      }

      // Reads never probe or print runtime context. Writes use the guard result.
    })
    // CONFIGURATION
    .command(deferredFamily('setup', wrap))
    .command(deferredFamily('auth', wrap))
    .command(deferredFamily('updatesets', wrap))
    .command(deferredFamily('scopes', wrap))
    .command(deferredFamily('domains', wrap))
    // CORE
    .command(deferredFamily('incidents', wrap))
    .command(deferredFamily('changes', wrap))
    .command(deferredFamily('requests', wrap))
    .command(deferredFamily('tasks', wrap))
    .command(deferredFamily('catalogitems', wrap))
    .command(deferredFamily('cases', wrap))
    // AUTOMATION — Async
    .command(flowsCmd(wrap))
    .command(workflowsCmd(wrap))
    .command(accessAnalyzerCmd(wrap))
    .command(deferredFamily('actions', wrap))
    .command(deferredFamily('scriptactions', wrap))
    .command(deferredFamily('scheduledjobs', wrap))
    .command(deferredFamily('asyncrules', wrap))
    .command(deferredFamily('triggers', wrap))
    // AUTOMATION — In Memory
    .command(deferredFamily('rules', wrap))
    .command(deferredFamily('decisiontables', wrap))
    .command(deferredFamily('assignments', wrap))
    // AUTOMATION — Inbound
    .command(deferredFamily('scrapi', wrap))
    .command(deferredFamily('email', wrap))
    // AUTOMATION — Outbound
    .command(deferredFamily('notifications', wrap))
    .command(deferredFamily('restmessage', wrap))
    .command(deferredFamily('soapmessages', wrap))
    // ACCESS
    .command(deferredFamily('acls', wrap))
    .command(deferredFamily('b4rules', wrap))
    .command(deferredFamily('roles', wrap))
    .command(deferredFamily('privileges', wrap))
    .command(deferredFamily('aliases', wrap))
    .command(deferredFamily('groups', wrap))
    .command(deferredFamily('groupmembers', wrap))
    .command(deferredFamily('grouproles', wrap))
    .command(deferredFamily('users', wrap))
    // USER EXPERIENCE — Shared
    .command(deferredFamily('forms', wrap))
    .command(deferredFamily('lists', wrap))
    .command(deferredFamily('clientscripts', wrap))
    .command(deferredFamily('uipolicies', wrap))
    .command(deferredFamily('uiactions', wrap))
    .command(deferredFamily('views', wrap))
    .command(deferredFamily('catalogscripts', wrap))
    .command(deferredFamily('cataloguipolicies', wrap))
    // USER EXPERIENCE — Core UI
    .command(deferredFamily('uipages', wrap))
    .command(deferredFamily('uimacros', wrap))
    .command(deferredFamily('listcontrols', wrap))
    // USER EXPERIENCE — Service Portal
    .command(deferredFamily('sppages', wrap))
    .command(deferredFamily('spwidgets', wrap))
    // USER EXPERIENCE — Next Experience
    .command(deferredFamily('uxscripts', wrap))
    .command(deferredFamily('uxlists', wrap))
    .command(deferredFamily('uxapplicability', wrap))
    // USER EXPERIENCE — Navigation
    .command(deferredFamily('appmenu', wrap))
    .command(deferredFamily('appmodules', wrap))
    // DATA — DB Schema
    .command(deferredFamily('tables', wrap))
    .command(deferredFamily('columns', wrap))
    .command(deferredFamily('relationships', wrap))
    // DATA — Shared Code, Transforms, Logs
    .command(deferredFamily('includes', wrap))
    .command(deferredFamily('import', wrap))
    .command(deferredFamily('logs', wrap))
    .command(deferredFamily('properties', wrap))
    // DATA
    .command(deferredFamily('cmdb', wrap))
    .command(deferredFamily('knowledge', wrap))
    .command(deferredFamily('records', wrap))
    .command(deferredFamily('attachments', wrap))
    .command(deferredFamily('transactions', wrap))

    .command(deferredFamily('platform', wrap))
    .command(deferredFamily('snippets', wrap))
    .command(deferredFamily('tickets', wrap))
    .command(deferredFamily('codesearch', wrap))
    // DEVELOPER
    .command(deferredFamily('atf', wrap))
    .command(deferredFamily('scan', wrap))
    .command(deferredFamily('store', wrap))
    .command(deferredFamily('plugins', wrap))
    .command(deferredFamily('compare', wrap))
    .command(subscriptionsCmd(wrap))
    .command(deferredFamily('approvals', wrap))
    .command(skippedUpdatesCmd(wrap))
    .command(perfCmd(wrap))
    .command(customizationsCmd(wrap))
    .command(midserversCmd(wrap))
    .command(deferredFamily('diff', wrap))
    .command(deferredFamily('graphql', wrap))
    .command(deferredFamily('eval', wrap))
    .command(deferredFamily('fixscripts', wrap))
    .command(deferredFamily('rest', wrap))
    .command(skillCmd(wrap))
    .command(docsCmd(wrap))
    .command(versionCmd(wrap))
    .command(deferredFamily('upgrade', wrap))
    .command(deferredFamily('document', wrap))
    .command(deferredFamily('tower', wrap))
    .command(discoverCmd(wrap, (argv) => visibleCommandRegistry(cliInstance.commandRegistry({ details: true }), app.config, argv)))
    .demandCommand(1, 'You must specify a command')
    .onParentDiscovery((argv, { path, subcommands }) => {
      // Reached only for a parent command that declares no default handler of
      // its own (attachments, docs community, and any future parent) —
      // the adapter used to fall through and exit 0 having printed nothing.
      // Children come from the registry, description included, so this list
      // cannot drift from the registrations the way a hand-written one did.
      if (DISCOVERY_OWNED_ELSEWHERE.has(path[0])) return;
      const canonical = path.join(' ');
      const summary = `jsn ${canonical} — available subcommands.`;
      // Same error boundary as every registered handler (AGENTS.md: handlers go
      // through wrap()). Discovery runs outside any command handler, and the
      // shared extractor throws on a `--get` path that does not resolve — an
      // unwrapped callback rejected parse() into an entry point with no
      // rejection handler, so a missing path printed a Node stack instead of the
      // extraction_not_found envelope.
      return wrap(async () => {
        (argv.app || app).ok({
          command: canonical,
          subcommands,
          _formatted: formatCommandList({
            title: `jsn ${canonical}`,
            commands: subcommands,
            footer: `Run "jsn ${canonical} <command> --help" for details.`,
          }),
        }, { summary });
      })(argv);
    })
    .epilogue(renderTips())
    .option('version', { type: 'boolean', alias: 'V', describe: 'Show the jsn version' })
    .help('help', 'Show help')
    .version(getVersion())
    .strictCommands()
    .strictOptions(false)
    .fail((msg, err) => {
      if (err) throw err;
      const raw = process.argv.slice(2);
      // A parse-time failure never reaches the format middleware, so resolve the
      // requested format with the adapter's OWN tokenizer (same option specs,
      // option termination, consumed values, repeated options, `--no-`
      // negation) instead of re-scanning raw argv — one policy, one answer for
      // this command line no matter which layer rejects it.
      const formatArgv = cliInstance.parseGlobalOptions(raw);
      app.output.verbose = formatArgv?.verbose === true;
      app.output.raw = formatArgv?.raw === true;
      const requestedFormat = resolveRequestedFormat(formatArgv);
      if (msg === 'You must specify a command') {
        const hasLoneProfile = raw.some((a, i, arr) => {
          if (a !== '--profile' && a !== '-p') return false;
          const next = arr[i + 1];
          return !next || next.startsWith('-');
        });
        if (hasLoneProfile) {
          const cfg = loadConfig();
          const activeName = cfg.activeProfile || cfg.defaultProfile;
          process.stdout.write('Profiles:\n');
          for (const [name, p] of Object.entries(cfg.profiles || {})) {
            const isActive = name === activeName;
            process.stdout.write(`  ${isActive ? '*' : ' '} ${name}  → ${p.instance_url || '(no url)'}\n`);
          }
          process.exit(0);
        }
        // No command is a discovery request, not a failure: the human view
        // stays exactly as it was (exit 0 + grouped help), and an explicit
        // --json gets the same surface as machine-readable data instead of
        // prose that a parser cannot read.
        if (requestedFormat === 'json') {
          app.output.setFormat('json');
          // `--get` is jsn's jq substitute for every JSON shape (AGENTS.md), so
          // the root discovery envelope honours it too: extract when the path
          // resolves, and fail with the structured envelope when it does not,
          // instead of always dumping the whole envelope.
          if (typeof formatArgv?.get === 'string' && formatArgv.get) {
            app.output.setJqFilter(formatArgv.get);
          }
          const { commands } = visibleCommandRegistry(cliInstance.commandRegistry(), loadConfig(formatArgv), formatArgv);
          try {
            app.ok({ commands }, {
              summary: `${commands.length} registered commands — run "jsn <command> --json" for a command's subcommands.`,
            });
          } catch (discoveryError) {
            exitWithError(discoveryError, { app });
          }
          process.exit(0);
        }
        // Human terminals always get the compact local home. Machine and
        // non-interactive discovery retain their existing reference output.
        const config = loadConfig(formatArgv);
        const welcome = maybeShowHome({ argv: formatArgv, requestedFormat, cfg: config });
        if (!welcome) {
          const registry = visibleCommandRegistry(
            cliInstance.commandRegistry({ summaries: true, shallow: true }), config, formatArgv);
          process.stdout.write(renderHelp(config, registry, { full: formatArgv?.allCommands === true }) + '\n');
        }
        process.exit(0);
      }
      // Every other failure here (unknown command, missing required argument,
      // invalid choice/number) is a usage failure. Route it through the same
      // renderer as handler and guard failures: exit 2, and the documented
      // error envelope on stdout when the caller is in JSON mode. Previously
      // this wrote raw prose to stderr and exited 1, so the exit code and the
      // output shape depended on which layer rejected the command.
      if (requestedFormat) app.output.setFormat(requestedFormat);
      let hint;
      try {
        const path = cliInstance._findPath(raw).path.map((n) => n.name).join(' ');
        hint = `Run "jsn ${path ? `${path} ` : ''}--help" for usage.`;
      } catch {
        hint = 'Run "jsn --help" for the command list.';
      }
      exitWithError(new AppError(CodeUsage, msg, hint), { app });
    });

  cliInstance.rootHelpRenderer = () => {
    const options = cliInstance.parseGlobalOptions(process.argv.slice(2));
    const config = loadConfig(options);
    const registry = visibleCommandRegistry(
      cliInstance.commandRegistry({ summaries: true, shallow: true }), config, options);
    return renderHelp(config, registry, { full: options?.allCommands === true });
  };

  // The capability registry is fully populated now that every command
  // factory has run — generate the mutation guard's path list.
  refreshMutationCommands();

  return cliInstance;
}

// Run if invoked directly (bin/jsn.js calls cli.parse())
export const cli = buildCLI();

export { cancelBackgroundChecks } from './commands/version.js';
export { impersonating } from './impersonation.js';
