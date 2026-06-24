import { normalizeInstanceURL, saveConfig, setProfile } from '../config.js';

export function profilesCmd(wrap) {
  return {
    command: 'profiles [subcommand]',
    aliases: ['profile'],
    describe: 'Manage configuration profiles',
    builder: (yargs) => {
      return yargs
        .command({
          command: 'create <name>',
          describe: 'Create a new profile',
          builder: (sub) => sub
            .positional('name', {
              describe: 'Profile name',
              type: 'string',
            })
            .option('instance', {
              alias: 'i',
              describe: 'ServiceNow instance URL (e.g. dev12345.service-now.com)',
              type: 'string',
            })
            .option('username', {
              alias: 'u',
              describe: 'Username for basic auth',
              type: 'string',
            })
            .option('password', {
              alias: 'p',
              describe: 'Password for basic auth',
              type: 'string',
            })
            .option('read-only', {
              describe: 'Mark profile as read-only (blocks mutation commands)',
              type: 'boolean',
              default: false,
            }),
          handler: wrap(async (argv, app) => {
            const name = argv.name;
            if (app.config.profiles && app.config.profiles[name]) {
              throw new Error(`Profile "${name}" already exists. Use "jsn profiles update" or remove it first.`);
            }

            let instance = argv.instance;
            if (!instance) {
              throw new Error(`Instance URL is required.\n\n  jsn profiles create ${name} --instance https://dev12345.service-now.com`);
            }
            instance = normalizeInstanceURL(instance);

            const profile = { instance_url: instance };

            // If username/password provided, save credentials too
            if (argv.username && argv.password) {
              const { saveCredentials } = await import('../auth.js');
              saveCredentials(instance, {
                auth_method: 'basic',
                username: argv.username,
                password: argv.password,
              }, argv.username);
              profile.auth_method = 'basic';
              profile.username = argv.username;
            }

            // If read-only flag is set, mark the profile
            if (argv['read-only']) {
              profile.read_only = true;
            }

            await setProfile(app.config, name, profile);

            app.ok({
              profile: name,
              instance,
              auth_method: profile.auth_method || 'oauth (not yet logged in)',
            }, { summary: `Profile "${name}" created for ${instance}` });
          }),
        })
        .command({
          command: 'list',
          describe: 'List all profiles',
          handler: wrap(async (_argv, app) => {
            const profiles = [];
            for (const [name, profile] of Object.entries(app.config.profiles || {})) {
              const instance = profile.instance_url || '';
              const isAuth = app.auth.isAuthenticatedFor(instance);
              const isDefault = name === app.config.defaultProfile;
              profiles.push({
                name,
                instance,
                username: profile.username || '',
                authenticated: isAuth,
                default: isDefault,
                read_only: profile.read_only || false,
              });
            }

            // Build context-aware breadcrumb: suggest switching to a non-active profile
            const breadcrumbs = [];
            if (profiles.length > 0) {
              const activeName = app.config.activeProfile || app.config.defaultProfile;
              const nonActiveProfiles = profiles.filter(p => p.name !== activeName);
              if (nonActiveProfiles.length > 0) {
                const suggestName = nonActiveProfiles[0].name;
                breadcrumbs.push({
                  action: 'switch',
                  cmd: `jsn profiles use ${suggestName}`,
                  description: 'Switch to a different profile',
                });
              }
            }

            app.ok({ profiles }, { summary: `${profiles.length} profile(s)`, breadcrumbs });
          }),
        })
        .command({
          command: 'use <name>',
          describe: 'Set active profile',
          handler: wrap(async (argv, app) => {
            const name = argv.name;
            if (!app.config.profiles[name]) {
              throw new Error(`Profile not found: ${name}`);
            }
            app.config.defaultProfile = name;
            app.config.activeProfile = name;
            saveConfig(app.config);
            app.ok({ active_profile: name }, { summary: `Active profile: ${name}` });
          }),
        })
        .command({
          command: 'show [name]',
          describe: 'Show profile details',
          handler: wrap(async (argv, app) => {
            const name = argv.name || app.config.defaultProfile || Object.keys(app.config.profiles || {})[0];
            if (!name || !app.config.profiles[name]) {
              throw new Error('No profiles configured');
            }
            const profile = app.config.profiles[name];
            const readOnlyNote = profile.read_only ? ' [READ-ONLY]' : '';
            app.ok({ name, ...profile }, { summary: `Profile: ${name}${readOnlyNote}` });
          }),
        })
        .command({
          command: 'remove <name>',
          describe: 'Remove a profile',
          handler: wrap(async (argv, app) => {
            const name = argv.name;
            if (!app.config.profiles[name]) {
              throw new Error(`Profile not found: ${name}`);
            }
            const instance = app.config.profiles[name].instance_url;
            delete app.config.profiles[name];
            if (app.config.defaultProfile === name) {
              app.config.defaultProfile = '';
            }
            if (app.config.activeProfile === name) {
              app.config.activeProfile = '';
            }
            saveConfig(app.config);

            // Only clean up credentials if no other profile uses this instance URL
            const stillInUse = instance && Object.values(app.config.profiles || {})
              .some(p => p.instance_url === instance);
            if (instance && !stillInUse) {
              app.auth.logout(instance);
            }

            app.ok({ removed: name }, { summary: `Removed profile: ${name}` });
          }),
        })

    },
    handler: (argv) => {
      // When no subcommand is given, show help
      if (!argv._[1]) {
        console.log('Manage your ServiceNow instance profiles.\n');
        console.log('Usage: jsn profiles <create|list|show|use|remove> [options]\n');
        console.log('Commands:');
        console.log('  create <name>  Create a new profile (--instance required)');
        console.log('  list           List all profiles');
        console.log('  show [name]    Show profile details');
        console.log('  use  <name>    Switch to a different profile');
        console.log('  remove <name>  Remove a profile');
        console.log('\nRun "jsn profiles <command> --help" for more details.');
        console.log('\nNote: You can also create a profile by authenticating:');
        console.log('  jsn auth login --profile <name> <instance-url>');
        console.log('  jsn auth login --profile staging --password https://dev12345.service-now.com');
      }
    },
  };
}
