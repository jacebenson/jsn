import { loginWizard, loginProfile, showAuthStatus, switchProfile, modifyProfile, logoutProfile, removeConnection } from './auth.js';
import { errUsageHint } from '../errors.js';
import { declareCapabilities } from '../capabilities.js';

// Setup manages local profile config — runs without a configured instance.
// (Not in the daily-check skip-list: legacy behavior checks for updates here.)
declareCapabilities('setup', { noInstance: true, skipContextHeader: true });

const HUB_CHOICES = [
  { name: 'Add a connection', value: 'add', command: 'jsn auth login <instance> --name <name> --basic' },
  { name: 'Sign in again', value: 'login', command: 'jsn auth login --profile <name> (with the authentication options below)' },
  { name: 'Check connections', value: 'status', command: 'jsn auth status --details --json (use --local to skip instance probes)' },
  { name: 'Choose the default profile', value: 'switch', command: 'jsn auth switch <name>' },
  { name: 'Change settings', value: 'modify', command: 'jsn auth modify --profile <name> --read-only --confirm-deletes --no-include-counts' },
  { name: 'Sign out (keep the profile)', value: 'logout', command: 'jsn auth logout --profile <name> --force (only after explicit approval)' },
  { name: 'Remove a connection', value: 'remove', command: 'jsn auth remove <name>' },
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
].join('\n');

/** The setup hub prompt; q and Escape resolve with no selected action. */
export const authHubPrompt = async (...args) => {
  const { createPrompt, useKeypress, usePagination, useState, isDownKey, isEnterKey, isUpKey } = await import('@inquirer/core');
  return createPrompt((config, done) => {
    const [active, setActive] = useState(0);
    const choices = config.choices;

    useKeypress((key) => {
      if (key.name === 'q' || key.name === 'escape') {
        done(undefined);
        return;
      }
      if (isEnterKey(key)) {
        done(choices[active].value);
        return;
      }
      if (isUpKey(key) && active > 0) setActive(active - 1);
      if (isDownKey(key) && active < choices.length - 1) setActive(active + 1);
    });

    const page = usePagination({
      items: choices,
      active,
      pageSize: choices.length,
      loop: false,
      renderItem: ({ item, isActive }) => `${isActive ? '❯' : ' '} ${item.name}`,
    });
    return `${config.message}\n${page}\n\n↑↓ navigate • ⏎ select • q/Esc exit`;
  })(...args);
};

/** Interactive hub: what do you want to do? Returns an action or undefined on exit. */
export async function authHubMenu({ promptFn = authHubPrompt, input, output } = {}) {
  return promptFn({ message: 'What would you like to do?', choices: HUB_CHOICES }, { input, output });
}

/**
 * Dispatch a hub action to the shared operation. Kept separate from the
 * handler so routing is testable without invoking inquirer prompts.
 */
export async function dispatchSetupAction(app, argv, action) {
  if (action === 'add') {
    return loginWizard(app, argv);
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
  } else if (action === 'modify') {
    return modifyProfile(app, argv);
  }
}

// `jsn setup` is the interactive front door for managing instances.
// The granular, scriptable surface lives under `jsn auth` — this command
// collects choices and dispatches to the same auth operations.
export function setupCmd(wrap) {
  return {
    command: 'setup',
    describe: 'Set up and manage your ServiceNow instances (interactive)',
    builder: y => y.epilogue(setupHelp()),
    handler: wrap(async (argv, app) => {
      const { canUsePicker } = await import('../helpers.js');
      if (!app.isInteractive() || !canUsePicker(app, argv)) {
        throw errUsageHint('"jsn setup" is interactive. Use explicit auth commands instead.', setupHelp());
      }
      const profileNames = Object.keys(app.config.profiles || {});
      if (profileNames.length === 0) {
        const result = await loginWizard(app, argv);
        await showAuthStatus({ ...argv, profile: result.profileName }, app);
        return;
      }
      const action = await authHubMenu();
      if (action === undefined) return;
      const result = await dispatchSetupAction(app, argv, action);
      if (action !== 'status') await showAuthStatus({ ...argv, profile: result?.profile || result?.profileName }, app);
    }),
  };
}
