import { declareCapabilities } from '../capabilities.js';
import { resolvePreferences, setPreference, unsetPreference, PREFERENCE_KEYS } from '../preferences.js';
import { errUsageHint } from '../errors.js';

// Preferences are installation settings: no instance is required or contacted.
declareCapabilities('preferences', { noInstance: true, skipContextHeader: true, skipDailyChecks: true });

const HELP = [
  'Precedence: built-in defaults < installation preferences < selected profile preferences.',
  'Installation and profile settings live in the global config; project .servicenow/config.json is never read.',
  '',
  'Examples:',
  '  jsn preferences show',
  '  jsn preferences show --profile production --json',
  '  jsn preferences set operations.delete false',
  '  jsn preferences set testing.methods atf,scan',
  '  jsn preferences set updatesets.initials JB --profile production',
  '  jsn preferences unset updatesets.initials',
  '',
  `Keys: ${PREFERENCE_KEYS.join(', ')}`,
].join('\n');

function activeProfile(argv, app) {
  return argv.profile || app.config.activeProfile || app.config.defaultProfile || '';
}

function summarize({ preferences, sources, profile }) {
  const lines = [`Preferences (${profile ? `profile "${profile}"` : 'installation'}) — precedence: default < installation < profile`];
  const walk = (value, prefix = '') => {
    for (const [key, entry] of Object.entries(value)) {
      const name = prefix ? `${prefix}.${key}` : key;
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) walk(entry, name);
      else lines.push(`  ${name} = ${Array.isArray(entry) ? entry.join(',') : JSON.stringify(entry)}  [${sources[name] || 'default'}]`);
    }
  };
  walk(preferences);
  return lines.join('\n');
}

function show(argv, app) {
  const profile = activeProfile(argv, app);
  const result = resolvePreferences({ profile });
  app.ok(
    { profile: profile || null, preferences: result.preferences, sources: result.sources },
    { summary: summarize(result) },
  );
}

export function preferencesCmd(wrap) {
  return {
    command: 'preferences',
    describe: 'Show or change JSN workflow preferences (operations, testing, update-set naming)',
    summary: 'Configure JSN workflow opinions installation-wide or per profile',
    builder: y => y
      .command({
        command: 'show',
        describe: 'Show effective preferences and where each value came from',
        builder: y2 => y2
          .option('profile', { alias: 'p', type: 'string', describe: 'Show effective values for this profile' }),
        handler: wrap(async (argv, app) => show(argv, app)),
      })
      .command({
        command: 'set <key>',
        describe: 'Set one preference (installation-wide, or --profile for an override)',
        builder: y2 => y2
          .positional('key', { type: 'string', describe: `One of: ${PREFERENCE_KEYS.join(', ')}` })
          .option('value', { type: 'string', describe: 'Value (true/false, comma-separated methods, or text)', demandOption: true })
          .option('profile', { alias: 'p', type: 'string', describe: 'Write a profile override instead of installation settings' }),
        handler: wrap(async (argv, app) => {
          const key = argv.key;
          const value = argv.value;
          if (value === undefined) {
            throw errUsageHint('Missing value.', 'Usage: jsn preferences set <key> <value> [--profile <name>]');
          }
          const profile = argv.profile || '';
          const result = setPreference({ key, value, profile });
          app.ok(
            { key, value: result.preferences, profile: profile || null, preferences: result.preferences, sources: result.sources },
            { summary: `Set ${key} for ${profile ? `profile "${profile}"` : 'this installation'}.\n${summarize(result)}` },
          );
        }),
      })
      .command({
        command: 'unset <key>',
        describe: 'Remove one preference override',
        builder: y2 => y2
          .positional('key', { type: 'string', describe: `One of: ${PREFERENCE_KEYS.join(', ')}` })
          .option('profile', { alias: 'p', type: 'string', describe: 'Remove a profile override instead of installation settings' }),
        handler: wrap(async (argv, app) => {
          const profile = argv.profile || '';
          const result = unsetPreference({ key: argv.key, profile });
          app.ok(
            { key: argv.key, profile: profile || null, preferences: result.preferences, sources: result.sources },
            { summary: `Unset ${argv.key} for ${profile ? `profile "${profile}"` : 'this installation'}.\n${summarize(result)}` },
          );
        }),
      })
      .epilogue(HELP),
    handler: wrap(async (argv, app) => show(argv, app)),
  };
}
