import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEncodedQuery, metadataIdentity, assertWriteQuery } from '../src/query-validate.js';
import { parseEncodedQuery } from '../src/query-parse.js';

const sdk = {
  async list(table, params, opts = {}) {
    const name = params.get('sysparm_query').slice(5);
    const rows = table === 'sys_db_object'
      ? [{ sys_id: 'a'.repeat(32), name, super_class: '' }]
      : ['ref', 'name', 'nameINTERNAL'].map(element => ({ name: 'task', element, internal_type: element === 'ref' ? 'reference' : 'string', reference: element === 'ref' ? 'task' : '' }));
    if (opts.responseMetadata) opts.responseMetadata.total = rows.length;
    return rows;
  },
};

test('dot-walk overflow is unverified and rejects filtered writes', async () => {
  const query = 'ref.ref.ref.ref.ref.ref.name=value';
  const verdict = await validateEncodedQuery({ sdk, table: 'task', query });
  assert.notEqual(verdict.state, 'valid');
  await assert.rejects(assertWriteQuery({ sdk }, { table: 'task', query }));
});

test('configured matching usernames do not prove authenticated principal', () => {
  assert.equal(metadataIdentity({ session: { username: 'alice' }, sdk: { username: 'alice' } }).principal, '');
});

test('spaced operators and platform expressions are preserved', () => {
  assert.equal(parseEncodedQuery('nameNOT INa,b').terms[0].field, 'name');
  for (const query of ['nameONtoday', 'nameNOTONtoday', 'nameRELATIVEGT@dayofweek@ago@1', 'nameDYNAMICabc', 'RLQUERYtask.ref,>=1^ENDRLQUERY', 'GROUPBYname']) {
    const parsed = parseEncodedQuery(query);
    assert.equal(parsed.invalid, false, query);
    assert.equal(parsed.unsupported, true, query);
    assert.equal(parsed.original, query);
  }
});

test('visible uppercase field boundary beats an embedded operator', async () => {
  const verdict = await validateEncodedQuery({ sdk, table: 'task', query: 'nameINTERNAL=value' });
  assert.equal(verdict.state, 'valid');
  assert.equal(verdict.terms[0].field, 'nameINTERNAL');
});

test('ordering fields and missing target cannot silently validate', async () => {
  assert.notEqual((await validateEncodedQuery({ sdk, table: 'task', query: 'ORDERBYhidden' })).state, 'valid');
  assert.notEqual((await validateEncodedQuery({ sdk, query: 'name=value' })).state, 'valid');
});
