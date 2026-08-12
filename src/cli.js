// Root CLI using yargs

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig, getActiveProfile, globalConfigDir } from './config.js';
import { App } from './app.js';
import { renderHelp } from './help.js';
import { isMutationCommand } from './mutations.js';
import { guardExit } from './errors.js';

// Command modules
import { setupCmd } from './commands/setup.js';
import { authCmd } from './commands/auth.js';
import { recordsCmd } from './commands/records.js';
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
import { versionCmd } from './commands/version.js';
import { devCmd } from './commands/dev.js';
import { skillCmd, checkSkill } from './commands/skill.js';
import { getVersion, checkLatest } from './commands/version.js';
import { docsCmd } from './commands/docs/docs.js';

// Dev subcommands promoted to root level for progressive disclosure
import {
  actionsCmd, includesCmd, rulesCmd,
  clientScriptsCmd, uiActionsCmd, uiPoliciesCmd,
  tablesCmd, columnsCmd, importCmd,
  spPagesCmd, spWidgetsCmd, uiPagesCmd, appMenuCmd,
  aclsCmd, rolesCmd, propertiesCmd,
  relationshipsCmd, appmodulesCmd, listcontrolsCmd, viewsCmd,
  privilegesCmd, uxscriptsCmd, aliasesCmd,
  catalogscriptsCmd, cataloguipoliciesCmd,
  uipoliciesCmd,
  scriptactionsCmd, scheduledjobsCmd, asyncrulesCmd, triggersCmd,
  decisiontablesCmd, assignmentsCmd,
  emailCmd,
  restmessageCmd, soapmessagesCmd,
  uimacrosCmd, uxlistsCmd, uxapplicabilityCmd,
} from './commands/dev/_simple.js';
import { flowsCmd } from './commands/dev/flows.js';
import { formsCmd } from './commands/dev/forms.js';
import { listsCmd } from './commands/dev/lists.js';
import { updateSetsCmd } from './commands/dev/updatesets.js';
import { scopesCmd } from './commands/dev/scopes.js';
import { domainsCmd } from './commands/dev/domains.js';
import { evalCmd } from './commands/dev/eval.js';
import { restCmd } from './commands/dev/rest.js';
import { logsCmd } from './commands/dev/logs.js';
import { scrapiCmd } from './commands/dev/scrapi.js';
import { b4rulesCmd } from './commands/dev/b4rules.js';

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
      if (err.code === 'not_found') {
        const id = argv._.slice(1).join(' ') || argv.id || argv.name || argv.sysID || '';
        process.stderr.write(`Error (${err.code}): ${err.message}\n`);
        if (id) {
          process.stderr.write(`\nHint: The identifier "${id}" was not found. Check the name or sys_id.\n`);
        }
        process.exit(1);
      }
      if (err.code === 'usage') {
        process.stderr.write(`Error (usage): ${err.message}\n`);
        process.exit(2);
      }
      if (err.code === 'system_error') {
        process.stderr.write(`Error (system): ${err.message}\n`);
        process.exit(3);
      }
      process.stderr.write(`Error: ${err.message}\n`);
      process.exit(1);
    }
  };
}

export function buildCLI() {
  const cfg = loadConfig();
  const app = new App(cfg);

  return yargs(hideBin(process.argv))
    .scriptName('jsn')
    .usage('Usage: jsn <command> [options]')
    .middleware([
      // Attach App instance to every command
      (argv) => {
        argv.app = app;
        argv._profile = cfg.profiles || {};
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
        description: 'Output format: auto, json, markdown, styled, quiet',
        choices: ['auto', 'json', 'markdown', 'styled', 'quiet'],
      },
      json: {
        type: 'boolean',
        description: 'Output in JSON format (shortcut for --format=json)',
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
      // Apply format option overrides
      (argv) => {
        if (argv.json) argv.format = 'json';
        if (argv.quiet) argv.format = 'quiet';
        if (argv.styled) argv.format = 'styled';
        if (argv.markdown) argv.format = 'markdown';
        if (argv.format) {
          app.output.setFormat(argv.format);
        }
        // --profile: resolve profile name to its instance URL
        // --instance wins if both are specified (explicit URL > profile reference)
        if (argv.profile) {
          const profile = (cfg.profiles || {})[argv.profile];
          if (!profile) {
            guardExit(argv, {
              code: 'unknown_profile',
              message: `Unknown profile "${argv.profile}"`,
              hint: 'Run "jsn auth status" to list profiles.',
            });
          }
          const url = profile.instance_url;
          app._overrideInstance = url;
          argv._overrideInstance = url;
          // Temporarily switch active profile so auth picks up the right user
          cfg.activeProfile = argv.profile;
        }
        if (argv.instance) {
          app._overrideInstance = argv.instance;
          argv._overrideInstance = argv.instance;
        }
      },
      // Guard mutation commands: require an instance, block read-only profiles
      (argv) => {
        const cmd = (argv._[0] || '').toString();
        if (!cmd || ['help', 'version', 'completion', 'setup', 'auth', 'skill', 'docs'].includes(cmd)) {
          return;
        }
        // Check for --instance override
        if (argv.instance) {
          app._overrideInstance = argv.instance;
          argv._overrideInstance = argv.instance;
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
          const profile = getActiveProfile(cfg);
          if (profile?.read_only === true) {
            const name = cfg.activeProfile || cfg.defaultProfile;
            guardExit(argv, {
              code: 'read_only',
              message: `Profile "${name}" is read-only. Mutations are blocked.`,
              hint: 'Switch to a write-enabled profile first:\n  jsn auth switch <name>',
            });
          }
        }
      },
    ])
    .middleware(async (argv) => {
      // Override instance for this command run
      if (argv._overrideInstance) {
        app.setEffectiveInstance(argv._overrideInstance);
      }

      const cmd = (argv._[0] || '').toString();

      // Daily npm version check (fire-and-forget, non-blocking)
      // Checks npm for newer jsn releases, at most once per 24 hours.
      const skipNpmCheck = ['help', 'version', 'completion', 'skill', 'docs'].includes(cmd)
        || process.env.JSN_NO_VERSION_CHECK === '1'
        || argv.json
        || argv.quiet;

      // Auto-check skill on every command (once per 24h, non-blocking)
      const skipSkillCheck = ['help', 'version', 'completion', 'skill', 'docs'].includes(cmd)
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
        const cacheFile = path.join(globalConfigDir(), '.last-npm-check');
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
          checkLatest().then(latest => {
            if (latest && version !== latest) {
              process.stderr.write(`\n⚠ jsn ${latest} available (you have ${version}) — run "npm install -g @jacebenson/jsn" to update\n\n`);
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
      if (!['help', 'version', 'completion', 'skill', 'docs'].includes(cmd)) {
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
    .command(uiPoliciesCmd(wrap))
    .command(uiActionsCmd(wrap))
    .command(viewsCmd(wrap))
    .command(catalogscriptsCmd(wrap))
    .command(uipoliciesCmd(wrap))
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
    .command(recordsCmd(wrap))
    .command(ticketsCmd(wrap))
    // DEVELOPER
    .command(evalCmd(wrap))
    .command(restCmd(wrap))
    .command(skillCmd(wrap))
    .command(docsCmd(wrap))
    .command(versionCmd(wrap))
    // Legacy
    .command(devCmd(wrap))
    .demandCommand(1, 'You must specify a command')
    .help('help', 'Show help')
    .version(false)
    .strictCommands()
    .strictOptions(false)
    .fail((msg, err) => {
      if (err) throw err;
      if (msg === 'You must specify a command') {
        const raw = process.argv.slice(2);
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
        process.stdout.write(renderHelp(loadConfig()) + '\n');
        process.exit(0);
      }
      process.stderr.write(msg + '\n');
      process.exit(1);
    });
}

// Run if invoked directly (bin/jsn.js calls cli.parse())
export const cli = buildCLI();
