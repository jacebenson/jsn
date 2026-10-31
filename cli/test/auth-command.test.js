// Tests for auth command structure and handler logic

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Auth commands persist profile changes through saveConfig(). Keep every auth
// test away from the developer's real ~/.config/servicenow/config.json,
// including tests that call helpers directly instead of going through a
// deliberately isolated fixture.
let originalAuthTestXdg;
let originalAuthTestCwd;
let authTestConfigHome;

before(() => {
  originalAuthTestXdg = process.env.XDG_CONFIG_HOME;
  originalAuthTestCwd = process.cwd();
  authTestConfigHome = mkdtempSync(path.join(tmpdir(), 'jsn-auth-file-test-'));
  process.env.XDG_CONFIG_HOME = authTestConfigHome;
  process.chdir(authTestConfigHome);
});

after(() => {
  process.chdir(originalAuthTestCwd);
  if (originalAuthTestXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalAuthTestXdg;
  rmSync(authTestConfigHome, { recursive: true, force: true });
});

describe('Auth Command Structure', () => {
  it('should export authCmd function', async () => {
    const { authCmd } = await import('../src/commands/auth.js');
    assert.strictEqual(typeof authCmd, 'function');
  });

  it('should define auth command with correct properties', async () => {
    const { authCmd } = await import('../src/commands/auth.js');
    const wrap = (fn) => fn;
    const cmd = authCmd(wrap);
    assert.ok(cmd.command.includes('auth'));
    assert.ok(cmd.aliases === undefined || Array.isArray(cmd.aliases));
    assert.ok(cmd.describe.toLowerCase().includes('oauth'));
  });

  it('should define login, logout, status, refresh, switch, modify, remove subcommands', async () => {
    const { authCmd } = await import('../src/commands/auth.js');
    const wrap = (fn) => fn;
    const cmd = authCmd(wrap);
    assert.strictEqual(typeof cmd.builder, 'function');

    const subcommands = [];
    const mockYargs = {
      command: (c) => {
        subcommands.push(typeof c === 'string' ? c : c.command);
        return mockYargs;
      },
    };
    cmd.builder(mockYargs);

    const names = subcommands.map(s => s.split(' ')[0]);
    assert.ok(names.includes('login'));
    assert.ok(names.includes('logout'));
    assert.ok(names.includes('status'));
    assert.ok(names.includes('refresh'));
    assert.ok(names.includes('switch'));
    assert.ok(names.includes('modify'));
    assert.ok(names.includes('remove'));
  });
});

describe('resolveInstanceArg', () => {
  let resolveInstanceArg;
  before(async () => {
    ({ resolveInstanceArg } = await import('../src/commands/auth.js'));
  });

  const cfg = {
    profiles: {
      staging: { instance_url: 'https://staging.example.com' },
    },
  };

  it('should pass full URLs through unchanged', () => {
    assert.strictEqual(
      resolveInstanceArg('https://dev12345.service-now.com', cfg),
      'https://dev12345.service-now.com'
    );
  });

  it('should add https:// to a bare host', () => {
    assert.strictEqual(
      resolveInstanceArg('dev12345.service-now.com', cfg),
      'https://dev12345.service-now.com'
    );
  });

  it('should resolve a known profile name to its stored URL', () => {
    assert.strictEqual(
      resolveInstanceArg('staging', cfg),
      'https://staging.example.com'
    );
  });

  it('should append .service-now.com to an unknown bare name (fixes dead-host trap)', () => {
    assert.strictEqual(
      resolveInstanceArg('dev99999', cfg),
      'https://dev99999.service-now.com'
    );
  });
});

describe('resolveWizardInstance', () => {
  let origEnv;
  before(() => { origEnv = process.env.SERVICENOW_INSTANCE_URL; });
  after(() => {
    if (origEnv === undefined) delete process.env.SERVICENOW_INSTANCE_URL;
    else process.env.SERVICENOW_INSTANCE_URL = origEnv;
  });

  it('returns empty when only a default profile exists (must ask for URL)', async () => {
    delete process.env.SERVICENOW_INSTANCE_URL;
    const { resolveWizardInstance } = await import('../src/commands/auth.js');
    const app = {
      config: {
        defaultProfile: 'dev227772',
        profiles: { dev227772: { instance_url: 'https://dev227772.service-now.com' } },
      },
      // This is what the real App exposes. The wizard must not treat it as
      // an explicit instance when adding a new profile.
      getEffectiveInstance: () => 'https://dev227772.service-now.com',
    };
    assert.strictEqual(resolveWizardInstance(app, {}), '');
  });

  it('pre-fills from an explicit --instance override', async () => {
    delete process.env.SERVICENOW_INSTANCE_URL;
    const { resolveWizardInstance } = await import('../src/commands/auth.js');
    const app = { config: { profiles: {} }, _overrideInstance: 'https://dev99999.service-now.com' };
    assert.strictEqual(resolveWizardInstance(app, {}), 'https://dev99999.service-now.com');
  });

  it('pre-fills from argv.instance', async () => {
    delete process.env.SERVICENOW_INSTANCE_URL;
    const { resolveWizardInstance } = await import('../src/commands/auth.js');
    const app = { config: { profiles: {} } };
    assert.strictEqual(resolveWizardInstance(app, { instance: 'https://dev12345.service-now.com' }), 'https://dev12345.service-now.com');
  });

  it('pre-fills from the env var', async () => {
    process.env.SERVICENOW_INSTANCE_URL = 'https://dev55555.service-now.com';
    const { resolveWizardInstance } = await import('../src/commands/auth.js');
    const app = { config: { profiles: {} } };
    assert.strictEqual(resolveWizardInstance(app, {}), 'https://dev55555.service-now.com');
  });
});
