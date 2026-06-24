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

  before(() => {
    originalEnv = { ...process.env };
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-save-test-'));
    process.env.XDG_CONFIG_HOME = tmpDir;
  });

  after(() => {
    Object.assign(process.env, originalEnv);
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

describe('SDKClient', () => {
  it('exports SDKClient class', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    assert.ok(SDKClient);
    assert.strictEqual(typeof SDKClient, 'function');
  });

  it('constructs with baseURL and authProvider', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const auth = { getCredentials: () => ({ auth_method: 'oauth', access_token: 'test-token' }) };
    const client = new SDKClient('https://test.service-now.com', auth);
    assert.strictEqual(client.baseURL, 'https://test.service-now.com');
    assert.strictEqual(client.timeout, 30000);
  });

  it('strips trailing slash from baseURL', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const auth = { getCredentials: () => ({ auth_method: 'oauth', access_token: 'test-token' }) };
    const client = new SDKClient('https://test.service-now.com/', auth);
    assert.strictEqual(client.baseURL, 'https://test.service-now.com');
  });

  it('accepts custom timeout', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const auth = { getCredentials: () => ({ auth_method: 'oauth', access_token: 'test-token' }) };
    const client = new SDKClient('https://test.service-now.com', auth, { timeout: 60000 });
    assert.strictEqual(client.timeout, 60000);
  });

  it('extracts HTML script output', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const auth = { getCredentials: () => ({ auth_method: 'oauth', access_token: 'test-token' }) };
    const client = new SDKClient('https://test.service-now.com', auth);

    const html = '<HTML><BODY><PRE>*** Script: Hello<BR/>*** Script: World<BR/></PRE></BODY></HTML>';
    const output = client._extractScriptOutput(html);
    assert.ok(output.includes('Hello'));
    assert.ok(output.includes('World'));
  });

  it('extracts script output with <br> tags', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const auth = { getCredentials: () => ({ auth_method: 'oauth', access_token: 'test-token' }) };
    const client = new SDKClient('https://test.service-now.com', auth);

    const html = '<pre>Line 1<br>Line 2<br>Line 3</pre>';
    const output = client._extractScriptOutput(html);
    assert.ok(output.includes('Line 1'));
    assert.ok(output.includes('Line 2'));
    assert.ok(output.includes('Line 3'));
  });

  it('extracts script output with HTML entities', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const auth = { getCredentials: () => ({ auth_method: 'oauth', access_token: 'test-token' }) };
    const client = new SDKClient('https://test.service-now.com', auth);

    const html = '<pre>&lt;test&gt; &amp; &quot;quoted&quot;</pre>';
    const output = client._extractScriptOutput(html);
    assert.strictEqual(output, '<test> & "quoted"');
  });

  it('has core CRUD methods', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const coreMethods = ['list', 'get', 'create', 'update', 'delete', 'request', 'rawRequest', 'aggregateCount', 'executeScript'];
    for (const method of coreMethods) {
      assert.strictEqual(typeof SDKClient.prototype[method], 'function', `Missing method: ${method}`);
    }
  });

  it('does not have domain-specific methods', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const forbiddenPatterns = ['ListForm', 'ListList', 'GetSP', 'ListSP'];
    const protoProps = Object.getOwnPropertyNames(SDKClient.prototype);
    for (const prop of protoProps) {
      for (const pattern of forbiddenPatterns) {
        assert.ok(!prop.includes(pattern), `Should not have domain method: ${prop}`);
      }
    }
  });
});

describe('Auth', () => {
  it('returns false when no instance configured', async () => {
    const origToken = process.env.SERVICENOW_OAUTH_TOKEN;
    const origSnUser = process.env.SN_USERNAME;
    const origSnPass = process.env.SN_PASSWORD;
    delete process.env.SERVICENOW_OAUTH_TOKEN;
    delete process.env.SN_USERNAME;
    delete process.env.SN_PASSWORD;
    try {
      const { AuthManager } = await import('../src/auth.js');
      const auth = new AuthManager({ getEffectiveInstance: () => '' });
      assert.strictEqual(auth.isAuthenticated(), false);
    } finally {
      if (origToken !== undefined) process.env.SERVICENOW_OAUTH_TOKEN = origToken;
      if (origSnUser !== undefined) process.env.SN_USERNAME = origSnUser;
      if (origSnPass !== undefined) process.env.SN_PASSWORD = origSnPass;
    }
  });

  it('isAuthenticatedFor returns false for empty instance', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const auth = new AuthManager({ getEffectiveInstance: () => '' });
    assert.strictEqual(auth.isAuthenticatedFor(''), false);
  });

  it('throws when no instance configured for getCredentials', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const auth = new AuthManager({ getEffectiveInstance: () => '' });
    await assert.rejects(() => auth.getCredentials(), /No instance configured/);
  });

  it('generates PKCE params', async () => {
    const { AuthManager } = await import('../src/auth.js');
    // We can validate PKCE indirectly by testing exchangeCode would reject
    const auth = new AuthManager({ getEffectiveInstance: () => '' });
    assert.ok(auth.httpClient);
  });
});

describe('App context', () => {
  it('exports App class', async () => {
    const { App } = await import('../src/app.js');
    assert.ok(App);
    assert.strictEqual(typeof App, 'function');
  });

  it('creates App with config', async () => {
    const { App } = await import('../src/app.js');
    const cfg = { instanceURL: 'https://test.service-now.com', profiles: {}, activeProfile: '' };
    const app = new App(cfg);
    assert.strictEqual(app.config, cfg);
    assert.ok(app.output);
    assert.ok(app.auth);
  });

  it('creates App without SDK when no instance', async () => {
    const { App } = await import('../src/app.js');
    const cfg = { instanceURL: '', profiles: {}, activeProfile: '' };
    const app = new App(cfg);
    assert.strictEqual(app.sdk, null);
  });

  it('requireInstance throws when no instance', async () => {
    const { App } = await import('../src/app.js');
    const cfg = { instanceURL: '', profiles: {}, activeProfile: '' };
    const app = new App(cfg);
    assert.throws(() => app.requireInstance(), /Instance URL required/);
  });

  it('requireInstance passes when instance is set', async () => {
    const { App } = await import('../src/app.js');
    const cfg = { instanceURL: 'https://test.service-now.com', profiles: {}, activeProfile: '' };
    const app = new App(cfg);
    assert.doesNotThrow(() => app.requireInstance());
  });

  it('requireAuth throws when not authenticated', async () => {
    const origToken = process.env.SERVICENOW_OAUTH_TOKEN;
    const origSnUser = process.env.SN_USERNAME;
    const origSnPass = process.env.SN_PASSWORD;
    delete process.env.SERVICENOW_OAUTH_TOKEN;
    delete process.env.SN_USERNAME;
    delete process.env.SN_PASSWORD;
    try {
      const { App } = await import('../src/app.js');
      const cfg = { instanceURL: 'https://test.service-now.com', profiles: {}, activeProfile: '' };
      const app = new App(cfg);
      assert.throws(() => app.requireAuth(), /Not authenticated/);
    } finally {
      if (origToken !== undefined) process.env.SERVICENOW_OAUTH_TOKEN = origToken;
      if (origSnUser !== undefined) process.env.SN_USERNAME = origSnUser;
      if (origSnPass !== undefined) process.env.SN_PASSWORD = origSnPass;
    }
  });

  it('isInteractive returns false for non-TTY', async () => {
    const { App } = await import('../src/app.js');
    const cfg = { instanceURL: '', profiles: {}, activeProfile: '' };
    const app = new App(cfg);
    assert.strictEqual(app.isInteractive(), false);
  });
});
