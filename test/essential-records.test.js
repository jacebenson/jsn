import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { enrichEssentialRecords } from '../src/essential-records.js';
import { buildRecordProfile, validateRecordProfiles, getRecordProfile } from '../src/record-profiles.js';
import { captureCommands } from './support/command-test-helpers.js';

const relationship = { name: 'actions', table: 'x_child', foreignKey: 'parent', orderBy: 'order', limit: 2, columns: ['name'] };
test('essential children use raw parent ids, bounded reads, explicit coverage and pinned retrieval hints', async () => {
  const calls = [], record = { sys_id: { value: 'raw-parent', display_value: 'Wrong parent' } };
  await enrichEssentialRecords(record, { sdk: { list: async (table, params) => {
    calls.push([table, Object.fromEntries(params)]); return [{ sys_id: '1' }, { sys_id: '2' }, { sys_id: '3' }];
  } }, relationships: [relationship], profileName: 'selected profile' });
  assert.equal(calls.length, 1); assert.equal(calls[0][1].sysparm_limit, '3');
  assert.equal(calls[0][1].sysparm_query, 'parent=raw-parent^ORDERBYorder');
  assert.equal(record._essential.actions.loaded, 2); assert.equal(record._essential.actions.has_more, true);
  assert.match(record._essential.actions.command, /--profile 'selected profile'/);
  assert.match(record._essential.actions.visibility, /ACLs/);
});
test('empty, forbidden and malformed child reads remain distinct without exposing provider bodies', async () => {
  const record = { sys_id: 'parent' };
  const relations = [relationship, { ...relationship, name: 'forbidden', table: 'x_denied' }, { ...relationship, name: 'invalid', table: 'x_invalid' }];
  await enrichEssentialRecords(record, { relationships: relations, sdk: { list: async table => {
    if (table === 'x_denied') throw Object.assign(new Error('private provider secret'), { code: 'forbidden' });
    return table === 'x_invalid' ? {} : [];
  } } });
  assert.equal(record._essential.actions.status, 'loaded'); assert.equal(record._essential.actions.loaded, 0);
  assert.equal(record._essential.forbidden.status, 'unavailable'); assert.equal(record._essential.forbidden.error.code, 'forbidden');
  assert.equal(record._essential.invalid.status, 'unavailable');
  assert.ok(!JSON.stringify(record).includes('private provider secret'));
});
test('custom profiles compose hooks and essential policy while invalid declarations fail before transport', async () => {
  const profile = structuredClone(getRecordProfile('includes'));
  profile.name = 'customessential'; profile.aliases = []; profile.relationships.essential = [relationship];
  const command = buildRecordProfile(profile, fn => fn, { onShow: record => { record._custom = true; } });
  const show = captureCommands(command).find(c => c.command.startsWith('show'));
  let calls = 0, output;
  const app = { sdk: { list: async table => { calls++; return table === profile.table ? [{ sys_id: 'parent', name: 'Named' }] : []; } },
    getEffectiveInstance: () => 'https://fixture.invalid', ok: data => { output = data; } };
  await show.handler({ identifier: 'Named' }, app);
  assert.equal(calls, 2); assert.equal(output._custom, true); assert.equal(output._essential.actions.loaded, 0);
  calls = 0;
  await show.handler({ identifier: 'Named', essential: false }, app);
  assert.equal(calls, 1); assert.equal(output._essential, undefined);
  for (const change of [r => { r.limit = -1; }, r => { r.orderBy = 'order^OR'; }, r => { r.columns = ['name^OR']; }]) {
    const invalid = structuredClone(profile); change(invalid.relationships.essential[0]);
    assert.throws(() => validateRecordProfiles([invalid]));
  }
});
test('real CLI UI-policy show emits one JSON envelope with actions; human and extraction share bounded data', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jsn essential '));
  let server;
  t.after(async () => { if (server?.listening) await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const requests = [], id = 'a'.repeat(32);
  let denied = false;
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid'); requests.push(url);
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/angular.do') { res.end('{}'); return; }
    if (url.pathname.endsWith('/sys_ui_policy_action')) {
      if (denied) { res.writeHead(403); res.end('{"error":"provider-private-secret"}'); return; }
      res.end(JSON.stringify({ result: [{ sys_id: 'action1', field_name: { value: 'caller_id', display_value: 'Caller' }, mandatory: { value: 'true', display_value: 'true' } }] })); return;
    }
    res.end(JSON.stringify({ result: [{ sys_id: id, short_description: 'Fixture policy' }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const instance = `http://127.0.0.1:${server.address().port}`;
  await fs.mkdir(path.join(directory, 'servicenow'));
  await fs.writeFile(path.join(directory, 'servicenow', 'config.json'), JSON.stringify({ profiles: { selected: { instance_url: instance, auth_method: 'basic' } } }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SN_|SERVICENOW_)/i.test(key)));
  Object.assign(env, { XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, PATH: '', SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1', JSN_NO_HEADER: '1' });
  const execute = promisify(execFile), cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  async function run(flags) {
    const result = await execute(process.execPath, [cli, '--profile', 'selected', 'uipolicies', 'show', id, ...flags], { cwd: directory, env, timeout: 15000 });
    assert.ok(!(result.stdout + result.stderr).includes('provider-private-secret')); return result.stdout;
  }
  const result = JSON.parse(await run(['--json']));
  assert.equal(result.data._essential.actions.loaded, 1); assert.equal(result.data._essential.actions.records[0].sys_id, 'action1');
  const childReads = requests.filter(url => url.pathname.endsWith('/sys_ui_policy_action'));
  assert.equal(childReads.length, 1); assert.equal(childReads[0].searchParams.get('sysparm_limit'), '101');
  assert.equal(childReads[0].searchParams.get('sysparm_query'), `ui_policy=${id}^ORDERBYorder`);
  assert.equal(JSON.parse(await run(['--get', 'data._essential.actions.records.0.sys_id'])), 'action1');
  assert.match(await run(['--styled']), /Essential: actions \(1 loaded\)/);
  const before = requests.filter(url => url.pathname.endsWith('/sys_ui_policy_action')).length;
  assert.equal(JSON.parse(await run(['--no-essential', '--json'])).data._essential, undefined);
  assert.equal(requests.filter(url => url.pathname.endsWith('/sys_ui_policy_action')).length, before);
  denied = true;
  assert.equal(JSON.parse(await run(['--json'])).data._essential.actions.status, 'unavailable');
});
