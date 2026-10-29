// Tests for skill command — version extraction, path resolution, harness targets

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

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
    assert.ok(skillDir.includes(path.join('profiles', 'work', 'skills', 'servicenow')));
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
    assert.ok(skillDir.includes('profiles' + path.sep));
    assert.ok(skillDir.includes(path.join('skills', 'servicenow')));
  });
});

describe('Packaged skill lifecycle', () => {
  it('detects same-version edits immediately and replaces all recorded copies offline', async () => {
    const { spawnSync } = await import('node:child_process');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-skill-lifecycle-'));
    const env = { ...process.env, XDG_CONFIG_HOME: directory,
      JSN_HERMES_BASE_DIR: path.join(directory, 'hermes'), JSN_DATA_HOME: directory,
      JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1', JSN_NO_HEADER: '1' };
    const preload = path.join(directory, 'offline.mjs');
    fs.writeFileSync(preload, 'globalThis.fetch = () => { throw new Error("Network access forbidden"); };');
    const run = (...args) => {
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, 'bin/jsn.js', 'skill', ...args],
        { cwd: new URL('..', import.meta.url), env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    try {
      const bundled = fs.readFileSync(new URL('../skills/servicenow/SKILL.md', import.meta.url), 'utf8');
      const destination = path.join(directory, 'custom');
      run('install', destination, '--json');
      const installed = path.join(destination, 'SKILL.md');
      const second = path.join(directory, 'second.md');
      fs.writeFileSync(second, bundled);
      const configPath = path.join(directory, 'servicenow', 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      config.skillLocations = [installed, second];
      fs.writeFileSync(configPath, JSON.stringify(config));
      fs.appendFileSync(installed, '\nLocal changes with the same version.\n');
      let check = JSON.parse(run('check', '--json')).data;
      assert.equal(check.current, false);
      assert.equal(check.installed_version, check.bundled_version);
      assert.equal(check.copies[0].status, 'different');
      assert.ok(check.copies[0].first_different_line > 0);
      assert.match(run('check', '--styled'), /first difference: line/);
      fs.unlinkSync(second);
      check = JSON.parse(run('check', '--json')).data;
      assert.equal(check.copies[1].status, 'missing');
      run('install', '--json');
      assert.equal(fs.readFileSync(installed, 'utf8'), bundled);
      assert.equal(fs.readFileSync(second, 'utf8'), bundled);
      assert.equal(JSON.parse(run('check', '--json')).data.current, true);
      assert.equal(run('fetch'), bundled);
      assert.equal(JSON.parse(run('path', '--json')).data.raw_url, undefined);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
