import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SKILL_NAME = 'servicenow';
const SKILL_REPO_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'skills', SKILL_NAME, 'SKILL.md'
);

const HERMES_SKILL_PATH = path.join(os.homedir(), '.hermes', 'skills', SKILL_NAME, 'SKILL.md');

const SKILL_RAW_URL = 'https://raw.githubusercontent.com/jacebenson/jsn/nodejs/skills/servicenow/SKILL.md';

// Known agent skill directories (personal/user-level)
// Keyed by agent name for the --target flag
const AGENT_SKILL_DIRS = {
  hermes: path.join(os.homedir(), '.hermes', 'skills', SKILL_NAME),
  copilot: path.join(os.homedir(), '.copilot', 'skills', SKILL_NAME),
  claude: path.join(os.homedir(), '.claude', 'skills', SKILL_NAME),
  cursor: path.join(os.homedir(), '.cursor', 'rules'),
  agents: path.join(os.homedir(), '.agents', 'skills', SKILL_NAME),
};

const TARGET_NAMES = {
  hermes: 'Hermes Agent',
  copilot: 'GitHub Copilot',
  claude: 'Claude Code',
  cursor: 'Cursor',
  agents: 'Agents (open standard)',
};

function readBundledSkill() {
  try {
    return fs.readFileSync(SKILL_REPO_PATH, 'utf-8');
  } catch {
    return null;
  }
}

function readInstalledSkill() {
  try {
    return fs.readFileSync(HERMES_SKILL_PATH, 'utf-8');
  } catch {
    return null;
  }
}

export async function checkSkill() {
  // Compare the Hermes-installed copy's version against GitHub (not the npm-bundled copy).
  // Uses the YAML frontmatter "version" field so publishing jsn doesn't flag it.
  const installed = readInstalledSkill() || readBundledSkill();
  if (!installed) return { current: false, error: 'Skill file not found' };

  const installedVersion = extractVersion(installed);
  if (!installedVersion) return { current: false, error: 'No version field in installed skill' };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(SKILL_RAW_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { current: false, error: `GitHub returned ${res.status}` };
    const upstream = await res.text();
    const upstreamVersion = extractVersion(upstream);
    if (!upstreamVersion) return { current: false, error: 'No version field in upstream skill' };

    const current = installedVersion === upstreamVersion;
    return {
      current,
      installed_version: installedVersion,
      upstream_version: upstreamVersion,
      error: current ? null : `Skill version ${installedVersion} vs GitHub ${upstreamVersion} — run "jsn skill install" to update`,
    };
  } catch {
    return { current: false, error: 'Could not check — GitHub unreachable' };
  }
}

function extractVersion(content) {
  // Matches version in YAML frontmatter (top-level or nested under metadata:)
  const m = content.match(/^\s*version:\s*["']?(.+?)["']?\s*$/m);
  return m ? m[1] : null;
}

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
          describe: 'Check if the bundled skill file is up to date with GitHub',
          handler: wrap(async (_argv, app) => {
            const result = await checkSkill();
            if (result.error && !result.current) {
              app.ok(result, { summary: result.error });
            } else if (result.current) {
              app.ok(result, { summary: `✓ Skill is current (v${result.installed_version})` });
            } else {
              app.ok(result, { summary: `⚠ Skill outdated: installed v${result.installed_version} vs GitHub v${result.upstream_version} — run "jsn skill install" to update` });
            }
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
                { action: 'install', cmd: 'jsn skill install', description: 'Install to Hermes (default)' },
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
              describe: 'Target agent(s): hermes, copilot, claude, cursor, agents, or "all" (comma-separated)',
              default: 'hermes',
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
            } else {
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
            }

            if (targets.length === 0) {
              throw new Error(`No targets matched. Valid targets: ${Object.keys(AGENT_SKILL_DIRS).join(', ')}, or "all"`);
            }

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
    handler: () => {},
  };
}
