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
import { listSlowPatterns, showSlowPattern, formatSlowPatterns } from '../src/slow-patterns.js';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';

const id = n => n.toString(16).padStart(32, '0');
const field = (value, display = value) => ({ value, display_value: display });
const query = (n, extra = {}) => ({ sys_id: field(id(n)), sys_class_name: field('sys_query_pattern', 'Slow Queries'), label: field(`SELECT synthetic${n}0.\`name\` FROM synthetic${n}`), url: field('Synthetic list\n    sysparm_query=active=true'), count: field('9591763', '9,591,763'), total: field('1970-01-01 02:51:18', '2 Hours 51 Minutes'), average: field('1.07'), first: field('2026-11-04 11:11:17', '2026-11-04 08:11:17'), last: field('2026-11-24 21:57:26', '2026-11-24 18:57:26'), ...extra });
const fullQuery = query(1, { example: field('SELECT synthetic10.`name` FROM synthetic1 synthetic10 WHERE synthetic10.`active` = 1 ORDER BY synthetic10.`name` LIMIT 0,20'), db_name: field('synthetic_1'), pool_name: field('glide'), stack_trace: field('glide.scheduler.worker.1\n\tcom.glide.Synthetic.run(Synthetic.java:1)\n\tSyntheticScriptInclude.get(sys_script_include.abc:12)') });
const script = { sys_id: field(id(5)), sys_class_name: field('sys_script_pattern', 'Slow Scripts'), label: field('sys_script:Synthetic rule'), url: field('/api/now/table/synthetic'), count: field('2'), total: field('1970-01-01 00:45:00', '45 Minutes'), average: field('1354885.27', '1,354,885.27'), script_source_table: field('sys_script'), script_source: field(id(6), 'Synthetic rule'), stack_trace: field('trace for synthetic rule') };
const interaction = { sys_id: field(id(7)), sys_class_name: field('sys_interaction_pattern', 'Slow Interaction'), label: field('Synthetic page'), count: field('1') };
const base = row => ({ sys_id: row.sys_id, sys_class_name: row.sys_class_name });
const tables = { sys_query_pattern: [fullQuery, query(2)], sys_script_pattern: [script], sys_interaction_pattern: [interaction], sys_pattern: [fullQuery, query(2), script, interaction].map(base) };
function fixtureSdk(overrides = {}) {
  const calls = [];
  return { calls, listStrict: async (table, params) => {
    calls.push({ table, params });
    let rows = overrides[table] ?? tables[table] ?? [];
    const q = params.get('sysparm_query');
    if (q.startsWith('sys_id=')) rows = rows.filter(row => row.sys_id.value === q.slice(7));
    return rows.slice(Number(params.get('sysparm_offset') || 0), Number(params.get('sysparm_offset') || 0) + Number(params.get('sysparm_limit')));
  } };
}

test('list ranks slow queries by total with an explicit field list and bounded lookahead', async () => {
  const sdk = fixtureSdk();
  const data = await listSlowPatterns(sdk, { limit: 1 });
  assert.equal(sdk.calls.length, 1);
  assert.equal(sdk.calls[0].table, 'sys_query_pattern');
  assert.equal(sdk.calls[0].params.get('sysparm_query'), 'ORDERBYDESCtotal^ORDERBYsys_id');
  assert.equal(sdk.calls[0].params.get('sysparm_fields'), 'sys_id,sys_class_name,label,url,count,total,average,first,last');
  assert.equal(sdk.calls[0].params.get('sysparm_limit'), '2');
  assert.equal(sdk.calls[0].params.get('sysparm_offset'), '0');
  assert.equal(sdk.calls[0].params.get('sysparm_display_value'), 'all');
  assert.equal(data.table, 'sys_query_pattern');
  assert.deepEqual(data.records[0].count, field('9591763', '9,591,763'));
  assert.deepEqual(data.pagination, { limit: 1, offset: 0, has_more: true, next_offset: 1 });
  const human = formatSlowPatterns(data, 'list');
  assert.match(human, /Slow queries by total/);
  assert.match(human, /2 Hours 51 Minutes[\s\S]*9,591,763[\s\S]*1\.07 ms \| last 2026-11-24 21:57:26 UTC/);
  assert.doesNotMatch(human, /18:57:26/);
  assert.ok(human.includes(id(1)));
  assert.match(human, /Synthetic list: SELECT synthetic10/);
  assert.doesNotMatch(human, /sysparm_query/);
});

test('list maps each type, order and since onto its table and encoded query', async () => {
  const cases = [
    [{ type: 'scripts', orderBy: 'count' }, 'sys_script_pattern', 'ORDERBYDESCcount^ORDERBYsys_id'],
    [{ type: 'transactions', orderBy: 'average' }, 'sys_transaction_pattern', 'ORDERBYDESCaverage^ORDERBYsys_id'],
    [{ type: 'events', since: '2026-11-01' }, 'sysevent_pattern', 'last>=2026-11-01^ORDERBYDESCtotal^ORDERBYsys_id'],
    [{ type: 'mutex', since: '2026-11-01 08:30:00' }, 'sys_mutex_pattern', 'last>=2026-11-01 08:30:00^ORDERBYDESCtotal^ORDERBYsys_id'],
    [{ type: 'cache', offset: 40 }, 'sys_cache_build_pattern', 'ORDERBYDESCtotal^ORDERBYsys_id'],
  ];
  for (const [options, table, encoded] of cases) {
    const sdk = fixtureSdk();
    const data = await listSlowPatterns(sdk, options);
    assert.equal(sdk.calls[0].table, table);
    assert.equal(sdk.calls[0].params.get('sysparm_query'), encoded);
    assert.equal(sdk.calls[0].params.get('sysparm_offset'), String(options.offset ?? 0));
    assert.equal(data.type, options.type);
  }
});

test('show finds the class by raw sys_id, then prints the full SQL and stack trace', async () => {
  const sdk = fixtureSdk();
  const data = await showSlowPattern(sdk, id(1));
  assert.equal(sdk.calls.length, 2);
  assert.equal(sdk.calls[0].table, 'sys_pattern');
  assert.equal(sdk.calls[0].params.get('sysparm_query'), `sys_id=${id(1)}`);
  assert.equal(sdk.calls[0].params.get('sysparm_fields'), 'sys_id,sys_class_name');
  assert.equal(sdk.calls[1].table, 'sys_query_pattern');
  assert.equal(sdk.calls[1].params.get('sysparm_query'), `sys_id=${id(1)}`);
  assert.equal(sdk.calls[1].params.get('sysparm_fields'), 'sys_id,sys_class_name,label,url,count,total,average,first,last,stack_trace,example,executable_sql,placeholders,db_name,pool_name');
  assert.equal(data.type, 'queries');
  const human = formatSlowPatterns(data, 'show');
  assert.ok(human.includes(fullQuery.example.value));
  assert.match(human, /SyntheticScriptInclude\.get\(sys_script_include\.abc:12\)/);
  assert.match(human, /sysparm_query=active=true/);
  assert.match(human, /last 2026-11-24 21:57:26 UTC \| first 2026-11-04 11:11:17 UTC/);

  const scriptData = await showSlowPattern(fixtureSdk(), id(5));
  assert.equal(scriptData.type, 'scripts');
  assert.match(formatSlowPatterns(scriptData, 'show'), /script_source: Synthetic rule[\s\S]*trace for synthetic rule/);

  const other = fixtureSdk();
  const otherData = await showSlowPattern(other, id(7));
  assert.equal(other.calls[1].table, 'sys_interaction_pattern');
  assert.equal(other.calls[1].params.get('sysparm_fields'), 'sys_id,sys_class_name,label,url,count,total,average,first,last,stack_trace');
  assert.equal(otherData.type, null);
});

test('invalid type, order, date, id and bounds reject before any request', async () => {
  const sdk = fixtureSdk();
  for (const options of [{ type: 'query' }, { type: 'sys_query_pattern' }, { orderBy: 'last' }, { orderBy: 'total^ORDERBYsys_id' }, { since: '2026-11' }, { since: '2026-11-01^NQsys_id!=x' }, { since: 'yesterday' }, { since: '2026-11-01T08:00:00Z' }, { limit: 0 }, { limit: 201 }, { limit: 1.5 }, { offset: -1 }, { offset: Infinity }]) {
    await assert.rejects(listSlowPatterns(sdk, options), /--type|--order-by|--since|--limit|--offset/, JSON.stringify(options));
  }
  for (const invalid of ['', 'bad', ` ${id(1)}`, `${id(1)}^NQ`, 123]) await assert.rejects(showSlowPattern(sdk, invalid), /sys_id/);
  assert.equal(sdk.calls.length, 0);
});

test('missing, denied, mismatched and malformed reads fail; an empty list is not called proof', async () => {
  await assert.rejects(showSlowPattern(fixtureSdk(), id(99)), /not found or is not readable/);
  await assert.rejects(showSlowPattern(fixtureSdk({ sys_query_pattern: [] }), id(1)), /not found or is not readable/);
  await assert.rejects(showSlowPattern(fixtureSdk({ sys_pattern: [{ sys_id: field(id(1)), sys_class_name: field('sys_query_pattern/../sys_user') }] }), id(1)), /class/);
  const wrongIdentity = { listStrict: async () => [{ ...base(fullQuery), sys_id: field(id(2), id(1)) }] };
  await assert.rejects(showSlowPattern(wrongIdentity, id(1)), /different record/);
  for (const status of [403, 404]) {
    const error = Object.assign(new Error('Synthetic read denied'), { status });
    await assert.rejects(listSlowPatterns({ listStrict: async () => { throw error; } }), e => e === error);
    await assert.rejects(showSlowPattern({ listStrict: async () => { throw error; } }, id(1)), e => e === error);
  }
  await assert.rejects(listSlowPatterns({ listStrict: async () => ({ result: [] }) }), /Malformed/);
  await assert.rejects(listSlowPatterns({ listStrict: async () => [null] }), /Malformed/);
  const empty = await listSlowPatterns(fixtureSdk({ sys_query_pattern: [] }));
  assert.equal(empty.count, 0);
  assert.match(formatSlowPatterns(empty, 'list'), /does not prove nothing is slow/);
});

test('real CLI reads slow patterns under a read-only profile with JSON, --get, human output and strict validation', async () => {
  const calls = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    calls.push({ method: req.method, pathname: url.pathname });
    res.setHeader('Content-Type', 'application/json');
    if (!url.pathname.startsWith('/api/now/table/')) return res.end(JSON.stringify({ result: [] }));
    Promise.resolve(fixtureSdk().listStrict(url.pathname.split('/').pop(), url.searchParams)).then(rows => res.end(JSON.stringify({ result: rows })));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-slow-patterns-'));
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: true } } }));
  const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
  const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const execute = promisify(execFile);
  const run = args => execute(process.execPath, [...loopbackCredentialArgs, cli, ...args], { env, cwd: dir, timeout: 20000 });
  try {
    const list = JSON.parse((await run(['perf', 'slow', '--limit', '1', '--json'])).stdout);
    assert.equal(list.ok, true);
    assert.equal(list.data.records[0].sys_id.value, id(1));
    assert.equal(list.data.pagination.has_more, true);
    const show = JSON.parse((await run(['perf', 'slow', 'show', id(1), '--json'])).stdout);
    assert.equal(show.data.record.example.value, fullQuery.example.value);
    const get = await run(['perf', 'slow', 'show', id(1), '--get', 'data.record.stack_trace.value']);
    assert.match(get.stdout, /SyntheticScriptInclude/);
    const human = await run(['perf', 'slow', 'show', id(1), '--format', 'styled']);
    assert.ok(human.stdout.includes(fullQuery.example.value));
    const before = calls.length;
    for (const args of [['--type', 'query'], ['--order-by', 'last'], ['--since', 'yesterday'], ['--limit', '0'], ['--typo'], ['show', 'bad'], ['bogus']]) {
      await assert.rejects(run(['perf', 'slow', ...args, '--json']), undefined, JSON.stringify(args));
    }
    assert.equal(calls.length, before);
    const help = await run(['perf', 'slow', '--help']);
    for (const word of ['show', '--type', '--order-by', '--since']) assert.ok(help.stdout.includes(word), word);
    assert.ok(calls.filter(call => call.pathname.startsWith('/api/now/table/')).every(call => call.method === 'GET'));
    assert.ok(calls.every(call => call.pathname.startsWith('/api/now/table/') || call.pathname === '/angular.do'));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
