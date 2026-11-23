import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { SDKClient } from '../src/sdk.js';
import { App } from '../src/app.js';
import { validateEncodedQuery, validateReadQuery, assertWriteQuery } from '../src/query-validate.js';
import { createQueryMetadataCache, QUERY_CACHE_LIMITS } from '../src/query-cache.js';

let home;
const oldCacheHome = process.env.XDG_CACHE_HOME;
before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn549-completion-'));
  process.env.XDG_CACHE_HOME = home;
});
after(() => {
  if (oldCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = oldCacheHome;
  fs.rmSync(home, { recursive: true, force: true });
});
const payload = table => ({ state: 'observed', complete: true, source: 'table-api', total: 1,
  hierarchy: [table], fields: { [table]: { name: { type: 'string', reference: '' } } } });
const identity = { instance: 'https://fixture.invalid', profile: 'selected', principal: 'a'.repeat(32) };

async function provider(t) {
  const state = { principal: 'a', candidate: 'ok', table: 'incident', field: 'name', writes: 0, calls: [] };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    const query = url.searchParams.get('sysparm_query') || '';
    const table = url.pathname.split('/')[4];
    state.calls.push({ method: req.method, table, query, fields: url.searchParams.get('sysparm_fields'), limit: url.searchParams.get('sysparm_limit') });
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/angular.do') return res.end(JSON.stringify({ result: {} }));
    let rows;
    if (req.method !== 'GET') {
      state.writes++;
      let body = ''; for await (const chunk of req) body += chunk;
      const data = JSON.parse(body || '{}');
      state.table = data.name || state.table;
      state.field = 'renamed_field';
      return res.end(JSON.stringify({ result: { sys_id: 'c'.repeat(32), ...data } }));
    }
    if (table === 'sys_user') rows = [{ sys_id: state.principal.repeat(32), user_name: state.principal === 'a' ? 'alice' : 'bob' }];
    else if (table === 'sys_db_object' && query.startsWith('nameSTARTSWITH')) {
      if (state.candidate !== 'ok') { res.statusCode = state.candidate === 'denied' ? 403 : 503; return res.end('{}'); }
      rows = [{ name: 'incident' }, { name: 'incognito' }, { name: 'sys_user' }, { name: 'incident^ORname=secret' }];
    } else if (table === 'sys_db_object') rows = query === `name=${state.table}` ? [{ sys_id: 'c'.repeat(32), name: state.table, super_class: '' }] : [];
    else if (table === 'sys_dictionary') {
      const element = state.principal === 'a' ? state.field : 'public_name';
      rows = [{ name: state.table, element, internal_type: 'string', reference: '' }];
    } else rows = [];
    res.setHeader('X-Total-Count', String(rows.length));
    res.end(JSON.stringify({ result: rows }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const instance = `http://127.0.0.1:${server.address().port}`;
  const sdk = new SDKClient(instance, { getCredentials: () => ({ auth_method: 'basic', username: 'fixture', password: 'fixture-only' }) });
  const app = { sdk, config: { activeProfile: 'selected' }, session: { username: 'configured-expectation' }, getEffectiveInstance: () => instance };
  return { state, app, instance };
}

test('unresolved table suggests only bounded accessible close names, never substitutes or writes', async t => {
  const { app, state } = await provider(t);
  const verdict = await validateReadQuery(app, { table: 'incidnet', query: 'name=fixture' });
  assert.notEqual(verdict.state, 'valid');
  assert.deepEqual(verdict.diagnostics[0].suggestions, ['incident']);
  assert.match(verdict.diagnostics[0].message, /not visible|incomplete/);
  assert.equal(verdict.query, 'name=fixture');
  const suggestions = state.calls.filter(call => call.query.startsWith('nameSTARTSWITH'));
  assert.deepEqual(suggestions, [{ method: 'GET', table: 'sys_db_object', query: 'nameSTARTSWITHinc^ORDERBYname', fields: 'name', limit: '20' }]);
  assert.equal(state.calls.filter(call => call.table === 'sys_dictionary').length, 0);
  await assert.rejects(assertWriteQuery(app, { table: 'incidnet', query: 'name=fixture' }), error => error.query_validation.diagnostics[0].suggestions.includes('incident'));
  assert.equal(state.writes, 0);
});

for (const candidate of ['denied', 'unavailable']) test(`candidate lookup ${candidate} stays unverified, uncached and zero-write`, async t => {
  const { app, state } = await provider(t);
  state.candidate = candidate;
  for (let n = 0; n < 2; n++) {
    const verdict = await validateReadQuery(app, { table: 'incidnet', query: 'name=fixture' });
    assert.notEqual(verdict.state, 'valid');
    assert.deepEqual(verdict.diagnostics[0].suggestions || [], []);
  }
  assert.equal(state.calls.filter(call => call.query.startsWith('nameSTARTSWITH')).length, 2);
  state.candidate = 'ok';
  const recovered = await validateReadQuery(app, { table: 'incidnet', query: 'name=fixture' });
  assert.deepEqual(recovered.diagnostics[0].suggestions, ['incident']);
  await assert.rejects(assertWriteQuery(app, { table: 'incidnet', query: 'name=fixture' }));
  assert.equal(state.writes, 0);
});

test('actual authenticated principal switch cannot reuse A fields or suggestions for B', async t => {
  const { app, state } = await provider(t);
  state.field = 'private_name';
  assert.equal((await validateReadQuery(app, { table: 'incident', query: 'private_name=value' })).state, 'valid');
  const aDiagnostic = await validateReadQuery(app, { table: 'incident', query: 'private_nam=value' });
  assert.ok(aDiagnostic.diagnostics[0].suggestions.includes('private_name'));
  const before = state.calls.filter(call => call.table === 'sys_dictionary').length;
  if (process.platform !== 'win32') assert.equal(before, 1, 'A metadata must actually be reused within TTL before the switch');
  state.principal = 'b';
  const verdict = await validateReadQuery(app, { table: 'incident', query: 'private_name=value' });
  assert.equal(verdict.state, 'incomplete');
  assert.equal(state.calls.filter(call => call.table === 'sys_dictionary').length, before + 1);
  assert.equal(JSON.stringify(verdict).includes('alice'), false);
  assert.equal(verdict.diagnostics.some(d => d.suggestions?.includes('private_name')), false);
  assert.equal((await validateReadQuery(app, { table: 'incident', query: 'public_name=value' })).state, 'valid');
  await assert.rejects(assertWriteQuery(app, { table: 'incident', query: 'private_name=value' }));
  assert.equal(state.writes, 0);
});

test('successful schema rename via public SDK invalidates old, new and dependent metadata', async t => {
  const { app, state, instance } = await provider(t);
  // The same callback installation as App._buildSdk, without constructing personal auth.
  const owner = Object.create(App.prototype);
  Object.assign(owner, app, { auth: { createProfileProvider: () => ({ getCredentials: () => ({ auth_method: 'basic', username: 'fixture', password: 'fixture-only' }) }) } });
  owner._buildSdk(instance, {});
  assert.equal((await validateReadQuery(owner, { table: 'incident', query: 'name=value' })).state, 'valid');
  const cache = createQueryMetadataCache({ identity: { ...identity, instance } });
  cache.set('renamed_incident', payload('renamed_incident'));
  cache.set('child', { ...payload('child'), hierarchy: ['child', 'incident'] });
  cache.set('referencing', { ...payload('referencing'), fields: { referencing: { name: { type: 'reference', reference: 'incident' } } } });
  if (process.platform !== 'win32') for (const table of ['incident', 'renamed_incident', 'child', 'referencing']) assert.ok(createQueryMetadataCache({ identity: { ...identity, instance } }).get(table), table);
  await owner.sdk.update('sys_db_object', 'c'.repeat(32), { name: 'renamed_incident' });
  assert.equal(state.writes, 1);
  for (const table of ['incident', 'renamed_incident', 'child', 'referencing']) assert.equal(createQueryMetadataCache({ identity: { ...identity, instance } }).get(table), null, table);
  const refreshed = await validateReadQuery(owner, { table: 'renamed_incident', query: 'renamed_field=value' });
  assert.equal(refreshed.state, 'valid');
  const old = await validateReadQuery(owner, { table: 'incident', query: 'name=value' });
  assert.notEqual(old.state, 'valid');
});

test('cache enforces entry and total-byte bounds deterministically on disk and memory', () => {
  const dir = fs.mkdtempSync(path.join(home, 'bounds-'));
  const cache = createQueryMetadataCache({ identity, dir });
  for (let n = 0; n < QUERY_CACHE_LIMITS.entries + 5; n++) cache.set(`table_${n}`, payload(`table_${n}`));
  const files = () => fs.readdirSync(dir).filter(name => name.endsWith('.json'));
  assert.equal(files().length, process.platform === 'win32' ? 0 : QUERY_CACHE_LIMITS.entries);
  const large = table => { const value = payload(table); value.fields[table].name.type = 's'.repeat(220000); return value; };
  const memory = createQueryMetadataCache({ identity: {} });
  const oversized = payload('oversized'); oversized.fields.oversized.name.type = 'x'.repeat(QUERY_CACHE_LIMITS.entryBytes);
  assert.equal(cache.set('oversized', oversized), null);
  assert.equal(memory.set('oversized', oversized), null);
  assert.equal(memory.get('oversized'), null);
  for (let n = 0; n < 45; n++) { cache.set(`large_${n}`, large(`large_${n}`)); memory.set(`large_${n}`, large(`large_${n}`)); }
  assert.ok(files().length <= QUERY_CACHE_LIMITS.entries);
  assert.ok(files().reduce((bytes, name) => bytes + fs.statSync(path.join(dir, name)).size, 0) <= QUERY_CACHE_LIMITS.bytes);
  let memoryBytes = 0;
  for (let n = 0; n < 45; n++) { const hit = memory.get(`large_${n}`); if (hit) memoryBytes += Buffer.byteLength(JSON.stringify(hit.payload)); }
  assert.ok(memoryBytes <= QUERY_CACHE_LIMITS.bytes, 'memory must be byte-bounded too');
});

test('field-comparison, hierarchy and range operand families never validate just the left side', async t => {
  const { app } = await provider(t);
  for (const query of ['nameSAMEASbogus', 'nameNSAMEASbogus', 'nameINSTANCEOFguessed_class', 'nameBETWEENa@b']) {
    const verdict = await validateEncodedQuery({ sdk: app.sdk, table: 'incident', query });
    assert.equal(verdict.state, 'unsupported', query);
    assert.equal(verdict.query, query);
    assert.ok(verdict.diagnostics.some(d => d.term === query && d.code === 'unsupported_operands'));
    await assert.rejects(assertWriteQuery(app, { table: 'incident', query }));
  }
});

test('Windows policy is explicitly memory-only and never touches disk paths', () => {
  const dir = path.join(home, 'windows-disabled');
  const cache = createQueryMetadataCache({ identity, dir, platform: 'win32' });
  assert.equal(cache.persistent, false);
  cache.set('incident', payload('incident'));
  assert.ok(cache.get('incident'));
  assert.equal(fs.existsSync(dir), false);
  assert.equal(createQueryMetadataCache({ identity, dir, platform: 'win32' }).get('incident'), null);
  cache.refresh('incident');
  assert.equal(cache.get('incident'), null);
  assert.deepEqual(cache.invalidate({ all: true }), { removed: 0 });
  assert.equal(fs.existsSync(dir), false);
});
