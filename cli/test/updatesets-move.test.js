import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { yargs } from '../src/cli-adapter.js';
import { updateSetsCmd } from '../src/commands/updatesets.js';
import { isMutationCommand } from '../src/mutations.js';
import { needsMutationContext } from '../src/mutation-context.js';
import { collectCapabilities } from '../src/capabilities.js';
import '../src/command-families.js';

const id = n => String(n).padStart(32, '0');
const APP = 'a'.repeat(32), OTHER = 'b'.repeat(32);

// Minimal encoded-query matcher: AND of field=value and fieldINa,b terms; ORDERBY ignored.
function matches(row, query) {
  return query.split('^').filter(term => term && !term.startsWith('ORDERBY')).every(term => {
    const inAt = term.indexOf('IN');
    const eq = term.indexOf('=');
    if (eq < 0 && inAt > 0) return term.slice(inAt + 2).split(',').includes(String(row[term.slice(0, inAt)]));
    return String(row[term.slice(0, eq)]) === term.slice(eq + 1);
  });
}

function fixture() {
  const sets = [
    { sys_id: id(1), name: 'sprint', state: 'in progress', application: APP, is_default: 'false' },
    { sys_id: id(2), name: 'feature', state: 'in progress', application: APP, is_default: 'false' },
    { sys_id: id(3), name: 'shipped', state: 'complete', application: APP, is_default: 'false' },
    { sys_id: id(4), name: 'Default', state: 'in progress', application: APP, is_default: 'true' },
    { sys_id: id(5), name: 'Default', state: 'in progress', application: OTHER, is_default: 'true' },
    { sys_id: id(6), name: 'elsewhere', state: 'in progress', application: OTHER, is_default: 'false' },
  ];
  const updates = [
    { sys_id: id(11), name: 'sys_script_include_x1', target_name: 'FeatureUtils', type: 'Script Include', update_set: id(1), application: APP },
    { sys_id: id(12), name: 'sys_script_x2', target_name: 'FeatureCheck', type: 'Business Rule', update_set: id(1), application: APP },
    { sys_id: id(13), name: 'sys_script_include_x3', target_name: 'Reporting', type: 'Script Include', update_set: id(1), application: APP },
  ];
  const writes = [], reads = [], counts = [], results = [];
  const ref = (table, value) => table === 'sys_update_set' && value === APP ? { value, display_value: 'Feature App' } : { value, display_value: value };
  const shape = (table, row, display) => Object.fromEntries(Object.entries(row).map(([k, v]) =>
    [k, display && ['application', 'update_set'].includes(k) ? ref(table, v) : display ? { value: v, display_value: v } : v]));
  const app = {
    ok: (data, meta) => results.push({ data, meta }),
    sdk: {
      listStrict: async (table, params) => {
        const query = params.get('sysparm_query');
        reads.push({ table, query });
        const rows = (table === 'sys_update_set' ? sets : updates).filter(row => matches(row, query));
        const offset = Number(params.get('sysparm_offset') || 0);
        return structuredClone(rows.slice(offset, offset + Number(params.get('sysparm_limit') || rows.length))
          .map(row => shape(table, row, params.get('sysparm_display_value') === 'all')));
      },
      aggregateCount: async (table, query) => { counts.push({ table, query }); return updates.filter(row => matches(row, query)).length; },
      update: async (table, sysID, data) => {
        writes.push({ table, sys_id: sysID, data });
        Object.assign(updates.find(row => row.sys_id === sysID), data);
        return {};
      },
    },
  };
  return { app, sets, updates, writes, reads, counts, results, get last() { return results.at(-1); } };
}

async function run(args, app) {
  await yargs(['updatesets', 'move', ...args]).strictCommands().strictOptions()
    .option('json', { type: 'boolean' }).option('profile', { type: 'string' }).option('instance', { type: 'string' })
    .command(updateSetsCmd(handler => argv => handler(argv, app)))
    .fail((message, error) => { throw error || new Error(message); }).parse();
}

const PICK = ['--from', 'sprint', '--to', 'feature', '--query', 'target_nameINFeatureUtils,FeatureCheck'];

test('move previews the matching updates by default and writes nothing', async () => {
  const f = fixture();
  await run(PICK, f.app);
  assert.deepEqual(f.writes, []);
  const { data } = f.last;
  assert.equal(data.dry_run, true);
  assert.equal(data.count, 2);
  assert.deepEqual(data.sample.map(row => row.target_name).sort(), ['FeatureCheck', 'FeatureUtils']);
  assert.equal(f.counts[0].query, `update_set=${id(1)}^target_nameINFeatureUtils,FeatureCheck`);
  assert.match(data.rerun, new RegExp(`--from ${id(1)} --to ${id(2)} .*--expect-count 2 .*--yes`));
});

test('the preview rerun keeps the profile and instance it was run against', async () => {
  const f = fixture();
  await run(['--profile', 'dev', '--instance', 'https://dev.example.com', ...PICK], f.app);
  assert.match(f.last.data.rerun, /--yes --profile dev --instance https:\/\/dev\.example\.com$/);
  assert.equal(f.last.meta.breadcrumbs[0].cmd, f.last.data.rerun);
});

test('move with --yes moves only the matched updates and verifies them by reading each back', async () => {
  const f = fixture();
  await run([...PICK, '--expect-count', '2', '--yes'], f.app);
  assert.deepEqual(f.writes.map(w => [w.table, w.sys_id, w.data]),
    [['sys_update_xml', id(11), { update_set: id(2) }], ['sys_update_xml', id(12), { update_set: id(2) }]]);
  assert.equal(f.updates.find(row => row.target_name === 'Reporting').update_set, id(1));
  const { data, meta } = f.last;
  assert.equal(data.matched, 2);
  assert.equal(data.moved, 2);
  assert.equal(data.verified, true);
  assert.deepEqual(data.failed, []);
  assert.match(meta.summary, /Moved 2 update\(s\) from "sprint" to "feature"/);
  assert.ok(f.reads.some(r => r.table === 'sys_update_xml' && r.query.startsWith(`sys_idIN${id(11)},${id(12)}`)));
});

test('move without --query moves every update in the source set', async () => {
  const f = fixture();
  await run(['--from', 'sprint', '--to', 'feature', '--expect-count', '3', '--yes'], f.app);
  assert.equal(f.writes.length, 3);
  assert.equal(f.last.data.moved, 3);
});

test('a duplicate set name is narrowed to the other set\'s application, never guessed', async () => {
  const f = fixture();
  await run(['--from', 'sprint', '--to', 'Default', '--expect-count', '3', '--yes'], f.app);
  assert.ok(f.writes.every(w => w.data.update_set === id(4)));
  const g = fixture();
  g.sets.push({ sys_id: id(7), name: 'Default', state: 'in progress', application: APP, is_default: 'false' });
  await assert.rejects(run(['--from', 'sprint', '--to', 'Default'], g.app), /Multiple update sets named "Default".*sys_id/s);
  assert.deepEqual(g.writes, []);
});

test('--to-default moves the updates into the Default set of the source set\'s application', async () => {
  const f = fixture();
  const list = f.app.sdk.listStrict; // a row outside the application or not default is never taken as the Default set
  f.app.sdk.listStrict = async (table, params) => [...await list(table, params), ...(params.get('sysparm_query').includes('is_default')
    ? [{ sys_id: { value: id(5) }, application: { value: OTHER }, is_default: { value: 'true' } }, { sys_id: { value: id(2) }, application: { value: APP }, is_default: { value: 'false' } }] : [])];
  await run(['--from', 'sprint', '--to-default'], f.app);
  assert.equal(f.last.data.to.sys_id, id(4));
  assert.match(f.last.data.rerun, new RegExp(`--to ${id(4)} .*--expect-count 3 .*--yes`));
  assert.ok(f.reads.some(r => r.table === 'sys_update_set' && r.query === `application=${APP}^is_default=true`));
  await run(['--from', 'sprint', '--to-default', '--expect-count', '3', '--yes'], f.app);
  assert.equal(f.writes.length, 3);
  assert.ok(f.writes.every(w => w.data.update_set === id(4)));
  assert.equal(f.last.data.verified, true);
});

test('--to-default refuses when the target is not exactly one Default set, before any write', async () => {
  const cases = [
    [f => f, ['--from', 'sprint', '--to', 'feature', '--to-default'], /exactly one of --to or --to-default/, true],
    [f => f, ['--from', 'sprint'], /exactly one of --to or --to-default/, true],
    [f => { f.sets[3].is_default = 'false'; }, ['--from', 'sprint', '--to-default'], /No Default update set for Feature App/],
    [f => { f.sets.push({ sys_id: id(8), name: 'Default 2', state: 'in progress', application: APP, is_default: 'true' }); }, ['--from', 'sprint', '--to-default'], /2 Default update sets for Feature App/],
    [f => { f.sets[3].state = 'complete'; }, ['--from', 'sprint', '--to-default'], /Target update set "Default" is complete/],
    [f => f, ['--from', id(4), '--to-default'], /"Default" is already its application's Default update set/],
    [f => f, ['--from', 'Default', '--to-default'], /Multiple update sets named "Default"/],
  ];
  for (const [mutate, args, error, noReads] of cases) {
    const f = fixture();
    mutate(f);
    await assert.rejects(run(args, f.app), error, args.join(' '));
    assert.deepEqual(f.writes, [], args.join(' '));
    if (noReads) assert.deepEqual(f.reads, [], args.join(' '));
  }
});

test('every refusal happens before the first write', async () => {
  const cases = [
    [['--from', 'sprint', '--to', 'shipped'], /is complete; updates can only move into an in-progress set/],
    [['--from', 'shipped', '--to', 'feature'], /Source update set "shipped" is complete.*jsn updatesets reopen/s],
    [['--from', 'sprint', '--to', 'feature', '--query', ' '], /--query is empty; omit it/],
    [['--from', 'sprint', '--to', 'elsewhere'], /updates move only within one application/],
    [['--from', 'sprint', '--to', 'sprint'], /same update set/],
    [['--from', 'missing', '--to', 'feature'], /Update set not found: missing/],
    [['--from', 'sprint^ORname=feature', '--to', 'feature'], /query characters/],
    [['--from', ' ', '--to', 'feature'], /--from must name an update set/],
    [[...PICK, '--yes'], /requires --expect-count/],
    [[...PICK, '--expect-count', '3', '--yes'], /--expect-count 3, live count 2/],
    [[...PICK, '--limit', '1'], /Matched 2 updates, exceeding --limit 1/],
    [[...PICK, '--limit', '0'], /--limit must be a positive/],
    [['--from', 'sprint', '--to', 'feature', '--query', 'type=Script Include^NQupdate_set=x'], /\^NQ/],
  ];
  for (const [args, error] of cases) {
    const f = fixture();
    await assert.rejects(run(args, f.app), error, args.join(' '));
    assert.deepEqual(f.writes, [], args.join(' '));
  }
});

test('both set identifiers are checked before any read, and a fetched set must be the one asked for', async () => {
  for (const args of [['--from', 'sprint', '--to', ' '], ['--from', 'sprint', '--to', 'feature^ORname=sprint']]) {
    const f = fixture();
    await assert.rejects(run(args, f.app), /--to must name an update set|query characters/);
    assert.deepEqual(f.reads, []);
  }
  const f = fixture();
  const list = f.app.sdk.listStrict;
  f.app.sdk.listStrict = async (table, params) => params.get('sysparm_query') === 'name=feature' ? list(table, new URLSearchParams({ ...Object.fromEntries(params), sysparm_query: 'name=sprint' })) : list(table, params);
  await assert.rejects(run(PICK, f.app), /Update set not found: feature/);
});

test('an update captured in another application blocks the move, in the preview too', async () => {
  for (const extra of [[], ['--expect-count', '2', '--yes']]) {
    const f = fixture();
    f.updates[1].application = OTHER;
    await assert.rejects(run([...PICK, ...extra], f.app), /belong to another application.*Nothing was moved/s);
    assert.deepEqual(f.writes, []);
  }
});

test('an object that already has an update in the target blocks the move, in the preview too', async () => {
  for (const extra of [[], ['--expect-count', '2', '--yes']]) {
    const f = fixture();
    f.updates.push({ sys_id: id(14), name: 'sys_script_x2', target_name: 'FeatureCheck', type: 'Business Rule', update_set: id(2), application: APP });
    await assert.rejects(run([...PICK, ...extra], f.app), /1 object\(s\) already have an update in "feature": sys_script_x2.*Nothing was moved/s);
    assert.deepEqual(f.writes, []);
    assert.ok(f.reads.some(r => r.query === `update_set=${id(2)}^nameINsys_script_include_x1,sys_script_x2`));
  }
});

test('rows that are not in the source set or are unreadable block the whole move', async () => {
  const f = fixture();
  f.app.sdk.listStrict = async (table, params) => table === 'sys_update_set'
    ? fixture().app.sdk.listStrict(table, params)
    : [{ sys_id: id(11), update_set: id(6), application: APP }, { sys_id: '', update_set: id(1), application: APP }];
  await assert.rejects(run([...PICK, '--expect-count', '2', '--yes'], f.app), /Nothing was moved/);
  assert.deepEqual(f.writes, []);
});

test('a failed write or a row the platform did not move is reported, never a success', async () => {
  const previous = process.exitCode;
  try {
    const f = fixture();
    const update = f.app.sdk.update;
    f.app.sdk.update = async (table, sysID, data) => {
      if (sysID === id(11)) throw new Error('ACL denied');
      if (sysID === id(12)) { f.writes.push({ table, sys_id: sysID, data }); return {}; } // accepted, not applied
      return update(table, sysID, data);
    };
    await run([...PICK, '--expect-count', '2', '--yes'], f.app);
    const { data, meta } = f.last;
    assert.equal(data.verified, false);
    assert.equal(data.moved, 0);
    assert.deepEqual(data.failed.map(row => row.sys_id), [id(11)]);
    assert.deepEqual(data.not_moved, [id(12)]);
    assert.match(meta.summary, /Move incomplete/);
    assert.equal(process.exitCode, 1);
  } finally { process.exitCode = previous; }
});

test('move is a mutation outside the capture-context guard, and validates --query against sys_update_xml', () => {
  assert.equal(isMutationCommand({ _: ['updatesets', 'move'] }), true);
  assert.equal(needsMutationContext({ _: ['updatesets', 'move'] }), false);
  const caps = collectCapabilities().get('updatesets');
  assert.equal(caps.queryTable({ _: ['updatesets', 'move'] }), 'sys_update_xml');
  assert.equal(caps.queryTable({ _: ['updatesets', 'list'] }), 'sys_update_set');
  const result = spawnSync(process.execPath, ['cli/bin/jsn.js', 'updatesets', 'move', '--help'], {
    cwd: new URL('../../', import.meta.url), encoding: 'utf8',
    env: { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  for (const flag of ['--from', '--to', '--to-default', '--query', '--expect-count', '--yes', '--limit']) assert.ok(result.stdout.includes(flag), flag);
});
