// Tests for `jsn completion` (issue #176) — yargs built-in shell completion.
// No instance required: 'completion' is in every middleware skip-list.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const CLI = path.resolve('bin/jsn.js');
const ENV = {
  ...process.env,
  JSN_NO_VERSION_CHECK: '1',
  JSN_NO_SKILL_CHECK: '1',
};

function runCompletion() {
  return spawnSync('node', [CLI, 'completion'], { encoding: 'utf-8', env: ENV });
}

// Simulate what the generated bash script does:
//   type_list=$(jsn --get-yargs-completions "${COMP_WORDS[@]}")
//   COMPREPLY=( $(compgen -W "${type_list}" -- ${cur_word}) )
// words includes the full command line, current word last ("" if just-spaced).
function yargsCompletions(words) {
  const r = spawnSync('node', [CLI, '--get-yargs-completions', ...words], {
    encoding: 'utf-8',
    env: ENV,
  });
  assert.strictEqual(r.status, 0, `probe failed for ${JSON.stringify(words)}: ${r.stderr}`);
  return r.stdout.split('\n').filter(Boolean);
}

// bash-side prefix filter
function compgen(wordlist, prefix) {
  return wordlist.filter((w) => w.startsWith(prefix));
}

describe('jsn completion', () => {
  it('prints a sourceable completion script without context headers or update notices', () => {
    const r = runCompletion();
    assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
    assert.match(r.stdout, /###-begin-jsn-completions-###/, 'missing completion begin marker');
    assert.match(r.stdout, /###-end-jsn-completions-###/, 'missing completion end marker');
    assert.match(r.stdout, /_jsn_yargs_completions/, 'missing completion function');
    assert.match(r.stdout, /complete .* _jsn_yargs_completions jsn/, 'missing complete registration');
    // Banners would break sourcing this output in a shell.
    assert.ok(!r.stdout.includes('Instance:'), 'context header leaked into stdout');
    assert.ok(!r.stdout.includes('⚠'), 'update notice leaked into stdout');
  });

  it('completes root commands on empty word', () => {
    const out = yargsCompletions(['jsn', '']);
    for (const cmd of ['incidents', 'changes', 'records', 'cmdb', 'completion']) {
      assert.ok(out.includes(cmd), `expected "${cmd}" in completions`);
    }
  });

  it('completes a root command prefix', () => {
    const out = yargsCompletions(['jsn', 'cha']);
    assert.deepStrictEqual(compgen(out, 'cha').sort(), ['change_request', 'changes']);
  });

  it('completes a prefix that is also an exact alias (#176 alias quirk)', () => {
    // "inc" is the alias for incidents. Plain yargs descends into the
    // incidents subcommands here, which can't prefix-match "inc" — the
    // custom filter merges root commands back in for the first word.
    const out = yargsCompletions(['jsn', 'inc']);
    assert.ok(compgen(out, 'inc').includes('incidents'), `expected incidents, got: ${out.join(' ')}`);
  });

  it('completes subcommands after a command', () => {
    const out = yargsCompletions(['jsn', 'incidents', '']);
    for (const sub of ['list', 'show', 'create', 'update', 'delete']) {
      assert.ok(out.includes(sub), `expected "${sub}" in incidents completions`);
    }
  });

  it('filters subcommands by prefix via compgen semantics', () => {
    const out = yargsCompletions(['jsn', 'incidents', 'l']);
    assert.deepStrictEqual(compgen(out, 'l'), ['list']);
  });

  it('completes global options after a dash prefix', () => {
    const out = yargsCompletions(['jsn', '--j']);
    assert.ok(compgen(out, '--j').includes('--json'), `expected --json, got: ${out.join(' ')}`);
  });

  it('appears in help output', () => {
    const r = spawnSync('node', [CLI, 'help'], { encoding: 'utf-8', env: ENV });
    assert.match(r.stdout + r.stderr, /completion/, '"completion" not mentioned in help output');
  });

  it('completion --help shows install instructions (not the script)', () => {
    const r = spawnSync('node', [CLI, 'completion', '--help'], { encoding: 'utf-8', env: ENV });
    assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    assert.match(r.stdout, /bash-completion/, 'missing bash install instructions');
    assert.match(r.stdout, /fish/, 'missing fish install instructions');
    assert.match(r.stdout, /zsh/, 'missing zsh install instructions');
    assert.ok(!r.stdout.includes('###-begin-jsn-completions-###'),
      '--help should show help, not dump the script');
  });

  it('hidden __completion plumbing command is not listed in completions', () => {
    const out = yargsCompletions(['jsn', '']);
    assert.ok(!out.includes('__completion'), '__completion leaked into completions');
  });
});
