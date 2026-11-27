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
import {
  loadQueryPattern, explainTarget, buildExplainScript, buildSuggestScript, parseMarker,
  assertExplainAnswer, readPlanRows, readPlanRowsSettled, explainSlowQuery,
  readIndexSuggestion, suggestIndexForSlowQuery, formatExplainPlan, formatIndexSuggestion,
} from '../src/slow-pattern-plans.js';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';

const id = n => n.toString(16).padStart(32, '0');
const field = (value, display = value) => ({ value, display_value: display });
const PATTERN = id(1);
const SUGGESTION = id(9);

const record = (extra = {}) => ({
  sys_id: field(PATTERN),
  sys_class_name: field('sys_query_pattern', 'Slow Queries'),
  label: field('SELECT * FROM incident'),
  executable_sql: field('SELECT * FROM incident WHERE active = 1'),
  example: field('SELECT * FROM incident'),
  pool_name: field('glide'),
  db_name: field('synthetic'),
  stack_trace: field('com.glide.Synthetic.run(Synthetic.java:1)'),
  ...extra,
});
const scriptRecord = { sys_id: field(id(5)), sys_class_name: field('sys_script_pattern', 'Slow Scripts'), label: field('sys_script:Synthetic') };

const mysqlPlan = {
  sys_id: field(id(20)),
  sys_class_name: field('plan_mysql'),
  order: field('1', '1'),
  id: field('1'),
  select_type: field('SIMPLE'),
  table: field('incident'),
  type: field('ALL'),
  possible_keys: field(''),
  key: field(''),
  key_len: field(''),
  ref: field(''),
  rows: field('1200', '1,200'),
  extra: field('Using where'),
};
const suggestion = {
  sys_id: field(SUGGESTION),
  table_name: field('incident'),
  column_names: field('active,caller_id', 'active, caller_id'),
  state: field('new', 'Suggested'),
  index_name: field(''),
  slow_query: field(PATTERN),
  example: field('SELECT ...'),
  sys_created_on: field('2026-11-26 12:00:00'),
};

function fixtureSdk({ execute = () => 'JSN_EXPLAIN:{"ok":true,"engine":"default","status":"ok"}', plans = { plan_mysql: [mysqlPlan] }, suggestionRow = suggestion, planError = {}, classes = {} } = {}) {
  const calls = [];
  const scripts = [];
  return {
    calls,
    scripts,
    async executeScript(script, scope) {
      scripts.push({ script, scope });
      if (typeof execute === 'function') return execute(script);
      throw execute;
    },
    async listStrict(table, params) {
      calls.push({ table, params });
      if (planError[table]) throw planError[table];
      const q = params.get('sysparm_query') || '';
      if (table === 'sys_pattern') {
        if (classes.sys_pattern) return classes.sys_pattern(q);
        return [{ sys_id: field(PATTERN), sys_class_name: field('sys_query_pattern') }];
      }
      if (table === 'sys_query_pattern') return [record()];
      if (table === 'sys_script_pattern') return [scriptRecord];
      if (table === 'sys_index_suggestion') return suggestionRow ? [suggestionRow] : [];
      if (table in plans) return plans[table];
      if (table.startsWith('plan_')) return [];
      return [];
    },
  };
}

test('explainTarget takes executable SQL first, then the example, as the UI action does', () => {
  assert.deepEqual(explainTarget(record()), { engine: 'default', collection: null, sql: 'SELECT * FROM incident WHERE active = 1' });
  assert.equal(explainTarget({ example: field('SELECT 1') }).sql, 'SELECT 1');
  assert.throws(() => explainTarget({}), /no executable_sql or example/);
  assert.throws(() => explainTarget({ executable_sql: field('') }), /no executable_sql or example/);
});

test('explainTarget routes MongoTable and trino queries like the UI action', () => {
  const mongo = explainTarget({
    executable_sql: field('MongoTable{fCollection=task, fDefinition=incident}\n{"find":"incident","filter":{}}'),
  });
  assert.equal(mongo.engine, 'mongo');
  assert.equal(mongo.collection, 'incident');
  assert.equal(mongo.sql, '{"find":"incident","filter":{}}');

  assert.equal(explainTarget({ executable_sql: field('SELECT 1'), pool_name: field('trino-default') }).engine, 'trino');
  assert.equal(explainTarget({ executable_sql: field('SELECT 1'), pool_name: field('glide') }).engine, 'default');

  assert.throws(() => explainTarget({ executable_sql: field('MongoTable{fCollection=task}') }), /missing fDefinition/);
  assert.throws(() => explainTarget({ executable_sql: field('MongoTable{fDefinition=incident}') }), /no query after its collection header/);
});

test('the explain payload names the pattern, quotes the SQL and picks the matching engine call', () => {
  const sql = `SELECT "quoted"\nFROM incident WHERE note = 'it''s'`;
  const script = buildExplainScript({ id: PATTERN, target: { engine: 'default', collection: null, sql } });
  assert.match(script, new RegExp(`patternId = "${PATTERN}"`));
  assert.ok(script.includes(JSON.stringify(sql)));
  assert.match(script, /GlideAQueryExplanation\.get\(\)/);
  assert.match(script, /explainPlan\(sql, patternId, null\)/);
  assert.doesNotMatch(script, /current\.update\(\)/);
  assert.match(buildExplainScript({ id: PATTERN, target: { engine: 'trino', sql } }), /GlideAQueryExplanation\.getForTrino\(\)/);
  assert.match(buildExplainScript({ id: PATTERN, target: { engine: 'mongo', collection: 'sys_user', sql } }), /GlideAQueryExplanation\.get\("sys_user"\)/);

  assert.throws(() => buildExplainScript({ id: 'not-a-id', target: { engine: 'default', sql } }), /32-character hexadecimal/);
  assert.throws(() => buildExplainScript({ id: PATTERN, target: {} }), /needs the slow query SQL/);
});

test('the suggest payload carries the exact sys_id and refuses a malformed one', () => {
  const script = buildSuggestScript(PATTERN);
  assert.ok(script.includes(`"${PATTERN}"`));
  assert.match(script, /new SNC\.IndexSuggestionAPI\(\)/);
  assert.match(script, /suggestIndex\(record\)/);
  assert.throws(() => buildSuggestScript(`${PATTERN}^NQ`), /32-character hexadecimal/);
});

test('parseMarker takes the last answer, and rejects output it cannot trust', () => {
  assert.deepEqual(parseMarker('JSN_EXPLAIN:{"ok":true,"status":"old"}\nJSN_EXPLAIN:{"ok":true,"status":"new"}', 'explain'), { ok: true, status: 'new' });
  assert.throws(() => parseMarker('nothing here', 'explain'), /printed no JSN_EXPLAIN result/);
  assert.throws(() => parseMarker('JSN_EXPLAIN:{not json}', 'explain'), /not valid JSON/);
  assert.throws(() => parseMarker('JSN_EXPLAIN:{"ok":"yes"}', 'explain'), /malformed/);
});

test('a disabled engine or a statistics answer is a failure carrying the provider message', () => {
  assert.throws(() => assertExplainAnswer({ ok: false, error: 'Index suggestion engine is not enabled' }), /Explain plan failed: Index suggestion engine is not enabled/);
  assert.throws(() => assertExplainAnswer({ ok: true, status: 'Table statistics are stale; run ANALYZE TABLE incident' }), /statistics are stale/);
  assert.throws(() => assertExplainAnswer({ ok: true, status: 'Explain is not supported on this engine' }), /not supported/);
  assert.throws(() => assertExplainAnswer({ ok: true, status: 'stats needed for incident' }), /stats needed/);
  assert.equal(assertExplainAnswer({ ok: true, status: 'ok' }), 'ok');
  assert.equal(assertExplainAnswer({ ok: true }), '');
});

test('readPlanRows reads each engine table separately and sorts by the platform order', async () => {
  const sdk = fixtureSdk({ plans: {
    plan_mysql: [{ ...mysqlPlan, order: field('2', '2') }, { ...mysqlPlan, sys_id: field(id(21)), order: field('1', '1'), table: field('sys_user') }],
    plan_trino: [{ sys_id: field(id(22)), sys_class_name: field('plan_trino'), order: field('1', '1'), plan: field('Scan[table=incident]') }],
  } });
  const plan = await readPlanRows(sdk, PATTERN);
  assert.deepEqual(plan.tables, ['plan_mysql', 'plan_postgres', 'plan_oracle', 'plan_trino']);
  assert.equal(plan.rows.length, 3);
  assert.equal(plan.rows[0].table.value, 'sys_user');
  assert.equal(plan.rows[1].plan.value, 'Scan[table=incident]');
  const mysqlCall = sdk.calls.find(call => call.table === 'plan_mysql');
  assert.equal(mysqlCall.params.get('sysparm_query'), `sys_query_pattern=${PATTERN}`);
  assert.equal(mysqlCall.params.get('sysparm_fields'), 'sys_id,sys_class_name,order,id,select_type,table,type,possible_keys,key,key_len,ref,rows,extra');
  assert.equal(mysqlCall.params.get('sysparm_display_value'), 'all');
  assert.equal(mysqlCall.params.get('sysparm_limit'), '500');
});

test('an unreadable plan table is reported, never silently empty', async () => {
  const forbidden = Object.assign(new Error('Access forbidden (HTTP 403).'), { status: 403 });
  const sdk = fixtureSdk({ plans: {}, planError: { plan_mysql: forbidden, plan_postgres: forbidden, plan_oracle: forbidden, plan_trino: forbidden } });
  const plan = await readPlanRows(sdk, PATTERN);
  assert.equal(plan.rows.length, 0);
  assert.equal(plan.tables.length, 0);
  assert.equal(plan.unavailable.length, 4);
  assert.equal(plan.unavailable[0].status, 403);

  const broken = fixtureSdk({ planError: { plan_mysql: Object.assign(new Error('boom'), { status: 500 }) } });
  await assert.rejects(readPlanRows(broken, PATTERN), /boom/);
});

test('plan readback retries a lagging empty answer but never past its bound', async () => {
  let reads = 0;
  const sdk = {
    async listStrict(table) {
      if (table !== 'plan_mysql') return [];
      reads++;
      return reads < 2 ? [] : [mysqlPlan];
    },
  };
  const plan = await readPlanRowsSettled(sdk, PATTERN, { delay: async () => {} });
  assert.equal(plan.rows.length, 1);
  assert.equal(reads, 2);

  const alwaysEmpty = { async listStrict(_table) { return []; } };
  const empty = await readPlanRowsSettled(alwaysEmpty, PATTERN, { attempts: 2, delay: async () => {} });
  assert.equal(empty.rows.length, 0);
});

test('explain reads the pattern, runs the action and returns the plan rows with status', async () => {
  const sdk = fixtureSdk();
  const data = await explainSlowQuery(sdk, PATTERN, { delay: async () => {} });
  assert.equal(sdk.scripts.length, 1);
  assert.equal(sdk.scripts[0].scope, 'global');
  assert.match(sdk.scripts[0].script, /sys_query_pattern/);
  assert.equal(data.pattern.sys_id, PATTERN);
  assert.equal(data.engine, 'default');
  assert.equal(data.status, 'ok');
  assert.equal(data.count, 1);
  assert.deepEqual(data.plan_tables, ['plan_mysql', 'plan_postgres', 'plan_oracle', 'plan_trino']);
  const human = formatExplainPlan(data);
  assert.match(human, /Explain plan for slow query/);
  assert.match(human, /type ALL \| key \(none\)/);
  assert.match(human, /wrote plan rows on the instance/);
});

test('explain refuses a non-query pattern before writing anything', async () => {
  const sdk = fixtureSdk({ classes: { sys_pattern: () => [{ sys_id: field(id(5)), sys_class_name: field('sys_script_pattern') }] } });
  await assert.rejects(loadQueryPattern(sdk, id(5)), /only Slow Queries/);
  await assert.rejects(explainSlowQuery(sdk, id(5)), /only Slow Queries/);
  assert.equal(sdk.scripts.length, 0);
  await assert.rejects(loadQueryPattern(fixtureSdk(), 'bad'), /32-character hexadecimal/);
});

test('explain surfaces provider failures, an empty plan and an unreadable readback', async () => {
  const providerFailure = fixtureSdk({ execute: () => 'JSN_EXPLAIN:{"ok":false,"error":"Table statistics are outdated"}' });
  await assert.rejects(explainSlowQuery(providerFailure, PATTERN, { delay: async () => {} }), /Explain plan failed: Table statistics are outdated/);
  assert.equal(providerFailure.calls.length, 2); // the pattern read only — no plan read

  const statistics = fixtureSdk({ execute: () => 'JSN_EXPLAIN:{"ok":true,"status":"needs table statistics"}' });
  await assert.rejects(explainSlowQuery(statistics, PATTERN, { delay: async () => {} }), /needs table statistics/);

  const noRows = fixtureSdk({ plans: {} });
  await assert.rejects(explainSlowQuery(noRows, PATTERN, { attempts: 1, delay: async () => {} }), /wrote no readable plan rows\. That is a failure, not an empty plan/);

  const forbidden = Object.assign(new Error('Access forbidden (HTTP 403).'), { status: 403 });
  const unreadable = fixtureSdk({ planError: { plan_mysql: forbidden, plan_postgres: forbidden, plan_oracle: forbidden, plan_trino: forbidden } });
  await assert.rejects(explainSlowQuery(unreadable, PATTERN, { attempts: 1, delay: async () => {} }), /no plan table is readable.*plan_mysql \(HTTP 403\)/);

  const broken = fixtureSdk({ execute: () => { throw new Error('Background script failed: script exceeded its time limit'); } });
  await assert.rejects(explainSlowQuery(broken, PATTERN), /script exceeded its time limit/);

  const garbage = fixtureSdk({ execute: () => 'no marker' });
  await assert.rejects(explainSlowQuery(garbage, PATTERN), /printed no JSN_EXPLAIN result/);
});

test('suggest-index reads back the record the API claims to have created', async () => {
  const sdk = fixtureSdk({ execute: () => `JSN_SUGGEST:{"ok":true,"value":"${SUGGESTION}"}` });
  const data = await suggestIndexForSlowQuery(sdk, PATTERN);
  assert.equal(data.suggestion.sys_id.value, SUGGESTION);
  assert.equal(data.pattern.sys_id, PATTERN);
  const readback = sdk.calls.find(call => call.table === 'sys_index_suggestion');
  assert.equal(readback.params.get('sysparm_query'), `sys_id=${SUGGESTION}`);
  const human = formatIndexSuggestion(data);
  assert.match(human, /Table: incident/);
  assert.match(human, /Columns: active, caller_id/);
  assert.match(human, /A suggestion record, not an index/);
});

test('suggest-index never turns a disabled engine, an empty answer or a bad readback into success', async () => {
  const engineOff = fixtureSdk({ execute: () => 'JSN_SUGGEST:{"ok":false,"error":"SNC is not defined"}' });
  await assert.rejects(suggestIndexForSlowQuery(engineOff, PATTERN), /Index suggestion failed: SNC is not defined/);
  assert.equal(engineOff.calls.length, 2);

  const statistics = fixtureSdk({ execute: () => 'JSN_SUGGEST:{"ok":true,"value":"needs statistics"}' });
  await assert.rejects(suggestIndexForSlowQuery(statistics, PATTERN), /answered "needs statistics" instead of a sys_index_suggestion sys_id/);

  const empty = fixtureSdk({ execute: () => 'JSN_SUGGEST:{"ok":true,"value":""}' });
  await assert.rejects(suggestIndexForSlowQuery(empty, PATTERN), /\(empty answer\)/);

  const missing = fixtureSdk({ execute: () => `JSN_SUGGEST:{"ok":true,"value":"${SUGGESTION}"}`, suggestionRow: null });
  await assert.rejects(suggestIndexForSlowQuery(missing, PATTERN), /no sys_index_suggestion record is readable/);
  assert.equal(await readIndexSuggestion(missing, SUGGESTION), null);

  const foreign = fixtureSdk({ execute: () => `JSN_SUGGEST:{"ok":true,"value":"${SUGGESTION}"}`, suggestionRow: { ...suggestion, slow_query: field(id(3)) } });
  await assert.rejects(suggestIndexForSlowQuery(foreign, PATTERN), /belongs to slow query/);

  const blank = fixtureSdk({ execute: () => `JSN_SUGGEST:{"ok":true,"value":"${SUGGESTION}"}`, suggestionRow: { ...suggestion, column_names: field('') } });
  await assert.rejects(suggestIndexForSlowQuery(blank, PATTERN), /no table or columns/);

  const broken = fixtureSdk({ execute: () => { throw new Error('Background script failed: quota exceeded'); } });
  await assert.rejects(suggestIndexForSlowQuery(broken, PATTERN), /quota exceeded/);
});

// ── live loopback CLI ────────────────────────────────────────────────────────
// The background script is simulated at /sys.scripts.do, exactly where the SDK
// sends it. The instance is never contacted and nothing is written anywhere.

function cliFixture() {
  const calls = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    calls.push({ method: req.method, pathname: url.pathname, query: url.searchParams.get('sysparm_query'), body: null });
    const json = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/angular.do' && url.searchParams.get('sysparm_type') === 'view_form.login') return json(200, {});
    if (url.pathname === '/angular.do') return json(200, {}, { 'X-UserToken-Response': 'fixture-token' });
    if (url.pathname === '/sys.scripts.do' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<input name="sysparm_ck" type="hidden" value="fixture-csrf">');
    }
    if (url.pathname === '/sys.scripts.do') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const script = decodeURIComponent(body.replace(/\+/g, ' '));
        const call = calls.at(-1);
        call.body = script;
        const answer = script.includes('JSN_SUGGEST')
          ? `JSN_SUGGEST:{"ok":true,"value":"${SUGGESTION}"}`
          : 'JSN_EXPLAIN:{"ok":true,"engine":"default","status":"ok"}';
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<PRE>${answer}<BR></PRE>`);
      });
      return;
    }
    if (url.pathname.startsWith('/api/now/table/')) {
      const table = url.pathname.split('/').pop();
      const query = url.searchParams.get('sysparm_query') || '';
      if (table === 'sys_pattern') return json(200, { result: query.includes(id(5)) ? [{ sys_id: field(id(5)), sys_class_name: field('sys_script_pattern') }] : [{ sys_id: field(PATTERN), sys_class_name: field('sys_query_pattern') }] });
      if (table === 'sys_query_pattern') return json(200, { result: [record()] });
      if (table === 'sys_script_pattern') return json(200, { result: [scriptRecord] });
      if (table === 'plan_mysql') return json(200, { result: [mysqlPlan] });
      if (table === 'sys_index_suggestion') return json(200, { result: [suggestion] });
      return json(200, { result: [] });
    }
    return json(404, { error: { message: 'not found' } });
  });
  return { server, calls };
}

async function withCliFixture(options, fn) {
  const { server, calls } = cliFixture(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-perf-plans-')));
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: options.readOnly === true } } }));
  const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
  const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const run = args => promisify(execFile)(process.execPath, [...loopbackCredentialArgs, cli, ...args], { env, cwd: dir, timeout: 20000 });
  try {
    return await fn({ run, calls });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const posted = calls => calls.filter(call => call.pathname === '/sys.scripts.do' && call.method === 'POST');

test('a read-only profile refuses explain and suggest-index before any request', async () => {
  await withCliFixture({ readOnly: true }, async ({ run, calls }) => {
    for (const command of ['explain', 'suggest-index']) {
      const failure = await run(['perf', command, PATTERN, '--force', '--json']).catch(error => error);
      const envelope = JSON.parse(failure.stdout);
      assert.equal(envelope.ok, false, command);
      assert.equal(envelope.code, 'read_only', command);
      assert.equal(failure.code, 1, command);
    }
    assert.equal(calls.length, 0);
  });
});

test('both writes require an explicit confirmation and write nothing when refused', async () => {
  await withCliFixture({}, async ({ run, calls }) => {
    for (const command of ['explain', 'suggest-index']) {
      const failure = await run(['perf', command, PATTERN, '--json']).catch(error => error);
      const envelope = JSON.parse(failure.stdout);
      assert.equal(envelope.code, 'confirmation_required', command);
      assert.match(envelope.hint, new RegExp(`jsn perf ${command} ${PATTERN} --force`));
    }
    // Reading the pattern for the prompt is allowed; the write is not sent.
    assert.equal(posted(calls).length, 0);
    assert.ok(calls.every(call => call.method === 'GET' || call.pathname === '/angular.do'));
  });
});

test('explain --force runs the action once and reports the plan rows', async () => {
  await withCliFixture({}, async ({ run, calls }) => {
    const envelope = JSON.parse((await run(['perf', 'explain', PATTERN, '--force', '--json'])).stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.status, 'ok');
    assert.equal(envelope.data.count, 1);
    assert.equal(envelope.data.plan_rows[0].table.value, 'incident');
    assert.equal(posted(calls).length, 1);
    assert.match(posted(calls)[0].body, new RegExp(PATTERN));
    assert.ok(posted(calls)[0].body.includes('WHERE active = 1'));

    const human = await run(['perf', 'explain', PATTERN, '--force', '--format', 'styled']);
    assert.match(human.stdout, /Explain plan for slow query/);
    assert.match(human.stdout, /Plan rows: 1/);
  });
});

test('suggest-index --force runs the action once and reports the suggestion', async () => {
  await withCliFixture({}, async ({ run, calls }) => {
    const envelope = JSON.parse((await run(['perf', 'suggest-index', PATTERN, '--force', '--json'])).stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.suggestion.sys_id.value, SUGGESTION);
    assert.equal(posted(calls).length, 1);
    const human = await run(['perf', 'suggest-index', PATTERN, '--force', '--format', 'styled']);
    assert.match(human.stdout, /Table: incident/);
  });
});

test('strict validation and a non-query pattern fail before the script is sent', async () => {
  await withCliFixture({}, async ({ run, calls }) => {
    for (const arg of ['', 'bad', `${PATTERN}^NQ`]) {
      const failure = await run(['perf', 'explain', arg, '--force', '--json']).catch(error => error);
      assert.equal(JSON.parse(failure.stdout).code, 'usage_error', JSON.stringify(arg));
    }
    const notQuery = await run(['perf', 'explain', id(5), '--force', '--json']).catch(error => error);
    assert.equal(JSON.parse(notQuery.stdout).code, 'usage_error');
    assert.match(JSON.parse(notQuery.stdout).error, /only Slow Queries/);
    assert.equal(posted(calls).length, 0);
    const help = await run(['perf', 'explain', '--help']);
    assert.match(help.stdout, /not yet verified against a live instance/);
    assert.match(help.stdout, /--force/);
  });
});
