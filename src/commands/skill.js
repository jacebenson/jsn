import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const SKILL_REPO_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'skills', 'servicenow', 'SKILL.md'
);

const SKILL_RAW_URL = 'https://raw.githubusercontent.com/jacebenson/jsn/nodejs/skills/servicenow/SKILL.md';

function readBundledSkill() {
  try {
    return fs.readFileSync(SKILL_REPO_PATH, 'utf-8');
  } catch {
    return null;
  }
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
          command: 'fetch',
          describe: 'Download the latest skill file from GitHub to stdout',
          handler: wrap(async (_argv, _app) => {
            const res = await fetch(SKILL_RAW_URL);
            if (!res.ok) throw new Error(`Failed to fetch skill: ${res.status} ${res.statusText}`);
            const content = await res.text();
            // Print raw content to stdout for pipe/save usage
            process.stdout.write(content);
          }),
        })
        .command({
          command: 'path',
          describe: 'Show skill file locations and install targets',
          handler: wrap(async (_argv, app) => {
            const hermesDir = path.join(os.homedir(), '.hermes', 'skills', 'servicenow');
            const hermesPath = path.join(hermesDir, 'SKILL.md');
            app.ok({
              bundled: SKILL_REPO_PATH,
              hermes: hermesPath,
              raw_url: SKILL_RAW_URL,
            }, {
              summary: 'Skill file locations',
              breadcrumbs: [
                { action: 'view', cmd: 'jsn skill show', description: 'Show bundled skill content' },
                { action: 'fetch', cmd: 'jsn skill fetch', description: 'Download latest from GitHub' },
                { action: 'install', cmd: 'jsn skill install', description: 'Download + save to Hermes' },
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
              describe: 'Target directory (default: ~/.hermes/skills/servicenow/)',
            }),
          handler: wrap(async (argv, app) => {
            const targetDir = argv.dir || path.join(os.homedir(), '.hermes', 'skills', 'servicenow');
            const targetPath = path.join(targetDir, 'SKILL.md');

            fs.mkdirSync(targetDir, { recursive: true });

            const res = await fetch(SKILL_RAW_URL);
            if (!res.ok) throw new Error(`Failed to fetch skill: ${res.status} ${res.statusText}`);
            const content = await res.text();

            fs.writeFileSync(targetPath, content, 'utf-8');

            app.ok({
              installed: targetPath,
              from: SKILL_RAW_URL,
            }, {
              summary: `Skill installed to ${targetPath}`,
              breadcrumbs: [
                { action: 'verify', cmd: `head -30 ${targetPath}`, description: 'Verify the installed skill' },
                { action: 'reinstall', cmd: 'jsn skill install', description: 'Re-download and reinstall' },
              ],
            });
          }),
        });
    },
    handler: () => {}, // Handled by subcommands
  };
}
