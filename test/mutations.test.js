import { describe, it } from 'node:test';
import { isMutationCommand, MUTATION_COMMANDS } from '../src/mutations.js';
import assert from 'node:assert';

// The mutation path data is derived from the capability registry, which is
// populated when command factories run — i.e. when cli.js is loaded.
// Import it for its side effect before any isMutationCommand() call.
import '../src/cli.js';

describe('mutations.js', () => {
  it('should have MUTATION_COMMANDS exported as an array', () => {
    assert.ok(Array.isArray(MUTATION_COMMANDS));
    // Populated at CLI build time (buildCLI → refreshMutationCommands)
    assert.ok(MUTATION_COMMANDS.length > 0);
  });

  it('should detect incidents create as mutation', () => {
    assert.strictEqual(isMutationCommand({ _: ['incidents', 'create'] }), true);
  });

  it('should not detect incidents list as mutation', () => {
    assert.strictEqual(isMutationCommand({ _: ['incidents', 'list'] }), false);
  });

  it('should detect dev eval as mutation', () => {
    assert.strictEqual(isMutationCommand({ _: ['dev', 'eval'] }), true);
  });

  // Read-only bypass regression (issue #143): root `jsn eval` and
  // `jsn rest` were NOT in the registry — only the legacy dev forms were.
  it('should detect root eval as mutation', () => {
    assert.strictEqual(isMutationCommand({ _: ['eval'] }), true);
  });

  it('should detect rest as mutation in both forms', () => {
    assert.strictEqual(isMutationCommand({ _: ['rest'] }), true);
    assert.strictEqual(isMutationCommand({ _: ['dev', 'rest'] }), true);
  });

  it('should not detect auth switch as mutation', () => {
    assert.strictEqual(isMutationCommand({ _: ['auth', 'switch', 'foo'] }), false);
  });

  it('should detect records delete as mutation', () => {
    assert.strictEqual(isMutationCommand({ _: ['records', 'delete'] }), true);
  });

  it('should not detect help as mutation', () => {
    assert.strictEqual(isMutationCommand({ _: ['help'] }), false);
  });

  it('should not detect setup as mutation', () => {
    assert.strictEqual(isMutationCommand({ _: ['setup'] }), false);
  });

  it('should detect dev updatesets set as mutation', () => {
    assert.strictEqual(isMutationCommand({ _: ['dev', 'updatesets', 'set'] }), true);
  });

  it('should not detect dev updatesets list as mutation', () => {
    assert.strictEqual(isMutationCommand({ _: ['dev', 'updatesets', 'list'] }), false);
  });

  it('should detect dev scopes set as mutation', () => {
    assert.strictEqual(isMutationCommand({ _: ['dev', 'scopes', 'set'] }), true);
  });

  it('should not detect dev scopes list as mutation', () => {
    assert.strictEqual(isMutationCommand({ _: ['dev', 'scopes', 'list'] }), false);
  });

  it('should handle empty argv', () => {
    assert.strictEqual(isMutationCommand({ _: [] }), false);
  });

  // New commands from #97, #100, #102
  it('should detect tickets create as mutation', () => {
    assert.strictEqual(isMutationCommand({ _: ['tickets', 'create'] }), true);
  });

  it('should detect tickets update as mutation', () => {
    assert.strictEqual(isMutationCommand({ _: ['tickets', 'update'] }), true);
  });

  it('should detect tickets delete as mutation', () => {
    assert.strictEqual(isMutationCommand({ _: ['tickets', 'delete'] }), true);
  });

  it('should not detect tickets list as mutation', () => {
    assert.strictEqual(isMutationCommand({ _: ['tickets', 'list'] }), false);
  });

  it('should detect users create as mutation', () => {
    assert.strictEqual(isMutationCommand({ _: ['users', 'create'] }), true);
  });

  it('should not detect users list as mutation', () => {
    assert.strictEqual(isMutationCommand({ _: ['users', 'list'] }), false);
  });

  it('should detect groups delete as mutation', () => {
    assert.strictEqual(isMutationCommand({ _: ['groups', 'delete'] }), true);
  });

  // The real command is `catalogitems create` (src/commands/catalog.js).
  // The old hand-maintained registry listed ['catalog', 'create-item'],
  // a command that does not exist — the guard never fired on the real one.
  it('should detect catalogitems create as mutation', () => {
    assert.strictEqual(isMutationCommand({ _: ['catalogitems', 'create'] }), true);
  });

  it('should not detect catalogitems list as mutation', () => {
    assert.strictEqual(isMutationCommand({ _: ['catalogitems', 'list'] }), false);
  });

  it('should not detect catalog create-item (no such command)', () => {
    assert.strictEqual(isMutationCommand({ _: ['catalog', 'create-item'] }), false);
  });

  // Read-only bypass regression: the actual command is `catalogitems create`
  // (src/commands/catalog.js), but the hand-maintained registry listed
  // ['catalog', 'create-item'] — so `jsn catalogitems create` bypassed the
  // read-only profile guard entirely.
  it('should detect catalogitems create as mutation (registry-derived)', async () => {
    // Importing cli.js runs buildCLI() at module scope, populating the
    // capability registry the derived paths come from.
    await import('../src/cli.js');
    const { mutationPaths } = await import('../src/capabilities.js');
    const paths = mutationPaths();
    assert.strictEqual(isMutationCommand({ _: ['catalogitems', 'create'] }, paths), true);
    assert.strictEqual(isMutationCommand({ _: ['catalogitems', 'list'] }, paths), false);
    assert.strictEqual(isMutationCommand({ _: ['catalogitems', 'show', 'abc'] }, paths), false);
  });

  it('should not flag unregistered commands when derived (restmethods dead entry)', async () => {
    await import('../src/cli.js');
    const { mutationPaths } = await import('../src/capabilities.js');
    const paths = mutationPaths();
    // restmethods is never registered in cli.js — it must not appear in the
    // derived mutation surface.
    assert.strictEqual(isMutationCommand({ _: ['restmethods', 'create'] }, paths), false);
  });

  it('should detect dev flows create as mutation', () => {
    assert.strictEqual(isMutationCommand({ _: ['dev', 'flows', 'create'] }), true);
  });

  it('should not detect dev flows list as mutation', () => {
    assert.strictEqual(isMutationCommand({ _: ['dev', 'flows', 'list'] }), false);
  });

  it('should detect dev scopes create as mutation', () => {
    assert.strictEqual(isMutationCommand({ _: ['dev', 'scopes', 'create'] }), true);
  });

  // Dev CRUD registry expansion (read_only enforcement coverage)
  it('should detect root dev CRUD create as mutation', () => {
    assert.strictEqual(isMutationCommand({ _: ['includes', 'create'] }), true);
    assert.strictEqual(isMutationCommand({ _: ['rules', 'create'] }), true);
    assert.strictEqual(isMutationCommand({ _: ['acls', 'create'] }), true);
  });

  it('should detect dev-prefixed CRUD create/update/delete as mutations', () => {
    assert.strictEqual(isMutationCommand({ _: ['dev', 'includes', 'update'] }), true);
    assert.strictEqual(isMutationCommand({ _: ['dev', 'rules', 'delete'] }), true);
    assert.strictEqual(isMutationCommand({ _: ['dev', 'clientscripts', 'update'] }), true);
    assert.strictEqual(isMutationCommand({ _: ['dev', 'uiactions', 'create'] }), true);
    assert.strictEqual(isMutationCommand({ _: ['dev', 'acls', 'delete'] }), true);
  });

  it('should not detect read-only dev commands as mutations', () => {
    assert.strictEqual(isMutationCommand({ _: ['sppages', 'create'] }), false);
    assert.strictEqual(isMutationCommand({ _: ['dev', 'sppages', 'create'] }), false);
    assert.strictEqual(isMutationCommand({ _: ['import', 'create'] }), false);
  });

  it('should detect root scopes and updatesets set/create as mutations', () => {
    assert.strictEqual(isMutationCommand({ _: ['scopes', 'set'] }), true);
    assert.strictEqual(isMutationCommand({ _: ['updatesets', 'create'] }), true);
  });

  it('should detect atf run and run-suite as mutations', () => {
    assert.strictEqual(isMutationCommand({ _: ['atf', 'run'] }), true);
    assert.strictEqual(isMutationCommand({ _: ['atf', 'run', 'abc123'] }), true); // trailing positional
    assert.strictEqual(isMutationCommand({ _: ['atf', 'run-suite'] }), true);
  });

  it('should not detect read-only atf commands as mutations', () => {
    assert.strictEqual(isMutationCommand({ _: ['atf', 'list'] }), false);
    assert.strictEqual(isMutationCommand({ _: ['atf', 'suites'] }), false);
    assert.strictEqual(isMutationCommand({ _: ['atf', 'results', 'abc123'] }), false);
  });

  it('should detect approvals approve/reject/submit as mutations', () => {
    assert.strictEqual(isMutationCommand({ _: ['approvals', 'approve'] }), true);
    assert.strictEqual(isMutationCommand({ _: ['approvals', 'approve', 'abc123'] }), true); // trailing positional
    assert.strictEqual(isMutationCommand({ _: ['approvals', 'reject'] }), true);
    assert.strictEqual(isMutationCommand({ _: ['approvals', 'submit'] }), true);
  });

  it('should not detect read-only approvals commands as mutations', () => {
    assert.strictEqual(isMutationCommand({ _: ['approvals', 'list'] }), false);
    assert.strictEqual(isMutationCommand({ _: ['approvals', 'history', 'CHG001'] }), false);
  });
});
