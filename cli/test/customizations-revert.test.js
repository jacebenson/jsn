import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { customizationsCmd } from '../src/commands/customizations.js';
import { isMutationCommand } from '../src/mutations.js';
import { needsMutationContext } from '../src/mutation-context.js';

const id = n => n.toString(16).padStart(32, '0');
const APP = id(900);
const STORE = id(901);
const SET = id(902);
const si = n => `sys_script_include_${id(n)}`;
const xml = (n, script) => `<?xml version="1.0" encoding="UTF-8"?><record_update table="sys_script_include"><sys_script_include action="INSERT_OR_UPDATE"><name>Util${n}</name><script><![CDATA[${script}]]></script><sys_id>${id(n)}</sys_id></sys_script_include></record_update>`;
const version = (v, n, state, source_table, script, extra = {}) => ({ sys_id: id(v), name: si(n), state, source_table, source: source_table === 'sys_update_set' ? SET : STORE, reverted_from: '', sys_recorded_at: String(v), sys_created_on: '2026-11-26 10:00:00', payload: xml(n, script), ...extra });
// 1 and 2 are customised with a base version, 3 was added on the instance, 4 is back at base, 5 has no record, 6 was edited back to match its base.
const VERSIONS = () => [
  version(11, 1, 'history', 'sys_store_app', 'base 1'), version(12, 1, 'current', 'sys_update_set', 'custom 1'),
  version(21, 2, 'history', 'sys_store_app', 'base 2'), version(22, 2, 'current', 'sys_update_set', 'custom 2'),
  version(31, 3, 'current', 'sys_update_set', 'added 3'),
  version(41, 4, 'current', 'sys_store_app', 'base 4'),
  version(61, 6, 'history', 'sys_store_app', 'base 6'), version(62, 6, 'current', 'sys_update_set', 'base 6'),
];
const update = name => ({ name, application: APP, replace_on_upgrade: 'false' });
const meta = (n, scope = APP) => ({ sys_id: id(n), sys_class_name: 'sys_script_include', sys_update_name: si(n), sys_scope: scope });

function filter(rows, query) {
  const terms = query.split('^').filter(term => !term.startsWith('ORDERBY'));
  return rows.filter(row => terms.every(term => {
    const [, name, op, value] = term.match(/^(\w+?)(=|IN)(.*)$/);
    return op === 'IN' ? value.split(',').includes(row[name]) : row[name] === value;
  })).sort((a, b) => Number(b.sys_recorded_at) - Number(a.sys_recorded_at));
}

function fixture({ apps = [{ sys_id: APP, scope: 'sn_demo', name: 'Demo', sys_class_name: 'sys_store_app' }], updates = [si(1), si(1), si(2), si(3), si(4), si(5), si(6)].map(update),
  metadata = [meta(1), meta(2), meta(3), meta(4), meta(6)], fail = [], ui = {}, cursor = true, stray = [], versions: start = VERSIONS(), brokenVersions = false } = {}) {
  const commands = [];
  const builder = { command(c) { commands.push(c); return this; }, epilogue() { return this; } };
  customizationsCmd(fn => fn, { canUsePicker: () => false, confirm: async () => { throw new Error('unexpected prompt'); }, ...ui }).builder(builder);
  const handler = commands.find(c => c.command === 'revert').handler;
  const reads = [];
  const scripts = [];
  let versions = start;
  const live = Object.fromEntries([1, 2, 3, 4, 6].map(n => [id(n), { sys_id: id(n), name: `Util${n}`, script: n === 4 || n === 6 ? `base ${n}` : `custom ${n}` }]));
  const outputs = [];
  const read = async (table, params) => {
    const query = params.get('sysparm_query');
    reads.push({ table, query, fields: params.get('sysparm_fields'), limit: params.get('sysparm_limit') });
    if (table === 'sys_scope') return apps;
    if (table === 'sys_update_xml') { const after = query.match(/\^name>([^^]+)/)?.[1]; return updates.filter(row => !cursor || after === undefined || row.name > after).slice(0, Number(params.get('sysparm_limit'))); }
    if (table === 'sys_metadata') return [...metadata.filter(row => query.slice(17).split(',').includes(row.sys_update_name)), ...stray];
    if (table === 'sys_update_version') return brokenVersions ? ['x'] : filter(versions, query).slice(0, Number(params.get('sysparm_limit')));
    const ids = query.replace(/^sys_id(IN|=)/, '').split(',');
    return ids.filter(sysId => live[sysId]).map(sysId => ({ ...live[sysId], sys_update_name: `sys_script_include_${sysId}`, sys_class_name: 'sys_script_include' }));
  };
  const app = {
    config: {}, session: { profileName: 'p' }, requireInstance() {}, getEffectiveInstance: () => 'https://example.service-now.com',
    sdk: {
      list: read, listStrict: read,
      executeScript: async script => {
        scripts.push(script);
        const to = script.match(/target\.get\('([0-9a-f]{32})'\)/)[1];
        const name = script.match(/addQuery\('name', '([^']+)'\)/)[1];
        if (fail.includes(name)) return 'JSN_REVERT:false';
        const target = versions.find(row => row.sys_id === to);
        versions = [...versions.map(row => row.name === name && row.state === 'current' ? { ...row, state: 'previous' } : row), { ...target, sys_id: id(Number.parseInt(to, 16) + 5), state: 'current', source_table: 'sys_update_set', reverted_from: to }];
        const sysId = name.slice(-32);
        live[sysId] = { ...live[sysId], script: target.payload.match(/CDATA\[(.*?)\]/)[1] };
        return 'JSN_REVERT:true';
      },
    },
    ok(value, opts) { outputs.push({ value, opts }); },
  };
  return { app, reads, scripts, outputs, get data() { return outputs.at(-1)?.value; },
    run: (args = {}) => handler({ _: ['customizations', 'revert'], scope: 'sn_demo', ...args }, app) };
}

test('customizations revert refuses a malformed scope or cursor before any request', async () => {
  for (const scope of ['', 'global', 'x y', "sn'); gs.print('x", 'Sn_Demo']) {
    const f = fixture();
    await assert.rejects(f.run({ scope }), /--scope must be/);
    assert.deepEqual([f.reads, f.scripts], [[], []]);
  }
  for (const after of ['', 'a b', 'x^ORname!=y']) {
    const f = fixture();
    await assert.rejects(f.run({ after }), /--after must be an update name/);
    assert.deepEqual([f.reads, f.scripts], [[], []]);
  }
});

test('customizations revert refuses an application built on the instance, or a scope no single application has', async () => {
  for (const [apps, message] of [
    [[{ sys_id: APP, scope: 'sn_demo', name: 'Demo', sys_class_name: 'sys_app' }], /built on this instance/],
    [[], /No application has the scope sn_demo/],
    [[{ sys_id: APP, scope: 'sn_demo', sys_class_name: 'sys_store_app' }, { sys_id: id(903), scope: 'sn_demo', sys_class_name: 'sys_store_app' }], /More than one application/],
    [[{ sys_id: APP, scope: 'sn_other', sys_class_name: 'sys_store_app' }], /other than sn_demo/],
    [[{ sys_id: 'not-a-sys-id', scope: 'sn_demo', sys_class_name: 'sys_store_app' }], /no readable sys_id/],
  ]) {
    const f = fixture({ apps });
    await assert.rejects(f.run(), message);
    assert.deepEqual(f.reads.map(r => r.table), ['sys_scope']);
    assert.deepEqual(f.scripts, []);
  }
});

test('customizations revert previews by default: it sorts the files, writes nothing and gives a token', async () => {
  const f = fixture();
  await f.run();
  assert.deepEqual(f.scripts, []);
  const scope = f.reads.find(r => r.table === 'sys_scope');
  assert.deepEqual([scope.query, scope.limit], ['scope=sn_demo', '2']);
  const updates = f.reads.find(r => r.table === 'sys_update_xml');
  assert.deepEqual([updates.query, updates.limit], [`application=${APP}^replace_on_upgrade=false^ORDERBYname`, '1001']);
  const metadata = f.reads.filter(r => r.table === 'sys_metadata');
  assert.deepEqual(metadata.map(r => [r.query, r.limit]), [[`sys_update_nameIN${[1, 2, 3, 4, 5, 6].map(si).join(',')}`, '12']]);
  const data = f.data;
  assert.deepEqual(data.plans.map(plan => [plan.update_name, plan.from_version, plan.to_version]), [[si(1), id(12), id(11)], [si(2), id(22), id(21)]]);
  assert.deepEqual([data.added.map(row => row.update_name), data.at_base.map(row => row.update_name), data.refused.map(row => row.update_name)], [[si(3)], [si(4), si(6)], [si(5)]]);
  assert.match(data.refused[0].reason, /No record has this update name/);
  assert.match(data.confirmation_token, /^[0-9a-f]{64}$/);
  assert.equal(data.writes_performed, false);
  assert.match(f.outputs.at(-1).opts.summary, /nothing reverted\. Rerun with --confirm [0-9a-f]{64}/);
  assert.match(data._formatted, /Added on this instance, left as they are \(jsn never deletes them\)/);
});

test('customizations revert with the preview\'s token reverts each file and reads it back', async () => {
  const preview = fixture();
  await preview.run();
  const f = fixture();
  await f.run({ confirm: preview.data.confirmation_token });
  assert.equal(f.scripts.length, 2);
  assert.deepEqual(f.data.results.map(row => [row.update_name, row.success, row.new_version]), [[si(1), true, id(16)], [si(2), true, id(26)]]);
  assert.deepEqual([f.data.success_count, f.data.failure_count], [2, 0]);
  assert.deepEqual(f.data.added.map(row => row.update_name), [si(3)]);
  assert.ok(f.reads.some(r => r.table === 'sys_script_include' && r.query === `sys_idIN${id(1)}` && r.fields === 'sys_id,script'));
});

test('customizations revert at a terminal asks once, and reverts only on yes', async () => {
  for (const yes of [true, false]) {
    const asked = [];
    const f = fixture({ ui: { canUsePicker: () => true, confirm: async question => { asked.push(question); return yes; } } });
    await f.run();
    assert.equal(f.outputs[0].opts.summary, 'Review the files before confirming');
    assert.deepEqual(asked.map(question => [question.message, question.default]), [['Revert 2 file(s) of sn_demo to their base system versions?', false]]);
    if (yes) assert.deepEqual([f.scripts.length, f.data.success_count], [2, 2]);
    else assert.deepEqual([f.scripts, f.data], [[], { cancelled: true, writes_performed: false }]);
  }
});

test('customizations revert refuses a token that does not match the files now, with nothing reverted', async () => {
  for (const confirm of ['', 'nope', 'a'.repeat(64)]) {
    const f = fixture();
    await assert.rejects(f.run({ confirm }), /changed since the preview, or the token does not match; nothing was reverted/);
    assert.deepEqual(f.scripts, []);
  }
  // A file edited again after the preview has another current version, so the preview's token no longer matches.
  const preview = fixture();
  await preview.run();
  const edited = fixture({ versions: VERSIONS().map(row => row.sys_id === id(12) ? { ...row, sys_id: id(13), sys_recorded_at: '13' } : row) });
  await assert.rejects(edited.run({ confirm: preview.data.confirmation_token }), /changed since the preview/);
  assert.deepEqual(edited.scripts, []);
});

test('customizations revert reports a failed file, carries on with the rest and exits nonzero', async () => {
  const preview = fixture({ fail: [si(1)] });
  await preview.run();
  const f = fixture({ fail: [si(1)] });
  try {
    await f.run({ confirm: preview.data.confirmation_token });
    assert.equal(process.exitCode, 1);
  } finally { process.exitCode = 0; }
  assert.deepEqual(f.data.results.map(row => [row.update_name, row.success]), [[si(1), false], [si(2), true]]);
  assert.match(f.data.results[0].message, /did not revert/);
  assert.match(f.outputs.at(-1).opts.summary, /1 reverted; 1 failed/);
});

test('customizations revert needs the shared capture guard and a verified Global selection, which captures its global scripts', async () => {
  assert.equal(needsMutationContext({ _: ['customizations', 'revert'] }), true);
  const scoped = fixture();
  scoped.app.mutationContext = { verified: true, application_id: APP };
  await assert.rejects(scoped.run(), /needs Global selected; nothing was read or reverted/);
  await assert.rejects(scoped.run({ confirm: 'a'.repeat(64) }), /needs Global selected/);
  assert.deepEqual([scoped.reads.length, scoped.scripts.length], [0, 0]);
  const f = fixture();
  f.app.mutationContext = { verified: true, application_id: 'global' };
  await f.run();
  await f.run({ confirm: f.data.confirmation_token });
  assert.deepEqual([f.scripts.length, f.data.success_count], [2, 2]);
});

test('customizations revert refuses a file now in another scope and never trusts rows it did not ask for', async () => {
  const moved = fixture({ metadata: [meta(1, id(905)), meta(2), meta(3), meta(4), meta(6)] });
  await moved.run();
  assert.deepEqual(moved.data.refused.map(row => [row.update_name, row.reason]), [[si(1), 'The record now belongs to another scope.'], [si(5), 'No record has this update name; it may have been deleted on this instance.']]);
  for (const [options, message] of [
    [{ updates: [{ ...update(si(1)), application: id(905) }] }, /outside the application/],
    [{ updates: [{ ...update(si(1)), replace_on_upgrade: 'true' }] }, /outside the application/],
  ]) {
    const f = fixture(options);
    await assert.rejects(f.run(), message);
    assert.deepEqual(f.scripts, []);
  }
});

test('customizations revert refuses an unsafe or doubled update name and stops on a response it cannot trust', async () => {
  const f = fixture({ updates: [si(1), 'sys_x^ORname!=y', si(2)].map(update), metadata: [meta(1), { ...meta(1), sys_id: id(7) }, meta(2)] });
  await f.run();
  assert.deepEqual(f.data.refused.map(row => [row.update_name, row.reason]), [['sys_x^ORname!=y', 'The update name holds characters jsn will not put into a query.'], [si(1), 'More than one record has this update name.']]);
  assert.deepEqual(f.data.plans.map(plan => plan.update_name), [si(2)]);
  assert.equal(f.reads.find(r => r.table === 'sys_metadata').query, `sys_update_nameIN${si(1)},${si(2)}`);
  for (const [options, message] of [
    [{ stray: [meta(7)] }, /did not ask for/],
    [{ brokenVersions: true }, /Malformed table response for sys_update_version/],
  ]) {
    const g = fixture(options);
    await assert.rejects(g.run(), message);
    assert.deepEqual(g.scripts, []);
  }
});

test('customizations revert takes 100 files a run and says more remain', async () => {
  const names = Array.from({ length: 101 }, (_, i) => `sys_ui_action_${id(1000 + i)}`);
  const f = fixture({ updates: names.map(update), metadata: [] });
  await f.run();
  const metadata = f.reads.filter(r => r.table === 'sys_metadata');
  assert.deepEqual(metadata.map(r => r.limit), ['50', '50', '50', '50']);
  assert.deepEqual(metadata.flatMap(r => r.query.slice(17).split(',')), names.slice(0, 100));
  assert.equal(f.data.refused.length, 100);
  assert.deepEqual([f.data.more, f.data.next_after], [true, names[99]]);
  assert.match(f.data._formatted, new RegExp(`run again with --after ${names[99]} for the rest\\.\\nNothing to revert in this batch\\.`));
  assert.equal(f.outputs.at(-1).opts.summary, `Nothing to revert in this batch; more customised files remain: rerun with --after ${names[99]}`);
  // Files a run leaves unreverted keep their mark, so only the cursor moves the next run on.
  const next = fixture({ updates: names.map(update), metadata: [] });
  await next.run({ after: names[99] });
  assert.equal(next.reads.find(r => r.table === 'sys_update_xml').query, `application=${APP}^replace_on_upgrade=false^name>${names[99]}^ORDERBYname`);
  assert.deepEqual([next.data.refused.map(row => row.update_name), next.data.more, next.data.next_after], [[names[100]], false, null]);
  // An instance that dropped the name> term would return the same batch forever.
  const ignored = fixture({ updates: names.map(update), metadata: [], cursor: false });
  await assert.rejects(ignored.run({ after: names[99] }), /ignored --after/);
  assert.deepEqual(ignored.reads.map(r => r.table), ['sys_scope', 'sys_update_xml']);
});

test('customizations revert keeps --after in the preview\'s rerun line', async () => {
  const f = fixture();
  await f.run({ after: si(1) });
  assert.deepEqual(f.data.plans.map(plan => plan.update_name), [si(2)]);
  assert.equal(f.outputs.at(-1).opts.summary, `Preview: 1 file(s) to revert; nothing reverted. Rerun with --after ${si(1)} --confirm ${f.data.confirmation_token}`);
  assert.deepEqual(f.scripts, []);
});

test('customizations revert is registered as a mutation and its help lists its flags', () => {
  assert.equal(isMutationCommand({ _: ['customizations', 'revert'] }), true);
  assert.equal(isMutationCommand({ _: ['customizations', 'show'] }), false);
  const result = spawnSync(process.execPath, ['cli/bin/jsn.js', 'customizations', 'revert', '--help'], {
    cwd: new URL('../../', import.meta.url), encoding: 'utf8',
    env: { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  for (const flag of ['--scope', '--after', '--confirm', '--expect-scope', '--expect-update-set']) assert.ok(result.stdout.includes(flag), flag);
  assert.match(result.stdout, /never deleted/);
});

// Through bin/jsn.js, so the shared middleware runs: it sets argv.app to the App context, and it holds the read-only guard.
test('customizations revert through the CLI takes --scope and refuses a read-only profile before any request', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jsn-customizations-revert-'));
  const src = file => JSON.stringify(new URL(`../src/${file}`, import.meta.url).href);
  writeFileSync(path.join(dir, 'fixture.mjs'), `
import { mock } from 'node:test';
import * as config from ${src('config.js')};
import * as sdk from ${src('sdk.js')};
import * as context from ${src('mutation-context.js')};
mock.module(${src('config.js')}, { namedExports: { ...config, loadConfig: () => ({ profiles: { fixture: { instance_url: 'https://fixture.invalid', username: 'test', auth_method: 'basic', read_only: process.env.FIXTURE_READONLY === '1' } }, activeProfile: 'fixture', defaultProfile: 'fixture' }) } });
class SDKClient {
  async listStrict(table) {
    if (process.env.FIXTURE_READONLY === '1') throw new Error('a read-only run made a request');
    if (table === 'sys_scope') return [];
    throw new Error('unexpected read of ' + table);
  }
  async list(table, params) { return this.listStrict(table, params); }
  async request() { throw new Error('unexpected request'); }
}
mock.module(${src('sdk.js')}, { namedExports: { ...sdk, SDKClient } });
// The capture guard has its own suites; this test is about what reaches the handler.
mock.module(${src('mutation-context.js')}, { namedExports: { ...context, guardMutationContext: async () => null } });
`);
  const run = env => spawnSync(process.execPath, ['--experimental-test-module-mocks', '--import', pathToFileURL(path.join(dir, 'fixture.mjs')).href, fileURLToPath(new URL('../bin/jsn.js', import.meta.url)), 'customizations', 'revert', '--scope', 'sn_demo', '--json'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: dir, JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', ...env },
  });
  try {
    const reached = run({});
    assert.equal(JSON.parse(reached.stdout).error, 'No application has the scope sn_demo.', reached.stdout + reached.stderr);
    const readOnly = run({ FIXTURE_READONLY: '1' });
    assert.equal(readOnly.status, 1, readOnly.stdout + readOnly.stderr);
    assert.equal(JSON.parse(readOnly.stdout).code, 'read_only');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
