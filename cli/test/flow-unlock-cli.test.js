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
const id = 'a'.repeat(32);
const owned = { canUserEdit: true, currentEditor: null };
const free = { canUserEdit: false, currentEditor: null };

const scenarios = [
  { name: 'provider refusal', deleteResult: { deleteSuccess: false, id }, operations: ['read', 'delete'], message: /release was not confirmed.*no retry attempted/i },
  { name: 'wrong release identity', deleteResult: { deleteSuccess: true, id: 'b'.repeat(32) }, operations: ['read', 'delete'], message: /release was not confirmed.*no retry attempted/i },
  { name: 'unreadable initial status', before: {}, operations: ['read'], message: /Unreadable safe edit status/i },
  { name: 'unreadable release readback', after: {}, operations: ['read', 'delete', 'read'], message: /Unreadable safe edit status/i },
  { name: 'still-owned release readback', after: owned, operations: ['read', 'delete', 'read'], message: /readback still reports an edit session.*Inspect the exact flow/i },
  { name: 'GraphQL provider rejection', errors: [{ message: 'Synthetic provider denied release' }], operations: ['read', 'delete'], message: /Flow safe edit delete: Synthetic provider denied release/i },
  { name: 'missing provider result', missingResult: true, operations: ['read', 'delete'], message: /Flow safe edit delete returned no result/i },
];

for (const scenario of scenarios) {
  test(`flows unlock CLI emits a JSON failure for ${scenario.name} without retry or upsert`, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jsn-unlock-json-'));
    const operations = [];
    const requests = [];
    const server = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const pathname = new URL(req.url, 'http://localhost').pathname;
      requests.push({ method: req.method, pathname });
      let response = { result: [] };
      if (pathname === '/api/now/table/sys_hub_flow') response = { result: [{ sys_id: id, name: 'Fixture' }] };
      if (pathname === '/api/now/graphql') {
        const { query } = JSON.parse(body);
        const operation = query.includes('delete:') ? 'delete' : query.includes('upsert:') ? 'upsert' : 'read';
        operations.push(operation);
        const status = operations.length === 1 ? scenario.before ?? owned : scenario.after ?? free;
        const safeEdit = operation === 'delete'
          ? { deleteResult: scenario.deleteResult ?? { deleteSuccess: true, id } }
          : { status };
        response = operation === 'delete' && scenario.errors ? { errors: scenario.errors }
          : operation === 'delete' && scenario.missingResult ? { data: {} }
            : { data: { global: { snFlowDesigner: { safeEdit } } } };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    });
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
        result = { code: 0, ...await exec(process.execPath, [cli, 'flows', 'unlock', id, '--force', '--json'], { env, timeout: 20000 }) };
      } catch (error) {
        result = { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' };
      }
      assert.equal(result.code, 1, result.stdout + result.stderr);
      assert.deepEqual(operations, scenario.operations, 'exact bounded sequence proves no retry, upsert or content write');
      assert.ok(requests.every(request => request.method === 'GET' || ['/api/now/graphql', '/angular.do'].includes(request.pathname)), JSON.stringify(requests));
      assert.match(result.stdout + result.stderr, scenario.message, 'actionable provider/readback message is retained');
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.ok, false);
      assert.equal(envelope.code, 'api_error');
      assert.match(envelope.error, scenario.message);
      assert.equal(result.stderr, '');
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
}
