// First-run welcome (issue #387).
//
// A brand-new install gets a compact front door instead of the command catalog,
// exactly once, only when a human is reading it.
//
// Invariants (see docs/DECISIONS.md):
//   - at most once: a marker file in the XDG config dir records that the note
//     was shown, and it is created exclusively so two racing first runs cannot
//     both print it;
//   - human terminal only: no --json/--quiet/--csv/--markdown/--get, no piped
//     output, no agent/CI environments;
//   - explicit help stays comprehensive; the first-run front door stands alone;
//   - never an instance or auth operation: the note only points at local and
//     interactive commands, so it cannot block setup or require credentials;
//   - nothing on this path reaches the network, prompts, or reads an instance;
//   - not shown to an already-configured installation (profiles exist);
//   - plain ASCII at every width, so NO_COLOR, TERM=dumb and narrow terminals
//     all read the same thing.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { globalConfigDir } from './config.js';
import { canPrompt } from './helpers.js';
import { getVersion } from './commands/version.js';

/** Marker file in the XDG config dir. Presence means "already welcomed". */
export const WELCOME_MARKER = '.welcomed';

/** Line budget for the note at 80 columns (issue #387 hard limit). */
export const WELCOME_MAX_LINES = 12;

/** The note never uses more than this many columns, however wide the terminal. */
const MAX_WIDTH = 80;

/** Below this, descriptions and prose get one word per line; commands never split. */
const MIN_WIDTH = 24;

const HUMAN_FORMATS = new Set(['', 'auto', 'styled']);

/** One obvious next action, plus secondary discovery; no command catalog. */
const STEPS = [
  { command: 'jsn setup', detail: 'connect to ServiceNow' },
  { command: 'jsn --help', detail: 'every command and flag' },
];

/**
 * Resolve the terminal width this note may use. Absent or nonsense columns
 * fall back to 80, so a non-interactive writer still gets the documented
 * layout.
 *
 * @param {number|undefined} columns
 * @returns {number}
 */
function layoutWidth(columns) {
  const numeric = Number(columns);
  if (!Number.isFinite(numeric) || numeric <= 0) return MAX_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(numeric)));
}

/**
 * Greedy word wrap that never truncates: a word longer than the width is left
 * whole on its own line rather than cut. Command names are passed with
 * `atomic: true` and are never split at all.
 *
 * @param {string} text
 * @param {number} width
 * @param {string} [indent]
 * @returns {string[]}
 */
function wrapText(text, width, indent = '') {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = `${indent}${word}`;
      continue;
    }
    if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
      continue;
    }
    lines.push(current);
    current = `${indent}${word}`;
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Candidate labels for "where config lives". The first honest label that fits
 * the width wins, so a long XDG path is replaced by the switch that produced
 * it rather than pushed off the screen.
 *
 * @param {object} env
 * @param {string} configDir
 * @returns {string[]}
 */
function configLabels(env, configDir) {
  const home = os.homedir();
  const replaceHome = (value) => (home && value.startsWith(`${home}${path.sep}`)
    ? `~${value.slice(home.length)}`
    : value);
  const labels = [`Config: ${replaceHome(path.join(configDir, 'config.json'))}`];
  if (env.XDG_CONFIG_HOME) labels.push('Config: $XDG_CONFIG_HOME/servicenow/config.json');
  labels.push('Config: ~/.config/servicenow/config.json');
  return [...new Set(labels)];
}

/**
 * Render the "Next steps" block. A wide terminal gets command and description
 * on one aligned row; a narrow one puts the description underneath, indented,
 * so the command name is always intact.
 *
 * @param {number} width
 * @returns {string[]}
 */
function renderSteps(width, steps = STEPS) {
  const commandWidth = Math.max(...steps.map((step) => step.command.length));
  const alignedColumn = 4 + commandWidth + 2;
  const oneLine = steps.every((step) => alignedColumn + step.detail.length <= width);
  const lines = [];
  for (const step of steps) {
    if (oneLine) {
      lines.push(`    ${step.command.padEnd(commandWidth)}  ${step.detail}`);
      continue;
    }
    lines.push(`    ${step.command}`);
    lines.push(...wrapText(step.detail, width, '      '));
  }
  return lines;
}

/**
 * The orientation text. Kept short: it stands alone on the first screen
 * instead of the command catalog, and stays inside 12 lines at 80
 * columns.
 *
 * Everything shown is derived from local state: the version comes from the
 * installed package.json, the config path from the same resolution the CLI
 * uses, and the update command from the version's release channel. No network.
 *
 * @param {object} [opts]
 * @param {number} [opts.columns] — terminal width (defaults to process.stdout.columns)
 * @param {object} [opts.env] — environment (defaults to process.env)
 * @param {string} [opts.configDir] — config dir the marker lives in
 * @param {string} [opts.version] — installed version (defaults to package.json)
 * @returns {string[]} lines
 */
export function welcomeLines({
  columns = process.stdout?.columns,
  env = process.env,
  configDir = globalConfigDir(),
  version = getVersion(),
} = {}) {
  const width = layoutWidth(columns);
  const labels = configLabels(env, configDir);
  const configLabel = labels.find((label) => label.length <= width)
    || labels.reduce((shortest, label) => (label.length < shortest.length ? label : shortest));
  const title = version && version !== '0.0.0'
    ? `Welcome to jsn ${version} (ServiceNow from your terminal)`
    : 'Welcome to jsn (ServiceNow from your terminal)';
  return [
    ...wrapText(title, width),
    ...wrapText(configLabel, width),
    '',
    '  Get started',
    ...renderSteps(width),
  ];
}

/**
 * The orientation text as a single string (no trailing newline).
 *
 * @param {object} [opts] — same inputs as welcomeLines
 * @returns {string}
 */
export function welcomeText(opts = {}) {
  return welcomeLines(opts).join('\n');
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
 * `JSN_NO_WELCOME` is honoured only as the literal value `1`; `0`, an empty
 * value and an unset variable all mean "normal first-run behavior".
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
 * Exclusively record that the welcome was shown.
 *
 * Two first runs racing on the same config dir must not both print the note
 * and must never leave a half-written marker, so the marker is created by
 * hard-linking a fully written temp file: `link(2)` fails with EEXIST for every
 * process but the winner, and the marker path only ever points at complete
 * content.
 *
 * @param {string} [configDir]
 * @returns {'claimed'|'taken'|'unwritable'} — 'taken' means another process
 *   already recorded (or recorded concurrently) the note.
 */
export function claimWelcome(configDir = globalConfigDir()) {
  const marker = welcomeMarkerPath(configDir);
  const temp = `${marker}.${process.pid}.tmp`;
  const stamp = `${new Date().toISOString()} pid=${process.pid}\n`;
  try {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o750 });
    fs.writeFileSync(temp, stamp, { mode: 0o600 });
  } catch {
    // A read-only or missing config dir must not break the command; the note
    // may be shown again on the next run.
    try { fs.unlinkSync(temp); } catch { /* never created */ }
    return 'unwritable';
  }
  try {
    fs.linkSync(temp, marker);
    return 'claimed';
  } catch (err) {
    if (err && err.code === 'EEXIST') return 'taken';
    // Filesystems without hard links: exclusive create is still a single
    // winner, it just cannot guarantee the marker appears complete.
    try {
      fs.writeFileSync(marker, stamp, { flag: 'wx', mode: 0o600 });
      return 'claimed';
    } catch (fallbackError) {
      if (fallbackError && fallbackError.code === 'EEXIST') return 'taken';
      return 'unwritable';
    }
  } finally {
    try { fs.unlinkSync(temp); } catch { /* already gone */ }
  }
}

/**
 * Boolean form of claimWelcome for callers that only need "did this process
 * record the note".
 *
 * @param {string} [configDir]
 * @returns {boolean}
 */
export function markWelcomeSeen(configDir = globalConfigDir()) {
  return claimWelcome(configDir) === 'claimed';
}

/**
 * Every human bare invocation gets a local-only home. The legacy welcome
 * marker controls only the greeting, never whether the catalog is selected.
 */
export function maybeShowHome({ argv = {}, requestedFormat = '', cfg = {}, env = process.env,
  configDir = globalConfigDir(), interactive = canPrompt(), columns = process.stdout?.columns } = {}) {
  if (env.JSN_NO_WELCOME === '1' || !interactive || argv.get || !HUMAN_FORMATS.has(requestedFormat || '')) return '';
  const width = layoutWidth(columns);
  const selected = cfg.activeProfile || cfg.defaultProfile;
  const profile = selected && cfg.profiles?.[selected] ? selected : undefined;
  const steps = profile ? [
    { command: 'jsn incidents list', detail: 'browse incidents' },
    { command: 'jsn setup', detail: 'manage connections' },
    { command: 'jsn --help', detail: 'every command and flag' },
  ] : STEPS;
  const greeting = shouldShowWelcome({ argv, requestedFormat, cfg, env, configDir, interactive })
    && claimWelcome(configDir) !== 'taken';
  const heading = profile ? `Profile: ${profile}` : greeting ? 'Welcome to jsn' : 'Get started';
  const text = [...wrapText(heading, width), '', ...renderSteps(width, steps)].join('\n');
  process.stdout.write(`${text}\n\n`);
  return text;
}

/** Legacy once-only note API; bare CLI discovery uses maybeShowHome. */
export function maybeShowWelcome(opts = {}) {
  if (!shouldShowWelcome(opts)) return '';
  const configDir = opts.configDir || globalConfigDir();
  if (claimWelcome(configDir) === 'taken') return '';
  const text = welcomeText({ ...opts, configDir });
  process.stdout.write(`${text}\n\n`);
  return text;
}
