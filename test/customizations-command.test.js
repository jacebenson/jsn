import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

test('actual CLI capture permits authentication bootstrap but only GET table reads; saved review is offline', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-customization-cli-'));
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    const url = new URL(req.url, 'http://localhost');
    const rows = {
      sys_scope: [{ sys_id: 'ours', name: 'Ours', scope: 'x_acme_ours' }],
      sys_metadata: [{ sys_id: 'a', sys_class_name: 'sys_script', sys_name: 'license_roles', sys_scope: 'ours', sys_update_name: 'sys_script_a', sys_updated_by: 'fixture-user' }],
      sys_upgrade_history_log: [],
    };
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/angular.do' && req.method === 'POST') {
      res.setHeader('Set-Cookie', 'JSESSIONID=fixture; Path=/');
      res.setHeader('X-UserToken-Response', 'fixture-gck');
      res.end('{}');
      return;
    }
    if (req.method !== 'GET') { res.statusCode = 405; res.end('{}'); return; }
    const table = url.pathname.split('/').at(-1);
    const offset = Number(url.searchParams.get('sysparm_offset') || 0);
    const limit = Number(url.searchParams.get('sysparm_limit') || 100);
    res.end(JSON.stringify({ result: (rows[table] || []).slice(offset, offset + limit) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const instance = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_CACHE_HOME: path.join(dir, 'cache'), JSN_DATA_HOME: path.join(dir, 'data'), JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1', JSN_NO_HEADER: '1', SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture' };
  const run = args => exec(process.execPath, [path.resolve('bin/jsn.js'), 'customizations', ...args], { env, cwd: dir });
  try {
    const first = JSON.parse((await run(['capture', '--instance', instance, '--customer-scope', 'x_acme_ours', '--json'])).stdout);
    assert.equal(first.ok, true);
    assert.equal(first.data.categories.customer_app_artifacts.length, 1);
    const second = JSON.parse((await run(['capture', '--instance', instance, '--customer-scope', 'x_acme_ours', '--json'])).stdout);
    const id = first.data.run_id;
    assert.equal(JSON.parse((await run(['list', '--json'])).stdout).data.count, 2);
    assert.equal(JSON.parse((await run(['show', id, '--get', 'data.run_id'])).stdout), id);
    const defaultView = JSON.parse((await run(['show', id])).stdout).data._formatted;
    assert.match(defaultView, /GROUPED BY FILE TYPE/);
    assert.match(defaultView, /Script \(1\)/);
    assert.match(defaultView, /--group-by updated-by/);
    const expanded = JSON.parse((await run(['show', id, '--filter', 'sys_script'])).stdout).data._formatted;
    assert.match(expanded, /CUSTOMER_APP_ARTIFACTS/);
    assert.match(expanded, /License Roles/);
    const regrouped = JSON.parse((await run(['show', id, '--group-by', 'scope'])).stdout).data._formatted;
    assert.match(regrouped, /GROUPED BY SCOPE/);
    const updaterView = JSON.parse((await run(['show', id, '--group-by', 'updated-by'])).stdout).data._formatted;
    assert.match(updaterView, /fixture-user \(1\)/);
    assert.match(updaterView, /GROUPED BY UPDATED BY/);
    const compare = JSON.parse((await run(['compare', id, second.data.run_id, '--json'])).stdout);
    assert.deepEqual(compare.data.changes, []);
    assert.equal(compare.data.status, 'incomplete');
    assert.ok(requests.some(req => req.url.includes('/api/now/table/sys_metadata')));
    assert.ok(requests.some(req => req.method === 'POST' && req.url.startsWith('/angular.do?')));
    assert.ok(requests.filter(req => req.url.startsWith('/api/now/table/')).every(req => req.method === 'GET'));
    assert.ok(requests.every(req => req.method === 'GET' || (req.method === 'POST' && req.url.startsWith('/angular.do?'))));
    const count = requests.length;
    await new Promise(resolve => server.close(resolve));
    assert.equal(JSON.parse((await run(['show', id, '--json'])).stdout).data.run_id, id);
    assert.equal(requests.length, count);
    await assert.rejects(run(['compare', id, id, '--json']));
    await assert.rejects(run(['show', '--json']));
    await assert.rejects(run(['capture', '--json']));
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
