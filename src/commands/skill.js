import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { execSync } from 'node:child_process';

import { globalConfigPath } from '../config.js';

const SKILL_NAME = 'servicenow';
const SKILL_REPO_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'skills', SKILL_NAME, 'SKILL.md'
);

const SKILL_RAW_URL = 'https://raw.githubusercontent.com/jacebenson/jsn/main/skills/servicenow/SKILL.md';

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

function recordSkillInstall(targetPath) {
  const bundled = readBundledSkill();
  const version = extractVersion(bundled) || 'unknown';
  saveSkillConfig({
    skillLocation: targetPath,
    skillVersion: version,
    skillLastChecked: new Date().toISOString(),
  });
}

// ── Skill version check (once per day, uses recorded location) ──

export function checkSkill() {
  const cfg = loadSkillConfig();
  const location = cfg.skillLocation;
  if (!location) return { current: true, note: 'Skill not installed — run "jsn skill install"' };

  // Throttle: skip if checked within last 24 hours
  if (cfg.skillLastChecked) {
    const elapsed = Date.now() - new Date(cfg.skillLastChecked).getTime();
    if (elapsed < 86400000) return { current: true, note: 'Checked within 24h — skipping' };
  }

  let installed;
  try {
    installed = fs.readFileSync(location, 'utf-8');
  } catch {
    return { current: true, note: `Skill file not found at ${location} — run "jsn skill install"` };
  }

  const installedVersion = extractVersion(installed);
  const bundled = readBundledSkill();
  const bundledVersion = extractVersion(bundled);

  if (!installedVersion || !bundledVersion) {
    return { current: true, error: 'Could not determine skill version' };
  }

  const current = installedVersion === bundledVersion;

  if (!current) {
    process.stderr.write(
      `\n⚠ jsn: ServiceNow skill is outdated (installed v${installedVersion}, bundled v${bundledVersion}).\n` +
      `  Run "jsn skill install" to update.\n\n`
    );
  }

  // Update last-checked timestamp
  saveSkillConfig({ skillLastChecked: new Date().toISOString() });

  return { current, installed_version: installedVersion, bundled_version: bundledVersion };
}

function extractVersion(content) {
  // Matches version in YAML frontmatter (top-level or nested under metadata:)
  const m = content.match(/^\s*version:\s*["']?(.+?)["']?\s*$/m);
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
              bundled: SKILL_REPO_PATH,
            }, {
              summary: 'jsn AI agent skill file (bundled)',
            });
          }),
        })
        .command({
          command: 'check',
          describe: 'Check if the installed skill matches the bundled version',
          handler: wrap(async (_argv, app) => {
            const result = checkSkill();

            let summary;
            if (result.error) {
              summary = result.error;
            } else if (result.note) {
              summary = result.note;
            } else if (result.current) {
              summary = `✓ Skill is current (v${result.installed_version} matches bundled v${result.bundled_version})`;
            } else {
              summary = `⚠ Skill outdated: installed v${result.installed_version} vs bundled v${result.bundled_version} — run "jsn skill install" to update`;
            }

            app.ok(result, { summary });
          }),
        })
        .command({
          command: 'fetch',
          describe: 'Download the latest skill file from GitHub to stdout',
          handler: wrap(async (_argv, _app) => {
            const res = await fetch(SKILL_RAW_URL);
            if (!res.ok) throw new Error(`Failed to fetch skill: ${res.status} ${res.statusText}`);
            const content = await res.text();
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
              raw_url: SKILL_RAW_URL,
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
          describe: 'Download and save the latest skill file',
          builder: (y) => y
            .positional('dir', {
              type: 'string',
              describe: 'Target directory (overrides --target; installs only to this dir)',
            })
            .option('target', {
              type: 'string',
              describe: 'Target agent(s): hermes, copilot, vscode, claude, cursor, agents, opencode, openclaw, codex, or "all" (comma-separated). Omit for interactive picker.',
            }),
          handler: wrap(async (argv, app) => {
            const res = await fetch(SKILL_RAW_URL);
            if (!res.ok) throw new Error(`Failed to fetch skill: ${res.status} ${res.statusText}`);
            const content = await res.text();

            // Resolve target directories
            let targets = [];

            if (argv.dir) {
              // Explicit --dir overrides targets — single install
              const p = path.resolve(argv.dir);
              fs.mkdirSync(p, { recursive: true });
              const targetPath = path.join(p, 'SKILL.md');
              fs.writeFileSync(targetPath, content, 'utf-8');
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
                    fs.writeFileSync(targetPath, content, 'utf-8');
                    targets.push({ name: TARGET_NAMES[key], path: targetPath });
                  } else {
                    fs.mkdirSync(dir, { recursive: true });
                    const targetPath = path.join(dir, 'SKILL.md');
                    fs.writeFileSync(targetPath, content, 'utf-8');
                    targets.push({ name: TARGET_NAMES[key], path: targetPath });
                  }
                }
              }
            } else if (process.stdin.isTTY) {
              // Interactive: show multi-select picker
              const fetchedVersion = extractVersion(content);
              // Check if any existing installed copies are outdated
              const outdated = [];
              if (fetchedVersion) {
                for (const [key, dir] of Object.entries(AGENT_SKILL_DIRS)) {
                  const skillPath = key === 'cursor'
                    ? path.join(dir, `${SKILL_NAME}.mdc`)
                    : path.join(dir, 'SKILL.md');
                  try {
                    const existing = fs.readFileSync(skillPath, 'utf-8');
                    const existingVersion = extractVersion(existing);
                    if (existingVersion && existingVersion !== fetchedVersion) {
                      outdated.push(TARGET_NAMES[key]);
                    }
                  } catch {
                    // Not installed — skip
                  }
                }
              }
              const promptMsg = outdated.length > 0
                ? `Where should the jsn skill be installed? (${outdated.length} outdated)`
                : 'Where should the jsn skill be installed?';

              const { default: checkbox } = await import('@inquirer/checkbox');
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
                  fs.writeFileSync(targetPath, content, 'utf-8');
                  targets.push({ name: TARGET_NAMES[key], path: targetPath });
                } else {
                  fs.mkdirSync(dir, { recursive: true });
                  const targetPath = path.join(dir, 'SKILL.md');
                  fs.writeFileSync(targetPath, content, 'utf-8');
                  targets.push({ name: TARGET_NAMES[key], path: targetPath });
                }
              }
            } else {
              // Non-interactive, no --target: install to Hermes only (backward compat)
              const dir = AGENT_SKILL_DIRS.hermes;
              fs.mkdirSync(dir, { recursive: true });
              const targetPath = path.join(dir, 'SKILL.md');
              fs.writeFileSync(targetPath, content, 'utf-8');
              targets.push({ name: TARGET_NAMES.hermes, path: targetPath });
            }

            if (targets.length === 0) {
              throw new Error(`No targets matched. Valid targets: ${Object.keys(AGENT_SKILL_DIRS).join(', ')}, or "all"`);
            }

            // Record install location so checkSkill knows where to look
            recordSkillInstall(targets[0].path);

            const installed = targets.reduce((acc, t) => { acc[t.name] = t.path; return acc; }, {});
            const summary = targets.length === 1
              ? `Skill installed to ${targets[0].path}`
              : `Skill installed to ${targets.length} target(s)`;

            const okOpts = {
              summary,
              breadcrumbs: [
                { action: 'reinstall', cmd: 'jsn skill install', description: 'Re-download and reinstall to default target' },
              ],
            };

            if (targets.length > 1) {
              okOpts.notice = 'Installed to multiple agents. Restart or reload your agent to pick up the skill.';
            }

            app.ok({ installed, from: SKILL_RAW_URL }, okOpts);
          }),
        });
    },
    handler: () => {
      console.log('Manage the jsn AI agent skill file.');
      console.log('');
      console.log('Available subcommands:');
      console.log('  show       Show the bundled skill file');
      console.log('  fetch      Download the latest skill from GitHub');
      console.log('  path       Show skill file locations');
      console.log('  install    Install skill file to agents directory');
      console.log('');
      console.log('Run "jsn skill <command> --help" for details.');
    },
  };
}
