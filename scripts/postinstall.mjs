#!/usr/bin/env node
/**
 * postinstall.mjs — Copies the bundled ServiceNow SKILL.md to agent skill directories
 * on npm global install. Mirrors what `basecamp`'s installer does for their skill.
 *
 * Only runs when `npm install -g @jacebenson/jsn`.
 * On `npm install` (local dependency), it's a no-op.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_SOURCE = path.resolve(__dirname, '..', 'skills', 'servicenow', 'SKILL.md');
const AGENTS_DIR = path.join(os.homedir(), '.agents', 'skills', 'servicenow');
const AGENTS_SKILL = path.join(AGENTS_DIR, 'SKILL.md');
const CLAUDE_SKILL_DIR = path.join(os.homedir(), '.claude', 'skills');
const CLAUDE_SYMLINK = path.join(CLAUDE_SKILL_DIR, 'servicenow');

function isGlobalInstall() {
  return (
    process.env.npm_config_global === 'true' ||
    process.env.npm_lifecycle_event === 'postinstall'
  );
}

function installSkill() {
  // Check if running in a non-interactive/CI environment where .agents
  // doesn't make sense. Skip silently.
  if (!AGENTS_DIR.startsWith(os.homedir())) {
    return;
  }

  if (!fs.existsSync(SKILL_SOURCE)) {
    console.warn('  ⚠ jsn: ServiceNow SKILL.md not found at', SKILL_SOURCE);
    return;
  }

  // Create ~/.agents/skills/servicenow/
  try {
    fs.mkdirSync(AGENTS_DIR, { recursive: true });
  } catch {
    // user's home might not be writable in container/CI
    return;
  }

  // Copy the bundled skill file
  try {
    fs.copyFileSync(SKILL_SOURCE, AGENTS_SKILL);
    console.log('  ✓ jsn: ServiceNow skill installed to ' + AGENTS_SKILL);
  } catch (err) {
    console.warn('  ⚠ jsn: Could not copy skill to ' + AGENTS_SKILL, err.message);
    return;
  }

  // Create symlink at ~/.claude/skills/servicenow → ../../.agents/skills/servicenow
  // This is the same pattern basecamp's installer uses: ~/.claude/skills/basecamp → ../../.agents/skills/basecamp
  try {
    fs.mkdirSync(CLAUDE_SKILL_DIR, { recursive: true });

    // Remove stale symlink or directory if it exists
    try {
      fs.unlinkSync(CLAUDE_SYMLINK);
    } catch {
      // doesn't exist — fine
    }

    // Relative symlink so it survives user home dir moves
    const relativeTarget = path.relative(CLAUDE_SKILL_DIR, AGENTS_DIR);
    fs.symlinkSync(relativeTarget, CLAUDE_SYMLINK, 'dir');
    console.log('  ✓ jsn: Claude Code skill link at ' + CLAUDE_SYMLINK);
  } catch (err) {
    // Claude Code skill dir might not be expected — non-fatal
    console.warn('  ⚠ jsn: Could not create Claude Code symlink:', err.message);
  }
}

installSkill();
