import { createPrompt, useKeypress, usePagination, useState, isDownKey, isEnterKey, isUpKey } from '@inquirer/core';
import { loginWizard, loginProfile, showAuthStatus, switchProfile, modifyProfile, logoutProfile, removeConnection } from './auth.js';
import { errUsage } from '../errors.js';
import { declareCapabilities } from '../capabilities.js';

// Setup manages local profile config — runs without a configured instance.
// (Not in the daily-check skip-list: legacy behavior checks for updates here.)
declareCapabilities('setup', { noInstance: true, skipContextHeader: true });

const HUB_CHOICES = [
  { name: 'Add a connection', value: 'add' },
  { name: 'Sign in again', value: 'login' },
  { name: 'Check connections', value: 'status' },
  { name: 'Choose the default profile', value: 'switch' },
  { name: 'Change settings', value: 'modify' },
  { name: 'Sign out (keep the profile)', value: 'logout' },
  { name: 'Remove a connection', value: 'remove' },
];

/** The setup hub prompt; q and Escape resolve with no selected action. */
export const authHubPrompt = createPrompt((config, done) => {
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
});

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
    handler: wrap(async (argv, app) => {
      const { canUsePicker } = await import('../helpers.js');
      if (!app.isInteractive() || !canUsePicker(app, argv)) {
        throw errUsage('"jsn setup" is interactive. Use the specific commands:\n  jsn auth login <instance>\n  jsn auth refresh\n  jsn auth status');
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
