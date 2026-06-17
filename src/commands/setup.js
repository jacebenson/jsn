import readline from 'node:readline';
import { getEffectiveInstance, normalizeInstanceURL, saveConfig, setProfile } from '../config.js';

export function setupCmd(wrap) {
  return {
    command: 'setup',
    describe: 'Interactive first-time setup',
    builder: (yargs) => {
      return yargs
        .option('read-only', {
          describe: 'Mark profile as read-only (blocks mutation commands)',
          type: 'boolean',
          default: false,
        });
    },
    handler: wrap(async (_argv, app) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

      console.log('Welcome to JSN - ServiceNow CLI');
      console.log();

      let instance = getEffectiveInstance(app.config);
      if (!instance) {
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
      if (_argv['read-only']) {
        profile.read_only = true;
      }

      const authMethod = await ask('Authentication method (OAuth/Basic) [OAuth]: ');
      const useBasic = authMethod.toLowerCase().startsWith('b');

      if (useBasic) {
        const username = await ask('Username: ');
        rl.close(); // Close outer readline before askHidden creates its own
        const { loadCredentials, askHidden } = await import('../auth.js');
        const existing = loadCredentials(instance) || loadCredentials(instance, username);
        if (existing && existing.auth_method === 'basic') {
          console.log(`Using existing credentials for ${instance}`);
        } else {
          const password = await askHidden('Password: ');
          const { saveCredentials } = await import('../auth.js');
          saveCredentials(instance, { auth_method: 'basic', username, password }, username);
          profile.username = username;
          console.log('Basic auth credentials saved');
        }
        profile.auth_method = 'basic';
      } else {
        profile.auth_method = 'oauth';
      }

      await setProfile(app.config, profileName, profile);
      // Set as active profile so subsequent commands know which instance to use
      app.config.activeProfile = profileName;
      app.config.defaultProfile = profileName;
      saveConfig(app.config);

      if (!useBasic) {
        const loginNow = await ask('Login now? [Y/n]: ');
        if (!loginNow || loginNow.toLowerCase() !== 'n') {
          await app.auth.login(instance);
          // Re-save credentials under <user>@<instance> after verifying username
          try {
            const { SDKClient } = await import('./sdk.js');
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
        }
      }

      rl.close();
      app.ok({ setup: true, instance, profile: profileName }, { summary: 'Setup complete' });
    }),
  };
}
