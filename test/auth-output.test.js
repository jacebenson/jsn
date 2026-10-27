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

export const AUTH_STATUS_FIXTURE = {
  default_instance: 'https://dev.service-now.com',
  authenticated: true,
  profiles: [
    {
      name: 'dev',
      instance: 'https://dev.service-now.com',
      authenticated: true,
      auth_source: 'keyring',
      active: true,
      username: 'admin',
      diagnostics: { auth_method: 'oauth', auth_source: 'keyring', state: 'available', probe: { status: 'succeeded' } },
      verified: true,
      verified_as: 'admin',
      last_seen: 1000,
      days_since_last_seen: 3,
      stale: false,
      default: true,
      read_only: true,
      skip_confirmations: true,
      include_counts: true,
    },
    {
      name: 'prod',
      username: 'deployer',
      include_counts: false,
      diagnostics: { auth_method: 'gck', auth_source: 'unavailable', state: 'missing', probe: { status: 'not_attempted' } },
      instance: 'https://prod.service-now.com',
      authenticated: false,
      verified: false,
      days_since_last_seen: 10,
      stale: true,
      default: false,
      read_only: false,
      skip_confirmations: false,
    },
    {
      // no name, no username → instance-only row
      instance: 'https://anon.service-now.com',
      authenticated: true,
      verified: null,
      default: false,
      read_only: false,
      skip_confirmations: false,
    },
    {
      // username but no name → "instance (as username)" row
      username: 'bob',
      instance: 'https://bob.service-now.com',
      authenticated: true,
      verified: null,
      default: false,
      read_only: false,
      skip_confirmations: false,
    },
  ],
};

export const AUTH_STATUS_STYLED_GOLDEN = `4 profiles

PROFILE          AUTH             CREDENTIALS  CONNECTION   ACCESS      DELETES    COUNTS
dev * (default)  OAuth            Available    Verified     Read-only   No prompt  On
prod             Browser session  Missing      Failed       Read/write  Confirm    Off
Profile 3        Not configured   Available    Not checked  Read/write  Confirm    On
Profile 4        Not configured   Available    Not checked  Read/write  Confirm    On

* selected profile

prod: jsn auth login --profile prod

Show users and instance URLs: jsn auth status --details
`;

describe('auth status styled output (visual pin)', () => {
  it('renders the profiles envelope byte-identically via OutputWriter', async () => {
    const { OutputWriter } = await import('../src/output.js');
    const { renderAuthStatus } = await import('../src/commands/auth.js');

    const chunks = [];
    const ow = new OutputWriter();
    ow.setFormat('styled');
    ow.writer = { write: (s) => chunks.push(String(s)), isTTY: true };

    // The handler ships data._formatted built by renderAuthStatus; the
    // OutputWriter then writes it verbatim (summary suppressed).
    const data = { ...AUTH_STATUS_FIXTURE, _formatted: renderAuthStatus(AUTH_STATUS_FIXTURE, '4 profiles') };
    ow.ok(data, { summary: '4 profiles' });

    assert.strictEqual(chunks.join(''), AUTH_STATUS_STYLED_GOLDEN);
  });
});
