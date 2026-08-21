import { loginWizard, modifyProfile, removeProfile, pickProfile } from './auth.js';
import { setActiveProfile } from '../config.js';
import { errUsage } from '../errors.js';
import { declareCapabilities } from '../capabilities.js';

// Setup manages local profile config — runs without a configured instance.
// (Not in the daily-check skip-list: legacy behavior checks for updates here.)
declareCapabilities('setup', { noInstance: true });

/** Interactive hub: what do you want to do? Returns 'add' | 'switch' | 'remove' | 'modify'. */
export async function authHubMenu() {
  const { select } = await import('@inquirer/prompts');
  return select({
    message: 'What would you like to do?',
    choices: [
      { name: 'Add a new instance', value: 'add' },
      { name: 'Switch to a different instance', value: 'switch' },
      { name: 'Remove an instance', value: 'remove' },
      { name: 'Modify an instance', value: 'modify' },
    ],
  });
}

/**
 * Dispatch a hub action to the shared operation. Kept separate from the
 * handler so routing is testable without invoking inquirer prompts.
 */
export async function dispatchSetupAction(app, argv, action) {
  if (action === 'add') {
    const result = await loginWizard(app, argv);
    app.ok({ setup: true, ...result }, { summary: 'Setup complete' });
  } else if (action === 'switch') {
    const name = await pickProfile(app, 'Switch to which instance?');
    await setActiveProfile(app.config, name);
    app.ok({ active_profile: name }, { summary: `Active profile: ${name}` });
  } else if (action === 'remove') {
    const name = await pickProfile(app, 'Remove which instance?');
    await removeProfile(app, name);
  } else { // modify
    await modifyProfile(app, argv);
  }
}

// `jsn setup` is the interactive front door for managing instances.
// The granular, scriptable surface lives under `jsn auth` — this command
// dispatches to the SAME functions (loginWizard, setActiveProfile,
// removeProfile, modifyProfile) so the two surfaces can never drift.
export function setupCmd(wrap) {
  return {
    command: 'setup',
    describe: 'Set up and manage your ServiceNow instances (interactive)',
    handler: wrap(async (argv, app) => {
      if (!app.isInteractive()) {
        throw errUsage('"jsn setup" is interactive. Use the specific commands:\n  jsn auth login <instance>\n  jsn auth refresh\n  jsn auth status');
      }
      const profileNames = Object.keys(app.config.profiles || {});
      if (profileNames.length === 0) {
        const result = await loginWizard(app, argv);
        app.ok({ setup: true, ...result }, { summary: 'Setup complete' });
        return;
      }
      const action = await authHubMenu();
      await dispatchSetupAction(app, argv, action);
    }),
  };
}
