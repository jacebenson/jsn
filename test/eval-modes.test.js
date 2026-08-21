// Tests for `jsn eval` script-mode flags (issue #177) — mapping CLI flags to
// the sys.scripts.do form fields. No instance required: we unit-test the
// form-body builder and the CLI surface.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { buildScriptFormBody } from '../src/sdk.js';

const CLI = path.resolve('bin/jsn.js');
const ENV = {
  ...process.env,
  JSN_NO_VERSION_CHECK: '1',
  JSN_NO_SKILL_CHECK: '1',
};

function run(args, input = '', env = {}) {
  return spawnSync('node', [CLI, ...args], {
    encoding: 'utf-8',
    env: { ...ENV, ...env },
    input,
  });
}

// The --sandbox warning is emitted by the eval *handler*, which only runs
// after the middleware instance guard passes. With no instance configured the
// guard exits before the handler — so a bare env (CI) never sees the warning.
// These tests exercise the warning, so they need (a) an isolated empty config
// (no developer profile leaking in via ~/.config) and (b) a fake instance so
// the guard passes and the handler runs. The command then fails at auth —
// after the warning — which is what we assert on.
function isolatedEnv() {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-eval-test-'));
  return {
    XDG_CONFIG_HOME: cfgDir,
    SERVICENOW_INSTANCE_URL: 'https://nonexistent.invalid',
    SERVICENOW_USERNAME: 'fake',
    SERVICENOW_PASSWORD: 'fake',
  };
}

describe('buildScriptFormBody', () => {
  const base = { script: 'gs.info("hi")', csrf: 'TOKEN', scope: '' };

  it('defaults to rollback on + quota managed on (current behavior)', () => {
    const body = buildScriptFormBody(base);
    assert.strictEqual(body.get('record_for_rollback'), 'on');
    assert.strictEqual(body.get('quota_managed_transaction'), 'on');
    assert.strictEqual(body.get('sandbox'), null);
    assert.strictEqual(body.get('scriptlet'), null);
  });

  it('--no-rollback omits record_for_rollback', () => {
    const body = buildScriptFormBody({ ...base, rollback: false });
    assert.strictEqual(body.get('record_for_rollback'), null);
  });

  it('--sandbox sets sandbox field', () => {
    const body = buildScriptFormBody({ ...base, sandbox: true });
    assert.strictEqual(body.get('sandbox'), 'on');
  });

  it('--scriptlet sets scriptlet field', () => {
    const body = buildScriptFormBody({ ...base, scriptlet: true });
    assert.strictEqual(body.get('scriptlet'), 'on');
  });

  it('--no-quota-managed-transaction omits quota field', () => {
    const body = buildScriptFormBody({ ...base, quotaManagedTransaction: false });
    assert.strictEqual(body.get('quota_managed_transaction'), null);
  });

  it('always includes script, csrf token, runscript, and scope', () => {
    const body = buildScriptFormBody({ ...base, scope: 'abc123' });
    assert.strictEqual(body.get('script'), 'gs.info("hi")');
    assert.strictEqual(body.get('sysparm_ck'), 'TOKEN');
    assert.strictEqual(body.get('runscript'), 'Run script');
    assert.strictEqual(body.get('sys_scope'), 'abc123');
  });
});

describe('jsn eval flags', () => {
  it('documents the four script-mode flags', () => {
    const r = run(['eval', '--help']);
    assert.strictEqual(r.status, 0, r.stderr);
    for (const opt of ['--rollback', '--sandbox', '--scriptlet', '--quota-managed-transaction']) {
      assert.ok(r.stdout.includes(opt), `missing option ${opt}`);
    }
  });

  it('warns when --sandbox is combined with a multi-line script', () => {
    const r = run(['eval', '--stdin', '--sandbox', '--json'], 'var a = 1;\nvar b = 2;\ngs.info(a+b);', isolatedEnv());
    // Fake instance present so the guard passes and the handler runs; it then
    // fails at auth, but the sandbox warning is emitted first on stderr.
    assert.match(r.stderr, /sandbox/i);
    assert.match(r.stderr, /single expression|one expression|multi/i);
  });

  it('does not warn for single-expression --sandbox', () => {
    const r = run(['eval', '--stdin', '--sandbox', '--json'], '1 + 1', isolatedEnv());
    assert.ok(!/sandbox/i.test(r.stderr), `unexpected sandbox warning: ${r.stderr}`);
  });
});
