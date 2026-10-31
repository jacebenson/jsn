// Tests for skill command — version extraction, path resolution, harness targets

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── extractVersion ───

describe('Skill extractVersion', () => {
  it('should extract version from YAML frontmatter', async () => {
    const { extractVersion } = await import('../src/commands/skill.js');
    const content = `---
name: test
version: "1.2.3"
description: A test skill
---
Body text`;
    assert.strictEqual(extractVersion(content), '1.2.3');
  });

  it('should extract version without quotes', async () => {
    const { extractVersion } = await import('../src/commands/skill.js');
    const content = `---
name: test
version: 1.2.3
---
Body text`;
    assert.strictEqual(extractVersion(content), '1.2.3');
  });

  it('should extract version with single quotes', async () => {
    const { extractVersion } = await import('../src/commands/skill.js');
    const content = `---
name: test
version: '1.2.3'
---`;
    assert.strictEqual(extractVersion(content), '1.2.3');
  });

  it('should return null when no version field', async () => {
    const { extractVersion } = await import('../src/commands/skill.js');
    const content = `---
name: test
---
Body`;
    assert.strictEqual(extractVersion(content), null);
  });

  it('should return null for content without frontmatter', async () => {
    const { extractVersion } = await import('../src/commands/skill.js');
    const content = 'Just some text without frontmatter';
    assert.strictEqual(extractVersion(content), null);
  });

  it('should extract version with trailing whitespace', async () => {
    const { extractVersion } = await import('../src/commands/skill.js');
    const content = `---
name: test
version: 1.2.3  
---
Body`;
    assert.strictEqual(extractVersion(content), '1.2.3');
  });
});

// ─── Target maps ───

describe('Skill target maps', () => {
  it('should have all AGENT_SKILL_DIRS keys in TARGET_NAMES', async () => {
    const { AGENT_SKILL_DIRS, TARGET_NAMES } = await import('../src/commands/skill.js');
    for (const key of Object.keys(AGENT_SKILL_DIRS)) {
      assert.ok(TARGET_NAMES[key], `TARGET_NAMES missing key: ${key}`);
    }
  });

  it('should have all TARGET_NAMES keys in AGENT_SKILL_DIRS', async () => {
    const { AGENT_SKILL_DIRS, TARGET_NAMES } = await import('../src/commands/skill.js');
    for (const key of Object.keys(TARGET_NAMES)) {
      assert.ok(AGENT_SKILL_DIRS[key], `AGENT_SKILL_DIRS missing key: ${key}`);
    }
  });

  it('should define at least 9 targets', async () => {
    const { AGENT_SKILL_DIRS } = await import('../src/commands/skill.js');
    assert.ok(Object.keys(AGENT_SKILL_DIRS).length >= 9);
  });

  it('should include opencode, openclaw, codex targets', async () => {
    const { AGENT_SKILL_DIRS } = await import('../src/commands/skill.js');
    assert.ok(AGENT_SKILL_DIRS.opencode);
    assert.ok(AGENT_SKILL_DIRS.openclaw);
    assert.ok(AGENT_SKILL_DIRS.codex);
  });

  it('should include hermes, copilot, claude targets', async () => {
    const { AGENT_SKILL_DIRS } = await import('../src/commands/skill.js');
    assert.ok(AGENT_SKILL_DIRS.hermes);
    assert.ok(AGENT_SKILL_DIRS.copilot);
    assert.ok(AGENT_SKILL_DIRS.claude);
  });

  it('should include cursor with .mdc extension path', async () => {
    const { AGENT_SKILL_DIRS } = await import('../src/commands/skill.js');
    // Cursor uses rules/ dir without the SKILL_NAME subfolder
    assert.ok(AGENT_SKILL_DIRS.cursor);
  });
});

// ─── realHomeDir ───

describe('Skill realHomeDir', () => {
  it('should return a non-empty string', async () => {
    const { realHomeDir } = await import('../src/commands/skill.js');
    const home = realHomeDir();
    assert.ok(typeof home === 'string');
    assert.ok(home.length > 0);
  });

  it('should return an absolute path', async () => {
    const { realHomeDir } = await import('../src/commands/skill.js');
    const home = realHomeDir();
    assert.ok(path.isAbsolute(home));
  });
});

// ─── hermesSkillDir ───

describe('Skill hermesSkillDir', () => {
  let tmpDir;
  let origHome;
  let origHermesProfile;
  let origHermesBase;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-hermes-test-'));
    origHome = process.env.HOME;
    origHermesProfile = process.env.HERMES_PROFILE;
    origHermesBase = process.env.JSN_HERMES_BASE_DIR;
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    if (origHermesProfile !== undefined) process.env.HERMES_PROFILE = origHermesProfile;
    else delete process.env.HERMES_PROFILE;
    if (origHermesBase !== undefined) process.env.JSN_HERMES_BASE_DIR = origHermesBase;
    else delete process.env.JSN_HERMES_BASE_DIR;
  });

  it('should use HERMES_PROFILE env var when set', async () => {
    // Set up a temp hermes structure
    const hermesDir = path.join(tmpDir, '.hermes');
    fs.mkdirSync(path.join(hermesDir, 'profiles', 'work'), { recursive: true });

    process.env.HOME = tmpDir;
    process.env.JSN_HERMES_BASE_DIR = hermesDir;
    process.env.HERMES_PROFILE = 'work';

    const { hermesSkillDir } = await import('../src/commands/skill.js');
    const skillDir = hermesSkillDir();
    assert.ok(skillDir.includes('profiles/work/skills/servicenow'));
  });

  it('should scan profiles directory when HERMES_PROFILE not set', async () => {
    const hermesDir = path.join(tmpDir, '.hermes');
    fs.mkdirSync(path.join(hermesDir, 'profiles', 'holly'), { recursive: true });
    fs.mkdirSync(path.join(hermesDir, 'profiles', 'work'), { recursive: true });

    process.env.HOME = tmpDir;
    process.env.JSN_HERMES_BASE_DIR = hermesDir;
    delete process.env.HERMES_PROFILE;

    const { hermesSkillDir } = await import('../src/commands/skill.js');
    const skillDir = hermesSkillDir();
    // Should find the first profile directory
    assert.ok(skillDir.includes('profiles/'));
    assert.ok(skillDir.includes('skills/servicenow'));
  });
});
