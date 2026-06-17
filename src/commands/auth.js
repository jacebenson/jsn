import { getEffectiveInstance, normalizeInstanceURL } from '../config.js';
import { errUsage } from '../errors.js';
import process from 'node:process';

export function authCmd(wrap) {
  return {
    command: 'auth <subcommand>',
    describe: 'Manage authentication (OAuth or basic auth via env vars)',
    builder: (yargs) => {
      return yargs
        .command({
          command: 'login [instance]',
          describe: 'Authenticate with a ServiceNow instance via OAuth',
          builder: (sub) => sub
            .option('code', {
              describe: 'Authorization code from browser (bypasses interactive prompt)',
              type: 'string',
            })
            .option('password', {
              describe: 'Authenticate with basic auth via env vars (SN_USERNAME/SN_PASSWORD)',
              type: 'boolean',
            })
            .option('print-url', {
              describe: 'Print the OAuth URL and exit (saves PKCE state for --code)',
              type: 'boolean',
            })
            .option('wait-file', {
              describe: 'File path to watch for authorization code (used with --print-url)',
              type: 'string',
            }),
          handler: wrap(async (argv, app) => {
            let instanceURL;
            if (argv.instance) {
              // Check if it's a profile name first
              const profiles = app.config.profiles || {};
              if (profiles[argv.instance] && profiles[argv.instance].instance_url) {
                instanceURL = normalizeInstanceURL(profiles[argv.instance].instance_url);
              } else {
                instanceURL = normalizeInstanceURL(argv.instance);
              }
            } else {
              instanceURL = getEffectiveInstance(app.config);
              if (!instanceURL) {
                // Try interactive profile picker
                const profileNames = Object.keys(app.config.profiles || {});
                if (profileNames.length > 0 && app.isInteractive()) {
                  const { search } = await import('@inquirer/prompts');
                  const choices = profileNames.map(name => ({
                    name: `${name} — ${app.config.profiles[name].instance_url}`,
                    value: name,
                  }));
                  const selected = await search({
                    message: 'Select a profile:',
                    source: (input) => {
                      const filter = (input || '').toLowerCase();
                      return choices.filter(c => c.name.toLowerCase().includes(filter));
                    },
                  });
                  instanceURL = normalizeInstanceURL(app.config.profiles[selected].instance_url);
                } else {
                  throw errUsage(`Instance URL required.

Examples:
  jsn auth login https://dev12345.service-now.com
  jsn auth login dev373698
  jsn auth login --password https://dev328604.service-now.com

Find your instance URL in your browser's address bar when logged into ServiceNow.`);
                }
              }
            }

            // --password: authenticate with basic auth from env vars
            if (argv.password) {
              await app.auth.loginWithPassword(instanceURL);
            }
            // --print-url with --wait-file: print URL and wait for code file
            else if (argv.printUrl && argv.waitFile) {
              await app.auth.buildAuthURL(instanceURL, argv.waitFile);
            }
            // --print-url: just print the URL and exit
            else if (argv.printUrl) {
              const authURL = app.auth.buildAuthURL(instanceURL);
              console.log(authURL);
              return;
            }
            // --code: exchange the provided authorization code directly
            else if (argv.code) {
              await app.auth.loginWithCode(instanceURL, argv.code);
            } else {
              // Interactive: full OAuth flow with browser + prompt
              await app.auth.login(instanceURL);
            }

            // Verify auth by fetching current user
            let username = '';
            try {
              if (!app.sdk) {
                const { SDKClient } = await import('../sdk.js');
                app.sdk = new SDKClient(instanceURL, app.auth);
              }
              const user = await app.sdk.getCurrentUser();
              username = user?.user_name || user?.name || '';
            } catch {
              // Non-fatal — token is saved, just couldn't verify
            }

            // Save to profiles — deduplicate by instance URL
            if (!app.config.profiles) {
              app.config.profiles = {};
            }

            // Check if a profile already exists for this instance
            let profileName = null;
            for (const [existingName, existingProfile] of Object.entries(app.config.profiles)) {
              if (existingProfile.instance_url === instanceURL) {
                profileName = existingName;
                break;
              }
            }

            // If no existing profile found, generate a name from the URL
            if (!profileName) {
              profileName = instanceURL.replace(/https?:\/\//, '').replace(/\.service-now\.com.*/, '').replace(/[^a-zA-Z0-9]/g, '-');
            }

            app.config.profiles[profileName] = {
              ...(app.config.profiles[profileName] || {}),
              instance_url: instanceURL,
              auth_method: argv.password ? 'basic' : 'oauth',
              username: username || undefined,
            };

            // Re-save OAuth credentials with username now that we have it,
            // so they're keyed by <user>@<instance> for per-user isolation.
            // Also clean up the old bare-instance key so migration is clean.
            if (!argv.password && username) {
              const { saveCredentials, loadCredentials, deleteCredentials } = await import('../auth.js');
              const stored = loadCredentials(instanceURL);
              if (stored && stored.access_token) {
                stored.username = username;
                saveCredentials(instanceURL, stored, username);
                deleteCredentials(instanceURL); // remove bare-instance legacy key
              }
            }

            // Set as default if this is the first one
            const setDefault = !app.config.instanceURL && !app.config.defaultProfile;
            if (setDefault) {
              app.config.instanceURL = instanceURL;
              app.config.defaultProfile = profileName;
            }

            const { saveConfig } = await import('../config.js');
            saveConfig(app.config);

            const result = {
              authenticated: true,
              instance: instanceURL,
              username: username || undefined,
              profile: profileName,
              default: setDefault || undefined,
            };
            const summary = username
              ? `✓ Authenticated to ${instanceURL} as ${username} (profile: ${profileName})`
              : `✓ Authenticated to ${instanceURL} (profile: ${profileName})`;
            app.ok(result, { summary });
          }),
        })
        .command({
          command: 'logout [instance]',
          describe: 'Remove stored OAuth credentials',
          handler: wrap(async (argv, app) => {
            let instanceURL;
            if (argv.instance) {
              instanceURL = normalizeInstanceURL(argv.instance);
            } else {
              instanceURL = getEffectiveInstance(app.config);
              if (!instanceURL) {
                throw errUsage(`No instance specified.

Examples:
  jsn auth logout
  jsn auth logout https://dev12345.service-now.com`);
              }
            }
            app.auth.logout(instanceURL);
            app.ok({ logged_out: true, instance: instanceURL }, { summary: `✓ Logged out from ${instanceURL}` });
          }),
        })
        .command({
          command: 'status',
          describe: 'Show detailed authentication status',
          handler: wrap(async (_argv, app) => {
            const defaultInstance = getEffectiveInstance(app.config);

            // Check environment auth
            const envToken = process.env.SERVICENOW_OAUTH_TOKEN || '';

            const profiles = [];
            for (const [name, profile] of Object.entries(app.config.profiles || {})) {
              const instance = profile.instance_url;
              const isAuth = app.auth.isAuthenticatedFor(instance);
              const lastSeen = app.auth.getLastSeen(instance);
              const authSource = isAuth ? app.auth.getAuthSource(instance) : null;
              const legacy = !isAuth && app.auth.hasLegacyCredentials(instance) ? true : undefined;

              // Try live verification
              let verified = null;
              let verifiedAt = null;
              if (isAuth && instance) {
                try {
                  const { SDKClient } = await import('../sdk.js');
                  const sdk = new SDKClient(instance, app.auth);
                  const user = await sdk.getCurrentUser();
                  if (user && user.user_name) {
                    verified = true;
                    verifiedAt = user.user_name;
                  }
                } catch {
                  verified = false;
                }
              }

              // Calculate days since last seen
              let daysSinceLastSeen = null;
              if (lastSeen) {
                daysSinceLastSeen = Math.floor((Date.now() / 1000 - lastSeen) / 86400);
              }

              profiles.push({
                name,
                instance,
                authenticated: isAuth,
                legacy,
                auth_source: authSource || (legacy ? 'legacy' : undefined),
                verified,
                verified_as: verifiedAt || undefined,
                last_seen: lastSeen || undefined,
                days_since_last_seen: daysSinceLastSeen,
                stale: daysSinceLastSeen > 7,
                default: instance === defaultInstance,
              });
            }

            const result = {
              default_instance: defaultInstance,
              authenticated: app.auth.isAuthenticated(),
              environment_auth: envToken ? true : undefined,
              profiles,
            };

            app.ok(result, { summary: `${profiles.length} profile(s)` });

            // Warn about legacy credentials that need re-authentication
            const legacyProfiles = profiles.filter(p => p.legacy);
            if (legacyProfiles.length > 0) {
              process.stderr.write(
                '\n⚠️  This release changed how credentials are stored.\n' +
                '   Some profiles still use the old format.\n' +
                '   Run the following to re-authenticate:\n'
              );
              for (const p of legacyProfiles) {
                process.stderr.write(`     jsn auth login ${p.name}\n`);
              }
              process.stderr.write('\n');
            }
          }),
        })
        .command({
          command: 'refresh [instance]',
          describe: 'Refresh OAuth token for an instance',
          handler: wrap(async (argv, app) => {
            let instanceURL;
            if (argv.instance) {
              // Check if it's a profile name or URL
              const profiles = app.config.profiles || {};
              if (profiles[argv.instance] && profiles[argv.instance].instance_url) {
                instanceURL = normalizeInstanceURL(profiles[argv.instance].instance_url);
              } else {
                instanceURL = normalizeInstanceURL(argv.instance);
              }
            } else {
              instanceURL = getEffectiveInstance(app.config);
              if (!instanceURL) {
                throw errUsage(`No instance specified and no default configured.

Examples:
  jsn auth refresh
  jsn auth refresh https://dev12345.service-now.com
  jsn auth refresh dev12345`);
              }
            }

            const creds = await app.auth.getCredentialsFor(instanceURL);
            const refreshed = await app.auth.refreshToken(instanceURL, creds);
            app.ok({
              refreshed: true,
              instance: instanceURL,
              expires_at: refreshed.expires_at,
            }, { summary: `✓ Token refreshed for ${instanceURL}` });
          }),
        });
    },
    handler: () => {},
  };
}
