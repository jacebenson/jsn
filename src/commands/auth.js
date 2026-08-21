import { getEffectiveInstance, normalizeInstanceURL, saveConfig, setActiveProfile, setProfile } from '../config.js';
import { errUsage } from '../errors.js';
import { declareCapabilities } from '../capabilities.js';
import process from 'node:process';

// Auth manages local credentials/profiles — runs without a configured
// instance. (Not in the daily-check skip-list: legacy behavior checks for
// updates here.)
declareCapabilities('auth', { noInstance: true });

/**
 * Render the `jsn auth status` styled (TTY) view: one line per profile with
 * default marker, auth ✓/✗, 🔒 read_only, ⚡ skip_confirmations, ✅/⚠️
 * live-verification, and stale-last-seen hints.
 *
 * This view logic lives in the auth command — NOT in src/output.js — and is
 * shipped to the OutputWriter as `data._formatted` (the documented escape
 * hatch for command-curated visuals; see the interface comment in
 * src/output.js). The `summary` line is folded into the formatted string
 * because the writer suppresses opts.summary when _formatted is present.
 * Golden-pinned by test/auth.test.js ("auth status styled output").
 */
export function renderAuthStatus(result, summary) {
  let out = summary ? `${summary}\n\n` : '';
  const profiles = Array.isArray(result.profiles) ? result.profiles : [];
  if (profiles.length > 0) {
    out += '\n';
    for (const p of profiles) {
      const prefix = p.default ? '* ' : '  ';
      const authIcon = p.authenticated ? '✓' : '✗';

      // Show verified status if we got one
      let verifiedStr = '';
      if (p.verified === true) {
        verifiedStr = ' ✅';
      } else if (p.verified === false) {
        verifiedStr = ' ⚠️';
      }

      // Show stale hint if >7 days since last seen
      let staleStr = '';
      if (p.stale && p.days_since_last_seen) {
        staleStr = ` (${p.days_since_last_seen}d ago — may have been released)`;
      }

      // Show lock icon for read-only profiles
      const lockIcon = p.read_only ? ' 🔒' : '';

      // Show confirmations-off badge for skip_confirmations profiles
      const confirmBadge = p.skip_confirmations ? ' ⚡' : '';

      if (p.name) {
        out += `${prefix}${authIcon} ${p.name} — ${p.instance}${lockIcon}${confirmBadge}${verifiedStr}${staleStr}\n`;
      } else if (p.username) {
        out += `${prefix}${authIcon} ${p.instance} (as ${p.username})${lockIcon}${confirmBadge}${verifiedStr}${staleStr}\n`;
      } else {
        out += `${prefix}${authIcon} ${p.instance}${lockIcon}${confirmBadge}${verifiedStr}${staleStr}\n`;
      }
    }
  }
  return out;
}

/**
 * Resolve a login/logout/refresh argument to a concrete instance URL.
 *
 * gh-style precision: a full URL is used as-is; a bare name is first checked
 * against known profile names (gh: --hostname), then treated as a ServiceNow
 * instance name with the canonical `.service-now.com` host appended. This kills
 * the old trap where `jsn auth login dev99999` silently targeted
 * `https://dev99999` (a dead host).
 */
export function resolveInstanceArg(arg, cfg) {
  if (!arg) return '';
  const trimmed = arg.trim();
  if (/^https?:\/\//i.test(trimmed)) return normalizeInstanceURL(trimmed);
  const profile = cfg?.profiles?.[trimmed];
  if (profile?.instance_url) return normalizeInstanceURL(profile.instance_url);
  // Already looks like a host (has a dot) — add the scheme, nothing else
  if (trimmed.includes('.')) return normalizeInstanceURL(trimmed);
  // Bare ServiceNow instance name → canonical host
  return normalizeInstanceURL(`${trimmed}.service-now.com`);
}

/**
 * Pick a profile by name — interactive search picker when ambiguous,
 * auto-selects when there's exactly one, throws when none configured.
 */
export async function pickProfile(app, message) {
  const { search } = await import('@inquirer/prompts');
  const profileNames = Object.keys(app.config.profiles || {});
  if (profileNames.length === 0) throw errUsage('No profiles configured. Run "jsn setup" first.');
  if (profileNames.length === 1 || !app.isInteractive()) return profileNames[0];
  const choices = profileNames.map(name => ({
    name: `${name} — ${app.config.profiles[name].instance_url}`,
    value: name,
  }));
  return search({
    message,
    source: (input) => {
      const filter = (input || '').toLowerCase();
      return choices.filter(c => c.name.toLowerCase().includes(filter));
    },
  });
}

/**
 * Resolve the instance for the wizard: only an EXPLICIT source (env var or
 * a flag-provided override visible on the app session) pre-fills. The
 * config's default profile must NOT — the wizard adds an instance, so it
 * always asks otherwise.
 */
export function resolveWizardInstance(app, argv = {}) {
  // app.getEffectiveInstance() is the session-backed read (production App);
  // the _overrideInstance fallback keeps hand-rolled test fakes honest.
  return process.env.SERVICENOW_INSTANCE_URL || app.getEffectiveInstance?.() || app._overrideInstance || argv.instance || '';
}

/**
 * Interactive first-run wizard (formerly `jsn setup`).
 *
 * Walks: instance URL → profile name → auth method → optional OAuth login.
 * Creates and activates the profile, then returns the result so the caller
 * decides how to report it. Basic auth saves credentials directly (the OAuth
 * path has no interactive username/password).
 */
export async function loginWizard(app, argv = {}) {
  const readline = (await import('node:readline')).default;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  console.log('Welcome to JSN - ServiceNow CLI');
  console.log();

  // Ask for the instance URL unless one was explicitly provided (env var,
  // --instance flag/override). NEVER pre-fill from the config's default
  // profile — this wizard adds an instance, so it must always ask.
  // (Regression: setup → Add skipped the URL ask when a default profile
  // existed, silently re-targeting the default instance.)
  let instance = resolveWizardInstance(app, argv);
  if (instance) {
    instance = normalizeInstanceURL(instance);
  } else {
    instance = await ask('ServiceNow instance URL (e.g., dev12345.service-now.com): ');
    instance = normalizeInstanceURL(instance);
  }
  console.log(`Instance: ${instance}`);

  // Warn if another profile already uses this instance URL
  const existing = Object.entries(app.config.profiles || {}).find(([, p]) => p.instance_url === instance);
  if (existing) {
    console.log(`Note: instance is also used by profile "${existing[0]}".`);
  }

  const profileName = (await ask('Profile name (default): ')) || 'default';
  const profile = { instance_url: instance };
  if (argv['read-only']) {
    profile.read_only = true;
  }
  if (argv['skip-confirmations']) {
    profile.skip_confirmations = true;
  }

  const authMethod = await ask('Authentication method (OAuth/Basic) [OAuth]: ');
  const useBasic = authMethod.toLowerCase().startsWith('b');

  let loggedIn = false;
  if (useBasic) {
    const username = await ask('Username: ');
    rl.close(); // Close outer readline before askHidden creates its own
    const { loadCredentials, askHidden, saveCredentials } = await import('../auth.js');
    const existingCreds = loadCredentials(instance) || loadCredentials(instance, username);
    if (existingCreds && existingCreds.auth_method === 'basic') {
      console.log(`Using existing credentials for ${instance}`);
    } else {
      const password = await askHidden('Password: ');
      saveCredentials(instance, { auth_method: 'basic', username, password }, username);
      console.log('Basic auth credentials saved');
    }
    profile.username = username;
    profile.auth_method = 'basic';
  } else {
    profile.auth_method = 'oauth';
  }

  await setProfile(app.config, profileName, profile);
  // Set as active profile so subsequent commands know which instance to use
  app.config.activeProfile = profileName;
  app.config.defaultProfile = profileName;

  // Present all connection-level options during setup. Gated on interactivity
  // so a piped/scripted call never blocks on prompts.
  const { canPrompt } = await import('../helpers.js');
  if (canPrompt()) {
    const { confirm } = await import('@inquirer/prompts');
    profile.read_only = await confirm({ message: 'Read-only profile (blocks mutation commands)?', default: profile.read_only || false });
    profile.skip_confirmations = await confirm({ message: 'Skip confirmations (deletes run without prompting)?', default: profile.skip_confirmations || false });
    profile.include_counts = await confirm({ message: 'Include result totals on list commands?', default: profile.include_counts !== false });
    console.log('');
  }

  await saveConfig(app.config);

  if (!useBasic) {
    const loginNow = await ask('Login now? [Y/n]: ');
    rl.close();
    if (!loginNow || loginNow.toLowerCase() !== 'n') {
      await app.auth.login(instance);
      // Re-save credentials under <user>@<instance> after verifying username
      try {
        const { SDKClient } = await import('../sdk.js');
        const sdk = new SDKClient(instance, app.auth);
        const user = await sdk.getCurrentUser();
        if (user && user.user_name) {
          const { loadCredentials, saveCredentials } = await import('../auth.js');
          const stored = loadCredentials(instance);
          if (stored && stored.access_token) {
            stored.username = user.user_name;
            saveCredentials(instance, stored, user.user_name);
          }
          profile.username = user.user_name;
        }
      } catch {
        // Non-fatal — token saved, username will be set on next auth login
      }
      console.log('Login successful!');
      loggedIn = true;

      // Probe domain separation capability once and stamp the profile, so
      // `jsn domains` (and its help entry) only appear on instances with it.
      try {
        const { SDKClient } = await import('../sdk.js');
        const domainsMod = await import('./dev/domains.js');
        const sdk = new SDKClient(instance, app.auth);
        profile.domain_separation = await domainsMod.isDomainSeparationInstalled({ sdk });
        await setProfile(app.config, profileName, profile);

        // If domain separation is installed, offer to pick a default domain
        // for the profile — every request will be scoped to it via X-Now-Domain.
        if (profile.domain_separation) {
          const { confirm } = await import('@inquirer/prompts');
          const setDomainNow = await confirm({
            message: 'Domain separation detected. Configure a domain for this instance?',
            default: false,
          });
          if (setDomainNow) {
            const domainSysID = await domainsMod.pickDomain({ ...app, sdk });
            if (domainSysID) {
              profile.domain = domainSysID;
              await setProfile(app.config, profileName, profile);
              console.log('Domain configured.');
            }
          }
        }
      } catch {
        // Non-fatal — capability unknown; domains command falls back to probing
      }
    }
  } else {
    rl.close();
  }

  return { instanceURL: instance, profileName, loggedIn };
}

/**
 * gh-faithful login target picker: existing profiles plus an "add a new
 * instance" row. Typing filters profiles; picking the ＋ row uses what you
 * typed (or prompts for it).
 *
 * Returns { addNew: true, instanceName } or { addNew: false, name }.
 */
async function pickLoginTarget(app) {
  const { search, input } = await import('@inquirer/prompts');
  const ADD_NEW = '__add_new__';
  const profileNames = Object.keys(app.config.profiles || {});
  let lastInput = '';
  const selected = await search({
    message: 'Log in to which instance?',
    source: (term) => {
      const filter = (term || '').toLowerCase();
      lastInput = term || '';
      const profiles = profileNames
        .filter((name) => {
          const label = `${name} — ${app.config.profiles[name].instance_url}`.toLowerCase();
          return !filter || label.includes(filter);
        })
        .map((name) => ({
          name: `${name} — ${app.config.profiles[name].instance_url}`,
          value: name,
        }));
      const addLabel = filter
        ? `＋ Add "${term.trim()}" as a new instance`
        : '＋ Add a new instance';
      return [{ name: addLabel, value: ADD_NEW }, ...profiles];
    },
  });
  if (selected === ADD_NEW) {
    const typed = lastInput.trim();
    if (typed) return { addNew: true, instanceName: typed };
    const name = await input({
      message: 'ServiceNow instance name or URL (e.g. dev12345):',
      validate: (v) => (v.trim() ? true : 'Instance name or URL is required'),
    });
    return { addNew: true, instanceName: name.trim() };
  }
  return { addNew: false, name: selected };
}

/** Per-profile configurable flags (extensible — any boolean on the profile). */
const PROFILE_FLAGS = [
  { name: 'Read-only (blocks mutation commands)', value: 'read_only', icon: '🔒' },
  { name: 'Skip confirmations (deletes run without prompting)', value: 'skip_confirmations', icon: '⚡' },
  { name: 'Include result totals on list commands', value: 'include_counts', icon: '🔢' },
];

/**
 * Modify a profile: toggle a boolean flag, or set/clear the domain.
 * Interactive picker when no flag passed; testable via argv.flag/argv.domain.
 */
export async function modifyProfile(app, argv = {}) {
  const name = argv.name || await pickProfile(app, 'Modify which instance?');
  const profile = app.config.profiles?.[name];
  if (!profile) throw new Error(`Profile not found: ${name}`);

  // Domain setting path: --domain <name|sys_id|clear>
  if (argv.domain !== undefined) {
    if (!profile.domain_separation) {
      throw new Error(`Domain separation is not installed on ${profile.instance_url} — no domain to configure.`);
    }
    if (argv.domain === 'clear' || argv.domain === 'none' || argv.domain === '') {
      profile.domain = '';
      await saveConfig(app.config);
      app.ok({ profile: name, domain: '' }, { summary: `Domain cleared for ${name}` });
      return;
    }
    const { isDomainSeparationInstalled } = await import('./dev/domains.js');
    const { SDKClient } = await import('../sdk.js');
    const sdk = new SDKClient(profile.instance_url, app.auth);
    if (!(await isDomainSeparationInstalled({ sdk }))) {
      throw new Error(`Domain separation is not installed on ${profile.instance_url}`);
    }
    const { resolveDomainSysId } = await import('./dev/domains.js');
    const sysID = await resolveDomainSysId({ sdk }, argv.domain);
    profile.domain = sysID;
    await saveConfig(app.config);
    app.ok({ profile: name, domain: sysID }, { summary: `Domain set for ${name}` });
    return;
  }

  let flag = argv.flag;
  if (!flag) {
    const { select } = await import('@inquirer/prompts');
    const choices = PROFILE_FLAGS.map(f => ({
      name: `${f.icon} ${f.name}: ${profile[f.value] ? 'on' : 'off'}`,
      value: f.value,
    }));
    if (profile.domain_separation) {
      choices.push({
        name: `🌐 Domain: ${profile.domain ? 'set' : 'not set'}`,
        value: 'domain',
      });
    }
    const { SDKClient } = await import('../sdk.js');
    const sdk = new SDKClient(profile.instance_url, app.auth);
    flag = await select({
      message: `Modify ${name} (${profile.instance_url})`,
      choices,
    });
    if (flag === 'domain') {
      const domainsMod = await import('./dev/domains.js');
      const installed = await domainsMod.isDomainSeparationInstalled({ sdk });
      if (!installed) {
        throw new Error(`Domain separation is not installed on ${profile.instance_url}`);
      }
      const { confirm } = await import('@inquirer/prompts');
      const clear = profile.domain
        ? await confirm({ message: `Domain is set. Clear it?`, default: false })
        : false;
      if (clear) {
        profile.domain = '';
        await saveConfig(app.config);
        app.ok({ profile: name, domain: '' }, { summary: `Domain cleared for ${name}` });
        return;
      }
      const sysID = await domainsMod.pickDomain({ ...app, sdk });
      if (sysID) {
        profile.domain = sysID;
        await saveConfig(app.config);
        app.ok({ profile: name, domain: sysID }, { summary: `Domain set for ${name}` });
      }
      return;
    }
  }

  profile[flag] = !profile[flag];
  await saveConfig(app.config);
  app.ok({ profile: name, [flag]: profile[flag] },
    { summary: `${flag} is now ${profile[flag] ? 'ON' : 'off'} for ${name}` });
}

/**
 * Delete an instance entry and its stored credentials (shared by the
 * `auth remove` subcommand and the `jsn setup` hub).
 */
export async function removeProfile(app, name) {
  if (!app.config.profiles[name]) {
    throw new Error(`Profile not found: ${name}`);
  }
  const instance = app.config.profiles[name].instance_url;
  delete app.config.profiles[name];
  if (app.config.defaultProfile === name) app.config.defaultProfile = '';
  if (app.config.activeProfile === name) app.config.activeProfile = '';
  saveConfig(app.config);

  // Only clear credentials if no other profile uses this instance URL
  const stillInUse = instance && Object.values(app.config.profiles || {})
    .some(p => p.instance_url === instance);
  if (instance && !stillInUse) {
    app.auth.logout(instance);
  }

  app.ok({ removed: name }, { summary: `Removed profile: ${name}` });
}

export function authCmd(wrap) {
  return {
    command: 'auth [subcommand]',
    describe: 'Manage authentication (OAuth or basic auth via env vars)',
    builder: (yargs) => {
      return yargs
        .command({
          command: 'login [instance]',
          describe: 'Authenticate with a ServiceNow instance (interactive picker when run bare)',
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
            })
            .option('read-only', {
              describe: 'Mark the created profile as read-only (blocks mutation commands)',
              type: 'boolean',
              default: false,
            })
            .option('skip-confirmations', {
              describe: 'Skip delete confirmations on this profile (deletes run without prompting)',
              type: 'boolean',
              default: false,
            })
            .option('include-counts', {
              describe: 'Include result totals on list commands (default on; pass --no-include-counts to opt out)',
              type: 'boolean',
            }),
          handler: wrap(async (argv, app) => {
            let instanceURL;
            if (argv.instance) {
              instanceURL = resolveInstanceArg(argv.instance, app.config);
            } else if (app.isInteractive()) {
              // gh-faithful: interactive terminals always get a picker —
              // existing profiles plus "＋ Add a new instance". Zero profiles
              // goes straight to the setup wizard.
              const profileNames = Object.keys(app.config.profiles || {});
              if (profileNames.length === 0) {
                const wizard = await loginWizard(app, argv);
                if (wizard.loggedIn) {
                  app.ok({ authenticated: true, instance: wizard.instanceURL, profile: wizard.profileName },
                    { summary: `✓ Authenticated to ${wizard.instanceURL} (profile: ${wizard.profileName})` });
                } else {
                  app.ok({ setup: true, instance: wizard.instanceURL, profile: wizard.profileName },
                    { summary: `Profile "${wizard.profileName}" created for ${wizard.instanceURL}. Run "jsn auth login" to authenticate.` });
                }
                return;
              }
              const target = await pickLoginTarget(app);
              if (target.addNew) {
                instanceURL = resolveInstanceArg(target.instanceName, app.config);
              } else {
                instanceURL = normalizeInstanceURL(app.config.profiles[target.name].instance_url);
              }
            } else {
              instanceURL = getEffectiveInstance(app.config);
              if (!instanceURL) {
                throw errUsage(`Instance URL required.

Examples:
  jsn auth login https://dev12345.service-now.com
  jsn auth login dev373698
  jsn auth login --password https://dev328604.service-now.com

Find your instance URL in your browser's address bar when logged into ServiceNow.`);
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
              read_only: argv['read-only'] || undefined,
              skip_confirmations: argv['skip-confirmations'] || undefined,
              include_counts: argv['include-counts'] === true ? true : argv['include-counts'] === false ? false : undefined,
            };

            // Re-save OAuth credentials with username now that we have it,
            // so they're keyed by <user>@<instance> for per-user isolation.
            // The legacy bare-instance key is cleaned up behind the
            // AuthManager seam (credential-store internals don't leak here).
            if (!argv.password && username) {
              app.auth.migrateLegacyCredential(instanceURL, username);
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
          describe: 'Clear stored credentials (keeps the instance entry — use "auth remove" to delete it)',
          handler: wrap(async (argv, app) => {
            let instanceURL;
            if (argv.instance) {
              instanceURL = resolveInstanceArg(argv.instance, app.config);
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
                read_only: profile.read_only || false,
                skip_confirmations: profile.skip_confirmations || false,
                include_counts: profile.include_counts !== false,
              });
            }

            const result = {
              default_instance: defaultInstance,
              authenticated: app.auth.isAuthenticated(),
              environment_auth: envToken ? true : undefined,
              profiles,
            };

            const summary = `${profiles.length} profile(s)`;
            // Ship the styled view as _formatted (see renderAuthStatus); the
            // OutputWriter prints it verbatim and suppresses the summary.
            result._formatted = renderAuthStatus(result, summary);
            app.ok(result, { summary });

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
              instanceURL = resolveInstanceArg(argv.instance, app.config);
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

            // Re-probe domain separation on refresh so the capability flag
            // stays in sync if the plugin was installed/removed since setup.
            try {
              const { SDKClient } = await import('../sdk.js');
              const { isDomainSeparationInstalled } = await import('./dev/domains.js');
              const sdk = new SDKClient(instanceURL, app.auth);
              const hasDS = await isDomainSeparationInstalled({ sdk });
              const name = app.config.activeProfile || app.config.defaultProfile;
              if (name && app.config.profiles[name] && app.config.profiles[name].instance_url === instanceURL) {
                app.config.profiles[name].domain_separation = hasDS;
                await saveConfig(app.config);
              }
            } catch {
              // Non-fatal — capability probe is best-effort
            }

            app.ok({
              refreshed: true,
              instance: instanceURL,
              expires_at: refreshed.expires_at,
            }, { summary: `✓ Token refreshed for ${instanceURL}` });
          }),
        })
        .command({
          command: 'switch [name]',
          describe: 'Switch active profile (gh: auth switch)',
          builder: (sub) => sub
            .positional('name', {
              describe: 'Profile name to activate',
              type: 'string',
            }),
          handler: wrap(async (argv, app) => {
            let name = argv.name;
            if (!name) {
              const profileNames = Object.keys(app.config.profiles || {});
              if (profileNames.length === 0) {
                throw errUsage('No profiles configured. Run "jsn auth login" first.');
              }
              if (profileNames.length > 1 && app.isInteractive()) {
                const { search } = await import('@inquirer/prompts');
                const choices = profileNames.map(profileName => ({
                  name: `${profileName} — ${app.config.profiles[profileName].instance_url}`,
                  value: profileName,
                }));
                const selected = await search({
                  message: 'Select a profile:',
                  source: (input) => {
                    const filter = (input || '').toLowerCase();
                    return choices.filter(c => c.name.toLowerCase().includes(filter));
                  },
                });
                name = selected;
              } else {
                name = profileNames[0];
              }
            }
            await setActiveProfile(app.config, name);
            app.ok({ active_profile: name }, { summary: `Active profile: ${name}` });
          }),
        })
        .command({
          command: 'modify [name]',
          describe: 'Toggle instance configuration (read-only, skip confirmations, domain)',
          builder: (sub) => sub
            .positional('name', {
              describe: 'Profile name to modify',
              type: 'string',
            })
            .option('domain', {
              type: 'string',
              describe: 'Set the domain for this profile (name, sys_id, or "clear")',
            }),
          handler: wrap(async (argv, app) => {
            await modifyProfile(app, argv);
          }),
        })
        .command({
          command: 'remove [name]',
          describe: 'Delete an instance entry and its stored credentials',
          builder: (sub) => sub
            .positional('name', {
              describe: 'Profile name to delete',
              type: 'string',
            }),
          handler: wrap(async (argv, app) => {
            let name = argv.name;
            if (!name) {
              name = await pickProfile(app, 'Remove which instance?');
            }
            await removeProfile(app, name);
          }),
        });
    },
    handler: () => {
      console.log('Manage authentication for ServiceNow instances.');
      console.log('');
      console.log('Available subcommands:');
      console.log('  login <url|name>  Log in / add an instance (picker when run bare)');
      console.log('  refresh           Refresh the access token');
      console.log('  status            Show auth status for all profiles');
      console.log('');
      console.log('Tip: "jsn setup" is the interactive manager — add, switch, remove, or modify instances.');
      console.log('Run "jsn auth <command> --help" for details.');
    },
  };
}
