// Root CLI using the local yargs-compatible adapter

import yargs, { hideBin } from './cli-adapter.js';
import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig, globalConfigDir } from './config.js';
import { App } from './app.js';
import { resolveSession, applySession } from './session.js';
import { renderHelp } from './help.js';
import { isMutationCommand, refreshMutationCommands } from './mutations.js';
import { skippedUpdatesCmd } from './commands/skipped-updates.js';
import { noInstanceCommands, dailyCheckSkipCommands, contextHeaderSkipCommands } from './capabilities.js';
import { guardExit, exitWithError, AppError, CodeUsage } from './errors.js';
import { formatCommandList } from './helpers.js';

// Command modules
import { setupCmd } from './commands/setup.js';
import { authCmd } from './commands/auth.js';
import { recordsCmd } from './commands/records.js';
import { cmdbCmd } from './commands/cmdb.js';
import { snippetsCmd } from './commands/snippets.js';
import { catalogCmd } from './commands/catalog.js';
import { incidentsCmd } from './commands/incidents.js';
import { changesCmd } from './commands/changes.js';
import { requestsCmd } from './commands/requests.js';
import { tasksCmd } from './commands/tasks.js';
import { usersCmd } from './commands/users.js';
import { groupsCmd } from './commands/groups.js';
import { groupMembersCmd } from './commands/groupmembers.js';
import { groupRolesCmd } from './commands/grouproles.js';
import { ticketsCmd } from './commands/tickets.js';
import { transactionsCmd } from './commands/transactions.js';

import { platformCmd } from './commands/platform.js';
import { codesearchCmd } from './commands/codesearch.js';
import { versionCmd } from './commands/version.js';
import { skillCmd, checkSkill } from './commands/skill.js';
import { getVersion, checkLatest, getReleaseChannel, getInstallCommand } from './commands/version.js';
import { docsCmd } from './commands/docs/docs.js';

// Table and platform commands registered at root level for progressive disclosure
import {
  actionsCmd, includesCmd, rulesCmd,
  clientScriptsCmd, uiActionsCmd,
  tablesCmd, columnsCmd, importCmd,
  spPagesCmd, spWidgetsCmd, uiPagesCmd, appMenuCmd,
  aclsCmd, rolesCmd, propertiesCmd,
  relationshipsCmd, appmodulesCmd, listcontrolsCmd, viewsCmd,
  privilegesCmd, uxscriptsCmd, aliasesCmd,
  catalogscriptsCmd, cataloguipoliciesCmd,
  uipoliciesCmd,
  scriptactionsCmd, scheduledjobsCmd, asyncrulesCmd, triggersCmd,
  assignmentsCmd,
  emailCmd,
  restmessageCmd, soapmessagesCmd,
  uimacrosCmd, uxlistsCmd, uxapplicabilityCmd,
} from './commands/_simple.js';
import { decisiontablesCmd } from './commands/decisiontables.js';
import { flowsCmd } from './commands/flows.js';
import { formsCmd } from './commands/forms.js';
import { listsCmd } from './commands/lists.js';
import { updateSetsCmd } from './commands/updatesets.js';
import { scopesCmd } from './commands/scopes.js';
import { domainsCmd } from './commands/domains.js';
import { evalCmd } from './commands/eval.js';
import { restCmd } from './commands/rest.js';
import { logsCmd } from './commands/logs.js';
import { scrapiCmd } from './commands/scrapi.js';
import { b4rulesCmd } from './commands/b4rules.js';
import { atfCmd } from './commands/atf.js';
import { approvalsCmd } from './commands/approvals.js';
import { perfCmd } from './commands/perf.js';
import { customizationsCmd } from './commands/customizations.js';
import { midserversCmd } from './commands/midservers.js';
import { diffCmd } from './commands/diff.js';
import { graphqlCmd } from './commands/graphql.js';

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
 * (csv > markdown > styled > quiet > json).
 */
export function resolveRequestedFormat(argv) {
  if (!argv) return '';
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

function wrap(handler) {
  return async (argv) => {
    try {
      const app = argv.app;
      if (!app) {
        process.stderr.write('Error: App context not initialized.\n');
        process.exit(1);
      }
      await handler(argv, app);
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
  // Root command names for the completion filter — captured from the yargs
  // registry after the chain below finishes registering all commands.
  let rootCommands = [];

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
        description: 'Output format: auto, json, markdown, styled, quiet, csv',
        choices: ['auto', 'json', 'markdown', 'styled', 'quiet', 'csv'],
      },
      json: {
        type: 'boolean',
        description: 'Output in JSON format (shortcut for --format=json)',
      },
      csv: {
        type: 'boolean',
        description: 'Output in CSV format (shortcut for --format=csv)',
      },
      get: {
        type: 'string',
        description: 'Extract a JSON path from the output envelope (e.g. --get "data.records.0.number"); no jq needed',
      },
      quiet: {
        type: 'boolean',
        description: 'Output only data, no envelope (shortcut for --format=quiet)',
        alias: 'q',
      },
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
        const requested = resolveRequestedFormat(argv);
        if (requested) {
          argv.format = requested;
          app.output.setFormat(requested);
        }
        if (argv.get) {
          app.output.setJqFilter(argv.get);
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
    ])
    .middleware(async (argv) => {
      // Session (incl. --instance/--profile overrides) was already applied
      // by the middleware above — nothing to re-apply here.
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

      // Print context header for interactive terminals
      if (!contextHeaderSkipCommands().has(cmd)) {
        await argv.app.printContextHeader(argv);
      }
    })
    // CONFIGURATION
    .command(setupCmd(wrap))
    .command(authCmd(wrap))
    .command(updateSetsCmd(wrap))
    .command(scopesCmd(wrap))
    .command(domainsCmd(wrap))
    // CORE
    .command(incidentsCmd(wrap))
    .command(changesCmd(wrap))
    .command(requestsCmd(wrap))
    .command(tasksCmd(wrap))
    .command(catalogCmd(wrap))
    // AUTOMATION — Async
    .command(flowsCmd(wrap))
    .command(actionsCmd(wrap))
    .command(scriptactionsCmd(wrap))
    .command(scheduledjobsCmd(wrap))
    .command(asyncrulesCmd(wrap))
    .command(triggersCmd(wrap))
    // AUTOMATION — In Memory
    .command(rulesCmd(wrap))
    .command(decisiontablesCmd(wrap))
    .command(assignmentsCmd(wrap))
    // AUTOMATION — Inbound
    .command(scrapiCmd(wrap))
    .command(emailCmd(wrap))
    // AUTOMATION — Outbound
    .command(restmessageCmd(wrap))
    .command(soapmessagesCmd(wrap))
    // ACCESS
    .command(aclsCmd(wrap))
    .command(b4rulesCmd(wrap))
    .command(rolesCmd(wrap))
    .command(privilegesCmd(wrap))
    .command(aliasesCmd(wrap))
    .command(groupsCmd(wrap))
    .command(groupMembersCmd(wrap))
    .command(groupRolesCmd(wrap))
    .command(usersCmd(wrap))
    // USER EXPERIENCE — Shared
    .command(formsCmd(wrap))
    .command(listsCmd(wrap))
    .command(clientScriptsCmd(wrap))
    .command(uipoliciesCmd(wrap))
    .command(uiActionsCmd(wrap))
    .command(viewsCmd(wrap))
    .command(catalogscriptsCmd(wrap))
    .command(cataloguipoliciesCmd(wrap))
    // USER EXPERIENCE — Core UI
    .command(uiPagesCmd(wrap))
    .command(uimacrosCmd(wrap))
    .command(listcontrolsCmd(wrap))
    // USER EXPERIENCE — Service Portal
    .command(spPagesCmd(wrap))
    .command(spWidgetsCmd(wrap))
    // USER EXPERIENCE — Next Experience
    .command(uxscriptsCmd(wrap))
    .command(uxlistsCmd(wrap))
    .command(uxapplicabilityCmd(wrap))
    // USER EXPERIENCE — Navigation
    .command(appMenuCmd(wrap))
    .command(appmodulesCmd(wrap))
    // DATA — DB Schema
    .command(tablesCmd(wrap))
    .command(columnsCmd(wrap))
    .command(relationshipsCmd(wrap))
    // DATA — Shared Code, Transforms, Logs
    .command(includesCmd(wrap))
    .command(importCmd(wrap))
    .command(logsCmd(wrap))
    .command(propertiesCmd(wrap))
    // DATA
    .command(cmdbCmd(wrap))
    .command(recordsCmd(wrap))
    .command(transactionsCmd(wrap))

    .command(platformCmd(wrap))
    .command(snippetsCmd(wrap))
    .command(ticketsCmd(wrap))
    .command(codesearchCmd(wrap))
    // DEVELOPER
    .command(atfCmd(wrap))
    .command(approvalsCmd(wrap))
    .command(skippedUpdatesCmd(wrap))
    .command(perfCmd(wrap))
    .command(customizationsCmd(wrap))
    .command(midserversCmd(wrap))
    .command(diffCmd(wrap))
    .command(graphqlCmd(wrap))
    .command(evalCmd(wrap))
    .command(restCmd(wrap))
    .command(skillCmd(wrap))
    .command(docsCmd(wrap))
    .command(versionCmd(wrap))
    .demandCommand(1, 'You must specify a command')
    // Completion plumbing under a hidden command name, so the explicit
    // 'completion' command below owns the UX. (#176)
    // The custom filter fixes two yargs behaviors:
    // 1. Under strictCommands(), yargs' default completion handler aborts
    //    when the current word isn't an exact command match. Delegating to
    //    completionFilter (the default generator) sidesteps that.
    // 2. When the current word is an exact ALIAS (e.g. "inc" for incidents),
    //    yargs descends into that command's subcommands, so a still-being-
    //    typed "jsn inc<TAB>" offers subcommands that can't match the prefix.
    //    When completing the FIRST word, merge in the root command list — the
    //    shell's compgen prefix-filters the final list anyway.
    .completion('__completion', false, (current, argv, completionFilter, done) => {
      completionFilter((err, completions) => {
        let out = completions || [];
        const depth = (argv._ || []).length;
        if (current && !current.startsWith('-') && depth === 0) {
          out = [...new Set([...out, ...rootCommands])];
        }
        done([...new Set(out)]);
      });
    })
    // User-facing completion command with a real help page (install docs).
    // yargs' built-in completion command prints the script even for --help,
    // which is why the plumbing above uses the hidden '__completion' name.
    .command({
      command: 'completion',
      describe: 'Generate shell completion script',
      builder: (y) => y
        .usage('Usage: jsn completion > <file for your shell>')
        .epilogue([
          'Install for your shell:',
          '',
          '  # bash (auto-loaded if the bash-completion package is installed)',
          '  jsn completion > ~/.local/share/bash-completion/jsn',
          '',
          '  # bash (simple)',
          '  jsn completion >> ~/.bashrc',
          '',
          '  # fish',
          '  jsn completion > ~/.config/fish/completions/jsn.fish',
          '',
          '  # zsh — the generated script is bash-style, load via bashcompinit.',
          '  # Add to ~/.zshrc:',
          '  autoload -U +X bashcompinit && bashcompinit',
          '  source <(jsn completion)',
          '',
          'Restart your shell (or source the file) after installing.',
        ].join('\n')),
      handler: () => {
        cliInstance.showCompletionScript();
      },
    })
    .onParentDiscovery((argv, { path, subcommands }) => {
      // Reached only for a parent command that declares no default handler of
      // its own (records attachments, docs community, and any future parent) —
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
    .help('help', 'Show help')
    .version(false)
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
          const { commands } = cliInstance.commandRegistry();
          try {
            app.ok({ commands }, {
              summary: `${commands.length} registered commands — run "jsn <command> --json" for a command's subcommands.`,
            });
          } catch (discoveryError) {
            exitWithError(discoveryError, { app });
          }
          process.exit(0);
        }
        process.stdout.write(renderHelp(loadConfig(), cliInstance.commandRegistry()) + '\n');
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

  // Snapshot the root command names (plus aliases) for the completion
  // filter. Done before any parse — command builders mutate the registry.
  rootCommands = cliInstance.getInternalMethods().getCommandInstance().getCommands();

  // The capability registry is fully populated now that every command
  // factory has run — generate the mutation guard's path list.
  refreshMutationCommands();

  return cliInstance;
}

// Run if invoked directly (bin/jsn.js calls cli.parse())
export const cli = buildCLI();

export { cancelBackgroundChecks } from './commands/version.js';
