import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildRecordPayload, parseFieldPairs } from '../src/helpers.js';
import { recordsCmd } from '../src/commands/records.js';
import { incidentsCmd } from '../src/commands/incidents.js';
import { ticketsCmd } from '../src/commands/tickets.js';
import { captureSubcommands, findCommand, wrapHandler } from './support/command-test-helpers.js';
import { makeApp } from './support/app-test-helpers.js';

function command(module, name) {
  return findCommand(captureSubcommands(module(wrapHandler)), name);
}

function updateSdk({ records = [], resolvedId = 'sys-id-1' } = {}) {
  const updates = [];
  return {
    updates,
    sdk: {
      list: async () => records,
      update: async (table, id, body) => {
        updates.push({ table, id, body });
        return { sys_id: id, ...body };
      },
      aggregateCount: async () => records.length,
    },
    resolvedId,
  };
}

describe('field pair payloads', () => {
  it('parses repeated pairs, first equals only, empty values, duplicates, and @@', () => {
    assert.deepEqual(parseFieldPairs({ field: ['state=2', 'url=https://x.test?a=b=c', 'empty=', 'name=first', 'name=last', 'literal=@@file.txt'] }), {
      state: '2',
      url: 'https://x.test?a=b=c',
      empty: '',
      name: 'last',
      literal: '@file.txt',
    });
  });

  it('reads @file values and strips one UTF-8 BOM', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-field-pairs-'));
    const file = path.join(dir, 'notes.txt');
    fs.writeFileSync(file, '\ufeffline one\nline two');
    assert.deepEqual(parseFieldPairs({ field: [`work_notes=@${file}`] }), { work_notes: 'line one\nline two' });
  });

  it('reports malformed and invalid field names clearly', () => {
    assert.throws(() => parseFieldPairs({ field: 'state' }), /-f expects field=value, got "state"/);
    assert.throws(() => parseFieldPairs({ field: '=value' }), /valid field name/);
    assert.throws(() => parseFieldPairs({ field: ['short description=value'] }), /valid field name/);
    assert.throws(() => parseFieldPairs({ field: ['short-description=value'] }), /valid field name/);
  });

  it('merges JSON and fields with fields winning, and requires a source by default', () => {
    assert.deepEqual(buildRecordPayload({ data: '{"state":"1","priority":"3"}', field: ['state=2', 'active=false'] }), {
      state: '2', priority: '3', active: 'false',
    });
    assert.throws(() => buildRecordPayload({}), /Provide fields with -f name=value/);
    assert.deepEqual(buildRecordPayload({}, { required: false }), {});
  });
});

describe('registered mutation commands accept field pairs', () => {
  it('shows -f in the real incidents update help without the old quoting example', () => {
    const result = spawnSync(process.execPath, ['bin/jsn.js', 'incidents', 'update', '--help'], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /--field, -f/);
    assert.doesNotMatch(result.stdout, /--data '\{/);
  });

  it('records update sends exact string-valued body', async () => {
    const { updates, sdk } = updateSdk({ records: [{ sys_id: 'rec-1', state: '1', priority: '3', short_description: 'old' }] });
    const app = makeApp({ sdk });
    await command(recordsCmd, 'update').handler({ app, table: 'incident', 'sys-id': 'rec-1', field: ['state=2', 'priority=1', 'short_description=VPN down for 3 users'], strict: false });
    assert.deepEqual(updates[0], { table: 'incident', id: 'rec-1', body: { state: '2', priority: '1', short_description: 'VPN down for 3 users' } });
  });

  it('incidents update resolves the number and sends field pairs', async () => {
    const updates = [];
    const app = makeApp({ sdk: {
      list: async () => [{ sys_id: 'inc-sys-id', number: 'INC0010023' }],
      update: async (table, id, body) => { updates.push({ table, id, body }); return { sys_id: id, ...body }; },
    } });
    await command(incidentsCmd, 'update').handler({ app, number: 'INC0010023', field: ['state=2', 'short_description=VPN down for 3 users'] });
    assert.deepEqual(updates, [{ table: 'incident', id: 'inc-sys-id', body: { state: '2', short_description: 'VPN down for 3 users' } }]);
  });

  it('tickets update resolves the number and sends field pairs', async () => {
    const updates = [];
    const app = makeApp({ sdk: {
      list: async () => [{ sys_id: 'task-sys-id', number: 'TASK001' }],
      update: async (table, id, body) => { updates.push({ table, id, body }); return { sys_id: id, ...body }; },
    } });
    await command(ticketsCmd, 'update').handler({ app, number: 'TASK001', field: ['state=2', 'priority=1'] });
    assert.deepEqual(updates, [{ table: 'task', id: 'task-sys-id', body: { state: '2', priority: '1' } }]);
  });

  it('records bulk accepts several field pairs and keeps --set JSON compatible', async () => {
    const updates = [];
    const app = makeApp({ sdk: {
      aggregateCount: async () => 2,
      list: async () => [{ sys_id: 'a' }, { sys_id: 'b' }],
      update: async (table, id, body) => { updates.push({ table, id, body }); },
    } });
    const bulk = command(recordsCmd, 'bulk');
    await bulk.handler({ app, table: 'incident', query: 'priority=1', field: ['state=2', 'active=false'], 'dry-run': false, execute: true, force: true, limit: 200 });
    assert.deepEqual(updates, [
      { table: 'incident', id: 'a', body: { state: '2', active: 'false' } },
      { table: 'incident', id: 'b', body: { state: '2', active: 'false' } },
    ]);
    updates.length = 0;
    await bulk.handler({ app, table: 'incident', query: 'priority=1', set: '{"state":"3"}', 'dry-run': false, execute: true, force: true, limit: 200 });
    assert.deepEqual(updates[0].body, { state: '3' });
  });

  it('preserves the existing --data update body', async () => {
    const { updates, sdk } = updateSdk({ records: [{ sys_id: 'rec-1', state: '1' }] });
    const app = makeApp({ sdk });
    await command(recordsCmd, 'update').handler({ app, table: 'incident', 'sys-id': 'rec-1', data: '{"state":"2"}', strict: false });
    assert.deepEqual(updates[0].body, { state: '2' });
  });
});
