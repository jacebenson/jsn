import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureCommands } from './support/command-test-helpers.js';
import { incidentsCmd } from '../src/commands/incidents.js';
import { includesCmd } from '../src/commands/_simple.js';
import { requestsCmd } from '../src/commands/requests.js';
import { ticketsCmd } from '../src/commands/tickets.js';
import { OutputWriter } from '../src/output.js';
import http from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('factory, ticket and rich-request show commands expose related options and enrich only on request', async () => {
  for (const [factory, table] of [[includesCmd, 'sys_script_include'], [incidentsCmd, 'incident'], [requestsCmd, 'sc_req_item'], [ticketsCmd, 'task']]) {
    const entries = captureCommands(factory(fn => fn));
    const show = entries.filter(c => c.command.startsWith('show')).at(-1);
    const options = [];
    const y = { option(name) { options.push(name); return y; } };
    show.builder(y);
    for (const option of ['related', 'view', 'related-limit']) assert.ok(options.includes(option));
    const calls = [], sdk = { list: async () => [{ sys_id: 'raw-id', name: 'Named', number: 'INC001' }], fetchAttachments: async () => [], fetchCatalogVariables: async () => [] };
    let output;
    const app = { sdk, _relatedListReaderSDK: sdk, relatedListReader: { read: async request => { calls.push(request); return { nonempty: [], coverage: { state: 'observed' } }; } },
      getEffectiveInstance: () => 'https://fixture.invalid', ok: data => { output = data; } };
    await show.handler({ identifier: 'Named', number: 'INC001' }, app);
    assert.equal(calls.length, 0); assert.equal(output._related, undefined);
    await show.handler({ identifier: 'Named', number: 'INC001', related: true, view: 'custom' }, app);
    assert.equal(calls.length, 1); assert.equal(calls[0].table, table); assert.equal(calls[0].view, 'custom');
    assert.equal(calls[0].recordId, 'raw-id'); assert.equal(output._related.coverage.state, 'observed');
  }
});
test('human record output renders nonempty related counts, exact commands and coverage gaps', () => {
  let output = '';
  const writer = new OutputWriter({ format: 'styled', writer: { write: text => { output += text; } } });
  writer.ok({ sys_id: 'parent', number: 'INC001', _context: { table: 'incident' }, _related: {
    nonempty: [{ label: 'Children', count: 2, command: 'jsn records list --table x_child --query parent=parent' }],
    coverage: { state: 'partial', warnings: [{ source: 'denied', reason: 'Count unavailable' }] },
  } });
  assert.match(output, /Children: 2/); assert.match(output, /Retrieve: jsn records list/);
  assert.match(output, /Coverage: partial/); assert.match(output, /Count unavailable/);
});
test('actual specialized CLI --related performs aggregate reads and leaves supplementary records lazy', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jsn related show ')); let server;
  t.after(async () => { if (server?.listening) await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const requests = [], parent = 'a'.repeat(32);
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid'); requests.push(url);
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/angular.do') { response.end('{}'); return; }
    if (url.pathname === '/api/now/v1/batch') { response.statusCode = 404; response.end('{"error":"Batch endpoint unsupported in this fixture"}'); return; }
    assert.equal(request.method, 'GET');
    if (url.pathname === '/api/now/stats/x_child') {
      assert.equal(url.searchParams.get('sysparm_query'), `parent=${parent}`);
      response.end('{"result":{"stats":{"count":"2"}}}'); return;
    }
    const table = url.pathname.split('/').at(-1);
    const rows = {
      incident: [{ sys_id: parent, number: 'INC001', short_description: 'Fixture' }],
      sys_db_object: [{ sys_id: 'table-id', name: 'incident', super_class: '' }],
      sys_ui_view: [], sys_ui_form: [], sys_ui_related_list: [], sys_relationship: [], sys_scope: [],
      sys_dictionary: [{ sys_id: 'field-id', name: 'x_child', element: 'parent', reference: 'incident', column_label: 'Children' }],
    }[table];
    if (!rows) { response.statusCode = 500; response.end('{"error":"unexpected eager child read"}'); return; }
    response.end(JSON.stringify({ result: rows }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const instance = `http://127.0.0.1:${server.address().port}`;
  await fs.mkdir(path.join(directory, 'servicenow'));
  await fs.writeFile(path.join(directory, 'servicenow', 'config.json'), JSON.stringify({ profiles: { selected: { instance_url: instance, auth_method: 'basic', read_only: true } } }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SN_|SERVICENOW_)/i.test(key)));
  Object.assign(env, { XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, PATH: '', SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1', JSN_NO_HEADER: '1' });
  const execute = promisify(execFile), cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  async function run(flags) { requests.length = 0; return (await execute(process.execPath, [cli, '--profile', 'selected', 'incidents', 'show', 'INC001', ...flags], { cwd: directory, env, timeout: 15000 })).stdout; }
  assert.equal(JSON.parse(await run(['--json'])).data._related, undefined);
  assert.ok(!requests.some(url => url.pathname.startsWith('/api/now/stats/')));
  const result = JSON.parse(await run(['--related', '--json']));
  assert.equal(result.data._related.nonempty[0].count, 2); assert.match(result.data._related.nonempty[0].command, /--profile selected/);
  assert.equal(requests.filter(url => url.pathname.startsWith('/api/now/stats/')).length, 1);
  assert.ok(!requests.some(url => url.pathname === '/api/now/table/x_child'));
  assert.match(await run(['--related', '--styled']), /Children: 2/);
  assert.equal(JSON.parse(await run(['--related', '--get', 'data._related.nonempty.0.count'])), 2);
});
