// Tests for `jsn codesearch` (issue #180) — sn_codesearch plugin REST API.
// Unit-level: command shape + output formatting (no instance).
// Live API probe is covered manually / in cli-e2e (requires a PDI with
// the sn_codesearch plugin active).

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { flattenHits } from '../src/commands/codesearch.js';

const CLI = path.resolve('bin/jsn.js');
const ENV = {
  ...process.env,
  JSN_NO_VERSION_CHECK: '1',
  JSN_NO_SKILL_CHECK: '1',
};

function run(args) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf-8', env: ENV });
}

describe('codesearch command', () => {
  it('is registered and shows in help', () => {
    const r = run(['help']);
    assert.match(r.stdout + r.stderr, /codesearch/, 'codesearch missing from help');
  });

  it('has a search subcommand with a term argument', () => {
    const r = run(['codesearch', '--help']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /search/);
  });

  it('errors with usage when no term is given', () => {
    const r = run(['codesearch', 'search', '--json']);
    // yargs demands <term> — should exit non-zero with a usage error
    assert.notStrictEqual(r.status, 0, 'should fail without a term');
  });

  it('documents --table, --scope, --limit, --search-group options', () => {
    const r = run(['codesearch', 'search', '--help']);
    assert.strictEqual(r.status, 0, r.stderr);
    for (const opt of ['--table', '--scope', '--limit', '--search-group']) {
      assert.ok(r.stdout.includes(opt), `missing option ${opt}`);
    }
  });
});

describe('flattenHits', () => {
  const hit = {
    recordType: 'sys_ui_page',
    hits: [{
      name: '$pwd_change',
      className: 'sys_ui_page',
      sys_id: 'abc123',
      matches: [{
        field: 'client_script',
        lineMatches: [
          { line: 152, context: "  var ga = new GlideAjax('PwdAjax');" },
          { line: 153, context: "  ga.addParam('x', 'y');" },
          { line: 154, context: '' }, // blank context lines are skipped
        ],
      }],
    }],
  };

  it('flattens the array shape (default search)', () => {
    const rows = flattenHits([hit]);
    assert.strictEqual(rows.length, 1);
    assert.deepStrictEqual(rows[0], {
      table: 'sys_ui_page',
      name: '$pwd_change',
      field: 'client_script',
      lines: '152,153',
      matches: 2,
      context: "var ga = new GlideAjax('PwdAjax');",
      sys_id: 'abc123',
    });
  });

  it('flattens the single-object shape (--table filter)', () => {
    const rows = flattenHits(hit);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].name, '$pwd_change');
  });

  it('handles empty/missing result', () => {
    assert.deepStrictEqual(flattenHits(null), []);
    assert.deepStrictEqual(flattenHits(undefined), []);
    assert.deepStrictEqual(flattenHits([]), []);
    assert.deepStrictEqual(flattenHits({}), []);
  });
});
