import { configureGlobalDefaults, configureDocumentation, connectionPreferences } from '../setup-preferences.js';
import { deferredFamilyDefinition } from '../command-families.js';
import { saveConfig } from '../config.js';
import { select } from '../prompts.js';
import { loginWizard, loginProfile, showAuthStatus, switchProfile, modifyProfile, logoutProfile, removeConnection } from './auth.js';
import { errUsageHint } from '../errors.js';

// Setup manages local profile config — runs without a configured instance.
// (Not in the daily-check skip-list: legacy behavior checks for updates here.)

const HUB_CHOICES = [
  { section: 'Connections', name: 'Check connections', value: 'status', command: 'jsn auth status --details --json (use --local to skip instance probes)' },
  { section: 'Connections', name: 'Choose default connection', value: 'switch', command: 'jsn auth switch <name>' },
  { section: 'Connections', name: 'Add a connection', value: 'add', command: 'jsn auth login <instance> --name <name> --basic' },
  { section: 'Connections', name: 'Sign in again', value: 'login', command: 'jsn auth login --profile <name> (with the authentication options below)' },
  { section: 'Connections', name: 'Change connection settings', value: 'modify', command: 'jsn auth modify --profile <name> --read-only --confirm-deletes --no-include-counts' },
  { section: 'JSN settings', name: 'Defaults and documentation', value: 'advanced', command: 'jsn setup' },
  { section: 'Cleanup', name: 'Sign out (keep connection)', value: 'logout', command: 'jsn auth logout --profile <name> --force (only after explicit approval)' },
  { section: 'Cleanup', name: 'Remove a connection', value: 'remove', command: 'jsn auth remove <name>' },
];

const setupHelp = () => [
  'With no profiles, setup opens the add-connection wizard; otherwise it opens the management menu.',
  'The wizard and these scriptable commands share the same authentication and configuration operations:',
  ...HUB_CHOICES.map(choice => `  ${choice.name}: ${choice.command}`),
  '',
  'Authentication input without secrets in command arguments:',
  '  Basic: set SN_USERNAME and SN_PASSWORD through your environment, then use --basic.',
  '  OAuth: jsn auth login <instance> --name <name> --oauth --print-url --wait-file <code-file> --json',
  '  Browser session: jsn auth login <instance> --name <name> --headers-file <session-file> --json',
  '  Piped browser session: jsn auth login <instance> --name <name> --headers-file - --json',
  '  A browser window can also be requested explicitly with --browser; it requires a human to sign in.',
  '  Refresh OAuth: jsn auth refresh --profile <name>',
  '  Renew captured browser headers: jsn auth refresh --profile <name> --headers-file <session-file>',
  '',
  'New-profile preferences: --read-only, --confirm-deletes, --include-counts and --make-default.',
  'Use --no-read-only, --no-confirm-deletes, --no-include-counts or --no-make-default for the opposite value.',
  'Use --json for structured output. Explicit flags avoid implicit pickers; ambiguous targets return an error.',
  'Discover all options with jsn auth <command> --help.',
  'Configure settings directly: jsn setup --configure-defaults or jsn setup --configure-docs.',
].join('\n');

/** The setup hub shares searchable local menus; Escape leaves the hub. */
export const authHubPrompt = async (config = {}, context = {}) => {
  const { select, escapeResult } = await import('../prompts.js');
  return select({ ...config, escapeValue: escapeResult(undefined) }, context);
};

/** Interactive hub: what do you want to do? Returns an action or undefined on exit. */
export async function authHubMenu({ promptFn = authHubPrompt, input, output, hasProfiles = true } = {}) {
  const choices = hasProfiles ? HUB_CHOICES : HUB_CHOICES.filter(choice => ['add', 'advanced'].includes(choice.value));
  return promptFn({ message: 'What would you like to do?', choices }, { input, output });
}

/**
 * Dispatch a hub action to the shared operation. Kept separate from the
 * handler so routing is testable without invoking inquirer prompts.
 */
export async function dispatchSetupAction(app, argv, action) {
  if (action === 'add') {
    return loginWizard(app, argv, { concise: true });
  } else if (action === 'login') {
    return loginProfile(argv, app);
  } else if (action === 'status') {
    return showAuthStatus(argv, app);
  } else if (action === 'switch') {
    return switchProfile(argv, app);
  } else if (action === 'logout') {
    return logoutProfile(argv, app);
  } else if (action === 'remove') {
    return removeConnection(argv, app);
  } else if (action === 'advanced') {
    const setting = await select({ message: 'JSN settings', choices: [
      { name: 'Defaults for future connections', value: 'defaults' },
      { name: 'Documentation source', value: 'docs' },
      { name: 'Back', value: 'back' },
    ] });
    if (setting === 'defaults') await configureGlobalDefaults(app.config, { documentation: false });
    if (setting === 'docs') await configureDocumentation(app.config);
    if (setting !== 'back') app.ok({ settings: setting }, { summary: 'Settings saved; existing connections unchanged' });
  } else if (action === 'modify') {
    return modifyProfile(app, argv);
  }
}

// `jsn setup` is the interactive front door for managing instances.
// The granular, scriptable surface lives under `jsn auth` — this command
// collects choices and dispatches to the same auth operations.
export function setupCmd(wrap) {
  return {
    ...deferredFamilyDefinition('setup'),
    builder: y => y.option('docs-source', { type: 'string', choices: ['snapshot', 'github', 'skip'], describe: 'Install optional documentation directly without the authentication wizard' })
      .option('configure-defaults', { type: 'boolean', describe: 'Configure defaults for future connections without the hub' })
      .option('configure-docs', { type: 'boolean', describe: 'Configure documentation without the hub' }).epilogue(setupHelp()),
    handler: wrap(async (argv, app) => {
      if (argv['docs-source']) {
        const { installDocumentation } = await import('./docs/install.js');
        app.ok(await installDocumentation(argv['docs-source']));
        return;
      }
      if (argv['configure-defaults'] || argv['configure-docs']) {
        if (argv['configure-defaults']) await configureGlobalDefaults(app.config, { documentation: false });
        if (argv['configure-docs']) await configureDocumentation(app.config);
        app.ok({ settings: true }, { summary: 'Settings saved; existing connections unchanged' });
        return;
      }
      const { canUsePicker } = await import('../helpers.js');
      if (!app.isInteractive() || !canUsePicker(app, argv)) {
        throw errUsageHint('"jsn setup" is interactive. Use explicit auth commands instead.', setupHelp());
      }
      const profileNames = Object.keys(app.config.profiles || {});
      const firstSetup = !app.config.connectionDefaults;
      if (firstSetup) {
        app.config.connectionDefaults = connectionPreferences(app.config);
        await saveConfig(app.config);
      }
      if (profileNames.length === 0 && firstSetup) {
        await loginWizard(app, argv, { concise: true });
        return;
      }
      const action = await authHubMenu({ hasProfiles: profileNames.length > 0 });
      if (action === undefined) return;
      const result = await dispatchSetupAction(app, argv, action);
      if (!['add', 'status', 'advanced'].includes(action)) await showAuthStatus({ ...argv, profile: result?.profile || result?.profileName }, app);
    }),
  };
}
