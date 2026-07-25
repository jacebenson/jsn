// Root CLI using yargs

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import process from 'node:process';
import { loadConfig, getEffectiveInstance } from './config.js';
import { App } from './app.js';
import { renderHelp } from './help.js';
import { isMutationCommand } from './mutations.js';

// Command modules
import { setupCmd } from './commands/setup.js';
import { authCmd } from './commands/auth.js';
import { profilesCmd } from './commands/profiles.js';
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

// Dev subcommands promoted to root level for progressive disclosure
import {
  actionsCmd, includesCmd, rulesCmd,
  clientScriptsCmd, uiActionsCmd, uiPoliciesCmd,
  tablesCmd, columnsCmd, importCmd,
  spPagesCmd, spWidgetsCmd, uiPagesCmd, appMenuCmd,
  aclsCmd, rolesCmd, propertiesCmd,
  relationshipsCmd, appmodulesCmd, listcontrolsCmd, viewsCmd,
  privilegesCmd, securitytypesCmd, uxscriptsCmd, aliasesCmd,
  catalogscriptsCmd, cataloguipoliciesCmd,
  scriptactionsCmd, scheduledjobsCmd, asyncrulesCmd, triggersCmd,
  workflowsCmd, decisiontablesCmd, assignmentsCmd,
  emailCmd,
  restmessageCmd, restmethodsCmd, soapmessagesCmd, soapfunctionsCmd,
  uimacrosCmd, uxlistsCmd, uxapplicabilityCmd,
} from './commands/dev/_simple.js';
import { flowsCmd } from './commands/dev/flows.js';
import { formsCmd } from './commands/dev/forms.js';
import { listsCmd } from './commands/dev/lists.js';
import { updateSetsCmd } from './commands/dev/updatesets.js';
import { scopesCmd } from './commands/dev/scopes.js';
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

  // Resolve instance once
  let effectiveInstance;
  try {
    effectiveInstance = getEffectiveInstance(cfg);
  } catch {
    effectiveInstance = null;
  }

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
        if (argv.instance) {
          app._overrideInstance = argv.instance;
        }
      },
      // Guard mutation commands when no instance configured
      (argv) => {
        const cmd = (argv._[0] || '').toString();
        if (!cmd || ['help', 'version', 'completion', 'setup', 'auth', 'profiles', 'skill'].includes(cmd)) {
          return;
        }
        // Check for --instance override
        if (argv.instance) {
          app._overrideInstance = argv.instance;
        }
        // Determine if this is a mutation
        const subcommand = (argv._[1] || '').toString();
        const isMutation = isMutationCommand(cmd, subcommand);
        if (isMutation) {
          app.requireInstance();
        }
      },
    ])
    .middleware(async (argv) => {
      // Override instance for this command run
      if (argv._overrideInstance) {
        app.setEffectiveInstance(argv._overrideInstance);
      }

      const cmd = (argv._[0] || '').toString();

      // Auto-check skill on every command (fire-and-forget, non-blocking)
      const skipSkillCheck = ['help', 'version', 'completion', 'skill'].includes(cmd)
        || process.env.JSN_NO_SKILL_CHECK === '1'
        || argv['no-skill-check']
        || argv.json
        || argv.quiet;
      if (!skipSkillCheck) {
        checkSkill().then(result => {
          if (result && !result.current && result.error) {
            process.stderr.write(`\n⚠ ${result.error}\n\n`);
          }
        }).catch(() => {});
      }

      // Print context header for interactive terminals
      if (!['help', 'version', 'completion', 'skill'].includes(cmd)) {
        await argv.app.printContextHeader(argv);
      }
    })
    // CONFIGURATION
    .command(setupCmd(wrap))
    .command(authCmd(wrap))
    .command(profilesCmd(wrap))
    .command(updateSetsCmd(wrap))
    .command(scopesCmd(wrap))
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
    .command(workflowsCmd(wrap))
    .command(decisiontablesCmd(wrap))
    .command(assignmentsCmd(wrap))
    // AUTOMATION — Inbound
    .command(scrapiCmd(wrap))
    .command(emailCmd(wrap))
    // AUTOMATION — Outbound
    .command(restmessageCmd(wrap))
    .command(restmethodsCmd(wrap))
    .command(soapmessagesCmd(wrap))
    .command(soapfunctionsCmd(wrap))
    // ACCESS
    .command(aclsCmd(wrap))
    .command(b4rulesCmd(wrap))
    .command(rolesCmd(wrap))
    .command(privilegesCmd(wrap))
    .command(securitytypesCmd(wrap))
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
        process.stdout.write(renderHelp() + '\n');
        process.exit(0);
      }
      process.stderr.write(msg + '\n');
      process.exit(1);
    });
}

// Run if invoked directly (bin/jsn.js calls cli.parse())
export const cli = buildCLI();
