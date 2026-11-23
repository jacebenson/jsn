import assert from 'node:assert/strict';
import { test } from 'node:test';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Independent synthetic provider probe. No real credentials or instance.
const execute = promisify(execFile);
test('public executable rejects all unproved mutation branches before any provider write', async () => {
const checkout = fileURLToPath(new URL('../../', import.meta.url));
const cli = path.join(checkout, 'cli/bin/jsn.js');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jsn549-public-'));
const id = x => x.repeat(32);
const definitions = [
  { sys_id: id('1'), name: 'incident', super_class: id('2') },
  { sys_id: id('2'), name: 'task', super_class: '' },
  { sys_id: id('3'), name: 'sys_user', super_class: '' },
];
const dictionary = [
  ...['sys_id', 'name', 'active', 'short_description'].map(element => ({ sys_id: element, name: 'task', element, internal_type: 'string', reference: '' })),
  { sys_id: 'number', name: 'incident', element: 'number', internal_type: 'string', reference: '' },
  { sys_id: 'caller', name: 'incident', element: 'caller_id', internal_type: 'reference', reference: 'sys_user' },
  ...['sys_id', 'name', 'user_name', 'email'].map(element => ({ sys_id: `user-${element}`, name: 'sys_user', element, internal_type: 'string', reference: '' })),
];
let rows;
const requests = [];
function selectMetadata(source, query) {
  let result = source;
  const match = query.match(/(?:^|\^)name(IN|=)([^^]*)/);
  if (match) result = result.filter(row => match[1] === 'IN' ? match[2].split(',').includes(row.name) : row.name === match[2]);
  const key = query.match(/(?:^|\^)sys_id=([^^]*)/);
  if (key) result = result.filter(row => row.sys_id === key[1]);
  return result;
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture.invalid');
  requests.push({ method: req.method, path: url.pathname, query: url.searchParams.get('sysparm_query') });
  res.setHeader('Content-Type', 'application/json');
  const query = url.searchParams.get('sysparm_query') || '';
  const table = url.pathname.split('/')[4];
  let result;
  if (url.pathname === '/angular.do') result = {};
  else if (url.pathname.startsWith('/api/now/stats/')) {
    const population = table === 'sys_dictionary' ? selectMetadata(dictionary, query) : table === 'sys_db_object' ? selectMetadata(definitions, query) : rows;
    result = { stats: { count: String(population.length) } };
  } else if (table === 'sys_db_object') result = url.pathname.split('/')[5] ? definitions.find(row => row.sys_id === url.pathname.split('/')[5]) : selectMetadata(definitions, query);
  else if (table === 'sys_dictionary') result = selectMetadata(dictionary, query);
  else if (table === 'sys_dictionary_override') result = [];
  else if (table === 'sys_user') result = [{ sys_id: id('4'), user_name: 'fixture', name: 'Fixture user', email: 'fixture@example.invalid' }];
  else if (table === 'incident') {
    if (req.method === 'DELETE') { rows = []; result = {}; }
    else if (req.method !== 'GET') {
      let body = ''; for await (const chunk of req) body += chunk;
      result = { ...rows[0], ...(body ? JSON.parse(body) : {}) };
    } else result = [...rows]; // Deliberately accepts/ignores bad terms, the danger being guarded.
  } else if (url.pathname === '/api/now/v1/batch') {
    res.statusCode = 404; result = { error: 'fixture batch unsupported' };
  } else { res.statusCode = 404; result = { error: 'fixture endpoint unavailable' }; }
  if (Array.isArray(result)) {
    res.setHeader('X-Total-Count', String(result.length));
    const offset = Number(url.searchParams.get('sysparm_offset') || 0);
    const limit = Number(url.searchParams.get('sysparm_limit') || 10000);
    result = result.slice(offset, offset + limit);
  }
  res.end(JSON.stringify({ result }));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
try {
  const instance = `http://127.0.0.1:${server.address().port}`;
  await fs.mkdir(path.join(directory, 'servicenow'), { recursive: true });
  await fs.writeFile(path.join(directory, 'servicenow/config.json'), JSON.stringify({ default_profile: 'selected', profiles: {
    selected: { instance_url: instance, auth_method: 'basic', username: 'fixture' },
  } }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(SN_|SERVICENOW_|JSN_)/i.test(name)));
  Object.assign(env, { HOME: directory, XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, JSN_DATA_HOME: path.join(directory, 'data'), PATH: '',
    SN_USERNAME: 'fixture', SN_PASSWORD: 'synthetic-probe-password', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1', JSN_NO_HEADER: '1' });
  const cases = [
    { name: 'operator typo read', args: ['records', 'list', '--table', 'incident', '--query', 'nameSTARTWITHfixture', '--no-count'], rejected: true, zeroWrites: true },
    { name: 'unknown later OR/NQ term bulk mutation', args: ['records', 'bulk', '--table', 'incident', '--query', 'nameSTARTSWITHfixture^ORbogus=1^NQactive=true', '-f', 'short_description=changed', '--execute', '--force', '--limit', '1'], rejected: true, zeroWrites: true },
    { name: 'operator typo delete mutation', args: ['records', 'delete-many', '--table', 'incident', '--query', 'nameSTARTWITHfixture', '--yes', '--expect-count', '1', '--limit', '1'], rejected: true, zeroWrites: true },
    { name: 'unresolved table mutation with accessible suggestions', args: ['records', 'bulk', '--table', 'incidnet', '--query', 'name=fixture', '-f', 'active=false', '--execute', '--force'], rejected: true, zeroWrites: true },
    { name: 'unsupported platform mutation', args: ['records', 'bulk', '--table', 'incident', '--query', 'nameONtoday', '-f', 'active=false', '--execute', '--force'], rejected: true, zeroWrites: true },
    { name: 'unresolved order field mutation', args: ['records', 'bulk', '--table', 'incident', '--query', 'name=fixture^ORDERBYhidden', '-f', 'active=false', '--execute', '--force'], rejected: true, zeroWrites: true },
    { name: 'inherited field valid read', args: ['records', 'list', '--table', 'incident', '--query', 'nameSTARTSWITHfixture', '--no-count'], rejected: false, zeroWrites: true },
  ];
  const observed = [];
  for (const item of cases) {
    rows = [{ sys_id: id('a'), number: 'INC-FIXTURE', name: 'fixture', active: 'true', short_description: 'Synthetic fixture' }];
    const before = requests.length;
    let result;
    try { result = { ...await execute(process.execPath, [cli, '--profile', 'selected', ...item.args, '--json'], { cwd: directory, env, timeout: 20000 }), code: 0 }; }
    catch (error) { result = error; }
    const calls = requests.slice(before);
    const writes = calls.filter(call => !['GET', 'HEAD'].includes(call.method) && call.path !== '/angular.do');
    let data; try { data = JSON.parse(result.stdout); } catch { data = null; }
    observed.push({ name: item.name, exit: result.code, expectedRejected: item.rejected, writeCount: writes.length,
      responseCode: data?.code || null, responseMessage: data?.message || data?.error?.message || null,
      queryValidation: data?.query_validation || data?.error?.query_validation || null,
      stderr: result.stderr || '',
      queryBytesPreserved: calls.filter(call => call.path === '/api/now/table/incident').every(call => call.query === item.args[item.args.indexOf('--query') + 1] || !call.query),
      passed: (item.rejected ? result.code !== 0 : result.code === 0) && (!item.zeroWrites || writes.length === 0) && data !== null,
    });
  }
  const unresolved = observed.find(item => item.name === 'unresolved table mutation with accessible suggestions');
  assert.deepEqual(unresolved.queryValidation.diagnostics[0].suggestions, ['incident']);
  assert.equal(requests.some(call => call.path === '/api/now/table/incidnet'), false, 'unresolved target must never reach record transport');
  for (const item of observed.filter(item => item.expectedRejected)) {
    assert.ok(item.queryValidation, item.name + ': structured validation must render');
    assert.ok(item.queryValidation.diagnostics.some(d => d.term), item.name + ': failing term');
  }
  assert.ok(observed.every(item => item.passed), 'Public CLI query-safety acceptance failed. See per-case observations.');
  const unverified = ['records', 'list', '--table', 'incident', '--query', 'nameONtoday', '--no-count'];
  const extracted = await execute(process.execPath, [cli, '--profile', 'selected', ...unverified, '--get', 'data.query_validation.state'], { cwd: directory, env, timeout: 20000 });
  assert.equal(JSON.parse(extracted.stdout), 'unsupported');
  const human = await execute(process.execPath, [cli, '--profile', 'selected', ...unverified, '--format', 'markdown'], { cwd: directory, env, timeout: 20000 });
  assert.match(human.stderr, /Warning: Query validation unsupported/);
} finally {
  await new Promise(resolve => server.close(resolve));
  await fs.rm(directory, { recursive: true, force: true });
}
});
