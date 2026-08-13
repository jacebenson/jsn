// CLI-level end-to-end tests — exercise the actual binary (bin/jsn.js)
// through the middleware layer, not just the SDK.
// Opt-in: set JSN_INTEGRATION_TESTS=true
//
// These cover the layer the SDK-level integration tests miss: the CLI
// middleware that enforces read-only profiles, delete confirmations,
// and exact-match query validation (issue #143, PRs #144/#145/#146).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const INTEGRATION_ENABLED = process.env.JSN_INTEGRATION_TESTS === 'true';
const CLI = path.resolve('bin/jsn.js');

let app;
let tmpDir;
let realCfg;
let instanceURL;
let createdNumber;

before(async () => {
  if (!INTEGRATION_ENABLED) return;

  // Real config: used to resolve the live instance + profile to copy.
  const { loadConfig } = await import('../src/config.js');
  const { App } = await import('../src/app.js');
  realCfg = loadConfig();
  app = new App(realCfg);
  instanceURL = app.getEffectiveInstance();
  if (!instanceURL) {
    throw new Error('No ServiceNow instance configured. Run jsn setup first or check your config.');
  }

  // Isolated XDG_CONFIG_HOME so tests can craft read_only /
  // skip_confirmations profiles WITHOUT touching the real config.
  // The OS keyring is global, so auth still resolves from the copied profile.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-cli-e2e-'));
});

after(async () => {
  if (!INTEGRATION_ENABLED) return;
  if (createdNumber && app) {
    try {
      const p = new URLSearchParams();
      p.set('sysparm_query', `number=${createdNumber}`);
      p.set('sysparm_limit', '1');
      p.set('sysparm_fields', 'sys_id');
      const recs = await app.sdk.list('incident', p);
      if (recs.length > 0) {
        await app.sdk.delete('incident', recs[0].sys_id);
      }
    } catch {
      // non-fatal cleanup
    }
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ───

/**
 * Write an isolated config with the real instance + optional profile flags.
 * @param {object} overrides — merged into the default profile (read_only,
 *   skip_confirmations, etc.)
 */
function writeIsolatedConfig(overrides = {}) {
  const baseProfile = realCfg.profiles?.[realCfg.activeProfile || realCfg.defaultProfile] || {};
  const profile = {
    instance_url: baseProfile.instance_url || instanceURL,
    auth_method: baseProfile.auth_method || 'oauth',
    username: baseProfile.username || 'admin',
    ...overrides,
  };
  const cfg = {
    instance_url: profile.instance_url,
    default_profile: 'default',
    active_profile: 'default',
    profiles: { default: profile },
  };
  fs.mkdirSync(path.join(tmpDir, 'servicenow'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'servicenow', 'config.json'), JSON.stringify(cfg, null, 2));
}

/**
 * Run the real CLI binary with the isolated config.
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function runCli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8',
    cwd: path.resolve('.'),
    env: { ...process.env, XDG_CONFIG_HOME: tmpDir },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ─── Read-only profile guard (PR #144) ───

describe('CLI E2E - Read-only profile guard', { skip: !INTEGRATION_ENABLED }, () => {
  it('blocks jsn eval on a read_only profile', () => {
    writeIsolatedConfig({ read_only: true });
    const r = runCli(['eval', '--script', 'gs.log("should not run")', '--json']);
    assert.notStrictEqual(r.status, 0, 'eval must be blocked on read-only profile');
    assert.match(r.stdout + r.stderr, /read-only|read_only|blocked/i);
  });

  it('blocks jsn rest DELETE on a read_only profile', () => {
    writeIsolatedConfig({ read_only: true });
    const r = runCli(['rest', '-X', 'DELETE', '--table', 'incident', '--query', 'sys_id=deadbeef', '--json']);
    assert.notStrictEqual(r.status, 0, 'rest DELETE must be blocked on read-only profile');
    assert.match(r.stdout + r.stderr, /read-only|read_only|blocked/i);
  });

  it('allows read commands on a read_only profile', () => {
    writeIsolatedConfig({ read_only: true });
    const r = runCli(['incidents', 'list', '--limit', '1', '--columns', 'number', '--json']);
    assert.strictEqual(r.status, 0, `read should work on read-only profile: ${r.stderr}`);
    assert.match(r.stdout, /"ok":\s*true/);
  });

  it('allows jsn eval on a write-enabled profile (sanity)', () => {
    writeIsolatedConfig({});
    const r = runCli(['eval', '--script', 'gs.log("hello from cli e2e")', '--json']);
    assert.strictEqual(r.status, 0, `eval should work on normal profile: ${r.stderr}`);
    assert.match(r.stdout, /"ok":\s*true/);
  });
});

// ─── Delete confirmation (PR #145) ───

describe('CLI E2E - Delete confirmation', { skip: !INTEGRATION_ENABLED }, () => {
  before(async () => {
    if (!INTEGRATION_ENABLED) return;
    // Create a real incident to delete via the CLI.
    const rec = await app.sdk.create('incident', {
      short_description: 'JSN CLI E2E delete-confirmation test ' + Date.now(),
    });
    createdNumber = rec.number;
  });

  it('rejects delete without --force in non-TTY (default ask)', () => {
    writeIsolatedConfig({});
    const r = runCli(['incidents', 'delete', createdNumber, '--json']);
    assert.notStrictEqual(r.status, 0, 'delete must require confirmation in non-TTY');
    assert.match(r.stdout + r.stderr, /confirmation required.*--force/s);
  });

  it('deletes with --force', () => {
    writeIsolatedConfig({});
    const r = runCli(['incidents', 'delete', createdNumber, '--force', '--json']);
    assert.strictEqual(r.status, 0, `delete --force should succeed: ${r.stderr}`);
    createdNumber = null; // cleaned up
  });

  it('deletes without --force when profile has skip_confirmations', async () => {
    // Create a second record for this case.
    const rec = await app.sdk.create('incident', {
      short_description: 'JSN CLI E2E skip-confirmations test ' + Date.now(),
    });
    writeIsolatedConfig({ skip_confirmations: true });
    const r = runCli(['incidents', 'delete', rec.number, '--json']);
    assert.strictEqual(r.status, 0, `delete should skip confirmation: ${r.stderr}`);
  });
});

// ─── Exact-match query validation (PR #146) ───

describe('CLI E2E - Exact-match query validation', { skip: !INTEGRATION_ENABLED }, () => {
  it('rejects identifiers containing ^', () => {
    writeIsolatedConfig({});
    const r = runCli(['incidents', 'show', 'INC0010001^state=1', '--json']);
    assert.notStrictEqual(r.status, 0, 'malicious identifier must be rejected');
    assert.match(r.stdout + r.stderr, /Unsafe identifier/i);
  });

  it('rejects identifiers containing ^OR', () => {
    writeIsolatedConfig({});
    const r = runCli(['incidents', 'show', 'INC0010001^ORnumber=INC0020002', '--json']);
    assert.notStrictEqual(r.status, 0, 'OR-clause injection must be rejected');
    assert.match(r.stdout + r.stderr, /Unsafe identifier/i);
  });

  it('allows normal identifiers', () => {
    writeIsolatedConfig({});
    const r = runCli(['incidents', 'list', '--limit', '1', '--columns', 'number', '--json']);
    assert.strictEqual(r.status, 0, `normal query should work: ${r.stderr}`);
    const data = JSON.parse(r.stdout).data;
    assert.ok(Array.isArray(data.records) && data.records.length > 0, 'should return records');
  });
});
