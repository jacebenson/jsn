import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { buildRecordPayload, parseFieldPairs } from '../src/helpers.js';
import { recordsCmd } from '../src/commands/records.js';
import { incidentsCmd } from '../src/commands/incidents.js';
import { ticketsCmd } from '../src/commands/tickets.js';
import { captureSubcommands, findCommand, wrapHandler } from './support/command-test-helpers.js';
import { makeApp } from './support/app-test-helpers.js';

function command(module, name) {
  return findCommand(captureSubcommands(module(wrapHandler)), name);
}

const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));

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

/**
 * The handler-level tests above pass `field` as a pre-built array, so they
 * cannot see the parser. A repeatable option declared `array: true` used to
 * survive only as its LAST value through the real parser, sending one field of
 * three. Drive the actual binary against a real HTTP endpoint to keep that
 * silent drop from coming back.
 */
describe('repeated -f survives the real CLI parser', () => {
  it('sends every field pair over the wire, in order, as strings', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jsn-field-pairs-e2e-'));
    const requests = [];
    const record = { sys_id: 'abc123def456', number: 'INC0010023', state: '1', priority: '3', short_description: 'old' };
    const server = http.createServer(async (request, response) => {
      const body = [];
      for await (const chunk of request) body.push(chunk);
      const url = new URL(request.url, 'http://fixture.invalid');
      requests.push({ method: request.method, path: url.pathname, body: Buffer.concat(body).toString() });
      response.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/api/now/table/sys_user') {
        response.end(JSON.stringify({ result: [{ sys_id: 'user-1', user_name: 'probe', name: 'Probe' }] }));
        return;
      }
      if (url.pathname.startsWith('/api/now/table/incident')) {
        if (request.method === 'GET') {
          response.end(JSON.stringify({ result: [record] }));
          return;
        }
        response.end(JSON.stringify({ result: { ...record, ...JSON.parse(Buffer.concat(body).toString() || '{}') } }));
        return;
      }
      response.end(JSON.stringify({ result: [] }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const instance = `http://127.0.0.1:${server.address().port}`;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SN_') && !key.startsWith('SERVICENOW_')));
    Object.assign(env, {
      JSN_DATA_HOME: path.join(directory, 'data'), XDG_CONFIG_HOME: directory, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1',
      SN_USERNAME: 'probe', SN_PASSWORD: 'probe',
    });

    // execFile (async) and not spawnSync: blocking the event loop would prevent
    // this in-process fixture server from ever answering the CLI.
    async function run(args) {
      try {
        return { ...(await promisify(execFile)(process.execPath, [cli, ...args], { cwd: directory, env, timeout: 30000 })), status: 0 };
      } catch (error) {
        return { status: error.code ?? 1, stdout: error.stdout || '', stderr: error.stderr || error.message };
      }
    }

    try {
      const login = await run(['auth', 'login', instance, '--name', 'probe', '--basic', '--skip-confirmations', '--make-default', '--json']);
      assert.equal(login.status, 0, login.stderr);

      const result = await run(['incidents', 'update', 'INC0010023',
        '-f', 'state=2',
        '-f', 'short_description=VPN down for 3 users',
        '-f', 'priority=1']);
      assert.equal(result.status, 0, result.stderr);

      const put = requests.find((entry) => entry.method === 'PUT');
      assert.ok(put, 'a PUT must be sent');
      assert.deepEqual(JSON.parse(put.body), {
        state: '2',
        short_description: 'VPN down for 3 users',
        priority: '1',
      });
    } finally {
      server.close();
    }
  });
});

