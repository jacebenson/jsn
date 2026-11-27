import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { whySlas, formatSlaWhy } from '../src/slas-why.js';
import { isMutationCommand } from '../src/mutations.js';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';
import '../src/command-families.js';

const id = n => n.toString(16).padStart(32, '0');
const field = (value, display = value) => ({ value, display_value: display });
const INC = id(1), P1 = id(10), P2 = id(11), FRESH = id(13), SIMPLE = id(30), SIMPLE_INCLUDE = id(31);
// One definition, as the REST read and the background script each see it.
const definition = (n, name, conditions = {}, extra = {}) => ({ n, name, conditions: { start: 'active=true', stop: 'state=7', pause: 'state=3', ...conditions },
  collection: 'incident', active: 'true', when_to_cancel: 'no_match', when_to_resume: 'no_match', condition_class: '', ...extra });
const DEFINITIONS = [definition(10, 'P1 resolution', { start: 'priority=1' }), definition(11, 'P2 resolution', { start: 'priority=2' }),
  definition(12, 'Response', { stop: 'assigned_toISNOTEMPTY' }), definition(13, 'Unassigned response')];
const MATCHES = { 'priority=1': true, 'active=true': true, assigned_toISNOTEMPTY: true };
const restRow = d => ({ sys_id: field(id(d.n)), name: field(d.name), collection: field(d.collection), type: field('SLA'), target: field('resolution'), duration_type: field(''),
  duration: field('1970-01-01 04:00:00', '4 Hours'), schedule_source: field('no_schedule'), schedule: field(''), schedule_source_field: field(''), active: field(d.active), sys_scope: field('global', 'Global'),
  ...Object.fromEntries(Object.entries(d.conditions).map(([name, query]) => [`${name}_condition`, field(query)])), when_to_cancel: field(d.when_to_cancel), when_to_resume: field(d.when_to_resume),
  condition_class: field(d.condition_class) });
const scriptRow = d => ({ sys_id: id(d.n), when_to_cancel: d.when_to_cancel, when_to_resume: d.when_to_resume, condition_class: d.condition_class,
  ...Object.fromEntries(Object.entries(d.conditions).map(([name, query]) => [`${name}_condition`, query])) });
const taskSla = (n, def, extra = {}) => ({ sys_id: field(id(n)), task: field(INC), sla: field(def, 'label'), stage: field('in_progress'), has_breached: field('false'), active: field('true'),
  start_time: field('2026-11-24 23:14:50'), end_time: field(''), planned_end_time: field('2026-11-25 03:14:50'), business_duration: field(''), business_percentage: field('10'), business_time_left: field(''), ...extra });
const TASK_SLAS = [taskSla(20, P1), taskSla(21, FRESH, { stage: field('cancelled'), active: field('false') })];

// The platform the background script sees. Every method the script reaches is checked against the reads it
// may make; anything else (insert, update, deleteRecord, setValue, gs.setProperty...) is recorded as unexpected,
// which is how these tests prove the script writes nothing.
const READS = { GlideRecord: ['get', 'getValue'], gs: ['print', 'getProperty'], SNC: ['Filter'], Filter: ['checkRecord'] };
function platform({ definitions = DEFINITIONS, matches = MATCHES, throws = [], properties = {}, classes = [], includes = [] } = {}) {
  const unexpected = [], reads = [], printed = [], records = new WeakMap();
  const guard = (label, target) => new Proxy(target, { get(t, name) {
    if (typeof name === 'string' && !READS[label].includes(name)) unexpected.push(`${label}.${name}`);
    return t[name] ?? (() => {});
  } });
  const tables = { incident: [{ sys_id: INC, priority: '1' }], contract_sla: definitions.map(scriptRow), sla_condition_class: classes, sys_script_include: includes };
  function GlideRecord(table) {
    const state = { table, row: null };
    const record = guard('GlideRecord', { get: sysId => { reads.push(['get', table, sysId]); state.row = (tables[table] ?? []).find(row => row.sys_id === sysId) ?? null; return Boolean(state.row); },
      getValue: name => state.row?.[name] || null });
    records.set(record, state);
    return record;
  }
  const checkRecord = (record, query, matchAll, caseSensitive) => {
    const { table, row } = records.get(record);
    reads.push(['check', table, row.sys_id, query, matchAll, caseSensitive]);
    if (throws.includes(query)) throw new Error('Invalid query');
    return matches[query] === true;
  };
  const context = { GlideRecord, gs: guard('gs', { print: line => printed.push(`*** Script: ${line}`), getProperty: (name, fallback) => properties[name] ?? fallback }),
    SNC: guard('SNC', { Filter: guard('Filter', { checkRecord }) }) };
  return { unexpected, reads, run: script => { printed.length = 0; vm.runInNewContext(script, context); return printed.join('\n'); } };
}

function fixture({ definitions = DEFINITIONS, taskSlas = TASK_SLAS, task = { sys_id: field(INC), number: field('INC0010001'), sys_class_name: field('incident', 'Incident') }, output, ...options } = {}) {
  const calls = [], instance = platform({ definitions, ...options });
  const sdk = {
    async listStrict(table, params) {
      calls.push({ table, query: params.get('sysparm_query'), limit: params.get('sysparm_limit') });
      if (table === 'task') return [task];
      if (table === 'task_sla') return taskSlas;
      const terms = params.get('sysparm_query').split('^').filter(term => !term.startsWith('ORDERBY')).map(term => term.split('='));
      const rows = definitions.filter(d => terms.every(([name, value]) => name === 'sys_id' ? id(d.n) === value : name === 'name' ? d.name === value : name === 'collection' ? d.collection === value : d.active === value));
      return rows.map(restRow).slice(0, Number(params.get('sysparm_limit')));
    },
    async executeScript(script, scope, opts) { calls.push({ script, scope, opts }); return output ?? instance.run(script); },
  };
  return { sdk, calls, instance };
}

test('reads the record, its task SLAs and the active definitions on its table, then tests each one\'s conditions in one read-only script', async () => {
  const f = fixture();
  const data = await whySlas(f.sdk, { task: 'INC0010001' });
  assert.deepEqual(f.calls.slice(0, 3).map(call => [call.table, call.query, call.limit]), [
    ['task', 'number=INC0010001^ORDERBYsys_id', '2'], ['task_sla', `task=${INC}^ORDERBYstart_time^ORDERBYsys_id`, '101'],
    ['contract_sla', 'collection=incident^active=true^ORDERBYname^ORDERBYsys_id', '101']]);
  assert.equal(f.calls.length, 4, 'one background script');
  assert.equal(f.calls[3].scope, 'global');
  assert.equal(f.calls[3].opts.rollback, false, 'no rollback context is recorded');
  assert.equal('visibility' in data, false);
  assert.deepEqual(f.instance.reads.slice(0, 2), [['get', 'incident', INC], ['get', 'contract_sla', P1]], 'the record is loaded as its own class');
  assert.deepEqual(f.instance.reads.filter(([kind]) => kind === 'check').slice(0, 3), [['check', 'incident', INC, 'priority=1', true, false],
    ['check', 'incident', INC, 'state=3', true, false], ['check', 'incident', INC, 'state=7', true, false]], 'SLAConditionBase\'s call, case-insensitive by default');
  assert.deepEqual(f.instance.unexpected, [], 'the script makes no call outside its reads');
  assert.deepEqual(data.records.map(d => [d.name, d.conditions, d.verdict]), [
    ['P1 resolution', { start: true, pause: false, stop: false }, 'Attached: in progress.'],
    ['P2 resolution', { start: false, pause: false, stop: false }, 'Not attached: the start condition does not match the record.'],
    ['Response', { start: true, pause: false, stop: true }, 'Not attached: the start condition matches, but so does the stop condition, which stops it attaching.'],
    ['Unassigned response', { start: true, pause: false, stop: false }, 'Not attached, though the start condition matches and nothing stops it. The SLA engine tests conditions only when the record is saved, so it attaches at the next update unless a contract or service offering rule stops it.']]);
  assert.deepEqual(data.records[3].task_slas, [{ sys_id: id(21), stage: 'cancelled', active: false }], 'task SLAs join on the raw definition sys_id');
  assert.deepEqual([data.count, data.attached, data.case_sensitive, data.more, data.more_task_slas], [4, 1, false, false, false]);
  const human = formatSlaWhy(data);
  assert.match(human, /^Why SLAs attach to INC0010001 \(incident\) \[0+1\] \(read-only background script; conditions tested against the record as saved\)\n {2}P1 resolution \[0+a\]\n {4}start matches, pause no match, stop no match\n {4}Attached: in progress\.\n/);
  assert.match(human, /Unassigned response \[0+d\]\n {4}start matches, pause no match, stop no match\n {4}earlier task SLA \[0+15\]: cancelled\n {4}Not attached, though/);
  assert.match(human, /Conditions were matched ignoring case, as com\.snc\.sla\.condition\.case_sensitive sets\. Contract and service offering rules were not tested\.$/);
});

test('the script writes nothing: a write call anywhere in it is caught', async () => {
  const f = fixture();
  await whySlas(f.sdk, { task: INC });
  assert.equal(f.calls[0].query, `sys_id=${INC}^ORDERBYsys_id`);
  const script = f.calls[3].script;
  for (const write of ['sla.update();', 'sla.deleteRecord();', 'sla.setValue(\'active\', false);', 'task.insert();', 'gs.setProperty(\'x\', \'y\');', 'gs.eventQueue(\'x\', task);']) {
    const probe = platform();
    probe.run(script.replace('var row = {', `${write} var row = {`));
    assert.notDeepEqual(probe.unexpected, [], `${write} is caught`);
  }
  assert.doesNotMatch(script, /\b(insert|update|deleteRecord|deleteMultiple|updateMultiple|setValue|setProperty|eventQueue)\s*\(/);
});

test('a named definition is tested whatever its state, and each reason it cannot attach is said', async () => {
  const why = async (d, options = {}) => (await whySlas(fixture({ definitions: [d], taskSlas: [], ...options }).sdk, { task: 'INC0010001', definition: d.name })).records[0];
  assert.equal((await why(definition(14, 'Retired', {}, { active: 'false' }))).verdict, 'Not attached: the definition is inactive, and the SLA engine tests only active ones.');
  assert.equal((await why(definition(15, 'On task', {}, { collection: 'task' }))).verdict,
    'Not attached: it is defined on task, and the SLA engine tests only definitions on the record\'s own table, incident.');
  assert.equal((await why(definition(16, 'No start', { start: '' }))).verdict, 'Not attached: it has no start condition, so it never attaches.');
  let row = await why(definition(17, 'Cancelled', { cancel: 'priority=1' }, { when_to_cancel: 'on_condition' }));
  assert.deepEqual([row.conditions, row.verdict], [{ start: true, pause: false, stop: false, cancel: true }, 'Not attached: the start condition matches, but so does the cancel condition, which stops it attaching.']);
  row = await why(definition(18, 'Resumes', { resume: 'priority=1' }, { when_to_resume: 'on_condition' }));
  assert.deepEqual(row.conditions, { start: true, pause: false, stop: false, resume: true });
  row = await why(definition(19, 'Changed', { start: 'priorityVALCHANGES^priority=1' }));
  assert.deepEqual([row.changes, row.verdict], [['start'], 'Not attached: the start condition does not match the record. The start condition uses a changes operator, which matches only while an update is saved, so it reads as no match here.']);
  row = await why(definition(20, 'Broken', { start: 'u_gone=1', stop: 'u_gone=2' }), { throws: ['u_gone=1', 'u_gone=2'] });
  assert.deepEqual([row.errors, row.verdict], [['start', 'stop'], 'Not attached: the start condition does not match the record. The start and stop conditions threw an error when tested, which the SLA engine counts as no match.']);
  const simple = { classes: [{ sys_id: SIMPLE, class_name: SIMPLE_INCLUDE }], includes: [{ sys_id: SIMPLE_INCLUDE, name: 'SLAConditionSimple' }] };
  row = await why(definition(21, 'Simple', {}, { condition_class: SIMPLE }), simple);
  assert.deepEqual([row.condition_class, row.verdict], ['SLAConditionSimple', 'Not attached. It uses the SLAConditionSimple condition class, which decides for itself; only its condition strings were tested.']);
  row = await why(definition(22, 'Default class record', {}, { condition_class: SIMPLE }), { classes: [{ sys_id: SIMPLE, class_name: '' }] });
  assert.equal(row.condition_class, 'SLAConditionBase', 'a class record with no script include falls back to the default, as TaskSLAController does');
  row = await why(definition(23, 'Property default'), { properties: { 'com.snc.sla.default_conditionclass': 'CustomerConditions' } });
  assert.equal(row.condition_class, 'CustomerConditions');
  const f = fixture({ definitions: [definition(24, 'Case sensitive')], properties: { 'com.snc.sla.condition.case_sensitive': 'true' } });
  const data = await whySlas(f.sdk, { task: 'INC0010001', definition: id(24) });
  assert.equal(f.calls[0].query, `sys_id=${id(24)}`);
  assert.ok(f.instance.reads.filter(([kind]) => kind === 'check').every(read => read[5] === true));
  assert.match(formatSlaWhy(data), /Conditions were matched case-sensitively/);
});

test('no active definitions on the table runs no script, and more than the limit says only the first were tested', async () => {
  const f = fixture({ definitions: [] });
  const data = await whySlas(f.sdk, { task: 'INC0010001' });
  assert.equal(f.calls.some(call => call.script), false);
  assert.deepEqual([data.count, data.case_sensitive], [0, null]);
  assert.match(data.visibility, /ACLs can hide rows/, 'an empty result says why in the data, for JSON readers');
  const bare = await whySlas(fixture({ taskSlas: [] }).sdk, { task: 'INC0010001' });
  assert.match(bare.visibility, /No readable task SLAs on the record\. ACLs can hide rows, so a definition shown as not attached may still be attached\./, 'an empty task SLA read is not proof of absence');
  assert.match(formatSlaWhy(bare), /may still be attached\.\nConditions were matched/);
  assert.match(formatSlaWhy(data), /No readable active SLA definitions on incident\. ACLs can hide rows, so an empty list does not prove there are none\.$/);
  const many = Array.from({ length: 101 }, (_, n) => definition(100 + n, `SLA ${String(n).padStart(3, '0')}`));
  const big = fixture({ definitions: many, taskSlas: Array.from({ length: 101 }, (_, n) => taskSla(300 + n, P2)) });
  const wide = await whySlas(big.sdk, { task: 'INC0010001' });
  assert.equal(JSON.parse(big.calls[3].script.match(/ids = (\[[^\]]*\])/)[1]).length, 100, 'at most 100 definitions go to the script');
  assert.deepEqual([wide.count, wide.more, wide.more_task_slas], [100, true, true]);
  assert.match(formatSlaWhy(wide), /More than 100 active definitions on incident; only the first 100 by name were tested\.\nMore than 100 task SLAs on the record/);
});

test('a missing, malformed or mismatched answer is never reported as a verdict, and bad input sends nothing', async () => {
  const row = { sys_id: P1, condition_class: 'SLAConditionBase', when_to_cancel: 'no_match', when_to_resume: null, conditions: { start: true, pause: false, resume: null, stop: false, cancel: null }, errors: [], changes: [] };
  const body = { found: true, case_sensitive: false, default_class: 'SLAConditionBase', definitions: [row] };
  const printed = value => `*** Script: JSN_SLA_WHY:${typeof value === 'string' ? value : JSON.stringify(value)}`;
  for (const output of ['', '*** Script: something else', printed('{not json'), printed({ ...body, case_sensitive: 'false' }), printed({ ...body, found: undefined }), printed({ ...body, definitions: [] }),
    printed({ ...body, definitions: [{ ...row, sys_id: P2 }] }), printed({ ...body, definitions: [{ ...row, conditions: { ...row.conditions, start: 'true' } }] }),
    printed({ ...body, definitions: [{ ...row, errors: ['reset'] }] }), printed({ ...body, definitions: [{ ...row, condition_class: '' }] }), printed({ ...body, definitions: [{ ...row, when_to_cancel: 1 }] })]) {
    await assert.rejects(whySlas(fixture({ definitions: [DEFINITIONS[0]], output }).sdk, { task: 'INC0010001' }), error => error.code === 'api_error', output);
  }
  await assert.rejects(whySlas(fixture({ output: printed({ found: false, definitions: [] }) }).sdk, { task: 'INC0010001' }), /could not read incident 0+1/);
  const odd = fixture({ task: { sys_id: field(INC), number: field('INC0010001'), sys_class_name: field('incident\'); gs.print(\'x') } });
  await assert.rejects(whySlas(odd.sdk, { task: 'INC0010001' }), error => error.code === 'api_error');
  assert.equal(odd.calls.some(call => call.script), false, 'a table name that is not one never reaches a script');
  for (const input of [{ task: 'INC1^ORnumber=INC2' }, { task: '' }, { task: 'INC0010001', definition: 'a^b' }, { task: 'INC1\nx', definition: 'P1 resolution' }]) {
    const f = fixture();
    await assert.rejects(whySlas(f.sdk, input), error => error.code === 'usage_error', JSON.stringify(input));
    assert.equal(f.calls.length, 0, `${JSON.stringify(input)} sends nothing`);
  }
});

test('why is a read to the mutation guard', () => {
  assert.equal(isMutationCommand({ _: ['slas', 'why'] }), false);
});

test('real CLI runs the posted script on a read-only profile and refuses bad input with no request', async () => {
  const calls = [], instance = platform();
  let logged = '';
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, pathname: url.pathname });
    const json = (status, value, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/angular.do') return json(200, {}, { 'Set-Cookie': 'JSESSIONID=fixture; Path=/; HttpOnly', 'X-UserToken-Response': 'fixture-token' });
    if (url.pathname === '/sys.scripts.do' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<input name="sysparm_ck" type="hidden" value="ck">'); }
    if (url.pathname === '/sys.scripts.do') {
      const form = new URLSearchParams(body);
      calls.at(-1).form = Object.fromEntries(form);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<PRE>${logged}${instance.run(form.get('script')).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}<BR></PRE>`);
    }
    if (url.pathname.startsWith('/api/now/table/')) return json(200, { result: await fixture().sdk.listStrict(url.pathname.split('/').pop(), url.searchParams) });
    return json(404, { error: { message: 'not found' } });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-slas-why-')));
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: true } } }));
  const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_COLOR: '1' });
  const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const run = args => promisify(execFile)(process.execPath, [...loopbackCredentialArgs, cli, ...args], { env, cwd: dir, timeout: 20000 });
  try {
    const envelope = JSON.parse((await run(['slas', 'why', 'INC0010001', '--json'])).stdout);
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.data.records.map(d => d.verdict.split(':')[0]), ['Attached', 'Not attached', 'Not attached', 'Not attached, though the start condition matches and nothing stops it. The SLA engine tests conditions only when the record is saved, so it attaches at the next update unless a contract or service offering rule stops it.']);
    assert.ok(calls.filter(call => call.pathname.startsWith('/api/now/')).every(call => call.method === 'GET'), 'the REST calls are reads');
    const posted = calls.filter(call => call.pathname === '/sys.scripts.do' && call.method === 'POST');
    assert.equal(posted.length, 1, 'one background script');
    assert.equal(posted[0].form.record_for_rollback, undefined, 'no rollback context');
    assert.equal(posted[0].form.sys_scope, 'global');
    assert.deepEqual(instance.unexpected, []);
    logged = 'Evaluator: org.mozilla.javascript.EcmaError: "brokenInclude" is not defined.\n'; // a condition's javascript: value the platform logged and ran past
    const human = await run(['slas', 'why', 'INC0010001', 'P2 resolution', '--format', 'styled']);
    assert.match(human.stdout, /Why SLAs attach to INC0010001 \(incident\)[\s\S]*P2 resolution \[0+b\]\n {4}start no match, pause no match, stop no match\n {4}Not attached: the start condition does not match the record\./);
    const before = calls.length;
    for (const args of [['INC1^ORnumber=INC2'], ['INC0010001', 'a^b'], [], ['INC0010001', 'P1', 'extra']]) {
      await assert.rejects(run(['slas', 'why', ...args, '--json']), undefined, args.join(' '));
    }
    assert.equal(calls.length, before, 'refused input sends nothing');
    assert.match((await run(['slas', 'why', '--help'])).stdout, /writes nothing and records no rollback context/);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
