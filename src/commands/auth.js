import { getEffectiveInstance, normalizeInstanceURL, saveConfig, setActiveProfile } from '../config.js';
import { errUsage, errUsageHint } from '../errors.js';
import { canUsePicker, formatCommandList, quoteShellArg } from '../helpers.js';
import { declareCapabilities } from '../capabilities.js';
import process from 'node:process';
import { refreshSession } from '../session.js';

function syncSession(app) {
  if (typeof app._buildSdk === 'function' && typeof app.loadContext === 'function') refreshSession(app);
}

// Auth manages local credentials/profiles — runs without a configured
// instance. (Not in the daily-check skip-list: legacy behavior checks for
// updates here.)
declareCapabilities('auth', { noInstance: true, skipContextHeader: true });

/** Render a compact status table; identity fields require explicit details. */
export function renderAuthStatus(result, summary, { details = false } = {}) {
  const profiles = Array.isArray(result.profiles) ? result.profiles : [];
  if (!profiles.length) return 'No profiles configured.\nRun: jsn auth login <instance> --browser\n';
  const methods = { oauth: 'OAuth', basic: 'Basic', gck: 'Browser session' };
  const states = { available: 'Available', missing: 'Missing', expired: 'Expired', refreshable: 'Refresh required', malformed: 'Invalid' };
  const headings = ['PROFILE', 'AUTH', 'CREDENTIALS', 'CONNECTION', 'ACCESS', 'DELETES', 'COUNTS'];
  if (details) headings.push('USER', 'INSTANCE');
  const notes = [];
  const rows = profiles.map((profile, index) => {
    const diagnostics = profile.diagnostics || {};
    const probe = diagnostics.probe || {};
    const label = profile.name || `Profile ${index + 1}`;
    const connection = profile.verified === true ? 'Verified'
      : probe.code === 'account_mismatch' ? 'User mismatch'
      : profile.verified === false ? 'Failed' : 'Not checked';
    const row = [
      `${label}${profile.active ? ' *' : ''}${profile.default ? ' (default)' : ''}`,
      methods[diagnostics.auth_method] || 'Not configured',
      states[diagnostics.state] || (profile.authenticated ? 'Available' : 'Missing'),
      connection,
      profile.read_only ? 'Read-only' : 'Read/write',
      profile.skip_confirmations ? 'No prompt' : 'Confirm',
      profile.include_counts === false ? 'Off' : 'On',
    ];
    if (details) {
      const user = profile.username || profile.verified_as || 'Not recorded';
      row.push(`${user}${profile.verified_as && profile.verified_as !== user ? ` (session: ${profile.verified_as})` : ''}`, profile.instance || 'Not configured');
    }
    if (profile.verified !== true && probe.message) notes.push(`${label}: ${probe.message}`);
    if (profile.name && profile.verified !== true) {
      const command = `jsn auth ${diagnostics.state === 'refreshable' ? 'refresh' : 'login'} --profile ${quoteShellArg(profile.name)}`;
      const hint = ['missing', 'expired', 'refreshable', 'malformed'].includes(diagnostics.state)
        || ['unauthorized', 'invalid_browser_session', 'refresh_failed', 'account_mismatch'].includes(probe.code)
        ? command : probe.hint;
      if (hint) notes.push(`${label}: ${hint}`);
    }
    return row;
  });
  const widths = headings.map((heading, column) => Math.max(heading.length, ...rows.map(row => row[column].length)));
  const formatRow = row => row.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd();
  const lines = [summary || `${profiles.length} profiles`, '', formatRow(headings), ...rows.map(formatRow)];
  if (profiles.some(profile => profile.active)) lines.push('', '* selected profile');
  if (profiles.some(profile => profile.diagnostics?.probe?.code === 'not_requested')) lines.push('', 'Connection not checked (--local).');
  if (notes.length) lines.push('', ...notes);
  if (!details) lines.push('', 'Show users and instance URLs: jsn auth status --details');
  return lines.join('\n') + '\n';
}

export function profileSettingValues(argv = {}) {
  if (argv['confirm-deletes'] !== undefined && argv['skip-confirmations'] !== undefined
    && argv['confirm-deletes'] === argv['skip-confirmations']) {
    throw errUsage('--confirm-deletes and --skip-confirmations request conflicting values.');
  }
  return {
    ...argv,
    'skip-confirmations': argv['confirm-deletes'] !== undefined ? !argv['confirm-deletes'] : argv['skip-confirmations'],
  };
}

/** The same profile preferences are offered by setup and new-profile login. */
export async function configureProfileOptions(profile, argv = {}, { interactive = false, confirm } = {}) {
  argv = profileSettingValues(argv);
  if (interactive && !confirm) ({ confirm } = await import('../prompts.js'));
  const settings = [
    ['read_only', 'read-only', 'Read-only profile (blocks mutation commands)?', false],
    ['skip_confirmations', 'skip-confirmations', 'Confirm before deleting records?', false],
    ['include_counts', 'include-counts', 'Include result totals on list commands?', true],
  ];
  for (const [key, flag, message, fallback] of settings) {
    if (argv[flag] !== undefined) profile[key] = argv[flag];
    else if (interactive) {
      const current = profile[key] ?? fallback;
      const value = await confirm({ message, default: key === 'skip_confirmations' ? !current : current });
      profile[key] = key === 'skip_confirmations' ? !value : value;
    }
  }
  return profile;
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

/** Resolve a command target by explicit profile name before instance fallback. */
export function resolveTargetProfile(argv = {}, cfg = {}, instanceURL = '') {
  if (argv.profile && cfg.profiles?.[argv.profile]) {
    return { name: argv.profile, profile: cfg.profiles[argv.profile] };
  }
  if (argv.instance && cfg.profiles?.[argv.instance]) return { name: argv.instance, profile: cfg.profiles[argv.instance] };
  const matches = Object.entries(cfg.profiles || {})
    .filter(([, profile]) => normalizeInstanceURL(profile.instance_url) === instanceURL);
  if (matches.length > 1) {
    const active = cfg.activeProfile || cfg.defaultProfile;
    if (!argv.instance && matches.some(([name]) => name === active)) return { name: active, profile: cfg.profiles[active] };
    throw errUsage('Multiple profiles use this instance. Choose the user with --profile <name>.');
  }
  const entry = matches[0];
  return entry ? { name: entry[0], profile: entry[1] } : { name: null, profile: null };
}

/**
 * Select the login method. Explicit Basic Auth wins; otherwise reuse the
 * method recorded on an existing profile. New instances remain OAuth by
 * default.
 */
export function shouldUseBasicAuth(argv = {}, cfg = {}, instanceURL = '', targetProfile = null) {
  if (argv.basic || argv.password) return true;
  if (argv.oauth || argv.code || argv.printUrl || argv.browser || argv.gck || argv.headers) return false;
  if (targetProfile) return targetProfile.auth_method === 'basic';
  return Object.values(cfg.profiles || {}).some(profile =>
    profile.instance_url === instanceURL && profile.auth_method === 'basic'
  );
}

export function shouldUseGckAuth(argv = {}, cfg = {}, instanceURL = '', targetProfile = null) {
  if (argv.gck || argv.headers || argv.browser) return true;
  if (argv.basic || argv.password || argv.oauth || argv.code || argv.printUrl) return false;
  if (targetProfile) return targetProfile.auth_method === 'gck';
  return Object.values(cfg.profiles || {}).some(profile =>
    profile.instance_url === instanceURL && profile.auth_method === 'gck'
  );
}

export function validateLoginSelectors(argv = {}, targetProfile = null) {
  const basic = argv.basic === true || argv.password === true;
  const gck = argv.gck === true || argv.headers !== undefined || argv.browser === true;
  const oauth = argv.oauth === true || argv.code !== undefined || argv.printUrl === true || argv.waitFile !== undefined;
  if (oauth && (basic || gck)) throw errUsage('Choose only one authentication method: --oauth, --basic, or --browser/--gck.');
  if (argv.waitFile && !argv.printUrl) throw errUsage('--wait-file requires --print-url.');
  if (argv.code !== undefined && argv.printUrl) throw errUsage('--code cannot be combined with --print-url.');
  if (argv.browserUrl !== undefined && !argv.browser) {
    throw errUsage('--browser-url requires --browser.');
  }
  if (argv.browserName !== undefined && (!argv.browser || argv.browserUrl !== undefined)) {
    throw errUsage('--browser-name requires --browser and cannot be combined with --browser-url.');
  }
  if (argv.browser && (argv.headers !== undefined || argv.code !== undefined || argv.printUrl || argv.waitFile)) {
    throw errUsage('--browser cannot be combined with --headers, --code, --print-url, or --wait-file.');
  }
  if (basic && gck) {
    throw errUsage('Basic and browser-session selectors are mutually exclusive; choose --basic/--password or --gck/--headers.');
  }
  if (basic && targetProfile?.auth_method === 'gck') {
    throw errUsage('This profile is configured for gck authentication; use --gck/--headers or change the profile method.');
  }
  if (gck && targetProfile?.auth_method === 'basic') {
    throw errUsage('This profile is configured for basic authentication; use --basic/--password or change the profile method.');
  }
  if (oauth && targetProfile?.auth_method && targetProfile.auth_method !== 'oauth') {
    throw errUsage(`This profile is configured for ${targetProfile.auth_method} authentication. Use --name to create a separate OAuth profile.`);
  }
}

export async function loginUsingBrowser(app, instance, argv = {}, username) {
  if (argv.browserUrl) return app.auth.loginWithBrowser(instance, { browserUrl: argv.browserUrl }, username);
  const { chooseBrowser } = await import('../browser-launch.js');
  const browser = await chooseBrowser({ browserName: argv.browserName, interactive: canUsePicker(app, argv) });
  return app.auth.loginWithBrowser(instance, {
    launch: true, browser,
    onProgress: message => process.stderr.write(`${message}\n`),
  }, username);
}

/**
 * Pick a profile by name — interactive search picker when ambiguous and a
 * human is available, auto-selects when there's exactly one, throws when
 * none configured. A non-interactive caller (agent, pipe, --json/--get)
 * never opens a picker; it falls back to the single/default profile.
 */
export async function pickProfile(app, message, argv = {}) {
  const { search } = await import('../prompts.js');
  const profileNames = Object.keys(app.config.profiles || {});
  if (profileNames.length === 0) throw errUsage('No profiles configured. Run "jsn setup" first.');
  if (argv.name || argv.profile) {
    const selected = argv.name || argv.profile;
    if (!app.config.profiles[selected]) throw errUsage(`Profile not found: ${selected}`);
    return selected;
  }
  if (profileNames.length === 1) return profileNames[0];
  if (!canUsePicker(app, argv)) throw errUsageHint(`Which profile? ${profileNames.length} profiles are configured: ${profileNames.join(', ')}`, 'Pass --profile <name>, or jsn auth switch <name> to choose a default.');
  const choices = profileNames.map(name => ({
    name,
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
  // Only explicit inputs may pre-fill the wizard. The active/default profile
  // belongs to the existing connection and must not silently become the new
  // instance when setup is adding a profile.
  return process.env.SERVICENOW_INSTANCE_URL || app._overrideInstance || argv.instance || '';
}

export async function readBrowserSessionInput() {
  const stdin = process.stdin;
  console.log('Paste the complete cURL command, then press Ctrl+D:');
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    const chunks = [];
    for await (const chunk of stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString();
  }

  return new Promise((resolve, reject) => {
    let pasted = '';
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdin.removeListener('error', onError);
      process.stdout.write('\n');
    };
    const onError = (err) => { finish(); reject(err); };
    const onData = (chunk) => {
      const text = chunk.toString();
      const eof = text.indexOf('\x04');
      if (eof !== -1) {
        pasted += text.slice(0, eof);
        finish();
        resolve(pasted);
      } else if (text.includes('\x03')) {
        finish();
        reject(new Error('Browser session input cancelled'));
      } else {
        pasted += text;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    stdin.on('error', onError);
  });
}

/** Collect human answers, then call the same login operation as auth login. */
export async function loginWizard(app, argv = {}) {
  const { input, select, confirm, password } = await import('../prompts.js');
  const explicitInstance = resolveWizardInstance(app, argv);
  const instance = resolveInstanceArg(explicitInstance || await input({
    message: 'ServiceNow instance name or URL:',
    validate: value => value.trim() ? true : 'An instance is required',
  }), app.config);
  const name = argv.name || await input({
    message: 'Profile name:', default: suggestedProfileName(instance),
    validate: value => !value.trim() ? 'A profile name is required'
      : app.config.profiles?.[value.trim()] ? 'That profile already exists; choose another name or sign in again.' : true,
  });
  const method = argv.browser ? 'browser' : argv.basic || argv.password ? 'basic' : await select({
    message: 'Authentication method:',
    choices: [
      { name: 'Browser — sign in on this computer', value: 'browser' },
      { name: 'OAuth — authorization code', value: 'oauth' },
      { name: 'Basic — username and password', value: 'basic' },
    ],
  });
  const request = { ...argv, profile: undefined, instance, name: name.trim() };
  if (method === 'browser') request.browser = true;
  if (method === 'oauth') request.oauth = true;
  if (method === 'basic') {
    request.basic = true;
    const username = await input({ message: 'Username:', validate: value => value.trim() ? true : 'A username is required' });
    request._basicCredentials = { username: username.trim(), password: await password({ message: 'Password:' }) };
  }
  const settings = await configureProfileOptions({}, argv, { interactive: true });
  request['read-only'] = settings.read_only;
  request['skip-confirmations'] = settings.skip_confirmations;
  request['include-counts'] = settings.include_counts;
  request.makeDefault = argv.makeDefault ?? await confirm({
    message: 'Use this profile by default?', default: !app.config.defaultProfile,
  });
  const result = await loginProfile(request, app);
  return { instanceURL: instance, profileName: result.profile, loggedIn: result.authenticated };
}

function suggestedProfileName(instance) {
  return instance.replace(/https?:\/\//, '').replace(/\.service-now\.com.*/, '').replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * gh-faithful login target picker: existing profiles plus an "add a new
 * instance" row. Typing filters profiles; picking the ＋ row uses what you
 * typed (or prompts for it).
 *
 * Returns { addNew: true, instanceName } or { addNew: false, name }.
 */
async function pickLoginTarget(app) {
  const { search, input } = await import('../prompts.js');
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
          const label = `${name} — ${app.config.profiles[name].instance_url} ${app.config.profiles[name].username || ''}`.toLowerCase();
          return !filter || label.includes(filter);
        })
        .map((name) => ({
          name: `${name} — ${app.config.profiles[name].instance_url} (${app.config.profiles[name].username || 'account not recorded'})`,
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
  { name: 'Confirm before deleting records', value: 'skip_confirmations', icon: '⚡' },
  { name: 'Include result totals on list commands', value: 'include_counts', icon: '🔢' },
];

/**
 * Modify a profile: toggle a boolean flag, or set/clear the domain.
 * Interactive picker when no flag passed; testable via argv.flag/argv.domain.
 */
export async function modifyProfile(app, argv = {}) {
  argv = profileSettingValues(argv);
  const name = argv.name || argv.profile || await pickProfile(app, 'Modify which profile?', argv);
  const profile = app.config.profiles?.[name];
  if (!profile) throw new Error(`Profile not found: ${name}`);
  const explicitSettings = ['read-only', 'skip-confirmations', 'include-counts'].some(flag => argv[flag] !== undefined);
  if (explicitSettings) {
    if (argv.domain !== undefined) throw errUsage('Set profile preferences and domain separately.');
    const updated = await configureProfileOptions({ ...profile }, argv);
    app.config.profiles[name] = updated;
    await saveConfig(app.config);
    app.ok({ profile: name, read_only: updated.read_only === true, confirm_deletes: updated.skip_confirmations !== true, include_counts: updated.include_counts !== false },
      { summary: `Settings saved for ${name}` });
    return;
  }

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
    const { isDomainSeparationInstalled } = await import('./domains.js');
    const sdk = app.getSDKForProfile
      ? app.getSDKForProfile(profile.instance_url, { profile, authMethod: profile.auth_method, username: profile.username })
      : app.sdk;
    if (!(await isDomainSeparationInstalled({ sdk }))) {
      throw new Error(`Domain separation is not installed on ${profile.instance_url}`);
    }
    const { resolveDomainSysId } = await import('./domains.js');
    const sysID = await resolveDomainSysId({ sdk }, argv.domain);
    profile.domain = sysID;
    await saveConfig(app.config);
    app.ok({ profile: name, domain: sysID }, { summary: `Domain set for ${name}` });
    return;
  }

  let flag = argv.flag;
  let picked = false;
  if (!flag) {
    if (!canUsePicker(app, argv)) throw errUsageHint('Specify the settings to change when noninteractive.', 'Use --read-only, --no-include-counts, or --confirm-deletes.');
    const { select } = await import('../prompts.js');
    const choices = PROFILE_FLAGS.map(f => ({
      name: `${f.icon} ${f.name}: ${(f.value === 'include_counts' ? profile[f.value] !== false : f.value === 'skip_confirmations' ? !profile[f.value] : profile[f.value]) ? 'on' : 'off'}`,
      value: f.value,
    }));
    if (profile.domain_separation) {
      choices.push({
        name: `🌐 Domain: ${profile.domain ? 'set' : 'not set'}`,
        value: 'domain',
      });
    }
    const sdk = app.getSDKForProfile
      ? app.getSDKForProfile(profile.instance_url, { profile, authMethod: profile.auth_method, username: profile.username })
      : app.sdk;
    flag = await select({
      message: `Modify ${name} (${profile.instance_url})`,
      choices,
    });
    picked = true;
    if (flag === 'domain') {
      const domainsMod = await import('./domains.js');
      const installed = await domainsMod.isDomainSeparationInstalled({ sdk });
      if (!installed) {
        throw new Error(`Domain separation is not installed on ${profile.instance_url}`);
      }
      const { confirm } = await import('../prompts.js');
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

  if (picked) {
    const setting = { read_only: 'read-only', skip_confirmations: 'confirm-deletes', include_counts: 'include-counts' }[flag];
    const { confirm } = await import('../prompts.js');
    const value = await confirm({
      message: { read_only: 'Read-only profile (blocks mutation commands)?', skip_confirmations: 'Confirm before deleting records?', include_counts: 'Include result totals on list commands?' }[flag],
      default: flag === 'skip_confirmations' ? !profile[flag] : flag === 'include_counts' ? profile[flag] !== false : !!profile[flag],
    });
    return modifyProfile(app, { name, [setting]: value });
  }

  profile[flag] = flag === 'include_counts' ? profile[flag] === false : !profile[flag];
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
  const profile = app.config.profiles[name];
  const instance = profile.instance_url;
  const otherBareProfiles = Object.entries(app.config.profiles)
    .filter(([profileName, other]) => profileName !== name
      && other.instance_url === instance
      && !other.username)
    .length;
  delete app.config.profiles[name];
  if (app.config.defaultProfile === name) app.config.defaultProfile = '';
  if (app.config.activeProfile === name) app.config.activeProfile = '';
  saveConfig(app.config);
  syncSession(app);

  // Delete only this profile's credential identity. Other profiles may share
  // the instance URL but must retain their separate credentials.
  if (instance && (profile.username || otherBareProfiles === 0)) {
    app.auth.logout(instance, profile.username || null);
  }

  app.ok({ removed: name }, { summary: `Removed profile: ${name}` });
}

/** Bare credentials are safe to clear only when their target is identifiable. */
function canLogoutBareProfile(app, instance, target, explicitlySelected) {
  if (target?.username) return true;
  const sameInstance = Object.entries(app.config.profiles || {})
    .filter(([, profile]) => profile.instance_url === instance);
  if (explicitlySelected) {
    return sameInstance.filter(([, profile]) => !profile.username).length === 1;
  }
  return sameInstance.length <= 1;
}

export async function loginProfile(argv, app) {
  argv = profileSettingValues(argv);
  validateLoginSelectors(argv);
  if (argv.name !== undefined) {
    if (!argv.name.trim()) throw errUsage('--name requires a nonempty profile name.');
    if (argv.profile) throw errUsage('Use --profile to reconnect or --name to create a profile, not both.');
    if (app.config.profiles?.[argv.name]) throw errUsage(`Profile "${argv.name}" already exists. Reconnect with --profile or choose another --name.`);
  }
  let instanceURL;
  let selectedProfileName = argv.profile || (argv.instance && app.config.profiles?.[argv.instance] ? argv.instance : null);
  if (argv.profile) {
    const namedProfile = app.config.profiles?.[argv.profile];
    if (!namedProfile?.instance_url) {
      throw errUsage(`Profile "${argv.profile}" is not configured.`);
    }
    // An explicit profile is authoritative, including in an
    // interactive terminal. Never let the picker retarget it.
    instanceURL = normalizeInstanceURL(namedProfile.instance_url);
  } else if (argv.instance) {
    instanceURL = resolveInstanceArg(argv.instance, app.config);
  } else if (canUsePicker(app, argv)) {
    // gh-faithful: interactive terminals always get a picker —
    // existing profiles plus "＋ Add a new instance". Zero profiles
    // goes straight to the setup wizard.
    const profileNames = Object.keys(app.config.profiles || {});
    if (profileNames.length === 0) {
      return loginWizard(app, argv);
    }
    const target = await pickLoginTarget(app);
    if (target.addNew) {
      return loginWizard(app, { ...argv, instance: resolveInstanceArg(target.instanceName, app.config) });
    } else {
      instanceURL = normalizeInstanceURL(app.config.profiles[target.name].instance_url);
      selectedProfileName = target.name;
    }
  } else {
    instanceURL = getEffectiveInstance(app.config);
    if (!instanceURL) {
      throw errUsage(`Instance URL required.

Examples:
  jsn auth login https://dev12345.service-now.com
  jsn auth login dev373698
  jsn auth login --basic https://dev328604.service-now.com

Find your instance URL in your browser's address bar when logged into ServiceNow.`);
    }
  }

  const matchingProfiles = Object.entries(app.config.profiles || {})
    .filter(([, profile]) => normalizeInstanceURL(profile.instance_url) === instanceURL);
  if (!selectedProfileName && !argv.name && matchingProfiles.length > 1) {
    throw errUsage('Multiple profiles use this instance. Choose the account with: jsn auth login --profile <name>');
  }
  const target = argv.name ? { name: argv.name, profile: null }
    : resolveTargetProfile({ ...argv, profile: selectedProfileName }, app.config, instanceURL);
  const targetProfile = target.profile;
  validateLoginSelectors(argv, targetProfile);
  let targetUsername = targetProfile?.username || '';
  const methodConfig = argv.name ? { profiles: {} } : app.config;
  const useBasic = shouldUseBasicAuth(argv, methodConfig, instanceURL, targetProfile);
  const useGck = shouldUseGckAuth(argv, methodConfig, instanceURL, targetProfile);
  const interactive = canUsePicker(app, argv);
  if (useGck && !argv.browser && !argv.headers && !interactive) {
    throw errUsage('Browser sign-in needs a human. Pass --browser to explicitly open a login window, or supply a captured session.');
  }
  if (!useGck && !useBasic && !argv.printUrl && !argv.code && !interactive) {
    throw errUsage('OAuth login requires --print-url followed by --code <code> when noninteractive.');
  }
  const preliminary = argv.printUrl && !argv.waitFile;
  const preferences = await configureProfileOptions({ ...targetProfile }, argv, {
    interactive: !targetProfile && interactive && !preliminary,
  });
  let setDefault = argv.makeDefault === true;
  if (!targetProfile && argv.makeDefault === undefined && interactive && !preliminary) {
    const { confirm } = await import('../prompts.js');
    setDefault = await confirm({ message: 'Use this profile by default?', default: !app.config.defaultProfile });
  }
  // --basic (with --password as a compatibility alias): authenticate
  // with basic auth from env vars and persist it for this profile.
  if (useGck) {
    const credentials = (argv.browser || (!argv.gck && !argv.headers))
      ? await loginUsingBrowser(app, instanceURL, argv, targetUsername || null)
      : await app.auth.loginWithGck(instanceURL, argv.headers || await readBrowserSessionInput(), targetUsername || null);
    targetUsername = credentials?.username || targetUsername;
  } else if (useBasic) {
    let credentials;
    try {
      credentials = argv._basicCredentials
        ? await app.auth.loginWithPassword(instanceURL, targetUsername || null, argv._basicCredentials)
        : await app.auth.loginWithPassword(instanceURL, targetUsername || null);
    } catch (error) {
      if (!interactive || argv._basicCredentials || error.code !== 'auth_error') throw error;
      const { input, password } = await import('../prompts.js');
      const username = targetUsername || await input({ message: 'Username:', validate: value => value.trim() ? true : 'A username is required' });
      credentials = await app.auth.loginWithPassword(instanceURL, targetUsername || null, {
        username, password: await password({ message: 'Password:' }),
      });
    }
    // A new profile has no configured username yet. The auth
    // manager saves env/stored credentials under creds.username;
    // carry that identity into verification and profile creation.
    targetUsername = credentials?.username || targetUsername;
  }
  // --print-url with --wait-file: print URL and wait for code file
  else if (argv.printUrl && argv.waitFile) {
    await app.auth.buildAuthURL(instanceURL, argv.waitFile, targetUsername || null);
  }
  // --print-url: just print the URL and exit
  else if (argv.printUrl) {
    const authURL = app.auth.buildAuthURL(instanceURL, undefined, targetUsername || null);
    const result = { authorization_url: authURL, instance: instanceURL, profile: target.name || undefined };
    const targetFlag = argv.name ? `--name ${quoteShellArg(argv.name)}` : target.name ? `--profile ${quoteShellArg(target.name)}` : '';
    const settingsFlags = ['read-only', 'skip-confirmations', 'include-counts']
      .filter(flag => argv[flag] !== undefined).map(flag => `--${argv[flag] ? '' : 'no-'}${flag}`);
    if (argv.makeDefault !== undefined) settingsFlags.push(`--${argv.makeDefault ? '' : 'no-'}make-default`);
    app.ok(result, {
      summary: 'Open the authorization URL, then complete login with the returned code.',
      breadcrumbs: [{ action: 'Complete login', cmd: ['jsn auth login', quoteShellArg(instanceURL), targetFlag, '--code <code>', ...settingsFlags].filter(Boolean).join(' '), description: 'Keep the same profile name and settings when exchanging the code' }],
    });
    return result;
  }
  // --code: exchange the provided authorization code directly
  else if (argv.code) {
    await app.auth.loginWithCode(instanceURL, argv.code, targetUsername || null);
  } else {
    // Interactive: full OAuth flow with browser + prompt
    await app.auth.login(instanceURL, targetUsername || null);
  }

  // Verify auth by fetching current user
  let username = '';
  try {
    const activeName = app.config.activeProfile || app.config.defaultProfile;
    const activeProfile = app.config.profiles?.[activeName];
    const activeInstance = app.getEffectiveInstance?.() || activeProfile?.instance_url || '';
    const activeUsername = activeProfile?.username || '';
    const activeMethod = activeProfile?.auth_method || '';
    const targetMethod = useGck ? 'gck' : useBasic ? 'basic' : 'oauth';
    const targetDiffers = instanceURL !== activeInstance
      || targetUsername !== activeUsername
      || targetMethod !== activeMethod;
    if (!app.sdk || targetDiffers) {
      app.sdk = app.getSDKForProfile
        ? app.getSDKForProfile(instanceURL, {
          authMethod: targetMethod,
          username: targetUsername,
          profile: targetProfile,
        })
        : app.sdk;
    }
    const user = await app.sdk.getCurrentUser();
    username = user?.user_name || user?.name || '';
  } catch {
    // Non-fatal — token is saved, just couldn't verify
  }

  // Basic/GCK auth establishes the target identity before the
  // profile exists; preserve it when verification is unavailable.
  username = username || targetUsername;

  // Save to profiles — deduplicate by instance URL
  if (!app.config.profiles) {
    app.config.profiles = {};
  }

  // Preserve an explicitly selected profile even when another profile
  // shares the same instance URL.
  let profileName = target.name;
  if (!profileName) {
    for (const [existingName, existingProfile] of Object.entries(app.config.profiles)) {
      if (existingProfile.instance_url === instanceURL) {
        profileName = existingName;
        break;
      }
    }
  }

  // If no existing profile found, generate a name from the URL
  if (!profileName) {
    profileName = suggestedProfileName(instanceURL);
  }

  app.config.profiles[profileName] = {
    ...(app.config.profiles[profileName] || {}),
    instance_url: instanceURL,
    auth_method: useGck ? 'gck' : useBasic ? 'basic' : 'oauth',
    username: username || undefined,
    read_only: preferences.read_only,
    skip_confirmations: preferences.skip_confirmations,
    include_counts: preferences.include_counts,
  };
  if (!targetProfile && interactive) {
    try {
      const domains = await import('./domains.js');
      const profile = app.config.profiles[profileName];
      const sdk = app.getSDKForProfile
        ? app.getSDKForProfile(instanceURL, { profile, authMethod: profile.auth_method, username: profile.username }) : app.sdk;
      profile.domain_separation = await domains.isDomainSeparationInstalled({ sdk });
      if (profile.domain_separation) {
        const { confirm } = await import('../prompts.js');
        if (await confirm({ message: 'Configure a default domain?', default: false })) profile.domain = await domains.pickDomain({ ...app, sdk });
      }
    } catch (error) {
      if (error.name === 'PromptCancelled') throw error;
      // Capability discovery remains best-effort, as in setup.
    }
  }

  // Re-save OAuth credentials with username now that we have it,
  // so they're keyed by <user>@<instance> for per-user isolation.
  // The legacy bare-instance key is cleaned up behind the
  // AuthManager seam (credential-store internals don't leak here).
  if (!useBasic && username) {
    app.auth.migrateLegacyCredential?.(instanceURL, username);
  }

  if (setDefault) {
    app.config.instanceURL = instanceURL;
    app.config.defaultProfile = profileName;
    app.config.activeProfile = profileName;
  }

  const { saveConfig } = await import('../config.js');
  saveConfig(app.config);
  syncSession(app);

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
  const settings = app.config.profiles[profileName];
  const breadcrumbs = !targetProfile ? [
    {
      action: 'Verify this profile', cmd: `jsn --profile ${quoteShellArg(profileName)} auth status`,
      description: 'Check the account and connection for this profile',
    },
    {
      action: 'Profile settings', cmd: `jsn auth modify ${quoteShellArg(profileName)}`,
      description: `${settings.read_only ? 'read-only' : 'writes allowed'}; ${settings.skip_confirmations ? 'delete confirmations off' : 'confirm deletes'}; counts ${settings.include_counts === false ? 'off' : 'on'}`,
    },
    {
      action: 'New profile flags', cmd: 'jsn auth login <instance> --read-only --no-include-counts',
      description: 'Set these at login; --skip-confirmations disables delete prompts',
    },
  ] : [];
  app.ok(result, { summary, breadcrumbs });
  return result;
}

export async function logoutProfile(argv, app) {
  if (!argv.instance && !argv.profile && canUsePicker(app, argv)) {
    argv = { ...argv, profile: await pickProfile(app, 'Sign out of which profile?', argv) };
  }
  let instanceURL;
  if (argv.profile) {
    instanceURL = app.config.profiles?.[argv.profile]?.instance_url;
    if (!instanceURL) throw errUsage(`Profile not found: ${argv.profile}`);
  } else if (argv.instance) {
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
  const target = resolveTargetProfile(argv, app.config, instanceURL);
  const username = target.profile?.username ?? null;
  if (username || canLogoutBareProfile(app, instanceURL, target.profile, !!argv.profile)) {
    app.auth.logout(instanceURL, username);
  }
  app.ok({ logged_out: true, instance: instanceURL }, { summary: `✓ Logged out from ${instanceURL}` });
}

export async function showAuthStatus(argv, app) {
  const configuredDefault = app.config.profiles?.[app.config.defaultProfile];
  const defaultInstance = configuredDefault?.instance_url || app.config.instanceURL || '';

  // Check environment auth
  const envToken = process.env.SERVICENOW_OAUTH_TOKEN || '';

  const profiles = [];
  const configuredProfiles = Object.entries(app.config.profiles || {});
  const selectedProfiles = argv.profile
    ? configuredProfiles.filter(([name]) => name === argv.profile)
    : configuredProfiles;
  for (const [name, profile] of selectedProfiles) {
    const instance = profile.instance_url;
    const authOptions = { authMethod: profile.auth_method, username: profile.username };
    const identityOptions = { username: profile.username, authMethod: profile.auth_method };
    const isAuth = app.auth.isAuthenticatedFor(instance, identityOptions);
    const lastSeen = app.auth.getLastSeen(instance, identityOptions);
    const authState = app.auth.getAuthState(instance, authOptions);
    const legacy = !isAuth && app.auth.hasLegacyCredentials(instance, identityOptions) ? true : undefined;
    // Keep the established status field contract: unauthenticated
    // profiles omit auth_source, except legacy credentials retain
    // their historical `legacy` marker. getAuthState remains the
    // safe metadata seam for authenticated profiles.
    const authSource = isAuth ? authState.auth_source : (legacy ? 'legacy' : undefined);

    // Try live verification through AuthManager's read-only probe seam.
    let verified = null;
    let verifiedAt = null;
    let probe;
    if (argv.local) {
      probe = { status: 'not_attempted', code: 'not_requested', classification: 'not_checked' };
    } else if (!instance) {
      probe = app.auth.probeUnavailable?.('missing_instance') || { status: 'not_attempted', code: 'missing_instance', classification: 'unavailable' };
    } else {
      try {
        const sdk = app.getSDKForProfile
          ? app.getSDKForProfile(instance, { ...authOptions, profile })
          : app.sdk || { getCurrentUser: async () => null };
        let user;
        probe = await app.auth.probeCurrentUser(instance, {
          getCurrentUser: async (options) => {
            user = await sdk.getCurrentUser(options);
            return user;
          },
        }, authOptions);
        if (probe.status === 'succeeded' && user?.user_name) {
          verified = true;
          verifiedAt = user.user_name;
          if (profile.username && profile.username !== user.user_name) {
            verified = false;
            probe = {
              status: 'failed', code: 'account_mismatch', classification: 'account_mismatch',
              message: 'The session account does not match the configured profile account.',
            };
          }
        } else if (probe.status !== 'not_attempted') {
          verified = false;
        }
      } catch {
        probe = app.auth.probeUnavailable?.('sdk_construction_failed') || { status: 'not_attempted', code: 'sdk_construction_failed', classification: 'configuration_error' };
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
      username: profile.username || undefined,
      active: name === (app.session?.profileName || app.config.activeProfile || app.config.defaultProfile),
      authenticated: isAuth,
      legacy,
      auth_source: authSource,
      verified,
      verified_as: verifiedAt || undefined,
      last_seen: lastSeen || undefined,
      days_since_last_seen: daysSinceLastSeen,
      stale: daysSinceLastSeen > 7,
      default: name === app.config.defaultProfile,
      read_only: profile.read_only || false,
      skip_confirmations: profile.skip_confirmations || false,
      include_counts: profile.include_counts !== false,
      diagnostics: {
        auth_method: authState.auth_method,
        auth_source: authState.auth_source,
        state: authState.state,
        probe,
      },
    });
  }

  const result = {
    default_instance: defaultInstance,
    authenticated: app.auth.isAuthenticated(),
    environment_auth: envToken ? true : undefined,
    profiles,
  };

  const summary = `${profiles.length} ${profiles.length === 1 ? 'profile' : 'profiles'}`;
  // Ship the styled view as _formatted (see renderAuthStatus); the
  // OutputWriter prints it verbatim and suppresses the summary.
  result._formatted = renderAuthStatus(result, summary, { details: argv.details === true });
  if (!argv.details) {
    delete result.default_instance;
    result.profiles = profiles.map(({ instance: _instance, username: _username, verified_as: _verifiedAs, ...visible }) => visible);
  }
  app.ok(result, {
    summary,
    breadcrumbs: [
      { action: 'Switch profile', cmd: 'jsn auth switch <name>', description: 'Choose the default profile' },
      { action: 'Renew session', cmd: 'jsn auth refresh --profile <name>', description: 'Refresh OAuth or sign in again in a browser' },
      { action: 'Change settings', cmd: 'jsn auth modify --profile <name>', description: 'Read-only access, delete confirmations, and counts' },
    ],
  });

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
}

export async function refreshProfile(argv, app) {
  let instanceURL;
  if (argv.profile) {
    instanceURL = app.config.profiles?.[argv.profile]?.instance_url;
    if (!instanceURL) throw errUsage(`Profile not found: ${argv.profile}`);
  } else if (argv.instance) {
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

  const target = resolveTargetProfile(argv, app.config, instanceURL);
  const targetProfile = target.profile;
  if (targetProfile?.auth_method === 'gck') {
    return loginProfile({
      ...argv, instance: instanceURL, profile: target.name,
      browser: argv.browser || (!argv.headers && canUsePicker(app, argv)),
    }, app);
  }
  const targetAuthOptions = {
    authMethod: targetProfile ? targetProfile.auth_method : 'oauth',
    username: targetProfile?.username,
  };
  const creds = await app.auth.getCredentialsFor(
    instanceURL,
    targetProfile?.username,
    { ...targetAuthOptions, refresh: false }
  );
  const refreshed = await app.auth.refreshToken(instanceURL, creds, targetProfile?.username ?? null);

  // Re-probe domain separation on refresh so the capability flag
  // stays in sync if the plugin was installed/removed since setup.
  try {
    const { isDomainSeparationInstalled } = await import('./domains.js');
    const sdk = app.getSDKForProfile
      ? app.getSDKForProfile(instanceURL, {
        ...targetAuthOptions,
        profile: targetProfile,
      })
      : app.sdk;
    const hasDS = await isDomainSeparationInstalled({ sdk });
    const name = target.name || app.config.activeProfile || app.config.defaultProfile;
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
}

export async function switchProfile(argv, app) {
  const name = argv.name || argv.profile || await pickProfile(app, 'Use which profile by default?', argv);
  if (!app.config.profiles?.[name]) throw errUsage(`Profile not found: ${name}`);
  app.config.instanceURL = app.config.profiles[name].instance_url;
  await setActiveProfile(app.config, name);
  syncSession(app);
  app.ok({ active_profile: name }, { summary: `Default profile: ${name}` });
}

export async function removeConnection(argv, app) {
  let name = argv.name;
  if (!name) {
    name = await pickProfile(app, 'Remove which profile?', argv);
  }
  await removeProfile(app, name);
}

export function authCmd(wrap) {
  return {
    command: 'auth [subcommand]',
    describe: 'Manage authentication (OAuth, Basic, or browser session)',
    builder: (yargs) => {
      return yargs
        .command({
          command: 'login [instance]',
          describe: 'Authenticate with a ServiceNow instance (interactive picker when run bare)',
          builder: (sub) => sub
            .option('name', { type: 'string', describe: 'Create a new named profile, including another user on the same instance' })
            .option('make-default', { type: 'boolean', describe: 'Explicitly use this profile by default' })
            .option('oauth', { type: 'boolean', describe: 'Authenticate using OAuth authorization code with PKCE' })
            .option('confirm-deletes', { type: 'boolean', describe: 'Require confirmation before deleting records' })
            .option('code', {
              describe: 'Authorization code from browser (bypasses interactive prompt)',
              type: 'string',
            })
            .option('basic', {
              alias: 'password',
              describe: 'Authenticate with Basic Auth via env vars (SN_USERNAME/SN_PASSWORD)',
              type: 'boolean',
            })
            .option('gck', {
              describe: 'Authenticate with a browser session from pasted request headers',
              type: 'boolean',
            })
            .option('headers', {
              describe: 'Browser request headers or cURL command for browser-session auth',
              type: 'string',
            })
            .option('browser', {
              describe: 'Open a browser and wait for you to log in to ServiceNow',
              type: 'boolean',
            })
            .option('browser-name', {
              describe: 'Browser to launch: chromium, chrome, or edge (otherwise choose an installed browser)',
              type: 'string',
            })
            .option('browser-url', {
              describe: 'Advanced: connect to an existing local debugging URL instead of launching (requires --browser)',
              type: 'string',
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
            })
            .option('skip-confirmations', {
              describe: 'Skip delete confirmations on this profile (deletes run without prompting)',
              type: 'boolean',
            })
            .option('include-counts', {
              describe: 'Include result totals on list commands (default on; pass --no-include-counts to opt out)',
              type: 'boolean',
            }),
          handler: wrap(loginProfile),
        })
        .command({
          command: 'logout [instance]',
          describe: 'Clear stored credentials (keeps the instance entry — use "auth remove" to delete it)',
          handler: wrap(logoutProfile),
        })
        .command({
          command: 'status',
          describe: 'Show authentication status (use --details for users and instance URLs)',
          builder: sub => sub.option('local', {
            type: 'boolean', describe: 'Show saved credential state without contacting any instance',
          }).option('details', {
            type: 'boolean', describe: 'Include users and instance URLs in status output',
          }),
          handler: wrap(showAuthStatus),
        })
        .command({
          command: 'refresh [instance]',
          describe: 'Refresh OAuth credentials or renew a browser session',
          builder: sub => sub
            .option('browser', { type: 'boolean', describe: 'Explicitly open a browser to renew the session' })
            .option('browser-name', { type: 'string', describe: 'Browser to launch: chromium, chrome, or edge' })
            .option('browser-url', { type: 'string', describe: 'Advanced: local browser debugging URL (requires --browser)' })
            .option('headers', { type: 'string', describe: 'Captured browser request headers or cURL command' }),
          handler: wrap(refreshProfile),
        })
        .command({
          command: 'switch [name]',
          describe: 'Choose the profile used by default',
          builder: (sub) => sub
            .positional('name', {
              describe: 'Profile name to activate',
              type: 'string',
            }),
          handler: wrap(switchProfile),
        })
        .command({
          command: 'modify [name]',
          describe: 'Change profile settings (read-only, counts, delete confirmations, domain)',
          builder: (sub) => sub
            .option('read-only', { type: 'boolean', describe: 'Set read-only access (use --no-read-only to allow writes)' })
            .option('include-counts', { type: 'boolean', describe: 'Set result counts (use --no-include-counts to disable)' })
            .option('confirm-deletes', { type: 'boolean', describe: 'Set delete confirmations (use --no-confirm-deletes to disable)' })
            .option('skip-confirmations', { type: 'boolean', describe: 'Compatibility flag: disable delete confirmations' })
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
          handler: wrap(removeConnection),
        });
    },
    handler: wrap(async (_argv, app) => {
      const commands = [
        { name: 'login', description: 'Sign in or add a connection' },
        { name: 'status', description: 'Show authentication and connection status' },
        { name: 'refresh', description: 'Refresh OAuth credentials or renew a browser session' },
        { name: 'switch', description: 'Choose the default profile' },
        { name: 'modify', description: 'Change connection settings' },
        { name: 'logout', description: 'Sign out and keep the profile' },
        { name: 'remove', description: 'Remove a connection and its credentials' },
      ];
      app.ok({
        commands: commands.map(command => command.name),
        _formatted: formatCommandList({ title: 'Manage ServiceNow authentication and connection settings', commands }),
      }, {
        summary: 'Manage ServiceNow authentication and connection settings',
        breadcrumbs: [{ action: 'Guided setup', cmd: 'jsn setup', description: 'Interactive login and connection management' }],
      });
    }),
  };
}
