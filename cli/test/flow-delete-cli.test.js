import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
const id = 'c'.repeat(32);
const owned = 5;

function fixtureServer({ keepAfterDelete = false, forbidDelete = false } = {}) {
  const requests = [];
  let deleted = false;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({ method: req.method, pathname: url.pathname, query: url.search });
    let response = { result: [] };
    if (url.pathname === '/api/now/table/sys_hub_flow' && req.method === 'GET') {
      const present = keepAfterDelete || !deleted;
      response = { result: present ? [{ sys_id: id, name: 'Fixture flow', status: 'Draft', active: 'false' }] : [] };
    }
    if (url.pathname.startsWith('/api/now/stats/') && req.method === 'GET') {
      const present = keepAfterDelete || !deleted;
      response = { result: { stats: { count: String(present ? owned : 0) } } };
    }
    if (req.method === 'DELETE' && url.pathname === `/api/now/table/sys_hub_flow/${id}`) {
      if (forbidDelete) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Access forbidden', detail: 'scope mismatch' }, status: 'failure' }));
        return;
      }
      deleted = true;
      response = { result: {} };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  });
  return { server, requests };
}

async function runDelete(serverResponse) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jsn-flow-delete-'));
  const { server, requests } = fixtureServer(serverResponse);
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const configDir = path.join(directory, 'config');
    await fs.mkdir(path.join(configDir, 'servicenow'), { recursive: true });
    await fs.writeFile(path.join(configDir, 'servicenow/config.json'), JSON.stringify({
      default_profile: 'fixture',
      profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: false } },
    }));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SN_|SERVICENOW_|JSN_|XDG_)/i.test(key)));
    Object.assign(env, {
      HOME: directory, XDG_CONFIG_HOME: configDir, XDG_CACHE_HOME: configDir,
      JSN_DATA_HOME: path.join(directory, 'data'), JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1',
      JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', SN_USERNAME: 'fixture', SN_PASSWORD: 'synthetic-fixture-only',
    });
    let result;
    try {
      result = { code: 0, ...await exec(process.execPath, [cli, 'flows', 'delete', id, '--force', '--json', '--verbose'], { env, timeout: 20000 }) };
    } catch (error) {
      result = { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' };
    }
    return { result, requests };
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('flows delete removes the flow record and reports what went with it', async () => {
  const { result, requests } = await runDelete();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  assert.match(envelope.summary, /Deleted flow "Fixture flow"/);
  assert.match(envelope.summary, new RegExp(`with ${owned} versions`));
  assert.equal(envelope.data.flow.id, id);
  assert.deepEqual(Object.values(envelope.data.remaining), [0, 0, 0, 0, 0]);
  assert.equal(requests.filter(request => request.method === 'DELETE').length, 1, 'one delete, no retry');
  assert.deepEqual(requests.filter(request => request.method === 'DELETE').map(request => request.pathname), [`/api/now/table/sys_hub_flow/${id}`]);
});

test('flows delete fails when the flow is still readable after the delete', async () => {
  const { result } = await runDelete({ keepAfterDelete: true });
  assert.equal(result.code, 1, result.stdout + result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, false);
  assert.match(envelope.error, /still present after the delete request/);
});

test('flows delete refuses without confirmation when --force is absent', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jsn-flow-delete-nc-'));
  const { server } = fixtureServer();
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const configDir = path.join(directory, 'config');
    await fs.mkdir(path.join(configDir, 'servicenow'), { recursive: true });
    await fs.writeFile(path.join(configDir, 'servicenow/config.json'), JSON.stringify({
      default_profile: 'fixture',
      profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: false } },
    }));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SN_|SERVICENOW_|JSN_|XDG_)/i.test(key)));
    Object.assign(env, {
      HOME: directory, XDG_CONFIG_HOME: configDir, XDG_CACHE_HOME: configDir,
      JSN_DATA_HOME: path.join(directory, 'data'), JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1',
      JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', SN_USERNAME: 'fixture', SN_PASSWORD: 'synthetic-fixture-only',
    });
    let result;
    try {
      result = { code: 0, ...await exec(process.execPath, [cli, 'flows', 'delete', id, '--json'], { env, timeout: 20000 }) };
    } catch (error) {
      result = { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' };
    }
    assert.equal(result.code, 1, result.stdout + result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.match(envelope.error, /confirmation/i);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('flows delete explains a scope refusal instead of a bare 403', async () => {
  const { result } = await runDelete({ forbidDelete: true });
  assert.equal(result.code, 1, result.stdout + result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.code, 'forbidden');
  assert.match(envelope.error, /application scope.*Switch to that scope first/);
  assert.match(envelope.error, /No delete was applied/);
});
