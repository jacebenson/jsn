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
  .option('no-skill-check', {
    describe: 'Skip the automatic skill version check',
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

    // Read-only profile check — block mutation commands on read-only profiles
    const activeProfileName = cfg.activeProfile || cfg.defaultProfile;
    if (activeProfileName && cfg.profiles[activeProfileName] && cfg.profiles[activeProfileName].read_only) {
      const skipReadOnlyCheck = ['help', 'version', 'setup', 'auth', 'profiles', 'profile', 'skill', undefined].includes(cmd);
      if (!skipReadOnlyCheck && isMutationCommand(argv)) {
        process.stderr.write(`\n🔒 Profile "${activeProfileName}" is read-only.\n`);
        process.stderr.write(`  Mutation commands are disabled on this profile.\n`);
        const nonReadOnlyProfiles = Object.entries(cfg.profiles || {})
          .filter(([n, p]) => n !== activeProfileName && !p.read_only)
          .map(([n]) => n);
        if (nonReadOnlyProfiles.length > 0) {
          process.stderr.write(`  Switch to a writable profile:  jsn profiles use ${nonReadOnlyProfiles[0]}\n`);
        }
        process.stderr.write('\n');
        process.exit(1);
      }
    }

    // Auto-check skill on every command (fire-and-forget, non-blocking)
    const skipSkillCheck = ['help', 'version', 'completion', 'skill'].includes(cmd)
      || process.env.JSN_NO_SKILL_CHECK === '1'
      || argv['no-skill-check'];
    if (!skipSkillCheck) {
      // Fire check but don't await — it runs in background
      checkSkill().then(result => {
        if (result && !result.current && result.error) {
          process.stderr.write(`\n⚠ ${result.error}\n\n`);
        }
      }).catch(() => {});
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
  .command(catalogCmd(wrap))
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
      // Check if --profile/-p was used without a value — show profile info instead
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
          const marker = name === activeName ? ' *' : '  ';
          process.stdout.write(`  ${marker} ${name.padEnd(20)} ${p.instance_url || ''}\n`);
        }
        process.stdout.write('\nUsage: jsn --profile <name> <command>\n');
        process.stdout.write('       jsn profiles use <name>\n');
        process.exit(0);
      }
      process.stdout.write(renderHelp());
      process.exit(0);
    }
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
  });
