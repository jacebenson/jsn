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
import { findReferences, formatReferences, LARGE_TABLE, COUNT_TIMEOUT, MAX_SLOW } from '../src/records/references.js';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';

const id = n => n.toString(16).padStart(32, '0');
const GROUP = id(1);
const parents = { sys_user_group: '', task: '', incident: 'task', cmdb_ci: '', cmdb_ci_server: 'cmdb_ci', sys_user_grmember: '', sysevent_email_action: '', sys_email: '', u_app_log: '', sys_approval_holder: '', sysapproval_approver: '', sys_metadata: '', sysrule_assignment: 'sys_metadata', sys_decision_question: 'sys_metadata' };
const dictionary = {
  reference: [
    ['task', 'assignment_group', 'reference'], ['incident', 'assignment_group', 'reference'],
    ['cmdb_ci', 'support_group', 'reference'], ['cmdb_ci_server', 'support_group', 'reference'],
    ['sys_user_grmember', 'group', 'reference'], ['task', 'group_list', 'glide_list'],
    ['var__m_wf_activity', 'group', 'reference'], ['u_app_log', 'group', 'reference'], ['sysrule_assignment', 'group', 'reference'], ['sysapproval_approver', 'sysapproval', 'reference'],
  ],
  document_id: [['sys_approval_holder', 'document', 'document_id'], ['sys_email', 'instance', 'document_id'], ['sys_activity0009', 'document_id', 'document_id'], ['sys_decision_question', 'answer', 'document_id']],
};
const dictRow = ([name, element, type]) => ({ name, element, internal_type: type, reference: type === 'document_id' ? '' : 'sys_user_group' });
// Counts by "table?query"; table sizes by table name.
const COUNTS = { [`task?assignment_group=${GROUP}`]: 1, [`task?group_listLIKE${GROUP}`]: 1, [`sys_user_grmember?group=${GROUP}`]: 1, [`sys_properties?valueLIKE${GROUP}`]: 1, [`sysrule_assignment?group=${GROUP}`]: 1 };
const ROWS = {
  task: { [`assignment_group=${GROUP}`]: [{ sys_id: id(10), sys_class_name: 'incident', number: 'INC0010001' }], [`group_listLIKE${GROUP}`]: [{ sys_id: id(11), sys_class_name: 'incident', number: 'INC0010002' }] },
  sys_user_grmember: { [`group=${GROUP}`]: [{ sys_id: id(12), sys_class_name: 'sys_user_grmember' }] },
  sys_properties: { [`valueLIKE${GROUP}`]: [{ sys_id: id(13), name: 'x.default_group' }] },
  sysrule_assignment: { [`group=${GROUP}`]: [{ sys_id: id(14), name: 'Route to desk' }] },
};
// The record's own child items, which neither mode searches.
const CHILD = ['sys_attachment', 'sys_journal_field', 'sys_audit', 'sys_update_xml', 'sys_update_version', 'syslog', 'sys_metadata_link', 'sys_trigger', 'sys_translated_text', 'sysapproval_approver', 'sys_email', 'sys_approval_holder'];

function fixture({ counts = COUNTS, sizes = {}, rows = ROWS, scan, list, cancelResponse } = {}) {
  const calls = [];
  const count = (table, query) => (query ? counts[`${table}?${query}`] ?? 0 : sizes[table] ?? 10);
  const parse = url => { const u = new URL(url, 'http://fixture.invalid'); return [u.pathname.split('/').pop(), u.searchParams.get('sysparm_query')]; };
  const sdk = {
    baseURL: 'http://fixture.invalid', calls,
    async list(table, params) { return this.listStrict(table, params); },
    async listStrict(table, params, opts) {
      const query = params.get('sysparm_query');
      calls.push({ kind: 'list', table, query, params, opts });
      if (list && !['sys_user_group', 'sys_db_object', 'sys_dictionary'].includes(table)) await list(table);
      if (table === 'sys_user_group') return query === `sys_id=${GROUP}` || query === 'name=Service Desk' ? [{ sys_id: { value: GROUP }, sys_class_name: { value: 'sys_user_group' }, name: { value: 'Service Desk' } }] : [];
      if (table === 'sys_db_object') return query.slice(6).split(',').filter(name => name in parents).map(name => ({ name, 'super_class.name': parents[name] }));
      if (table === 'sys_dictionary') return Number(params.get('sysparm_offset')) ? [] : (query.includes('document_id') ? dictionary.document_id : dictionary.reference).map(dictRow);
      return (rows[table]?.[query] ?? []).slice(0, Number(params.get('sysparm_limit')));
    },
    async batch(requests) {
      calls.push({ kind: 'batch', urls: requests.map(r => r.url) });
      throw new Error('The Batch API must not be used');
    },
    async request(url, opts) {
      calls.push({ kind: 'scan', url, opts });
      const normal = () => ({ result: { stats: { count: String(count(...parse(url))) } } });
      return scan ? scan(url, opts, normal) : normal();
    },
    async fetchResponse(url, opts) {
      calls.push({ kind: 'cancel', url, opts });
      return cancelResponse || { ok: true, status: 200, text: async () => '<xml><message text="Transaction cancelled"/></xml>' };
    },
  };
  return sdk;
}
const base = { table: 'sys_user_group', identifier: GROUP };
const counted = sdk => sdk.calls.filter(call => call.kind !== 'list');

test('data mode counts reference and list fields on data tables, one request each in the session, and lists each record once with its class', async () => {
  const sdk = fixture();
  const data = await findReferences(sdk, base);
  assert.equal(data.mode, 'data');
  const fields = data.sources.filter(source => source.group === 'fields').map(source => `${source.table}.${source.fields[0]}`);
  // Children repeat the parent's field; var__m_, log tables and sys_metadata tables are not counted in data mode.
  assert.deepEqual(fields.sort(), ['cmdb_ci.support_group', 'sys_user_grmember.group', 'task.assignment_group', 'task.group_list']);
  assert.ok(data.sources.every(source => source.kind !== 'document_id' && source.group !== 'system' && !CHILD.includes(source.table)));
  assert.ok(data.not_searched.some(item => /var__m_wf_activity/.test(item.source) && /sys_variable_value/.test(item.reason)));
  assert.ok(data.not_searched.some(item => /u_app_log\.group/.test(item.source) && /not references/.test(item.reason)));
  assert.ok(data.not_searched.some(item => /^Child items/.test(item.source)));
  // A task's own approvals are child items, though sysapproval is a plain reference field.
  assert.ok(data.not_searched.some(item => /sysapproval_approver\.sysapproval/.test(item.source) && /belong to it/.test(item.reason)));
  // Row reads share the counts' session, limit and cancel, and skip the Table API's repeat count.
  const reads = sdk.calls.filter(call => call.kind === 'list' && !['sys_user_group', 'sys_db_object', 'sys_dictionary'].includes(call.table));
  assert.ok(reads.length && reads.every(call => call.opts?.stateful === true && call.opts.timeout === COUNT_TIMEOUT && call.params.get('sysparm_no_count') === 'true'));
  assert.equal(data.not_searched[0].reason, 'Run with --mode system');
  // Every count, size check and scan is its own GET in the session; the Batch API is never used.
  const requests = counted(sdk);
  assert.ok(requests.length && requests.every(call => call.kind === 'scan' && call.opts.stateful === true && call.opts.readOnly === true && call.opts.timeout === COUNT_TIMEOUT));
  assert.equal(requests.length, data.requests.planned);
  assert.deepEqual(data.records.map(ref => [ref.table, ref.sys_id, ref.label]), [['incident', id(10), 'INC0010001'], ['incident', id(11), 'INC0010002'], ['sys_user_grmember', id(12), '']]);
  assert.deepEqual(data.records[1].via, ['task.group_list']);
  assert.equal(data.partial, false);
  assert.deepEqual(data.hierarchy, ['sys_user_group']);
  const text = formatReferences(data);
  assert.match(text, new RegExp(`incident ${id(11)} INC0010002 {2}via task\\.group_list`));
  assert.match(text, /mode: data/);
  assert.match(text, /Not searched:/);
});

test('system mode counts fields and document ID fields on sys_metadata tables and configuration text, and leaves data tables out', async () => {
  const sdk = fixture();
  const data = await findReferences(sdk, { ...base, mode: 'system' });
  const fields = data.sources.filter(source => source.group === 'fields').map(source => `${source.table}.${source.fields[0]}`);
  // Document ID fields on data tables (approvals, emails, shards) are child items, not references.
  assert.deepEqual(fields.sort(), ['sys_decision_question.answer', 'sysrule_assignment.group']);
  assert.ok(data.sources.some(source => source.group === 'system' && source.table === 'sys_properties'));
  assert.ok(data.sources.every(source => !['data', 'scripts'].includes(source.group) && !CHILD.includes(source.table)));
  assert.deepEqual(data.records.map(ref => [ref.table, ref.sys_id]), [['sys_properties', id(13)], ['sysrule_assignment', id(14)]]);
  assert.equal(data.not_searched[0].reason, 'Run with --mode data, the default');
  assert.ok(data.not_searched.some(item => item.reason === 'Add --scripts'));
  assert.ok(data.not_searched.some(item => /Flow Designer/.test(item.source)));
  assert.match(formatReferences(data), /mode: system/);
});

test('reference fields to a parent class are searched for a child record', async () => {
  const sdk = fixture();
  sdk.listStrict = (orig => async (table, params) => table === 'cmdb_ci_server' ? [{ sys_id: { value: id(2) }, sys_class_name: { value: 'cmdb_ci_server' } }] : orig.call(sdk, table, params))(sdk.listStrict);
  await findReferences(sdk, { table: 'cmdb_ci_server', identifier: id(2) });
  assert.ok(sdk.calls.some(call => call.table === 'sys_dictionary' && call.query.includes('referenceINcmdb_ci_server,cmdb_ci^')));
});

test('--plan reads metadata only and runs no count', async () => {
  const sdk = fixture();
  const data = await findReferences(sdk, { ...base, planOnly: true, mode: 'system', scripts: true });
  assert.equal(counted(sdk).length, 0);
  assert.ok(data.sources.every(source => source.status === 'planned'));
  assert.ok(data.sources.some(source => source.group === 'scripts'));
  assert.equal(data.requests.planned, data.sources.length + data.size_checks.length);
  const text = formatReferences(data);
  assert.match(text, /Nothing was counted/);
  // The human plan prints each count query and each size check, so an over-budget plan can be narrowed without --json.
  assert.ok(data.sources.every(source => text.includes(`  ${source.table}: ${source.query}`)));
  assert.equal(counted(sdk).length, 0);
  // Data mode is the one with LIKE scans, so it is the one that names its table size checks.
  const dataSdk = fixture();
  const dataPlan = await findReferences(dataSdk, { ...base, planOnly: true });
  const dataText = formatReferences(dataPlan);
  assert.ok(dataPlan.size_checks.length);
  assert.match(dataText, /Table size checks/);
  assert.ok(dataPlan.size_checks.every(table => dataText.split('\n').includes(`  ${table}`)));
  assert.equal(counted(dataSdk).length, 0);
});

test('row reads stop with the counts when three counts pass the slow threshold', async () => {
  const timedOut = () => Object.assign(new Error('Network error: Request timed out'), { code: 'network_error' });
  // The first count answers; the next three are slow, which stops the run.
  const sdk = fixture({ scan: async (url, opts, normal) => { if (url.includes('assignment_group')) return normal(); throw timedOut(); } });
  const data = await findReferences(sdk, base);
  assert.equal(data.stopped, 'slow');
  const countedSource = data.sources.find(source => source.fields[0] === 'assignment_group');
  assert.equal(countedSource.count, 1);
  // Its rows are not read: the run stopped to spare the instance, and says so with the command to read them later.
  assert.ok(!sdk.calls.some(call => call.kind === 'list' && call.table === 'task'));
  assert.equal(countedSource.listed, 0);
  assert.match(countedSource.reason, /stopped to spare the instance/);
  assert.ok(countedSource.command.startsWith('jsn records list --table task'));
  assert.ok(data.not_searched.some(item => item.source === 'task.assignment_group' && /stopped to spare the instance/.test(item.reason)));
  assert.equal(data.partial, true);
});

test('Ctrl-C during discovery stops before the next metadata read and counts nothing', async () => {
  const controller = new AbortController();
  const sdk = fixture();
  const real = sdk.listStrict;
  sdk.listStrict = async (table, params, opts) => {
    if (table === 'sys_dictionary') controller.abort();
    return real.call(sdk, table, params, opts);
  };
  await assert.rejects(findReferences(sdk, { ...base, signal: controller.signal }), /Interrupted before the plan was complete/);
  assert.equal(counted(sdk).length, 0);
});

test('a field table with no sys_db_object row is a gap that marks the run partial, not a data table', async () => {
  const sdk = fixture();
  const real = sdk.listStrict;
  sdk.listStrict = async (table, params, opts) => {
    const rows = await real.call(sdk, table, params, opts);
    if (table !== 'sys_dictionary' || params.get('sysparm_query').includes('document_id')) return rows;
    return Number(params.get('sysparm_offset')) ? [] : [...rows, dictRow(['ghost_table', 'group', 'reference'])];
  };
  const data = await findReferences(sdk, base);
  // Its ancestry is unknown, so it can be neither counted nor called clean: it is named, and the run is partial.
  assert.ok(data.not_searched.some(item => /ghost_table\.group/.test(item.source) && /sys_db_object/.test(item.reason)));
  assert.ok(!data.sources.some(source => source.table === 'ghost_table'));
  assert.equal(data.partial, true);
});

test('a dictionary read cut off at its row cap marks the run partial, not complete', async () => {
  const sdk = fixture();
  const real = sdk.listStrict;
  // Twenty full pages reach the 20000-row cap. Every row is a field this mode excludes, so the counts that follow stay cheap.
  const page = Array.from({ length: 1000 }, () => dictRow(['sysrule_assignment', 'group', 'reference']));
  sdk.listStrict = async (table, params, opts) => (table === 'sys_dictionary' && !params.get('sysparm_query').includes('document_id') ? page : real.call(sdk, table, params, opts));
  const data = await findReferences(sdk, base);
  assert.ok(data.not_searched.some(item => /More than 20000 dictionary rows/.test(item.reason)));
  assert.ok(data.sources.every(source => source.table !== 'sysrule_assignment'));
  assert.equal(data.partial, true);
});

test('large tables are skipped and listed unless --include-large', async () => {
  const sdk = fixture({ sizes: { task: LARGE_TABLE + 1 } });
  const data = await findReferences(sdk, base);
  const list = data.sources.find(source => source.fields[0] === 'group_list');
  assert.equal(list.status, 'skipped');
  // A skipped scan was planned and not run, so the answer is not complete.
  assert.equal(data.partial, true);
  assert.match(formatReferences(data), /PARTIAL/);
  assert.ok(data.not_searched.some(item => item.source === 'task.group_list' && /100001 rows/.test(item.reason)));
  assert.ok(!sdk.calls.some(call => call.kind === 'scan' && call.url.includes('group_list')));
  const wide = await findReferences(fixture({ sizes: { task: LARGE_TABLE + 1 } }), { ...base, includeLarge: true });
  assert.equal(wide.sources.find(source => source.fields[0] === 'group_list').count, 1);
  assert.equal(wide.partial, false);
});

test('invalid input and an over-budget plan reject before any count', async () => {
  for (const options of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { maxRequests: 0 }, { maxRequests: 20001 }, { mode: 'all' }, { scripts: true }, { mode: 'data', scripts: true }]) {
    const sdk = fixture();
    await assert.rejects(findReferences(sdk, { ...base, ...options }), /--limit|--max-requests|--mode|--scripts/);
    assert.equal(sdk.calls.length, 0);
  }
  for (const options of [{ identifier: `${GROUP}^NQ` }, { identifier: '' }, { table: 'bad table' }, { identifierField: 'name^x' }]) {
    const sdk = fixture();
    await assert.rejects(findReferences(sdk, { ...base, ...options }));
    assert.equal(sdk.calls.length, 0);
  }
  const sdk = fixture();
  await assert.rejects(findReferences(sdk, { ...base, maxRequests: 5 }), /needs \d+ count queries, more than --max-requests 5/);
  assert.equal(counted(sdk).length, 0);
});

test('a failed, denied or malformed count is a gap and marks the run partial, never zero', async () => {
  const denied = fixture({ scan: async url => { if (url.includes('assignment_group')) throw Object.assign(new Error('Synthetic denied'), { status: 403 }); return { result: { stats: { count: 'x' } } }; } });
  let data = await findReferences(denied, base);
  assert.equal(data.partial, true);
  assert.ok(data.sources.filter(source => source.match !== 'like').every(source => source.status === 'failed' && source.count === null));
  assert.ok(data.not_searched.some(item => item.reason === 'Synthetic denied'));
  // A failed size check means the scan is not run, and says why.
  assert.ok(data.sources.find(source => source.fields[0] === 'group_list').reason.startsWith('Row count for task failed'));
  const scan = fixture({ scan: async () => { throw Object.assign(new Error('Synthetic gateway error'), { status: 504 }); } });
  data = await findReferences(scan, base);
  assert.equal(data.partial, true);
  assert.equal(data.sources.find(source => source.fields[0] === 'assignment_group').http_status, 504);
  assert.equal(data.stopped, undefined);
  const badRows = fixture({ rows: { ...ROWS, task: { [`assignment_group=${GROUP}`]: [{ sys_id: '' }] } } });
  data = await findReferences(badRows, base);
  assert.equal(data.partial, true);
  assert.match(data.sources.find(source => source.fields[0] === 'assignment_group').reason, /without a readable sys_id/);
  // A nonzero count whose rows are all hidden is a gap with a reason, not an unexplained partial.
  data = await findReferences(fixture({ rows: { ...ROWS, task: {} } }), base);
  assert.equal(data.partial, true);
  assert.ok(data.not_searched.some(item => item.source === 'task.assignment_group' && item.reason === 'Counted 1, but no row could be read'));
  // An unreadable class row or an empty document ID read is not "no parents" or "no fields".
  for (const [hidden, message] of [['sys_db_object', /no sys_db_object row for sys_user_group/], ['sys_dictionary', /no document ID fields/]]) {
    const empty = fixture();
    empty.listStrict = (orig => async (table, params) => (table === hidden && (hidden === 'sys_db_object' || params.get('sysparm_query').includes('document_id')) ? [] : orig.call(empty, table, params)))(empty.listStrict);
    await assert.rejects(findReferences(empty, base), message);
    assert.equal(counted(empty).length, 0);
  }
  const malformedDictionary = fixture();
  malformedDictionary.listStrict = (orig => async (table, params) => (table === 'sys_dictionary' ? { result: [] } : orig.call(malformedDictionary, table, params)))(malformedDictionary.listStrict);
  await assert.rejects(findReferences(malformedDictionary, base), /Malformed table response for sys_dictionary/);
});

test('a count with no answer in 20 s is cancelled on the instance and fails alone, and three slow counts stop the run', async () => {
  const timedOut = () => Object.assign(new Error('Network error: Request timed out'), { code: 'network_error' });
  const one = fixture({ scan: async (url, opts, normal) => { if (url.includes('support_group')) throw timedOut(); return normal(); } });
  let data = await findReferences(one, base);
  assert.match(data.sources.find(source => source.fields[0] === 'support_group').reason, /^No answer in 20s; cancel sent to the instance: sent$/);
  assert.deepEqual(one.calls.filter(call => call.kind === 'cancel').map(call => call.opts.stateful), [true]);
  assert.equal(data.records.length, 3);
  assert.equal(data.partial, true);
  assert.equal(data.stopped, undefined);
  const all = fixture({ scan: async () => { throw timedOut(); } });
  data = await findReferences(all, base);
  assert.equal(all.calls.filter(call => call.kind === 'scan').length, MAX_SLOW);
  assert.equal(all.calls.filter(call => call.kind === 'cancel').length, MAX_SLOW);
  assert.equal(data.stopped, 'slow');
  assert.equal(data.partial, true);
  assert.ok(data.sources.filter(source => source.status === 'not_run').length && data.sources.filter(source => source.status === 'not_run').every(source => /stopped to spare the instance/.test(source.reason)));
  assert.match(formatReferences(data), /Stopped after 3 counts/);
  // A row read past the limit is cancelled the same way.
  const rowSlow = fixture({ list: async table => { if (table === 'task') throw timedOut(); } });
  data = await findReferences(rowSlow, base);
  assert.equal(rowSlow.calls.filter(call => call.kind === 'cancel').length, 2);
  assert.match(data.sources.find(source => source.fields[0] === 'assignment_group').reason, /^Rows could not be read: No answer in 20s; cancel sent/);
  // The instance's own quota cancel is slow too, and needs no cancel from jsn.
  const quota = fixture({ scan: async () => { throw Object.assign(new Error('Transaction cancelled: maximum execution time exceeded'), { status: 500 }); } });
  data = await findReferences(quota, base);
  assert.equal(data.stopped, 'slow');
  assert.equal(quota.calls.filter(call => call.kind === 'cancel').length, 0);
  // A rate-limit refusal stops the run the same way, without a cancel; other failures do not.
  const limited = fixture({ scan: async () => { throw Object.assign(new Error('API error (status 429): Too Many Requests'), { status: 429 }); } });
  data = await findReferences(limited, base);
  assert.equal(limited.calls.filter(call => call.kind === 'scan').length, MAX_SLOW);
  assert.equal(limited.calls.filter(call => call.kind === 'cancel').length, 0);
  assert.equal(data.stopped, 'slow');
  assert.match(formatReferences(data), /hit the instance's rate limit/);
  const broken = fixture({ scan: async () => { throw Object.assign(new Error('Synthetic server error'), { status: 500 }); } });
  data = await findReferences(broken, base);
  assert.equal(data.stopped, undefined);
  assert.ok(data.sources.every(source => source.status === 'failed'));
});

test('a refused UI session moves the scans to stateless reads and says Ctrl-C cannot cancel them', async () => {
  const sdk = fixture({ scan: async (url, opts) => { if (opts.stateful) throw Object.assign(new Error('Authentication rejected (HTTP 401).'), { code: 'auth_error', status: 401 }); return { result: { stats: { count: String(url.includes('group_listLIKE') ? 1 : 0) } } }; } });
  const data = await findReferences(sdk, base);
  const scans = sdk.calls.filter(call => call.kind === 'scan');
  // One refused session attempt, then every scan (that one included) runs without it.
  assert.equal(scans.filter(call => call.opts.stateful).length, 1);
  assert.equal(scans.filter(call => !call.opts.stateful).length, data.requests.planned);
  assert.equal(data.partial, false);
  assert.equal(data.scan_session, 'refused');
  assert.match(formatReferences(data), /neither Ctrl-C nor a slow count can be cancelled/);
  const denied = fixture({ scan: async () => { throw Object.assign(new Error('Access forbidden (HTTP 403).'), { code: 'forbidden', status: 403 }); } });
  const gap = await findReferences(denied, base);
  assert.ok(denied.calls.filter(call => call.kind === 'scan').every(call => call.opts.stateful));
  assert.equal(gap.partial, true);
});

test('Ctrl-C during a scan cancels it on the instance in its session and stops before the next request', async () => {
  const controller = new AbortController();
  const sdk = fixture({ scan: async () => { controller.abort(); throw new Error('Synthetic transaction cancelled'); } });
  const data = await findReferences(sdk, { ...base, signal: controller.signal });
  const cancel = sdk.calls.find(call => call.kind === 'cancel');
  assert.match(cancel.url, /cancel_my_transaction\.do\?sysparm_output=xml$/);
  assert.equal(cancel.opts.stateful, true);
  assert.deepEqual(data.cancel, { status: 'sent', message: 'Transaction cancelled' });
  assert.equal(sdk.calls.filter(call => call.kind === 'scan').length, 1);
  assert.equal(data.interrupted, true);
  assert.equal(data.partial, true);
  assert.ok(data.sources.some(source => source.status === 'not_run'));
  assert.equal(sdk.calls.filter(call => call.kind === 'list' && !['sys_user_group', 'sys_db_object', 'sys_dictionary'].includes(call.table)).length, 0);
  const refused = new AbortController();
  const denied = await findReferences(fixture({ scan: async () => { refused.abort(); throw new Error('Synthetic transaction cancelled'); }, cancelResponse: { ok: false, status: 403, text: async () => '' } }), { ...base, signal: refused.signal });
  assert.deepEqual(denied.cancel, { status: 'failed', message: 'HTTP 403' });
  // Ctrl-C during the row reads leaves each unread source with a reason and its list command.
  const late = new AbortController();
  const rows = await findReferences(fixture({ list: async () => late.abort() }), { ...base, signal: late.signal });
  assert.equal(rows.partial, true);
  const unread = rows.sources.filter(source => source.reason === 'Interrupted before its rows were read');
  assert.ok(unread.length && unread.every(source => source.command?.startsWith('jsn records list')));
  // Ctrl-C during a request that is also refused a session does not start a stateless retry.
  const midAuth = new AbortController();
  const authSdk = fixture({ scan: async () => { midAuth.abort(); throw Object.assign(new Error('Authentication rejected (HTTP 401).'), { code: 'auth_error', status: 401 }); } });
  const stoppedByAuth = await findReferences(authSdk, { ...base, signal: midAuth.signal });
  assert.equal(authSdk.calls.filter(call => call.kind === 'scan').length, 1);
  assert.equal(stoppedByAuth.scan_session, undefined);
  assert.equal(stoppedByAuth.interrupted, true);
});

test('real CLI reads only with GETs on a read-only profile, exits 1 when partial and rejects bad input before transport', async () => {
  const calls = [];
  let deny = false;
  const sdk = fixture();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    const call = { method: req.method, pathname: url.pathname };
    calls.push(call);
    res.setHeader('Content-Type', 'application/json');
    const table = url.pathname.split('/').pop();
    if (url.pathname.startsWith('/api/now/table/')) return res.end(JSON.stringify({ result: await sdk.listStrict(table, url.searchParams) }));
    if (url.pathname.startsWith('/api/now/stats/')) {
      if (deny && table === 'sys_user_grmember') { res.statusCode = 403; return res.end(JSON.stringify({ error: { message: 'Synthetic denied' } })); }
      return res.end(JSON.stringify(await sdk.request(req.url)));
    }
    res.end(JSON.stringify({ result: [] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-records-references-')));
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: true } } }));
  const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
  const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const run = args => promisify(execFile)(process.execPath, [...loopbackCredentialArgs, cli, ...args], { env, cwd: dir, timeout: 20000 });
  try {
    const { stdout } = await run(['records', 'references', 'sys_user_group', 'Service Desk', '--identifier-field', 'name', '--json']);
    const envelope = JSON.parse(stdout);
    assert.equal(envelope.ok, true);
    // The records and the gaps come before the few hundred sources, so a truncated read still has them.
    const keys = Object.keys(envelope.data);
    assert.equal(keys.at(-1), 'sources');
    assert.ok(keys.indexOf('records') < keys.indexOf('not_searched'));
    assert.equal(envelope.data.records.length, 3);
    assert.equal(envelope.data.partial, false);
    const system = JSON.parse((await run(['records', 'references', 'sys_user_group', GROUP, '--mode', 'system', '--json'])).stdout);
    assert.deepEqual(system.data.records.map(ref => ref.table), ['sys_properties', 'sysrule_assignment']);
    // Delimited and markdown output carry the referring records as a table, not the plan.
    const csvRun = await run(['records', 'references', 'sys_user_group', GROUP, '--csv']);
    const csv = csvRun.stdout.trim().split('\n');
    // Data mode says on stderr that configuration was not searched; system mode does not.
    assert.match(csvRun.stderr, /add --mode system/);
    assert.doesNotMatch((await run(['records', 'references', 'sys_user_group', GROUP, '--mode', 'system', '--csv'])).stderr, /add --mode system/);
    assert.equal(csv[0], 'table,sys_id,label,via');
    assert.equal(csv.length, 4);
    assert.ok(csv.some(line => line.startsWith(`incident,${id(10)},INC0010001,`)));
    assert.match((await run(['records', 'references', 'sys_user_group', GROUP, '--markdown'])).stdout, new RegExp(`\\| incident \\| ${id(10)} \\| INC0010001 \\|`));
    const human = await run(['records', 'references', 'sys_user_group', GROUP, '--format', 'styled']);
    assert.match(human.stdout, new RegExp(`incident ${id(10)} INC0010001`));
    deny = true;
    const partial = await run(['records', 'references', 'sys_user_group', GROUP, '--json']).then(() => null, error => error);
    assert.equal(partial?.code, 1);
    assert.equal(JSON.parse(partial.stdout).data.partial, true);
    const partialCsv = await run(['records', 'references', 'sys_user_group', GROUP, '--csv']).then(() => null, error => error);
    assert.equal(partialCsv?.code, 1);
    assert.match(partialCsv.stderr, /Partial: some sources were not searched/);
    deny = false;
    const before = calls.length;
    for (const args of [[GROUP, '--limit', '0'], [GROUP, '--max-requests', '0'], [`${GROUP}^NQ`], ['*'], [GROUP, '--mode', 'all'], [GROUP, '--scripts']]) {
      await assert.rejects(run(['records', 'references', 'sys_user_group', ...args, '--json']), undefined, JSON.stringify(args));
    }
    assert.equal(calls.length, before);
    // Table and Aggregate reads are GETs, and the Batch API is never called.
    assert.ok(calls.filter(call => /^\/api\/now\/(table|stats)\//.test(call.pathname)).every(call => call.method === 'GET'));
    assert.ok(!calls.some(call => call.pathname.endsWith('/batch')));
    const help = await run(['records', '--help']);
    assert.ok(help.stdout.includes('references'));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
