import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let originalEnv;

describe('Config - normalizeInstanceURL', () => {
  it('adds https:// prefix when missing', async () => {
    const { normalizeInstanceURL } = await import('../src/config.js');
    assert.strictEqual(normalizeInstanceURL('dev12345.service-now.com'), 'https://dev12345.service-now.com');
  });

  it('removes trailing slash', async () => {
    const { normalizeInstanceURL } = await import('../src/config.js');
    assert.strictEqual(normalizeInstanceURL('https://dev12345.service-now.com/'), 'https://dev12345.service-now.com');
  });

  it('preserves http:// prefix', async () => {
    const { normalizeInstanceURL } = await import('../src/config.js');
    assert.strictEqual(normalizeInstanceURL('http://localhost:8080'), 'http://localhost:8080');
  });

  it('returns empty string for empty input', async () => {
    const { normalizeInstanceURL } = await import('../src/config.js');
    assert.strictEqual(normalizeInstanceURL(''), '');
  });
});

describe('Config - loadConfig', () => {
  let tmpDir;
  let configPath;
  let originalCwd;

  before(() => {
    originalEnv = { ...process.env };
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-config-test-'));
    process.env.XDG_CONFIG_HOME = tmpDir;
    // Isolate from local .servicenow/config.json
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    configPath = path.join(tmpDir, 'servicenow', 'config.json');
    fs.mkdirSync(path.join(tmpDir, 'servicenow'), { recursive: true });
  });

  after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    if (originalCwd) process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads default config when no files exist', async () => {
    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig({});
    assert.strictEqual(cfg.instanceURL, '');
    assert.strictEqual(cfg.format, 'auto');
  });

  it('loads config from global file', async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      instance_url: 'https://dev12345.service-now.com',
      default_profile: 'dev',
      format: 'json',
    }));
    // Re-import module to pick up the changed env
    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig({});
    assert.strictEqual(cfg.instanceURL, 'https://dev12345.service-now.com');
    assert.strictEqual(cfg.format, 'json');
  });

  it('applies flag overrides on top of file config', async () => {
    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig({ instance: 'https://override.service-now.com', format: 'markdown' });
    assert.strictEqual(cfg.instanceURL, 'https://override.service-now.com');
    assert.strictEqual(cfg.sources.instance_url, 'flag');
  });

  it('loads from environment variables', async () => {
    const origInstance = process.env.SERVICENOW_INSTANCE_URL;
    const origFormat = process.env.SERVICENOW_FORMAT;
    process.env.SERVICENOW_INSTANCE_URL = 'https://env-instance.service-now.com';
    process.env.SERVICENOW_FORMAT = 'styled';
    try {
      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig({});
      assert.strictEqual(cfg.instanceURL, 'https://env-instance.service-now.com');
      assert.strictEqual(cfg.sources.instance_url, 'env');
    } finally {
      if (origInstance !== undefined) process.env.SERVICENOW_INSTANCE_URL = origInstance;
      else delete process.env.SERVICENOW_INSTANCE_URL;
      if (origFormat !== undefined) process.env.SERVICENOW_FORMAT = origFormat;
      else delete process.env.SERVICENOW_FORMAT;
    }
  });

  it('resolves profile from active profile flag', async () => {
    // Create config with profiles
    fs.writeFileSync(configPath, JSON.stringify({
      profiles: {
        dev: { instance_url: 'https://dev12345.service-now.com' },
        prod: { instance_url: 'https://prod.service-now.com' },
      },
    }));
    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig({ profile: 'prod' });
    assert.strictEqual(cfg.instanceURL, 'https://prod.service-now.com');
    assert.strictEqual(cfg.activeProfile, 'prod');
  });
});

describe('Config - getEffectiveInstance', () => {
  it('returns instance from active profile', async () => {
    const { getEffectiveInstance } = await import('../src/config.js');
    const cfg = {
      activeProfile: 'dev',
      profiles: { dev: { instance_url: 'https://dev.service-now.com' } },
      instanceURL: '',
    };
    assert.strictEqual(getEffectiveInstance(cfg), 'https://dev.service-now.com');
  });

  it('falls back to instanceURL', async () => {
    const { getEffectiveInstance } = await import('../src/config.js');
    const cfg = {
      activeProfile: '',
      profiles: {},
      instanceURL: 'https://fallback.service-now.com',
    };
    assert.strictEqual(getEffectiveInstance(cfg), 'https://fallback.service-now.com');
  });

  it('returns empty string', async () => {
    const { getEffectiveInstance } = await import('../src/config.js');
    assert.strictEqual(getEffectiveInstance({}), '');
  });
});

describe('Config - getActiveProfile', () => {
  it('returns the active profile', async () => {
    const { getActiveProfile } = await import('../src/config.js');
    const cfg = {
      activeProfile: 'dev',
      defaultProfile: '',
      profiles: { dev: { instance_url: 'https://dev.service-now.com' } },
    };
    const p = getActiveProfile(cfg);
    assert.ok(p);
    assert.strictEqual(p.instance_url, 'https://dev.service-now.com');
  });

  it('falls back to defaultProfile', async () => {
    const { getActiveProfile } = await import('../src/config.js');
    const cfg = {
      activeProfile: '',
      defaultProfile: 'prod',
      profiles: { prod: { instance_url: 'https://prod.service-now.com' } },
    };
    const p = getActiveProfile(cfg);
    assert.ok(p);
    assert.strictEqual(p.instance_url, 'https://prod.service-now.com');
  });

  it('returns null when no profile configured', async () => {
    const { getActiveProfile } = await import('../src/config.js');
    assert.strictEqual(getActiveProfile({}), null);
  });
});

describe('Config - saveConfig', () => {
  let tmpDir;
  let originalCwd;

  before(() => {
    originalEnv = { ...process.env };
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-save-test-'));
    process.env.XDG_CONFIG_HOME = tmpDir;
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves config to file and can reload it', async () => {
    const { saveConfig, loadConfig } = await import('../src/config.js');
    const cfg = loadConfig({});
    cfg.instanceURL = 'https://test.service-now.com';
    cfg.defaultProfile = 'test';
    saveConfig(cfg);

    const cfg2 = loadConfig({});
    assert.strictEqual(cfg2.instanceURL, 'https://test.service-now.com');
  });
});
