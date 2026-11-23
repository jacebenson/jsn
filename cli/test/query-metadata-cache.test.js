import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTableMetadata, resolveField } from '../src/query-metadata.js';
import { createQueryMetadataCache, identityKey } from '../src/query-cache.js';

const id = letter => letter.repeat(32);
const ref = value => ({ value });

function fixture({ deny = '', fail = '', empty = false, truncated = false, parentHidden = false } = {}) {
  const calls = [];
  const sdk = {
    async list(table, params) {
      calls.push({ table, query: params.get('sysparm_query'), fields: params.get('sysparm_fields'), limit: params.get('sysparm_limit') });
      if (deny === table) throw Object.assign(new Error('Access denied'), { status: 403 });
      if (fail === table) throw Object.assign(new Error('Server error'), { status: 500 });
      if (table === 'sys_db_object') {
        const query = params.get('sysparm_query');
        if (empty) return [];
        if (query === 'name=x_case') return [{ sys_id: id('a'), name: 'x_case', super_class: ref(id('b')) }];
        if (parentHidden) return [];
        if (query === `sys_id=${id('b')}`) return [{ sys_id: id('b'), name: 'task', super_class: '' }];
        return [];
      }
      if (table === 'sys_dictionary') {
        const rows = [
          { sys_id: id('c'), name: 'x_case', element: 'short_description', internal_type: 'string', reference: '' },
          { sys_id: id('d'), name: 'x_case', element: 'assigned_to', internal_type: 'reference', reference: 'sys_user' },
          { sys_id: id('e'), name: 'task', element: 'number', internal_type: 'string', reference: '' },
          { sys_id: id('f'), name: 'task', element: 'parent', internal_type: 'reference', reference: 'task' },
        ];
        if (truncated) return Array.from({ length: 1000 }, (_, i) => ({ sys_id: String(i).padStart(32, '0'), name: 'x_case', element: `f${i}`, internal_type: 'string', reference: '' }));
        return rows;
      }
      return [];
    },
  };
  return { sdk, calls };
}

test('metadata reads are table-scoped with exact requests and bounded ancestry', async () => {
  const { sdk, calls } = fixture();
  const metadata = await readTableMetadata(sdk, 'x_case');
  assert.equal(metadata.state, 'observed');
  assert.deepEqual(metadata.hierarchy, ['x_case', 'task']);
  assert.deepEqual(calls, [
    { table: 'sys_db_object', query: 'name=x_case', fields: 'sys_id,name,super_class', limit: '2' },
    { table: 'sys_db_object', query: `sys_id=${id('b')}`, fields: 'sys_id,name,super_class', limit: '2' },
    { table: 'sys_dictionary', query: 'nameINx_case,task^elementISNOTEMPTY', fields: 'sys_id,name,element,internal_type,reference', limit: '1000' },
  ]);
  assert.equal(resolveField(metadata, 'x_case', 'number').inherited, true);
  assert.equal(resolveField(metadata, 'x_case', 'assigned_to').reference, 'sys_user');
});

test('403 metadata is denied, never absence', async () => {
  const metadata = await readTableMetadata(fixture({ deny: 'sys_db_object' }).sdk, 'x_case');
  assert.equal(metadata.state, 'denied');
  assert.deepEqual(metadata.fields, {});
});

test('500/network metadata is unavailable', async () => {
  const metadata = await readTableMetadata(fixture({ fail: 'sys_dictionary' }).sdk, 'x_case');
  assert.equal(metadata.state, 'unavailable');
});

test('zero visible table rows is denied, not "table missing"', async () => {
  const metadata = await readTableMetadata(fixture({ empty: true }).sdk, 'x_case');
  assert.equal(metadata.state, 'denied');
  assert.match(metadata.reason, /not visible/);
});

test('hidden ancestor and truncated dictionary are incomplete', async () => {
  const hidden = await readTableMetadata(fixture({ parentHidden: true }).sdk, 'x_case');
  assert.equal(hidden.state, 'incomplete');
  const truncated = await readTableMetadata(fixture({ truncated: true }).sdk, 'x_case');
  assert.equal(truncated.state, 'incomplete');
  assert.match(truncated.reason, /incomplete/);
});

const identity = { instance: 'https://dev1.service-now.com', profile: 'work', principal: 'alice' };
const payload = { state: 'observed', hierarchy: ['x_case', 'task'], fields: { x_case: { short_description: { type: 'string', reference: '' } } } };

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'jsn549-cache-')); }

test('cache reuses within TTL across instances and expires after it, with 0600/0700', async () => {
  const dir = tmpDir();
  const first = createQueryMetadataCache({ identity, dir, ttlMs: 25 });
  first.set('x_case', payload);
  const file = path.join(dir, `${identityKey(identity, 'x_case')}.json`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const second = createQueryMetadataCache({ identity, dir, ttlMs: 25 });
  assert.deepEqual(second.get('x_case').payload.hierarchy, ['x_case', 'task']);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(second.get('x_case'), null);
});

test('cache is isolated by instance, profile and principal; unknown identity is memory-only', () => {
  const dir = tmpDir();
  createQueryMetadataCache({ identity, dir }).set('x_case', payload);
  assert.equal(createQueryMetadataCache({ identity: { ...identity, instance: 'https://dev2.service-now.com' }, dir }).get('x_case'), null);
  assert.equal(createQueryMetadataCache({ identity: { ...identity, profile: 'other' }, dir }).get('x_case'), null);
  assert.equal(createQueryMetadataCache({ identity: { ...identity, principal: 'bob' }, dir }).get('x_case'), null);
  const unknown = createQueryMetadataCache({ identity: { ...identity, principal: '' }, dir });
  assert.equal(unknown.persistent, false);
  unknown.set('x_case', payload);
  assert.ok(unknown.get('x_case'));
  assert.equal(createQueryMetadataCache({ identity: { ...identity, principal: '' }, dir }).get('x_case'), null);
});

test('explicit refresh and affected-entry invalidation remove only the right entries', () => {
  const dir = tmpDir();
  const cache = createQueryMetadataCache({ identity, dir });
  cache.set('x_case', payload);
  cache.set('incident', payload);
  cache.refresh('x_case');
  assert.equal(cache.get('x_case'), null);
  assert.ok(cache.get('incident'));
  cache.set('x_case', payload);
  cache.invalidate({ tables: ['x_case'] });
  assert.equal(cache.get('x_case'), null);
  assert.ok(cache.get('incident'));
});

test('corrupt, malformed and foreign cache entries are rejected', () => {
  const dir = tmpDir();
  const cache = createQueryMetadataCache({ identity, dir });
  cache.set('x_case', payload);
  const file = path.join(dir, `${identityKey(identity, 'x_case')}.json`);
  fs.writeFileSync(file, JSON.stringify({ version: 1, key: 'other', instance: identity.instance, profile: 'work', principal: 'alice', table: 'x_case', fetched_at: Date.now(), payload }));
  assert.equal(createQueryMetadataCache({ identity, dir }).get('x_case'), null);
  fs.writeFileSync(file, '{not json');
  assert.equal(createQueryMetadataCache({ identity, dir }).get('x_case'), null);
  fs.writeFileSync(file, JSON.stringify({ version: 1, key: identityKey(identity, 'x_case'), instance: identity.instance, profile: 'work', principal: 'alice', table: 'x_case', fetched_at: Date.now(), payload: { state: 'denied', hierarchy: ['x_case'], fields: {} } }));
  assert.equal(createQueryMetadataCache({ identity, dir }).get('x_case'), null);
});
