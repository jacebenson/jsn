import { describe, it } from 'node:test';
import { isMutationCommand, MUTATION_COMMANDS } from '../src/mutations.js';
import assert from 'node:assert';

describe('mutations.js', () => {
  it('should have MUTATION_COMMANDS exported as an array', () => {
    assert.ok(Array.isArray(MUTATION_COMMANDS));
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

  it('should detect catalog create-item as mutation', () => {
    assert.strictEqual(isMutationCommand({ _: ['catalog', 'create-item'] }), true);
  });

  it('should not detect catalog list-items as mutation', () => {
    assert.strictEqual(isMutationCommand({ _: ['catalog', 'list-items'] }), false);
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
});
