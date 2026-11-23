import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEncodedQuery, validateReadQuery, assertWriteQuery } from '../src/query-validate.js';

function fixture(parent = '') {
  const state = { calls: 0, writes: 0 };
  const sdk = {
    async list(table, params, opts = {}) {
      state.calls++;
      const rows = table === 'sys_db_object'
        ? [{ sys_id: 'a'.repeat(32), name: 'task', super_class: parent }]
        : ['name', 'nameINTERNAL', 'ref'].map(element => ({ name: 'task', element,
          internal_type: element === 'ref' ? 'reference' : 'string', reference: element === 'ref' ? 'task' : '' }));
      if (opts.responseMetadata) opts.responseMetadata.total = rows.length;
      return rows;
    },
    async listStrict(...args) { return sdk.list(...args); },
    async delete() { state.writes++; },
  };
  return { sdk, state };
}

test('invalid empty branches and empty filtered mutations reject locally before identity or schema', async () => {
  for (const query of ['', ' ', '^', 'OR', 'NQ', 'AND', '^EQ', 'name=x^OR', 'name=x^NQ', 'name=x^AND', 'name=x^OR^name=y']) {
    const { sdk, state } = fixture();
    await assert.rejects(assertWriteQuery({ sdk }, { table: 'task', query }), error => error.query_validation?.state === 'invalid', query);
    assert.deepEqual(state, { calls: 0, writes: 0 }, query);
    if (query.trim()) await assert.rejects(validateReadQuery({ sdk }, { table: 'task', query }));
    assert.equal(state.calls, 0, query);
  }
});

test('malformed or display-only ancestry is incomplete, never a proved root', async () => {
  for (const parent of [{}, { display_value: 'Task' }, { value: null }, null, [], 0, false]) {
    const { sdk, state } = fixture(parent);
    const verdict = await validateEncodedQuery({ sdk, table: 'task', query: 'name=value' });
    assert.equal(verdict.state, 'incomplete', JSON.stringify(parent));
    await assert.rejects(assertWriteQuery({ sdk }, { table: 'task', query: 'name=value' }));
    assert.equal(state.writes, 0);
  }
  for (const parent of ['', { value: '' }]) {
    const { sdk } = fixture(parent);
    assert.equal((await validateEncodedQuery({ sdk, table: 'task', query: 'name=value^EQ' })).state, 'valid');
  }
});

test('dot-walk operator ambiguity cannot prove only a shorter prefix', async () => {
  const { sdk, state } = fixture();
  for (const query of ['ref.nameINTERNAL.foo=x', 'ref.nameINTERNAL=x']) {
    const verdict = await validateReadQuery({ sdk }, { table: 'task', query });
    assert.equal(verdict.state, 'unsupported');
    assert.equal(verdict.query, query);
    assert.ok(verdict.diagnostics.some(d => d.code === 'ambiguous_dot_walk_operator'));
    await assert.rejects(assertWriteQuery({ sdk }, { table: 'task', query }));
  }
  for (const query of ['ref.name=x', 'nameINTERNAL=x', 'ref.name=x^EQ']) {
    assert.equal((await validateEncodedQuery({ sdk, table: 'task', query })).state, 'valid', query);
  }
  assert.equal(state.writes, 0);
});
