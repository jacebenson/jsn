// Audit #1 + #8: group membership/role writes must be DECLARED mutations
// (instance + read-only guard), must reject unsafe exact-match identifiers,
// must confirm removals with a complete rerun hint, and the confirmation
// hint factory must never recommend a permanent bypass.
//
// Reproduction first (pre-fix evidence): a read-only profile could reach
// `jsn grouproles remove` because neither factory declared
// mutationSubcommands, and the non-interactive confirmation hint dropped
// the target and the pinned profile.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = path.resolve('bin/jsn.js');

// Importing the modules runs their top-level declareCapabilities() calls.
await import('../src/commands/groupmembers.js');
await import('../src/commands/grouproles.js');
const { isMutationCommand, refreshMutationCommands } = await import('../src/mutations.js');
const { collectCapabilities } = await import('../src/capabilities.js');
const { quoteShellArg, buildRerunCommand, confirmDelete } = await import('../src/helpers.js');
const { errConfirmationRequired } = await import('../src/errors.js');

refreshMutationCommands();

describe('group write commands are declared mutations', () => {
  it('classifies every add/remove path and leaves list alone', () => {
    const mutations = [
      ['groupmembers', 'add'],
      ['groupmembers', 'remove'],
      ['grouproles', 'add'],
      ['grouproles', 'remove'],
    ];
    for (const cmd of mutations) {
      assert.equal(isMutationCommand({ _: cmd }), true, `${cmd.join(' ')} must be a mutation`);
    }
    assert.equal(isMutationCommand({ _: ['groupmembers', 'list'] }), false);
    assert.equal(isMutationCommand({ _: ['grouproles', 'list'] }), false);
  });

  it('declares mutationSubcommands in the capability registry', () => {
    const caps = collectCapabilities();
    for (const name of ['groupmembers', 'grouproles']) {
      assert.deepEqual(caps.get(name)?.mutationSubcommands, ['add', 'remove'], `${name} must declare its mutations`);
    }
  });
});

const ENV_KEYS = ['SERVICENOW_INSTANCE_URL', 'SERVICENOW_FORMAT', 'SERVICENOW_PROFILE'];

function isolatedEnv(configHome, extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of ENV_KEYS) delete env[key];
  return {
    ...env,
    XDG_CONFIG_HOME: configHome,
    JSN_NO_VERSION_CHECK: '1',
    JSN_NO_SKILL_CHECK: '1',
    JSN_NO_PROMPTS: '1',
    JSN_NO_HEADER: '1', // never let the context header probe a fake instance
    TERM: 'dumb',
  };
}

function withConfig(profiles, activeProfile = 'rw') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-usability-group-'));
  const dir = path.join(home, 'servicenow');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    default_profile: activeProfile,
    active_profile: activeProfile,
    profiles,
  }, null, 2));
  return home;
}

const RO = { instance_url: 'https://ro.example.invalid', auth_method: 'oauth', read_only: true };
const RW = { instance_url: 'https://rw.example.invalid', auth_method: 'oauth' };

function runCli(args, configHome) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8',
    cwd: path.resolve('.'),
    env: isolatedEnv(configHome),
    timeout: 20000,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * Confirmation output is a JSON envelope on stdout when stdout is not a TTY
 * (auto format resolves to json) and human text on stderr otherwise. Return
 * the message + hint from whichever shape the run produced.
 */
function confirmationText({ stdout, stderr }) {
  try {
    const parsed = JSON.parse(stdout);
    if (parsed?.code === 'confirmation_required') return `${parsed.error}\n${parsed.hint}`;
  } catch {
    // not JSON — fall through to stderr
  }
  return stderr;
}

describe('read-only profiles cannot reach group writes', () => {
  // The guard must exit BEFORE any lookup: a "Group not found" / "User not
  // found" message would prove the handler ran against the instance.
  const cases = [
    [['groupmembers', 'remove', '--group', 'G', '--user', 'U', '--profile', 'ro'], 'groupmembers remove'],
    [['gm', 'remove', '--group', 'G', '--user', 'U', '--profile', 'ro'], 'groupmembers remove (alias gm)'],
    [['groupmembers', 'add', '--group', 'G', '--user', 'U', '--profile', 'ro'], 'groupmembers add'],
    [['grouproles', 'remove', '--group', 'G', '--role', 'R', '--profile', 'ro'], 'grouproles remove'],
    [['gr', 'add', '--group', 'G', '--role', 'R', '--profile', 'ro'], 'grouproles add (alias gr)'],
  ];

  for (const [args, label] of cases) {
    it(`blocks ${label} for a read-only profile without touching the table`, () => {
      const home = withConfig({ ro: RO, rw: RW });
      try {
        const { status, stdout, stderr } = runCli(args, home);
        const out = stdout + stderr;
        assert.notEqual(status, 0, 'must fail');
        assert.match(out, /read-only/i, `expected a read-only block, got: ${out}`);
        assert.doesNotMatch(out, /Group not found|User not found|Role not found/, 'guard must exit before any lookup');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

describe('removal confirmation hints carry the exact target', () => {
  it('groupmembers remove emits a re-runnable command with target and pinned profile', () => {
    const home = withConfig({ ro: RO, rw: RW });
    try {
      const { status, stdout, stderr } = runCli(
        ['groupmembers', 'remove', '--group', 'Group With Spaces', '--user', "o'brien", '--profile', 'rw'],
        home,
      );
      const out = confirmationText({ stdout, stderr });
      assert.notEqual(status, 0);
      assert.match(out, /confirmation required/);
      assert.match(out, /jsn groupmembers remove --group 'Group With Spaces' --user 'o'\\''brien' --profile rw --force/);
      assert.doesNotMatch(out, /Group not found|User not found/, 'confirmation must precede lookups');
      assert.doesNotMatch(out, /skip_confirmations/, 'must not recommend a permanent confirmation bypass');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('grouproles remove emits a re-runnable command with target and pinned instance', () => {
    const home = withConfig({ ro: RO, rw: RW });
    try {
      const { stdout, stderr } = runCli(
        ['grouproles', 'remove', '--group', 'G', '--role', 'R', '--instance', 'https://rw.example.invalid'],
        home,
      );
      const out = confirmationText({ stdout, stderr });
      assert.match(out, /grouproles remove --group G --role R --instance https:\/\/rw\.example\.invalid --force/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('unsafe exact-match identifiers are refused before any request', () => {
  for (const bad of ['a^b', 'a=b', 'a*b', 'a,b', 'a!b']) {
    it(`rejects ${JSON.stringify(bad)} without contacting the instance`, () => {
      const home = withConfig({ ro: RO, rw: RW });
      try {
        const { status, stdout, stderr } = runCli(
          ['groupmembers', 'add', '--group', bad, '--user', 'U', '--profile', 'rw', '--force'],
          home,
        );
        const out = stdout + stderr;
        assert.notEqual(status, 0);
        assert.match(out, /Unsafe identifier/, `expected a refusal for ${bad}, got: ${out}`);
        assert.doesNotMatch(out, /Group not found|User not found/);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

describe('confirmation hint factory', () => {
  it('quotes shell-hostile tokens and keeps safe ones bare', () => {
    assert.equal(quoteShellArg('INC0010001'), 'INC0010001');
    assert.equal(quoteShellArg('group.name=Team'), 'group.name=Team');
    assert.equal(quoteShellArg('two words'), "'two words'");
    assert.equal(quoteShellArg("it's"), "'it'\\''s'");
    assert.equal(quoteShellArg(''), "''");
    assert.equal(quoteShellArg('$(rm -rf /)'), "'$(rm -rf /)'");
  });

  it('reconstructs positional and flag-shaped targets with pinned profile/instance', () => {
    // incidents delete INC0010001 (positional) with a pinned profile
    assert.equal(
      buildRerunCommand({ _: ['incidents', 'delete'], number: 'INC0010001', profile: 'audit' },
        { rerun: ['incidents', 'delete', 'INC0010001'] }),
      'jsn incidents delete INC0010001 --profile audit'
    );
    // records delete --table incident --sys-id X (flag-shaped) with an instance pin
    assert.equal(
      buildRerunCommand({ _: ['records', 'delete'], instance: 'https://dev.example' },
        { rerun: ['records', 'delete', '--table', 'incident', '--sys-id', 'abc123'] }),
      'jsn records delete --table incident --sys-id abc123 --instance https://dev.example'
    );
  });

  it('returns no command when the path is unknowable instead of a bare "jsn"', () => {
    assert.equal(buildRerunCommand({}, {}), '');
  });

  it('confirmDelete surfaces the rerun command and no bypass advice', async () => {
    const app = { config: { activeProfile: 'audit', profiles: { audit: {} } } };
    await assert.rejects(
      () => confirmDelete(app, { _: ['incidents', 'delete'], number: 'INC0010001', profile: 'audit' },
        'Delete incident INC0010001?', { rerun: ['incidents', 'delete', 'INC0010001'] }),
      (err) => {
        assert.equal(err.code, 'confirmation_required');
        assert.match(err.hint, /jsn incidents delete INC0010001 --profile audit --force/);
        assert.doesNotMatch(err.message + err.hint, /skip_confirmations/);
        return true;
      }
    );
  });

  it('errConfirmationRequired degrades honestly when no rerun command is known', () => {
    const err = errConfirmationRequired('Delete thing X?', '');
    assert.equal(err.code, 'confirmation_required');
    assert.match(err.message, /--force/);
    assert.doesNotMatch(err.hint, /skip_confirmations/);
  });
});
