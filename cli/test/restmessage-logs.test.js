import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRestMessageLogs, formatRestMessageLogs, redactPairs, endpointScope } from '../src/restmessage-logs.js';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';

const MESSAGE = 'a'.repeat(32);
const v = (value, display = value) => ({ value, display_value: display });
const message = (over = {}) => ({ sys_id: v(MESSAGE), name: v('Payroll API'), rest_endpoint: v('https://api.example.com/v1/${tenant}/pay'), ...over });
const method = (name, endpoint, over = {}) => ({ sys_id: v(name.padEnd(32, '0').replace(/[^0-9a-f]/g, 'b')), function_name: v(name), http_method: v('get', 'GET'), rest_endpoint: v(endpoint), rest_message: v(MESSAGE, 'Payroll API'), ...over });
let seq = 0;
const call = (status, url, over = {}) => ({
  sys_id: v((++seq).toString(16).padStart(32, '0')), sys_created_on: v('2026-11-26 10:00:00', '2026-11-26 21:00:00'),
  method: v('GET'), url: v(url), request_query: v(''), response_status: v(String(status)), response_time: v('147', '147'),
  request_length: v('0'), response_length: v('12'), log_level: v('basic', 'Basic'), source_table: v('sys_script'),
  source_record: v('c'.repeat(32)), mid_server: v(''), transaction_name: v('#1 /api/now/table/x'), user_name: v('admin'),
  app_scope: v('global'), system_id: v('node1'), request_headers: v(''), response_headers: v(''), ...over,
});

function world(over = {}) {
  return {
    sys_rest_message: params => params.get('sysparm_query') === 'name=Payroll API' || params.get('sysparm_query') === `sys_id=${MESSAGE}` ? [message()] : [],
    sys_rest_message_fn: [method('list', 'https://api.example.com/v1/${tenant}/pay?page=1'), method('post', ''), method('other', 'https://other.example.com/hooks/v2/notify')],
    sys_outbound_http_log: [call(200, 'https://api.example.com/v1/acme/pay'), call(404, 'https://api.example.com/v1/acme/pay/9')],
    ...over,
  };
}

function fixtureSdk(tables) {
  const calls = [];
  const read = async (table, params) => {
    calls.push({ table, params: Object.fromEntries(params) });
    const value = tables[table];
    if (value instanceof Error) throw value;
    return typeof value === 'function' ? value(params) : value ?? [];
  };
  return { calls, list: read, listStrict: read };
}

test('reads the message, its methods and the matching log rows with bounded GET queries', async () => {
  const sdk = fixtureSdk(world());
  const data = await readRestMessageLogs(sdk, 'Payroll API', { status: '404', endpoint: '/pay', limit: 1 });
  assert.deepEqual(sdk.calls.map(c => c.table), ['sys_rest_message', 'sys_rest_message_fn', 'sys_outbound_http_log']);
  assert.equal(sdk.calls[0].params.sysparm_query, 'name=Payroll API');
  assert.deepEqual(sdk.calls[1].params, { sysparm_query: `rest_message=${MESSAGE}^ORDERBYfunction_name`, sysparm_fields: 'sys_id,function_name,http_method,rest_endpoint,rest_message', sysparm_limit: '101', sysparm_display_value: 'all' });
  const log = sdk.calls[2].params;
  assert.equal(log.sysparm_query, 'urlSTARTSWITHhttps://api.example.com/^ORurlSTARTSWITHhttps://other.example.com/^urlLIKE/v1/^ORurlLIKE/hooks/v2/^response_status=404^urlLIKE/pay^ORDERBYDESCsys_created_on^ORDERBYDESCsequence');
  assert.equal(log.sysparm_limit, '2');
  assert.equal(log.sysparm_offset, '0');
  assert.equal(log.sysparm_display_value, 'all');
  assert.ok(!log.sysparm_fields.includes('request_body') && !log.sysparm_fields.includes('response_body'), 'bodies are never read');
  assert.deepEqual(data.message, { sys_id: MESSAGE, name: 'Payroll API' });
  assert.deepEqual(data.match, { hosts: ['https://api.example.com/', 'https://other.example.com/'], directories: ['/v1/', '/hooks/v2/'] });
  assert.equal(data.calls.length, 1);
  assert.deepEqual(data.pagination, { limit: 1, offset: 0, has_more: true, next_offset: 1 });
  const [first] = data.calls;
  assert.equal(first.status, 200);
  assert.equal(first.response_time_ms, 147);
  assert.equal(first.created_on, '2026-11-26 21:00:00');
  assert.deepEqual(first.source, { table: 'sys_script', sys_id: 'c'.repeat(32) });
  assert.equal(data.redacted, true);
});

test('a sys_id finds the message, and a status class becomes a range', async () => {
  const sdk = fixtureSdk(world());
  await readRestMessageLogs(sdk, MESSAGE, { status: '5xx' });
  assert.equal(sdk.calls[0].params.sysparm_query, `sys_id=${MESSAGE}`);
  assert.match(sdk.calls.at(-1).params.sysparm_query, /\^response_status>=500\^response_status<600\^ORDERBYDESC/);
});

test('endpoints whose host is a variable, or that are not http, are reported and left out of the query', async () => {
  const sdk = fixtureSdk(world({
    sys_rest_message: [message({ rest_endpoint: v('https://${host}/api') })],
    sys_rest_message_fn: [method('a', 'ftp://files.example.com/x'), method('b', 'https://ok.example.com/a^b/c'), method('c', 'https://good.example.com/v2/${id}'), method('d', '')],
  }));
  const data = await readRestMessageLogs(sdk, 'Payroll API');
  assert.deepEqual(data.match, { hosts: ['https://good.example.com/'], directories: ['/v2/'] });
  assert.deepEqual(data.unmatched_endpoints, [
    { endpoint: 'https://${host}/api', reason: 'the host is a variable' },
    { endpoint: 'ftp://files.example.com/x', reason: 'not an http or https URL' },
    { endpoint: 'https://ok.example.com/a^b/c', reason: 'holds characters an encoded query cannot match' },
  ]);
  assert.equal(sdk.calls.at(-1).params.sysparm_query, 'urlSTARTSWITHhttps://good.example.com/^urlLIKE/v2/^ORDERBYDESCsys_created_on^ORDERBYDESCsequence');
});

test('the message endpoint counts only while a method has none, and a base URL keeps its one segment', async () => {
  const logQuery = async (base, endpoints) => {
    const sdk = fixtureSdk(world({ sys_rest_message: [message({ rest_endpoint: v(base) })], sys_rest_message_fn: endpoints.map((endpoint, i) => method(`m${i}`, endpoint)) }));
    const data = await readRestMessageLogs(sdk, 'Payroll API');
    return [data.match, sdk.calls.at(-1).params.sysparm_query.replace('^ORDERBYDESCsys_created_on^ORDERBYDESCsequence', '')];
  };
  assert.deepEqual(await logQuery('https://graph.example.com/v1.0', ['https://graph.example.com/v1.0/users/${id}', '']),
    [{ hosts: ['https://graph.example.com/'], directories: ['/v1.0', '/v1.0/users/'] }, 'urlSTARTSWITHhttps://graph.example.com/^urlLIKE/v1.0^ORurlLIKE/v1.0/users/']);
  assert.deepEqual(await logQuery('https://api.example.com/', ['https://api.example.com/v1/refund']),
    [{ hosts: ['https://api.example.com/'], directories: ['/v1/'] }, 'urlSTARTSWITHhttps://api.example.com/^urlLIKE/v1/']);
  assert.deepEqual(await logQuery('https://api.example.com/v1/x', ['https://api.example.com']),
    [{ hosts: ['https://api.example.com/'], directories: [] }, 'urlSTARTSWITHhttps://api.example.com/']);
});

test('a message with no endpoint to match reads no log rows and says why', async () => {
  const sdk = fixtureSdk(world({ sys_rest_message: [message({ rest_endpoint: v('https://${host}/api') })], sys_rest_message_fn: [] }));
  await assert.rejects(readRestMessageLogs(sdk, 'Payroll API'), /No endpoint of REST message Payroll API has a fixed http or https host/);
  assert.ok(!sdk.calls.some(c => c.table === 'sys_outbound_http_log'));
});

test('credential headers and query values are redacted in every format the log may hold', () => {
  assert.equal(redactPairs('Content-Type: application/json\nAuthorization: Basic YWRtaW46cGFzcw==\nX-Api-Key: k1'),
    'Content-Type: application/json\nAuthorization: [redacted]\nX-Api-Key: [redacted]');
  assert.equal(redactPairs('{Authorization=Basic abc==, Accept=application/json, Set-Cookie=JSESSIONID=1; Path=/}'),
    '{Authorization=[redacted], Accept=application/json, Set-Cookie=[redacted]}');
  assert.equal(redactPairs('{"Authorization":"Bearer x.y.z","Accept":"*/*"}'), '{"Authorization":[redacted],"Accept":"*/*"}');
  assert.equal(redactPairs('page=2&access_token=abc&client_secret=s&q=x'), 'page=2&access_token=[redacted]&client_secret=[redacted]&q=x');
  assert.equal(redactPairs('Authorization: OAuth oauth_consumer_key="ck", oauth_token="t", oauth_signature="sig"'),
    'Authorization: [redacted], oauth_token=[redacted], oauth_signature=[redacted]');
  assert.equal(redactPairs('Ocp-Apim-Subscription-Key: k2\nx-functions-key: k3\nX-Request-Id: 7'), 'Ocp-Apim-Subscription-Key: [redacted]\nx-functions-key: [redacted]\nX-Request-Id: 7');
  assert.equal(redactPairs('subscription-key=k4&access_key=k5&pwd=p&page=1'), 'subscription-key=[redacted]&access_key=[redacted]&pwd=[redacted]&page=1');
  assert.equal(redactPairs(''), '');
});

test('log rows come back redacted', async () => {
  const sdk = fixtureSdk(world({ sys_outbound_http_log: [call(401, 'https://api.example.com/v1/a?token=abc&page=2', {
    request_headers: v('Authorization: Basic c2VjcmV0'), response_headers: v('Set-Cookie: glide_user=abc'), request_query: v('api_key=k&page=1'),
  })] }));
  const [row] = (await readRestMessageLogs(sdk, 'Payroll API')).calls;
  assert.equal(row.url, 'https://api.example.com/v1/a?token=[redacted]&page=2');
  assert.equal(row.request_headers, 'Authorization: [redacted]');
  assert.equal(row.response_headers, 'Set-Cookie: [redacted]');
  assert.equal(row.request_query, 'api_key=[redacted]&page=1');
  assert.doesNotMatch(JSON.stringify(row), /c2VjcmV0|glide_user=abc|api_key=k|token=abc/);
});

test('a user and password in an endpoint or a logged URL never come back', async () => {
  const sdk = fixtureSdk(world({
    sys_rest_message_fn: [method('a', 'https://bob:pw1@creds.example.com/v3/${id}'), method('b', 'ftp://u:pw2@files.example.com/x?key=pw3')],
    sys_outbound_http_log: [call(200, 'https://bob:pw1@creds.example.com/v3/1')],
  }));
  const data = await readRestMessageLogs(sdk, 'Payroll API');
  assert.deepEqual(data.match.hosts, ['https://[redacted]@creds.example.com/']);
  assert.deepEqual(data.unmatched_endpoints, [{ endpoint: 'ftp://[redacted]@files.example.com/x?key=[redacted]', reason: 'not an http or https URL' }]);
  assert.equal(data.calls[0].url, 'https://[redacted]@creds.example.com/v3/1');
  assert.doesNotMatch(JSON.stringify(data) + formatRestMessageLogs(data), /pw[123]/);
});

test('endpointScope takes the host and the directory of the part before a variable, query or fragment', () => {
  assert.deepEqual(endpointScope('https://i.example.com/t/payroll/status.do'), { endpoint: 'https://i.example.com/t/payroll/status.do', host: 'https://i.example.com/', directory: '/t/payroll/' });
  assert.deepEqual(endpointScope('https://a.example.com/x/${id}/y?q=1'), { endpoint: 'https://a.example.com/x/${id}/y?q=1', host: 'https://a.example.com/', directory: '/x/' });
  assert.deepEqual(endpointScope('https://g.example.com/v1.0'), { endpoint: 'https://g.example.com/v1.0', host: 'https://g.example.com/', directory: '/v1.0' });
  assert.deepEqual(endpointScope('HTTP://A.example.com:8443#frag'), { endpoint: 'HTTP://A.example.com:8443#frag', host: 'HTTP://A.example.com:8443/', directory: '/' });
  assert.deepEqual(endpointScope('https://api-${env}.example.com/a/'), { endpoint: 'https://api-${env}.example.com/a/', reason: 'the host is a variable' });
  assert.equal(endpointScope('  '), null);
});

test('rejected input reads nothing', async () => {
  for (const [id, opts] of [['', {}], [undefined, {}], ['Pay^ORname=x', {}], ['Payroll API', { limit: 0 }], ['Payroll API', { limit: 201 }], ['Payroll API', { offset: -1 }],
    ['Payroll API', { status: '99' }], ['Payroll API', { status: '6xx' }], ['Payroll API', { status: '404^ORurlLIKEx' }], ['Payroll API', { endpoint: '' }], ['Payroll API', { endpoint: 'a^ORb' }], ['Payroll API', { endpoint: 'a\nb' }]]) {
    const sdk = fixtureSdk(world());
    await assert.rejects(readRestMessageLogs(sdk, id, opts), undefined, JSON.stringify([id, opts]));
    assert.equal(sdk.calls.length, 0, JSON.stringify([id, opts]));
  }
});

test('missing, denied, mismatched and malformed reads are never reported as calls', async () => {
  const denied = Object.assign(new Error('Forbidden'), { status: 403 });
  await assert.rejects(readRestMessageLogs(fixtureSdk(world({ sys_rest_message: [] })), 'Payroll API'), /not found/i);
  await assert.rejects(readRestMessageLogs(fixtureSdk(world({ sys_rest_message_fn: denied })), 'Payroll API'), /Forbidden/);
  await assert.rejects(readRestMessageLogs(fixtureSdk(world({ sys_outbound_http_log: denied })), 'Payroll API'), /Forbidden/);
  await assert.rejects(readRestMessageLogs(fixtureSdk(world({ sys_outbound_http_log: [null] })), 'Payroll API'), e => e.code === 'malformed_response');
  await assert.rejects(readRestMessageLogs(fixtureSdk(world({ sys_rest_message_fn: [method('x', 'https://x.example.com', { rest_message: v('f'.repeat(32)) })] })), 'Payroll API'), /different REST message/);
  await assert.rejects(readRestMessageLogs(fixtureSdk(world({ sys_rest_message_fn: Array.from({ length: 101 }, (_, i) => method(`m${i}`, `https://h${i}.example.com`)) })), 'Payroll API'), /More than 100 methods/);
  await assert.rejects(readRestMessageLogs(fixtureSdk(world({ sys_rest_message: [message({ sys_id: v('') })] })), 'Payroll API'), /no readable sys_id/);
});

test('human output names the message, each call and the MID server breadcrumb data', async () => {
  const data = await readRestMessageLogs(fixtureSdk(world({ sys_outbound_http_log: [call(502, 'https://api.example.com/v1/a', { mid_server: v('mid01'), method: v('POST') })] })), 'Payroll API');
  const text = formatRestMessageLogs(data);
  assert.match(text, /REST message: Payroll API \(a{32}\)/);
  assert.match(text, /Matched: URLs starting https:\/\/api\.example\.com\/ or https:\/\/other\.example\.com\/ and containing \/v1\/ or \/hooks\/v2\//);
  assert.match(text, /2026-11-26 21:00:00 +502 +POST +https:\/\/api\.example\.com\/v1\/a +147 ms +Basic +MID mid01/);
  assert.match(text, /Credential headers and query values are redacted/);
  assert.deepEqual(data.mid_servers, ['mid01']);
  assert.equal(data.note, undefined);
  const empty = await readRestMessageLogs(fixtureSdk(world({ sys_outbound_http_log: [] })), 'Payroll API');
  assert.match(empty.note, /^No logged call of REST message Payroll API matched\. That is not proof it was not called: log rows age out, ACLs can hide sys_outbound_http_log rows/);
  assert.match(formatRestMessageLogs(empty), /No logged call of REST message Payroll API matched\. That is not proof/);
});

test('real CLI: read-only profile, JSON, --get, styled output, strict validation, GET only', async () => {
  const tables = world();
  const calls = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    calls.push({ method: req.method, pathname: url.pathname });
    res.setHeader('Content-Type', 'application/json');
    const table = url.pathname.startsWith('/api/now/table/') && url.pathname.split('/').pop();
    if (!table) { res.end(JSON.stringify({ result: [] })); return; }
    fixtureSdk(tables).listStrict(table, url.searchParams).then(rows => res.end(JSON.stringify({ result: rows })));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-restmessage-logs-'));
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: true } } }));
  const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
  const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const run = args => promisify(execFile)(process.execPath, [...loopbackCredentialArgs, cli, 'restmessage', ...args], { env, cwd: dir, timeout: 20000 });
  try {
    const envelope = JSON.parse((await run(['logs', 'Payroll API', '--json'])).stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data._formatted, undefined);
    assert.equal(envelope.data.calls.length, 2);
    const piped = JSON.parse((await run(['logs', 'Payroll API', '--limit', '1'])).stdout);
    assert.ok(!('_formatted' in piped.data), 'piped auto output carries no view');
    const paged = JSON.parse((await run(['logs', 'Payroll API', '--limit', '1', '--json', '--verbose'])).stdout);
    assert.ok(paged.breadcrumbs.some(b => b.cmd === `jsn restmessage logs ${MESSAGE} --limit 1 --offset 1`), 'the next page names the message by sys_id');
    assert.equal(JSON.parse((await run(['log', 'Payroll API', '--status', '404', '--get', 'data.message.name'])).stdout), 'Payroll API');
    const styled = (await run(['logs', 'Payroll API', '--styled'])).stdout;
    assert.match(styled, /REST message: Payroll API/);
    assert.match(styled, /404 +GET +https:\/\/api\.example\.com\/v1\/acme\/pay\/9/);
    const tableCalls = () => calls.filter(c => c.pathname.startsWith('/api/now/table/'));
    const before = tableCalls().length;
    for (const args of [['logs', 'Payroll API', '--typo'], ['logs', 'bad^name', '--json'], ['logs', 'Payroll API', '--status', 'x'], ['logs', 'Payroll API', '--limit', '0'], ['logs']]) {
      await assert.rejects(run(args), undefined, JSON.stringify(args));
    }
    assert.equal(tableCalls().length, before, 'rejected input reads nothing');
    assert.match((await run(['logs', '--help'])).stdout, /bodies are never read/i);
    assert.ok(tableCalls().length && tableCalls().every(c => c.method === 'GET'));
    assert.ok(calls.every(c => c.pathname.startsWith('/api/now/table/') || c.pathname === '/angular.do'), JSON.stringify(calls.map(c => c.pathname)));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
