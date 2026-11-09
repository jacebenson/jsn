import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const cliRoot = path.resolve(import.meta.dirname, '..');

// Standalone equivalent of the acceptance-suite runProcess helper. This branch
// targets main, which does not yet carry cli/scripts/acceptance/support.mjs.
function runProcess(executable, args, { cwd = cliRoot, env = process.env, timeoutMs = 30000, maxBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, overflow = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const collect = stream => data => {
      if (stream === 'out') stdout += data; else stderr += data;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxBytes) { overflow = true; child.kill('SIGKILL'); }
    };
    child.stdout.on('data', collect('out')); child.stderr.on('data', collect('err'));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      let json; try { json = JSON.parse(stdout); } catch { /* validated by caller */ }
      resolve({ exitCode: code ?? -1, stdout, stderr, json, durationMs: performance.now() - start, timedOut, overflow });
    });
  });
}

// The verified table is sys_ux_applicability_m2m_list (label: List
// Applicability). It has no `name` field; list/show must use sys_id plus the
// list/applicability references. This loopback test pins the table on the wire
// for both verbs so a profile regression cannot pass as a generic table read.
const table = 'sys_ux_applicability_m2m_list';
const oldTable = 'sys_ux_applicability_m2m';
const id = 'a'.repeat(32);
const listId = 'b'.repeat(32);
const applicabilityId = 'c'.repeat(32);
const scopeId = 'd'.repeat(32);
const stamp = '2026-01-01 00:00:00';

function fixtureRecord(displayValues) {
  const values = { sys_id: id, sys_updated_on: stamp, list: listId, applicability: applicabilityId, active: 'true', order: '0', sys_scope: scopeId };
  const display = { sys_id: id, sys_updated_on: stamp, list: 'Synthetic list', applicability: 'Synthetic audience', active: 'true', order: '0', sys_scope: 'Synthetic scope' };
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key,
    displayValues === 'all' ? { value, display_value: display[key] } : value]));
}

function project(record, fields) {
  if (!fields) return record;
  return Object.fromEntries(Object.entries(record).filter(([key]) => fields.includes(key)));
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jsn-uxapplicability-'));
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture');
    requests.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST' && url.pathname === '/angular.do') {
      response.setHeader('x-usertoken-response', 'synthetic-session-token');
      response.end('{}');
      return;
    }
    if (request.method !== 'GET') {
      response.statusCode = 405;
      response.end('{"error":{"message":"mutation refused"}}');
      return;
    }
    if (url.pathname !== `/api/now/table/${table}`) {
      response.statusCode = 404;
      response.end('{"error":{"message":"unexpected table"}}');
      return;
    }
    const fields = url.searchParams.get('sysparm_fields')?.split(',');
    const record = project(fixtureRecord(url.searchParams.get('sysparm_display_value')), fields);
    response.end(JSON.stringify({ result: [record] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const target = `http://127.0.0.1:${server.address().port}`;
  fs.mkdirSync(path.join(root, 'servicenow'));
  fs.writeFileSync(path.join(root, 'servicenow/config.json'), JSON.stringify({
    default_profile: 'fixture',
    profiles: { fixture: { instance_url: target, auth_method: 'basic' } },
  }));
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: path.join(root, 'cache'),
    JSN_DATA_HOME: path.join(root, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret',
    JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_DOCS_CHECK: '1', CI: '1' };
  for (const key of Object.keys(env)) if (/PROXY|^NODE_OPTIONS$|^SERVICENOW_/i.test(key)) delete env[key];
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    requests,
    run: args => runProcess(process.execPath, [path.join(cliRoot, 'bin/jsn.js'), ...args, '--profile', 'fixture', '--json'], { cwd: cliRoot, env }),
  };
}

test('real CLI uxapplicability list and show target sys_ux_applicability_m2m_list', async t => {
  const f = await fixture(t);

  const list = await f.run(['uxapplicability', 'list']);
  assert.equal(list.exitCode, 0, list.stderr);
  assert.equal(list.json?.ok, true);
  assert.equal(list.json.data.table, table);
  assert.deepEqual(list.json.data.columns, ['list', 'applicability', 'active', 'order', 'sys_scope']);
  assert.equal(list.json.data.count, 1);
  const listed = list.json.data.records[0];
  assert.equal(listed.sys_id, id);
  assert.equal(listed.list, 'Synthetic list');
  assert.equal(listed.applicability, 'Synthetic audience');

  const listRequests = f.requests.filter(r => r.path === `/api/now/table/${table}`);
  assert.equal(listRequests.length, 1);
  assert.equal(listRequests[0].method, 'GET');
  const listFields = listRequests[0].query.sysparm_fields.split(',');
  assert.deepEqual(new Set(listFields), new Set(['sys_id', 'list', 'applicability', 'active', 'order', 'sys_scope']));
  assert.ok(!listFields.includes('name'), 'the verified table has no name field');

  const beforeShow = f.requests.length;
  const show = await f.run(['uxapplicability', 'show', id, '--identifier-field', 'sys_id', '--display-values', 'raw']);
  assert.equal(show.exitCode, 0, show.stderr);
  assert.equal(show.json?.ok, true);
  assert.equal(show.json.data.sys_id, id);
  assert.equal(show.json.data.list, listId);
  assert.equal(show.json.data.applicability, applicabilityId);

  const showRequests = f.requests.slice(beforeShow).filter(r => r.path === `/api/now/table/${table}`);
  assert.equal(showRequests.length, 1);
  assert.equal(showRequests[0].method, 'GET');
  assert.equal(showRequests[0].query.sysparm_query, `sys_id=${id}`);
  assert.equal(showRequests[0].query.sysparm_limit, '2');
  assert.equal(showRequests[0].query.sysparm_display_value, 'false');

  assert.equal(f.requests.filter(r => r.path === `/api/now/table/${oldTable}`).length, 0);
  assert.ok(f.requests.every(r => r.method === 'GET' || (r.method === 'POST' && r.path === '/angular.do')));
});
