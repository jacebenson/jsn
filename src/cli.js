// Root CLI using yargs

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import process from 'node:process';
import { loadConfig, getEffectiveInstance } from './config.js';
import { App } from './app.js';
import { renderHelp } from './help.js';

// Command modules
import { setupCmd } from './commands/setup.js';
import { authCmd } from './commands/auth.js';
import { profilesCmd } from './commands/profiles.js';
import { recordsCmd } from './commands/records.js';
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
import { skillCmd } from './commands/skill.js';

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
      const app = argv.app;
      if (app) {
        app.err(err);
      } else {
        process.stderr.write(`Error: ${err.message || err}\n`);
      }
      process.exit(1);
    }
  };
}

export const cli = yargs(hideBin(process.argv))
  .scriptName('jsn')
  .usage('Usage: $0 <command> [options]')
  .option('instance', {
    describe: 'ServiceNow instance URL (e.g., https://dev12345.service-now.com)',
    type: 'string',
    global: true,
  })
  .option('profile', {
    alias: 'p',
    describe: 'Configuration profile to use',
    type: 'string',
    global: true,
  })
  .option('format', {
    describe: 'Output format: auto, json, markdown, styled, quiet',
    type: 'string',
    global: true,
  })
  .option('json', {
    describe: 'Output in JSON format',
    type: 'boolean',
    global: true,
  })
  .option('quiet', {
    alias: 'q',
    describe: 'Output only data, no envelope',
    type: 'boolean',
    global: true,
  })
  .option('styled', {
    describe: 'Force styled output',
    type: 'boolean',
    global: true,
  })
  .option('markdown', {
    describe: 'Output in Markdown format',
    type: 'boolean',
    global: true,
  })
  .middleware(async (argv) => {
    // Determine format from flags
    let format = 'auto';
    if (argv.json) format = 'json';
    else if (argv.quiet) format = 'quiet';
    else if (argv.styled) format = 'styled';
    else if (argv.markdown) format = 'markdown';
    else if (argv.format) format = argv.format;

    const cfg = loadConfig({
      instance: argv.instance,
      profile: argv.profile,
      format,
    });

    argv.app = new App(cfg);

    // Check auth for non-auth commands
    const cmd = argv._[0];
    const skipAuth = ['help', 'version', 'setup', 'auth', 'profiles', 'profile', 'skill', undefined].includes(cmd);
    if (!skipAuth) {
      const instance = getEffectiveInstance(cfg);
      if (!argv.app.auth.isAuthenticated() && instance) {
        process.stderr.write(`\n⚠️  Not authenticated to ${instance}\n\n`);
        process.stderr.write('To get started, run:\n');
        process.stderr.write('  jsn setup           # Interactive setup\n');
        process.stderr.write(`  jsn auth login ${instance}   # Login to instance\n\n`);
      }
    }

    // Print context header for interactive terminals (at the TOP, before command output)
    if (!['help', 'version', 'completion', 'skill'].includes(cmd)) {
      await argv.app.printContextHeader();
    }
  })
  .command(setupCmd(wrap))
  .command(authCmd(wrap))
  .command(profilesCmd(wrap))
  .command(recordsCmd(wrap))
  .command(incidentsCmd(wrap))
  .command(changesCmd(wrap))
  .command(requestsCmd(wrap))
  .command(tasksCmd(wrap))
  .command(usersCmd(wrap))
  .command(groupsCmd(wrap))
  .command(groupMembersCmd(wrap))
  .command(groupRolesCmd(wrap))
  .command(ticketsCmd(wrap))
  .command(devCmd(wrap))
  .command(skillCmd(wrap))
  .command(versionCmd(wrap))
  .demandCommand(1, 'You must specify a command')
  .help('help', 'Show help')
  .version(false)
  .strictCommands()
  .strictOptions(false)
  .fail((msg, err) => {
    if (err) throw err;
    // No command given → show custom grouped help instead of yargs error
    if (msg === 'You must specify a command') {
      process.stdout.write(renderHelp());
      process.exit(0);
    }
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
  });
