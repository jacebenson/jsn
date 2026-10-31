import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { execSync } from 'node:child_process';

import { globalConfigPath } from '../config.js';
import { declareCapabilities } from '../capabilities.js';
import { canUsePicker } from '../helpers.js';

declareCapabilities('skill', { noInstance: true, skipDailyChecks: true });

const SKILL_NAME = 'servicenow';
const SKILL_REPO_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'skills', SKILL_NAME, 'SKILL.md'
);

/**
 * Resolve the user's real home directory, even when Hermes overrides $HOME.
 */
function realHomeDir() {
  // getent doesn't exist on Windows; os.homedir() is reliable there.
  if (process.platform === 'win32') return os.homedir();

  try {
    const result = execSync('getent passwd ' + process.env.USER + ' 2>/dev/null', { encoding: 'utf-8', timeout: 3000 });
    const home = result.trim().split(':')[5];
    if (home) return home;
  } catch {
    // fall through
  }
  return os.homedir();
}

/**
 * Resolve the Hermes profile skill directory.
 * Checks HERMES_PROFILE env var, then scans ~/.hermes/profiles/ for the first
 * profile directory, falling back to ~/.hermes/skills/ (legacy symlink path).
 */
function hermesSkillDir() {
  // JSN_HERMES_BASE_DIR lets tests point at a temp .hermes tree.
  // realHomeDir() deliberately bypasses $HOME (Hermes overrides it to a
  // sandbox dir), so tests can't control the base via HOME.
  const base = process.env.JSN_HERMES_BASE_DIR || path.join(realHomeDir(), '.hermes');
  const profileEnv = process.env.HERMES_PROFILE;
  let profileName = profileEnv;

  if (!profileName) {
    try {
      const profiles = fs.readdirSync(path.join(base, 'profiles'));
      // Pick the first real profile directory (skip . and ..)
      profileName = profiles.find(d => d !== '.' && d !== '..') || null;
    } catch {
      profileName = null;
    }
  }

  if (profileName) {
    return path.join(base, 'profiles', profileName, 'skills', SKILL_NAME);
  }
  return path.join(base, 'skills', SKILL_NAME);
}

// Known agent skill directories (personal/user-level)
// Keyed by agent name for the --target flag
// Each value is the directory for the <name>/SKILL.md file
const AGENT_SKILL_DIRS = {
  hermes: hermesSkillDir(),
  copilot: path.join(realHomeDir(), '.copilot', 'skills', SKILL_NAME),
  vscode: path.join(realHomeDir(), '.copilot', 'instructions', SKILL_NAME),
  claude: path.join(realHomeDir(), '.claude', 'skills', SKILL_NAME),
  cursor: path.join(realHomeDir(), '.cursor', 'rules'),
  agents: path.join(realHomeDir(), '.agents', 'skills', SKILL_NAME),
  opencode: path.join(realHomeDir(), '.config', 'opencode', 'skills', SKILL_NAME),
  openclaw: path.join(realHomeDir(), '.openclaw', 'skills', SKILL_NAME),
  codex: path.join(realHomeDir(), '.codex', 'skills', SKILL_NAME),
};

const TARGET_NAMES = {
  hermes: 'Hermes Agent',
  copilot: 'GitHub Copilot',
  vscode: 'VS Code (Copilot Instructions)',
  claude: 'Claude Code',
  cursor: 'Cursor',
  agents: 'Agents (open standard)',
  opencode: 'OpenCode',
  openclaw: 'OpenClaw',
  codex: 'Codex CLI',
};

function readBundledSkill() {
  try {
    return fs.readFileSync(SKILL_REPO_PATH, 'utf-8');
  } catch {
    return null;
  }
}

// ── Skill config helpers — read/write skillLocation / skillVersion / skillLastChecked ──

function loadSkillConfig() {
  try {
    const raw = fs.readFileSync(globalConfigPath(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveSkillConfig(updates) {
  const cfg = loadSkillConfig();
  Object.assign(cfg, updates);
  fs.mkdirSync(path.dirname(globalConfigPath()), { recursive: true });
  fs.writeFileSync(globalConfigPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function replaceSkill(targetPath, content) {
  const temporary = `${targetPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(temporary, targetPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function recordSkillInstall(targetPaths, content) {
  const version = extractVersion(content) || 'unknown';
  saveSkillConfig({
    skillLocation: targetPaths[0],
    skillLocations: targetPaths,
    skillVersion: version,
    skillLastChecked: new Date().toISOString(),
  });
}

// Compare bytes, including edits that retain the same version number.
export function checkSkill({ warn = true } = {}) {
  const cfg = loadSkillConfig();
  const locations = cfg.skillLocations || (cfg.skillLocation ? [cfg.skillLocation] : []);
  const bundled = readBundledSkill();
  if (bundled === null) return { current: false, error: 'Bundled skill missing; reinstall jsn.' };
  if (!locations.length) return { current: false, note: 'Skill not installed — run "jsn skill install"' };
  const copies = locations.map(location => {
    let installed;
    try { installed = fs.readFileSync(location, 'utf-8'); } catch {
      return { location, current: false, status: 'missing' };
    }
    const current = installed === bundled;
    const actual = installed.split('\n');
    const expected = bundled.split('\n');
    const line = current ? undefined : Array.from({ length: Math.max(actual.length, expected.length) }, (_, i) => i)
      .find(i => actual[i] !== expected[i]) + 1;
    return { location, current, status: current ? 'matching' : 'different',
      installed_version: extractVersion(installed), first_different_line: line };
  });
  const current = copies.every(copy => copy.current);
  if (!current && warn) process.stderr.write('ServiceNow skill differs from the packaged copy. Run "jsn skill check" for locations or "jsn skill install" to replace it.\n');
  saveSkillConfig({ skillLastChecked: new Date().toISOString() });
  return { current, installed_version: copies[0].installed_version,
    bundled_version: extractVersion(bundled), copies };
}

function extractVersion(content) {
  // Matches version in YAML frontmatter (top-level or nested under metadata:)
  const m = (content || '').match(/^\s*version:\s*["']?(.+?)["']?\s*$/m);
  return m ? m[1] : null;
}

// Exported for testing
export { realHomeDir, hermesSkillDir, extractVersion, AGENT_SKILL_DIRS, TARGET_NAMES };

export function skillCmd(wrap) {
  return {
    command: 'skill',
    describe: 'Manage the jsn AI agent skill file (for Hermes, Claude Code, Cursor, etc.)',
    builder: (y) => {
      return y
        .command({
          command: 'show',
          describe: 'Show the bundled skill file content',
          handler: wrap(async (_argv, app) => {
            const content = readBundledSkill();
            if (!content) {
              throw new Error('Skill file not found in package (expected at skills/servicenow/SKILL.md)');
            }
            app.ok({
              content,
              _formatted: content.endsWith('\n') ? content : `${content}\n`,
              bundled: SKILL_REPO_PATH,
            }, {
              summary: 'jsn AI agent skill file (bundled)',
            });
          }),
        })
        .command({
          command: 'check',
          describe: 'Compare installed skill contents with the packaged skill',
          handler: wrap(async (_argv, app) => {
            const result = checkSkill({ warn: false });

            let summary;
            if (result.error) {
              summary = result.error;
            } else if (result.note) {
              summary = result.note;
            } else if (result.current) {
              summary = `✓ Skill contents match the packaged copy (v${result.bundled_version})`;
            } else {
              summary = `⚠ Skill contents differ — run "jsn skill install" to replace installed copies`;
            }

            const details = result.copies?.map(copy => `${copy.status}: ${copy.location}${copy.first_different_line ? ` (first difference: line ${copy.first_different_line})` : ''}`).join('\n');
            app.ok({ ...result, _formatted: [summary, details].filter(Boolean).join('\n') }, { summary });
          }),
        })
        .command({
          command: 'fetch',
          describe: 'Print the packaged skill to stdout (offline)',
          handler: wrap(async (_argv, _app) => {
            const content = readBundledSkill();
            if (content === null) throw new Error('Bundled skill missing; reinstall jsn.');
            process.stdout.write(content);
          }),
        })
        .command({
          command: 'path',
          describe: 'Show skill file locations and install targets',
          handler: wrap(async (_argv, app) => {
            const allPaths = {};
            for (const [key, dir] of Object.entries(AGENT_SKILL_DIRS)) {
              const file = key === 'cursor' ? path.join(dir, `${SKILL_NAME}.mdc`) : path.join(dir, 'SKILL.md');
              allPaths[TARGET_NAMES[key]] = file;
            }

            app.ok({
              bundled: SKILL_REPO_PATH,
              targets: allPaths,
            }, {
              summary: 'Skill file locations and install targets',
              breadcrumbs: [
                { action: 'install', cmd: 'jsn skill install', description: 'Interactive picker for install targets' },
                { action: 'install-all', cmd: 'jsn skill install --target all', description: 'Install to all supported agents' },
                { action: 'install-copilot', cmd: 'jsn skill install --target copilot', description: 'Install for GitHub Copilot' },
                { action: 'install-claude', cmd: 'jsn skill install --target claude', description: 'Install for Claude Code' },
              ],
            });
          }),
        })
        .command({
          command: 'install [dir]',
          describe: 'Install the bundled skill matched to this CLI version',
          builder: (y) => y
            .positional('dir', {
              type: 'string',
              describe: 'Target directory (overrides --target; installs only to this dir)',
            })
            .option('target', {
              type: 'string',
              describe: 'Target agent(s): hermes, copilot, vscode, claude, cursor, agents, opencode, openclaw, codex, or "all" (comma-separated). Omit to replace recorded copies, or choose targets on first install.',
            }),
          handler: wrap(async (argv, app) => {
            const content = readBundledSkill();
            if (!content) {
              throw new Error('Skill file not found in package (expected at skills/servicenow/SKILL.md). Reinstall jsn to restore it.');
            }

            // Resolve target directories
            let targets = [];

            if (argv.dir) {
              // Explicit --dir overrides targets — single install
              const p = path.resolve(argv.dir);
              fs.mkdirSync(p, { recursive: true });
              const targetPath = path.join(p, 'SKILL.md');
              replaceSkill(targetPath, content);
              targets.push({ name: path.basename(argv.dir), path: targetPath });
            } else if (argv.target) {
              // Explicit --target: install to specified agents
              const rawTargets = argv.target.split(',').map(t => t.trim().toLowerCase());
              const all = rawTargets.includes('all');

              for (const [key, dir] of Object.entries(AGENT_SKILL_DIRS)) {
                if (all || rawTargets.includes(key)) {
                  // For cursor, the skill goes in a .mdc file, not a subfolder
                  if (key === 'cursor') {
                    fs.mkdirSync(dir, { recursive: true });
                    const targetPath = path.join(dir, `${SKILL_NAME}.mdc`);
                    replaceSkill(targetPath, content);
                    targets.push({ name: TARGET_NAMES[key], path: targetPath });
                  } else {
                    fs.mkdirSync(dir, { recursive: true });
                    const targetPath = path.join(dir, 'SKILL.md');
                    replaceSkill(targetPath, content);
                    targets.push({ name: TARGET_NAMES[key], path: targetPath });
                  }
                }
              }
            } else if (loadSkillConfig().skillLocation) {
              const cfg = loadSkillConfig();
              for (const targetPath of cfg.skillLocations || [cfg.skillLocation]) {
                fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                replaceSkill(targetPath, content);
                targets.push({ name: targetPath, path: targetPath });
              }
            } else if (canUsePicker(app, argv)) {
              // Interactive: show multi-select picker. canUsePicker() (not a
              // bare stdin TTY check) keeps a PTY allocated for an agent,
              // CI, JSN_NO_PROMPTS, --json/--quiet or --get out of a prompt.
              // Check if any existing installed copies are outdated
              const outdated = [];
              for (const [key, dir] of Object.entries(AGENT_SKILL_DIRS)) {
                  const skillPath = key === 'cursor'
                    ? path.join(dir, `${SKILL_NAME}.mdc`)
                    : path.join(dir, 'SKILL.md');
                  try {
                    const existing = fs.readFileSync(skillPath, 'utf-8');
                    if (existing !== content) {
                      outdated.push(TARGET_NAMES[key]);
                    }
                  } catch {
                    // Not installed — skip
                  }
              }
              const promptMsg = outdated.length > 0
                ? `Where should the jsn skill be installed? (${outdated.length} outdated)`
                : 'Where should the jsn skill be installed?';

              const { checkbox } = await import('../prompts.js');
              const choices = Object.entries(TARGET_NAMES).map(([key, label]) => {
                const dir = AGENT_SKILL_DIRS[key];
                const targetPath = key === 'cursor'
                  ? path.join(dir, `${SKILL_NAME}.mdc`)
                  : path.join(dir, 'SKILL.md');
                // Show tildified path for readability
                const home = realHomeDir();
                const displayPath = targetPath.replace(home, '~');
                return {
                  name: label,
                  value: key,
                  description: displayPath,
                  // Pre-check agents whose skill dirs already exist
                  checked: fs.existsSync(AGENT_SKILL_DIRS[key]),
                };
              });
              const selected = await checkbox({
                message: promptMsg,
                choices,
                instructions: '(space to toggle, enter to confirm)',
              });

              if (selected.length === 0) {
                // Fall back to Hermes if nothing selected
                selected.push('hermes');
              }

              for (const key of selected) {
                const dir = AGENT_SKILL_DIRS[key];
                if (key === 'cursor') {
                  fs.mkdirSync(dir, { recursive: true });
                  const targetPath = path.join(dir, `${SKILL_NAME}.mdc`);
                  replaceSkill(targetPath, content);
                  targets.push({ name: TARGET_NAMES[key], path: targetPath });
                } else {
                  fs.mkdirSync(dir, { recursive: true });
                  const targetPath = path.join(dir, 'SKILL.md');
                  replaceSkill(targetPath, content);
                  targets.push({ name: TARGET_NAMES[key], path: targetPath });
                }
              }
            } else {
              // Non-interactive, no --target: install to Hermes only (backward compat)
              const dir = AGENT_SKILL_DIRS.hermes;
              fs.mkdirSync(dir, { recursive: true });
              const targetPath = path.join(dir, 'SKILL.md');
              replaceSkill(targetPath, content);
              targets.push({ name: TARGET_NAMES.hermes, path: targetPath });
            }

            if (targets.length === 0) {
              throw new Error(`No targets matched. Valid targets: ${Object.keys(AGENT_SKILL_DIRS).join(', ')}, or "all"`);
            }

            // Record install location so checkSkill knows where to look
            recordSkillInstall(targets.map(target => target.path), content);

            const installed = targets.reduce((acc, t) => { acc[t.name] = t.path; return acc; }, {});
            const summary = targets.length === 1
              ? `Skill installed to ${targets[0].path}`
              : `Skill installed to ${targets.length} target(s)`;

            const okOpts = {
              summary,
              breadcrumbs: [
                { action: 'reinstall', cmd: 'jsn skill install', description: 'Replace recorded copies with the packaged skill' },
              ],
            };

            if (targets.length > 1) {
              okOpts.notice = 'Installed to multiple agents. Restart or reload your agent to pick up the skill.';
            }

            app.ok({ installed, from: SKILL_REPO_PATH }, okOpts);
          }),
        });
    },
    handler: () => {
      console.log('Manage the jsn AI agent skill file.');
      console.log('');
      console.log('Available subcommands:');
      console.log('  show       Show the bundled skill file');
      console.log('  fetch      Print the packaged skill (offline)');
      console.log('  check      Show whether installed contents differ');
      console.log('  path       Show skill file locations');
      console.log('  install    Install skill file to agents directory');
      console.log('');
      console.log('Run "jsn skill <command> --help" for details.');
    },
  };
}
