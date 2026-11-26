import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { recordsCmd } from '../src/commands/records.js';
import { isMutationCommand } from '../src/mutations.js';
import { applyRevert } from '../src/records/revert.js';

const id = n => n.toString(16).padStart(32, '0');
const ID = id(1);
const KEY = `sys_script_include_${ID}`;
const UPGRADE = id(50);
const SET = id(51);
const xml = (script, active = 'true') => `<?xml version="1.0" encoding="UTF-8"?><record_update table="sys_script_include"><sys_script_include action="INSERT_OR_UPDATE"><active>${active}</active><name>SynthUtil</name><script><![CDATA[${script}]]></script><sys_id>${ID}</sys_id><sys_updated_on>2026-01-01 10:00:00</sys_updated_on></sys_script_include></record_update>`;
const BASE = 'var base = 1;';
const version = (n, state, source_table, script, extra = {}) => ({ sys_id: id(n), name: KEY, state, source_table, source: source_table === 'sys_update_set' ? SET : UPGRADE,
  reverted_from: '', sys_recorded_at: String(n), sys_created_on: `2026-11-${n} 10:00:00`, payload: xml(script), ...extra });
const VERSIONS = () => [version(13, 'current', 'sys_update_set', 'var custom = 2;', { payload: xml('var custom = 2;', 'false') }), version(12, 'previous', 'sys_update_set', 'var custom = 1;'), version(11, 'history', 'sys_upgrade_history', BASE)];

// Exact-condition filter over fixture rows; ORDERBY terms are asserted by tests and applied here as sys_recorded_at descending.
function filter(rows, query) {
  const terms = query.split('^').filter(term => !term.startsWith('ORDERBY'));
  return rows.filter(row => terms.every(term => {
    const [, name, op, value] = term.match(/^(\w+?)(=|IN)(.*)$/);
    return op === 'IN' ? value.split(',').includes(row[name]) : row[name] === value;
  })).sort((a, b) => Number(b.sys_recorded_at) - Number(a.sys_recorded_at));
}

function fixture({ versions = VERSIONS(), output = 'JSN_REVERT:true', after, updateName = KEY, recordId = ID, recordClass = 'sys_script_include', others = {} } = {}) {
  const commands = [];
  const builder = { command(c) { commands.push(c); return this; } };
  recordsCmd(fn => fn).builder(builder);
  const handler = commands.find(c => c.command === 'revert <table> <identifier>').handler;
  const reads = [];
  const scripts = [];
  let rows = versions;
  let live = { sys_id: recordId, active: 'false', script: 'var custom = 2;', name: 'SynthUtil' };
  let data;
  const read = async (table, params) => {
    reads.push({ table, ...Object.fromEntries(params) });
    const query = params.get('sysparm_query');
    if (table === 'sys_update_version') return filter(rows, query).slice(0, Number(params.get('sysparm_limit')));
    if (query === `sys_id=${recordId}`) return [{ ...live, sys_update_name: updateName, sys_class_name: recordClass }];
    if (query === `sys_idIN${recordId}`) return live ? [live] : [];
    if (query.startsWith('sys_idIN')) return (others[table] || []).filter(row => query.slice(8).split(',').includes(row.sys_id));
    return [];
  };
  const app = {
    config: {},
    requireInstance() {},
    sdk: {
      list: read, listStrict: read,
      get: async () => ({ sys_id: ID, sys_scope: 'global' }),
      executeScript: async (script, scope) => {
        scripts.push({ script, scope });
        if (String(output).includes('JSN_REVERT:true')) {
          const done = after ? after(rows, live, others) : null;
          if (done) ({ rows, live, others = others } = done);
          else {
            rows = [version(14, 'current', 'sys_update_set', BASE, { reverted_from: id(11) }), ...rows.map(row => row.state === 'current' ? { ...row, state: 'previous' } : row)];
            live = { ...live, active: 'true', script: BASE };
          }
        }
        return output;
      },
    },
    ok(value) { data = value; },
  };
  return { app, reads, scripts, get data() { return data; },
    run: (args = {}) => handler({ _: ['records', 'revert'], table: 'sys_script_include', identifier: ID, force: true, ...args }, app) };
}

test('revert refuses a malformed --version before any request', async () => {
  for (const version of ['12', `${id(11)}0`, "x'); gs.print('y", '']) {
    const f = fixture();
    await assert.rejects(f.run({ version }), /--version must be/);
    assert.deepEqual(f.reads, []);
    assert.deepEqual(f.scripts, []);
  }
});

test('revert reads the current version and the newest base version by the record update name', async () => {
  const f = fixture();
  await f.run();
  const versionReads = f.reads.filter(r => r.table === 'sys_update_version');
  assert.equal(versionReads[0].sysparm_query, `name=${KEY}^state=current`);
  assert.equal(versionReads[0].sysparm_limit, '2');
  assert.equal(versionReads[1].sysparm_query, `name=${KEY}^source_tableINsys_upgrade_history,sys_store_app^ORDERBYDESCsys_recorded_at^ORDERBYDESCsys_id`);
  assert.equal(versionReads[1].sysparm_limit, '1');
  for (const r of versionReads) assert.equal(r.sysparm_display_value, 'false');
});

test('revert refuses an update name it will not put into a query or script, before reading versions', async () => {
  for (const updateName of ['sys_script_include_x^ORname=y', "x'); gs.print('y"]) {
    const f = fixture({ updateName });
    await assert.rejects(f.run(), /will not put into a script/);
    assert.deepEqual(f.reads.filter(r => r.table === 'sys_update_version'), []);
    assert.deepEqual(f.scripts, []);
  }
});

test('revert refuses with no script when the record has no base version', async () => {
  const f = fixture({ versions: VERSIONS().filter(row => row.source_table === 'sys_update_set') });
  await assert.rejects(f.run(), /no base system version/);
  assert.deepEqual(f.scripts, []);
});

test('revert refuses with no script when the record is already at the version asked for', async () => {
  const atBase = fixture({ versions: [version(11, 'current', 'sys_upgrade_history', BASE)] });
  await assert.rejects(atBase.run(), /already at its base system version/);
  assert.deepEqual(atBase.scripts, []);
  const current = fixture();
  await assert.rejects(current.run({ version: id(13) }), /is the current version/);
  assert.deepEqual(current.scripts, []);
  const same = fixture({ versions: [version(13, 'current', 'sys_update_set', BASE), version(11, 'history', 'sys_upgrade_history', BASE)] });
  await assert.rejects(same.run(), /already matches/);
  assert.deepEqual(same.scripts, []);
});

test('revert refuses a --version that is missing or belongs to another record', async () => {
  const missing = fixture();
  await assert.rejects(missing.run({ version: id(99) }), /not a version of sys_script_include_/);
  assert.deepEqual(missing.scripts, []);
  const other = fixture({ versions: [...VERSIONS(), { ...version(20, 'history', 'sys_update_set', BASE), name: 'sys_script_include_other' }] });
  await assert.rejects(other.run({ version: id(20) }), /not a version of sys_script_include_/);
  assert.deepEqual(other.scripts, []);
});

test('revert refuses a target version that holds no row for the record or deletes it', async () => {
  const other = fixture({ versions: [VERSIONS()[0], version(11, 'history', 'sys_upgrade_history', BASE, { payload: xml(BASE).replaceAll(ID, id(77)) })] });
  await assert.rejects(other.run(), /holds no row for sys_script_include/);
  const deletes = fixture({ versions: [VERSIONS()[0], version(11, 'history', 'sys_upgrade_history', BASE, { payload: xml(BASE).replace('INSERT_OR_UPDATE', 'DELETE') })] });
  await assert.rejects(deletes.run(), /does not delete records/);
  assert.deepEqual([...other.scripts, ...deletes.scripts], []);
});

test('revert refuses with no script when there is no single current version', async () => {
  const none = fixture({ versions: VERSIONS().filter(row => row.state !== 'current') });
  await assert.rejects(none.run(), /No current version/);
  const two = fixture({ versions: [...VERSIONS(), version(15, 'current', 'sys_update_set', 'x')] });
  await assert.rejects(two.run(), /More than one current version/);
  const other = fixture();
  const list = other.app.sdk.listStrict;
  other.app.sdk.listStrict = async (table, params) => (await list(table, params)).map(row => ({ ...row, name: 'sys_script_include_other' }));
  await assert.rejects(other.run(), /another record/);
  assert.deepEqual([...none.scripts, ...two.scripts, ...other.scripts], []);
});

test('revert without --force and no terminal asks for confirmation, names the change and writes nothing', async () => {
  const previous = process.env.JSN_NO_PROMPTS;
  process.env.JSN_NO_PROMPTS = '1';
  try {
    const f = fixture();
    await assert.rejects(f.run({ force: false }), (error) => {
      assert.equal(error.code, 'confirmation_required');
      assert.match(error.message, /Revert sys_script_include .* to its base system version .*active, script/);
      assert.match(error.hint, new RegExp(`jsn records revert sys_script_include ${ID} --version ${id(11)} --force`));
      return true;
    });
    assert.deepEqual(f.scripts, []);
  } finally {
    if (previous === undefined) delete process.env.JSN_NO_PROMPTS; else process.env.JSN_NO_PROMPTS = previous;
  }
});

test('revert runs one guarded global script and verifies the new version and the live record', async () => {
  const f = fixture();
  await f.run();
  assert.equal(f.scripts.length, 1);
  const { script, scope } = f.scripts[0];
  assert.equal(scope, 'global');
  assert.match(script, /gs\.hasRole\('admin'\)/);
  assert.match(script, new RegExp(`target\\.get\\('${id(11)}'\\) \\|\\| target\\.getValue\\('name'\\) !== '${KEY}'`));
  assert.match(script, new RegExp(`getUniqueValue\\(\\) !== '${id(13)}'`));
  assert.match(script, new RegExp(`GlideappUpdateVersion\\.canWriteRecordInVersion\\('${id(11)}'\\)`));
  assert.match(script, new RegExp(`new GlideappUpdateVersion\\(\\)\\.revert\\('${id(11)}'\\)`));
  const live = f.reads.at(-1);
  assert.deepEqual({ table: live.table, query: live.sysparm_query, fields: live.sysparm_fields, display: live.sysparm_display_value },
    { table: 'sys_script_include', query: `sys_idIN${ID}`, fields: 'sys_id,active,script', display: 'false' });
  assert.equal(f.data.reverted, true);
  assert.equal(f.data.base, true);
  assert.equal(f.data.from_version, id(13));
  assert.equal(f.data.to_version, id(11));
  assert.equal(f.data.new_version, id(14));
  assert.deepEqual(f.data.changes[0].fields.map(field => field.field), ['active', 'script']);
});

test('a field only the current version holds is left alone and does not fail the readback', async () => {
  const extra = xml('var custom = 2;', 'false').replace('<name>', '<sandbox_callable>false</sandbox_callable><name>');
  const f = fixture({ versions: [version(13, 'current', 'sys_update_set', '', { payload: extra }), version(11, 'history', 'sys_upgrade_history', BASE)] });
  await f.run();
  assert.equal(f.reads.at(-1).sysparm_fields, 'sys_id,active,script');
  assert.equal(f.data.reverted, true);
});

test('revert reads the record back from its own class and refuses a base row from another source', async () => {
  const f = fixture();
  await f.run({ table: 'sys_metadata' });
  assert.equal(f.reads.at(-1).table, 'sys_script_include');
  assert.equal(f.data.table, 'sys_script_include');
  const wrong = fixture();
  const list = wrong.app.sdk.listStrict;
  wrong.app.sdk.listStrict = async (table, params) => (await list(table, params)).map(row => params.get('sysparm_query').includes('source_tableIN') ? { ...row, source_table: 'sys_update_set' } : row);
  await assert.rejects(wrong.run(), /not a base system version/);
  const named = fixture();
  const read = named.app.sdk.listStrict;
  named.app.sdk.listStrict = async (table, params) => (await read(table, params)).map(row => params.get('sysparm_query').includes('source_tableIN') ? { ...row, name: 'sys_script_include_other' } : row);
  await assert.rejects(named.run(), /not a base system version/);
  assert.deepEqual([...wrong.scripts, ...named.scripts], []);
});

test('revert to an explicit earlier version uses that version', async () => {
  const f = fixture({ after: (rows, live) => ({ rows: [version(14, 'current', 'sys_update_set', 'var custom = 1;', { reverted_from: id(12) }), ...rows.map(row => row.state === 'current' ? { ...row, state: 'previous' } : row)], live: { ...live, active: 'true', script: 'var custom = 1;' } }) });
  await f.run({ version: id(12) });
  assert.equal(f.reads.filter(r => r.table === 'sys_update_version')[1].sysparm_query, `sys_id=${id(12)}`);
  assert.match(f.scripts[0].script, new RegExp(`revert\\('${id(12)}'\\)`));
  assert.equal(f.data.base, false);
  assert.equal(f.data.to_version, id(12));
  assert.equal(f.data.to_source.created_on, '2026-11-12 10:00:00');
});

test('revert reports an unknown or refused outcome from the script, never success', async () => {
  const unknown = fixture({ output: '*** Script: Admin role required' });
  await assert.rejects(unknown.run(), /outcome is unknown.*Admin role required/s);
  assert.equal(unknown.data, undefined);
  const refused = fixture({ output: 'JSN_REVERT:false' });
  await assert.rejects(refused.run(), /did not revert/);
  assert.equal(refused.data, undefined);
});

test('revert never reports success when the readback does not show the revert', async () => {
  const cases = [
    [(rows, live) => ({ rows, live }), /not a revert of/],
    [(rows, live) => ({ rows: [version(14, 'current', 'sys_update_set', BASE, { reverted_from: id(12) }), ...rows.filter(row => row.state !== 'current')], live }), /not a revert of/],
    [(rows, live) => ({ rows: [version(14, 'current', 'sys_update_set', BASE, { reverted_from: id(11) }), ...rows.filter(row => row.state !== 'current')], live: { ...live, active: 'true' } }), /still differs .* script/],
    [(rows) => ({ rows: [version(14, 'current', 'sys_update_set', BASE, { reverted_from: id(11) }), ...rows.filter(row => row.state !== 'current')], live: { sys_id: ID, active: 'true' } }), /could not read script/],
    [(rows) => ({ rows: [version(14, 'current', 'sys_update_set', BASE, { reverted_from: id(11) }), ...rows.filter(row => row.state !== 'current')], live: null }), /could not be read/],
  ];
  for (const [after, message] of cases) {
    const f = fixture({ after });
    await assert.rejects(f.run(), message);
    assert.equal(f.data, undefined);
  }
  const denied = fixture();
  const list = denied.app.sdk.listStrict;
  denied.app.sdk.listStrict = async (table, params) => {
    if (denied.scripts.length && table === 'sys_script_include') throw Object.assign(new Error('Forbidden'), { status: 403 });
    return list(table, params);
  };
  await assert.rejects(denied.run(), /Forbidden/);
  assert.equal(denied.data, undefined);
});

const SET_ID = id(2);
const LIST_KEY = 'sys_choice_incident_u_size';
// A choice list update holds a wrapper, the list's own row, then one row per choice.
const choices = list => `<?xml version="1.0" encoding="UTF-8"?><record_update table="sys_choice"><sys_choice_set action="INSERT_OR_UPDATE" field="u_size" table="incident"><sys_choice_set action="INSERT_OR_UPDATE"><element>u_size</element><name>incident</name><sys_id>${SET_ID}</sys_id></sys_choice_set>${list.map(([n, label]) => `<sys_choice action="INSERT_OR_UPDATE"><element>u_size</element><label>${label}</label><name>incident</name><sys_id>${id(n)}</sys_id><value>v${n}</value></sys_choice>`).join('')}</sys_choice_set></record_update>`;
const listVersion = (n, state, source_table, list, extra = {}) => version(n, state, source_table, '', { name: LIST_KEY, payload: choices(list), ...extra });
const choiceRow = (n, label) => ({ sys_id: id(n), label });
// Base: 21 Small, 22 Medium. Current: 21 renamed, 22 deleted, 23 added.
function listFixture(afterOthers) {
  return fixture({
    updateName: LIST_KEY, recordId: SET_ID, recordClass: 'sys_choice_set',
    versions: [listVersion(13, 'current', 'sys_update_set', [[21, 'Tiny'], [23, 'Huge']]), listVersion(11, 'history', 'sys_upgrade_history', [[21, 'Small'], [22, 'Medium']])],
    others: { sys_choice: [choiceRow(21, 'Tiny'), choiceRow(23, 'Huge')] },
    after: (rows, live) => ({ rows: [listVersion(14, 'current', 'sys_update_set', [[21, 'Small'], [22, 'Medium']], { reverted_from: id(11) }), ...rows.filter(row => row.state !== 'current')], live, others: { sys_choice: afterOthers } }),
  });
}

test('revert refuses a single choice before any request and points to its choice list', async () => {
  const f = fixture();
  await assert.rejects(f.run({ table: 'sys_choice' }), /revert the list instead: jsn records revert sys_choice_set/);
  assert.deepEqual([f.reads, f.scripts], [[], []]);
});

test('a choice list revert checks every choice it touches in one bounded read', async () => {
  const f = listFixture([choiceRow(21, 'Small'), choiceRow(22, 'Medium')]);
  await f.run({ table: 'sys_choice_set', identifier: SET_ID });
  const choiceRead = f.reads.filter(r => r.table === 'sys_choice');
  assert.deepEqual(choiceRead.map(r => [r.sysparm_query, r.sysparm_fields, r.sysparm_limit]), [[`sys_idIN${id(21)},${id(22)},${id(23)}`, 'sys_id,label', '3']]);
  assert.deepEqual(f.data.changes.map(change => [change.sys_id, change.status]), [[id(21), 'changed'], [id(22), 'added'], [id(23), 'removed']]);
  assert.equal(f.data.reverted, true);
});

test('a choice list revert never reports success while a choice is not back as the version holds it', async () => {
  for (const [after, message] of [
    [[choiceRow(21, 'Tiny'), choiceRow(22, 'Medium')], new RegExp(`sys_choice ${id(21)} still differs in: label`)],
    [[choiceRow(21, 'Small')], new RegExp(`sys_choice ${id(22)} could not be read`)],
    [[choiceRow(21, 'Small'), choiceRow(22, 'Medium'), choiceRow(23, 'Huge')], new RegExp(`sys_choice ${id(23)} is still there`)],
  ]) {
    const f = listFixture(after);
    await assert.rejects(f.run({ table: 'sys_choice_set', identifier: SET_ID }), message);
    assert.equal(f.data, undefined);
  }
});

test('revert refuses before the script when the version holds a row jsn cannot read back', async () => {
  for (const bad of [choices([[21, 'Small']]).replace(`<sys_id>${id(21)}`, '<sys_id>not-an-id'), choices([[21, 'Small']]).replaceAll('sys_choice action', 'bad:table action').replace('</sys_choice></sys_choice_set></record', '</bad:table></sys_choice_set></record')]) {
    const f = fixture({ updateName: LIST_KEY, recordId: SET_ID, recordClass: 'sys_choice_set',
      versions: [listVersion(13, 'current', 'sys_update_set', [[21, 'Tiny']]), listVersion(11, 'history', 'sys_upgrade_history', [], { payload: bad })] });
    await assert.rejects(f.run({ table: 'sys_choice_set', identifier: SET_ID }), /cannot read back/);
    assert.deepEqual(f.scripts, []);
  }
});

test('revert holds a verified capture context to the record\'s own scope', async () => {
  const f = fixture();
  f.app.mutationContext = { verified: true, application_id: 'a'.repeat(32) };
  await assert.rejects(f.run(), /scope is unknown or differs/);
  assert.deepEqual(f.scripts, []);
});

test('applyRevert checks every value it puts into the script itself', async () => {
  const plan = { table: 'sys_script_include', sys_id: ID, update_name: KEY, from_version: id(13), to_version: id(11) };
  for (const wrong of [{ update_name: "x'); gs.print('y" }, { sys_id: 'nope' }, { from_version: `${id(13)}'` }, { to_version: '' }, { table: 'a b' }]) {
    const scripts = [];
    await assert.rejects(applyRevert({ executeScript: async (script) => { scripts.push(script); return 'JSN_REVERT:true'; } }, { ...plan, ...wrong }), /will not put|Invalid/);
    assert.deepEqual(scripts, []);
  }
});

test('revert is registered as a mutation and its help lists its flags', () => {
  assert.equal(isMutationCommand({ _: ['records', 'revert'] }), true);
  const result = spawnSync(process.execPath, ['cli/bin/jsn.js', 'records', 'revert', '--help'], {
    cwd: new URL('../../', import.meta.url), encoding: 'utf8',
    env: { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  for (const flag of ['--version', '--identifier-field', '--force']) assert.ok(result.stdout.includes(flag));
  assert.match(result.stdout, /base system version/);
});
