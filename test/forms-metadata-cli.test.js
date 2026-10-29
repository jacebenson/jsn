import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { credKey } from '../src/auth/credential-store.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
const id = character => character.repeat(32);

test('forms show uses selected-profile HTTP metadata and output controller while generic get stays one read', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jsn-form-metadata-'));
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    requests.push({ path: url.pathname, method: request.method, query: url.searchParams.get('sysparm_query') });
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname.endsWith('/batch')) {
      response.statusCode = 404; response.end('{"error":"batch unsupported"}'); return;
    }
    if (url.pathname === '/angular.do') { response.end('{}'); return; }
    if (url.pathname === '/api/now/table/sys_scope') { response.end('{"result":[]}'); return; }
    assert.equal(request.headers.authorization, `Basic ${Buffer.from('metadata-user:local-fixture-password').toString('base64')}`);
    assert.equal(request.method, 'GET');
    const table = url.pathname.split('/').pop();
    const rows = {
      sys_db_object: [{ sys_id: id('1'), name: 'x_case', super_class: '' }],
      sys_ui_view: [{ sys_id: id('2'), name: '', title: 'Default view' }],
      sys_dictionary: [], sys_relationship: [], sys_ui_related_list: [],
      sys_ui_form: [{ sys_id: id('3'), name: 'x_case', view: { value: id('2') } }],
      sys_ui_form_section: [{ sys_ui_section: id('4'), position: '0' }],
      sys_ui_section: [{ sys_id: id('4'), caption: 'Case details' }],
      sys_ui_element: [{ sys_ui_section: id('4'), element: 'short_description', position: '0' }],
      x_case: [{ sys_id: id('5'), short_description: 'Unchanged generic record' }],
    }[table];
    if (!rows) { response.statusCode = 500; response.end('{"error":"unexpected endpoint"}'); return; }
    response.end(JSON.stringify({ result: rows }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const instance = `http://127.0.0.1:${server.address().port}`;
  const configDir = path.join(directory, 'servicenow');
  await fs.mkdir(path.join(configDir, 'credentials'), { recursive: true });
  await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({ default_profile: 'wrong', profiles: {
    selected: { instance_url: instance, username: 'metadata-user', auth_method: 'basic', read_only: true },
    wrong: { instance_url: 'http://127.0.0.1:1', username: 'other-user', auth_method: 'basic' },
  } }));
  await fs.writeFile(path.join(configDir, 'credentials', `${credKey(instance, 'metadata-user')}.json`), JSON.stringify({ auth_method: 'basic', username: 'metadata-user', password: 'local-fixture-password' }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SN_|SERVICENOW_)/i.test(key)));
  Object.assign(env, { XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, PATH: '', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1', JSN_NO_HEADER: '1' });
  async function run(args) {
    requests.length = 0;
    const result = await execute(process.execPath, [cli, ...args, '--profile', 'selected'], { env, cwd: directory, timeout: 15000 });
    assert.ok(!result.stdout.includes('local-fixture-password'));
    assert.equal(result.stderr, '');
    return result.stdout;
  }
  const metadata = JSON.parse(await run(['forms', 'show', 'x_case', '--json']));
  assert.equal(metadata.data.form.sections[0].caption, 'Case details');
  assert.equal(metadata.data.form.sections[0].elements[0].element, 'short_description');
  assert.equal(metadata.data.coverage.state, 'observed');
  assert.equal(requests.filter(request => request.method === 'GET' && !request.path.includes('angular.do') && !request.path.endsWith('/sys_scope')).length, 9);
  assert.equal(JSON.parse(await run(['forms', 'show', 'x_case', '--json', '--get', 'data.form.sections[0].caption'])), 'Case details');
  const human = await run(['forms', 'show', 'x_case', '--styled']);
  assert.match(human, /^Form: x_case/);
  assert.match(human, /Case details/);
  assert.doesNotMatch(human, /_formatted/);
  const generic = JSON.parse(await run(['records', 'get', '--table', 'x_case', '--sys-id', id('5'), '--json']));
  assert.equal(generic.data.short_description, 'Unchanged generic record');
  assert.deepEqual(requests.filter(request => request.path.startsWith('/api/now/table/') && !request.path.endsWith('/sys_scope')).map(request => request.path), ['/api/now/table/x_case']);
});
