// Tests for the capability registry (src/capabilities.js) — the single
// source of truth for command metadata. Command modules declare their
// capabilities once at the definition site; cli.js derives its middleware
// skip-lists and the mutation guard from the registry.

import { describe, it } from 'node:test';
import assert from 'node:assert';

// Importing cli.js runs buildCLI() at module scope, which runs every command
// factory — that is what populates the capability registry.
import '../src/cli.js';
import {
  collectCapabilities,
  mutationPaths,
  noInstanceCommands,
  dailyCheckSkipCommands,
} from '../src/capabilities.js';

describe('capabilities registry', () => {
  it('collects capabilities declared by command modules', () => {
    const caps = collectCapabilities();
    // Spot-check a factory-built CRUD command
    assert.deepStrictEqual(caps.get('incidents'), {
      mutationSubcommands: ['create', 'update', 'delete'],
    });
    // A read-only factory command declares no mutations
    assert.deepStrictEqual(caps.get('sppages'), { mutationSubcommands: [] });
    // No-instance commands declare themselves
    assert.deepStrictEqual(caps.get('auth'), { noInstance: true });
    assert.deepStrictEqual(caps.get('setup'), { noInstance: true });
    assert.deepStrictEqual(caps.get('skill'), { noInstance: true, skipDailyChecks: true });
    assert.deepStrictEqual(caps.get('docs'), { noInstance: true, skipDailyChecks: true });
    // Built-ins
    assert.deepStrictEqual(caps.get('help'), { noInstance: true, skipDailyChecks: true });
    assert.deepStrictEqual(caps.get('completion'), { noInstance: true, skipDailyChecks: true });
  });

  it('marks the real catalogitems create as a mutation (regression: mutations.js registered catalog create-item)', () => {
    const mutations = mutationPaths();
    assert.ok(
      mutations.some((p) => p[0] === 'catalogitems' && p[1] === 'create'),
      `expected ['catalogitems','create'] in mutation paths, got: ${JSON.stringify(mutations.filter((p) => p[0] === 'catalogitems' || p[0] === 'catalog'))}`
    );
    // And the stale hand-maintained spelling is gone
    assert.ok(!mutations.some((p) => p[0] === 'catalog' && p[1] === 'create-item'));
  });

  it('does not include the unregistered restmethods command (dead entry)', () => {
    const caps = collectCapabilities();
    assert.ok(!caps.has('restmethods'), 'restmethods must not be in the capability registry');
    const mutations = mutationPaths(caps);
    assert.ok(!mutations.some((p) => p.includes('restmethods')));
  });

  it('uipolicies resolves to a single registered command', async () => {
    const { buildCLI } = await import('../src/cli.js');
    const cli = buildCLI();
    const handlers = cli.getInternalMethods().getCommandInstance().getCommandHandlers();
    assert.ok('uipolicies' in handlers);
    const caps = collectCapabilities();
    assert.deepStrictEqual(caps.get('uipolicies'), {
      mutationSubcommands: ['create', 'update', 'delete'],
    });
  });

  it('derives noInstanceCommands with the exact legacy skip-list semantics', () => {
    const skip = noInstanceCommands();
    for (const cmd of ['help', 'version', 'completion', 'setup', 'auth', 'skill', 'docs']) {
      assert.ok(skip.has(cmd), `expected ${cmd} in noInstance skip set`);
    }
    // And nothing instance-bound leaks in
    assert.ok(!skip.has('incidents'));
    assert.ok(!skip.has('records'));
  });

  it('derives dailyCheckSkipCommands with the exact legacy 5-item semantics', () => {
    const skip = dailyCheckSkipCommands();
    assert.deepStrictEqual([...skip].sort(), ['completion', 'docs', 'help', 'skill', 'version']);
  });

  it('derives mutation paths for root CRUD commands', () => {
    const mutations = mutationPaths();
    const has = (path) => mutations.some((p) => p.join('') === path.join(''));
    // Factory CRUD: root
    assert.ok(has(['includes', 'create']));
    assert.ok(has(['rules', 'update']));
    // Read-only factory commands are absent
    assert.ok(!has(['sppages', 'create']));
    assert.ok(!has(['import', 'create']));
    // eval + rest
    assert.ok(has(['eval']));
    assert.ok(has(['rest']));
    // scopes / domains / updatesets specials
    assert.ok(has(['scopes', 'set']));
    assert.ok(has(['domains', 'set']));
    assert.ok(has(['updatesets', 'complete']));
    // tickets, users, groups, catalogitems
    assert.ok(has(['tickets', 'create']));
    assert.ok(has(['users', 'delete']));
    assert.ok(has(['groups', 'update']));
    // records bulk + attachments add
    assert.ok(has(['records', 'bulk']));
    assert.ok(has(['records', 'attachments', 'add']));
    // atf + approvals
    assert.ok(has(['atf', 'run']));
    assert.ok(has(['atf', 'run-suite']));
    assert.ok(has(['approvals', 'approve']));
    assert.ok(has(['approvals', 'reject']));
    assert.ok(has(['approvals', 'submit']));
  });
});
