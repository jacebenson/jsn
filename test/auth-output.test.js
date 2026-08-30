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
      auth_source: 'oauth',
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

export const AUTH_STATUS_STYLED_GOLDEN =
  '4 profile(s)\n' +
  '\n' +
  '\n' +
  '* ✓ dev — https://dev.service-now.com 🔒 ⚡ ✅\n' +
  '  ✗ prod — https://prod.service-now.com ⚠️ (10d ago — may have been released)\n' +
  '  ✓ https://anon.service-now.com\n' +
  '  ✓ https://bob.service-now.com (as bob)\n';

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
    const data = { ...AUTH_STATUS_FIXTURE, _formatted: renderAuthStatus(AUTH_STATUS_FIXTURE, '4 profile(s)') };
    ow.ok(data, { summary: '4 profile(s)' });

    assert.strictEqual(chunks.join(''), AUTH_STATUS_STYLED_GOLDEN);
  });
});
