// First-run welcome (issue #387).
//
// A brand-new install that runs bare `jsn` gets grouped help, which assumes
// the reader already knows what to do with it. This adds a short orientation
// above that help, exactly once, only when a human is reading it.
//
// Invariants (see docs/DECISIONS.md):
//   - at most once: a marker file in the XDG config dir records that the note
//     was shown, so it never returns;
//   - human terminal only: no --json/--quiet/--csv/--markdown/--get, no piped
//     output, no agent/CI environments;
//   - never instead of help: the grouped help below it is unchanged;
//   - never an instance or auth operation: the note only points at `jsn setup`,
//     so it cannot block setup or require credentials;
//   - not shown to an already-configured installation (profiles exist).

import fs from 'node:fs';
import path from 'node:path';
import { globalConfigDir } from './config.js';
import { canPrompt } from './helpers.js';

/** Marker file in the XDG config dir. Presence means "already welcomed". */
export const WELCOME_MARKER = '.welcomed';

const HUMAN_FORMATS = new Set(['', 'auto', 'styled']);

/**
 * The orientation text. Kept deliberately short: it must fit above the grouped
 * help without pushing it off the first screen.
 *
 * @returns {string}
 */
export function welcomeText() {
  return [
    'Welcome to jsn — ServiceNow from your terminal.',
    '',
    '  Next steps',
    '    jsn setup                  connect an instance (interactive)',
    '    jsn --help                 the full command list',
    '    jsn docs search <query>    search ServiceNow documentation',
    '',
    '  Nothing above needs an instance. jsn asks for credentials only when a',
    '  command has to reach ServiceNow. This note appears once.',
  ].join('\n');
}

/**
 * Marker path for a given config dir (injectable for tests).
 *
 * @param {string} [configDir]
 * @returns {string}
 */
export function welcomeMarkerPath(configDir = globalConfigDir()) {
  return path.join(configDir, WELCOME_MARKER);
}

/**
 * Decide whether this invocation may show the first-run welcome.
 *
 * Pure except for the marker existence check, so callers and tests can pass
 * every input explicitly.
 *
 * @param {object} [opts]
 * @param {object} [opts.argv] — parsed args (for `--get` and global format flags)
 * @param {string} [opts.requestedFormat] — format resolved from the same argv
 * @param {object} [opts.cfg] — loaded profile config
 * @param {object} [opts.env] — environment (defaults to process.env)
 * @param {string} [opts.configDir] — config dir holding the marker
 * @param {boolean} [opts.interactive] — a human is reachable (defaults to canPrompt())
 * @returns {boolean}
 */
export function shouldShowWelcome({
  argv = {},
  requestedFormat = '',
  cfg = {},
  env = process.env,
  configDir = globalConfigDir(),
  interactive = canPrompt(),
} = {}) {
  if (env.JSN_NO_WELCOME === '1') return false;
  // Machine-readable output and one-shot extraction never get prose.
  if (!HUMAN_FORMATS.has(requestedFormat || '')) return false;
  if (argv && argv.get) return false;
  if (!interactive) return false;
  // An installation that already has a connection is not a first run. Profiles
  // are the durable record of that (an env-provided instance URL is momentary).
  if (cfg && (Object.keys(cfg.profiles || {}).length > 0 || cfg.defaultProfile)) return false;
  try {
    if (fs.existsSync(welcomeMarkerPath(configDir))) return false;
  } catch {
    // Unreadable config dir: showing the note once more is harmless.
  }
  return true;
}

/**
 * Record that the welcome was shown. Failure is non-fatal — the worst case is
 * the note appearing again, which must never break the command line that
 * triggered it.
 *
 * @param {string} [configDir]
 * @returns {boolean} true when the marker was written
 */
export function markWelcomeSeen(configDir = globalConfigDir()) {
  try {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o750 });
    fs.writeFileSync(welcomeMarkerPath(configDir), `${new Date().toISOString()}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Show the welcome (above the caller's own help output) when this is a first
 * run, then record it. Returns the text that was shown, or '' when nothing was.
 *
 * @param {object} [opts] — same inputs as shouldShowWelcome
 * @returns {string}
 */
export function maybeShowWelcome(opts = {}) {
  if (!shouldShowWelcome(opts)) return '';
  const configDir = opts.configDir || globalConfigDir();
  markWelcomeSeen(configDir);
  const text = welcomeText();
  process.stdout.write(`${text}\n\n`);
  return text;
}
