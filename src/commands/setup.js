import { loginWizard } from './auth.js';

// `jsn setup` is kept as a hidden compatibility alias for `jsn auth login`.
// The wizard lives in auth.js (loginWizard) so there is exactly ONE code path
// for first-run onboarding — this command can never drift out of sync.
export function setupCmd(wrap) {
  return {
    command: 'setup',
    describe: 'Interactive first-time setup (use "jsn auth login")',
    hidden: true, // legacy alias for `jsn auth login` — works but hidden from help
    builder: (yargs) => {
      return yargs
        .option('read-only', {
          describe: 'Mark profile as read-only (blocks mutation commands)',
          type: 'boolean',
          default: false,
        });
    },
    handler: wrap(async (argv, app) => {
      console.log('Note: "jsn setup" is now "jsn auth login". Running the same wizard...\n');
      const result = await loginWizard(app, argv);
      app.ok({ setup: true, ...result }, { summary: 'Setup complete' });
    }),
  };
}
