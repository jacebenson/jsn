import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as helpers from '../src/helpers.js';
import { SDKClient } from '../src/sdk.js';
import { makeApp } from './support/app-test-helpers.js';
import { findCommand, wrapHandler } from './support/command-test-helpers.js';

process.env.JSN_NO_VERSION_CHECK = '1';
process.env.JSN_NO_SKILL_CHECK = '1';
const id = 'a'.repeat(32);
const record = { sys_id: id, name: 'Example' };
mock.module('../src/helpers.js', { namedExports: {
  ...helpers, interactiveList: async () => ({ ...record }),
} });
const { groupsCmd } = await import('../src/commands/groups.js');
const { importCmd } = await import('../src/commands/import.js');

function fixture(respond) {
  const sdk = new SDKClient('https://fixture.example.service-now.com', {});
  const calls = [];
  sdk.request = async (endpoint, options) => {
    const url = new URL(endpoint);
    calls.push({ url, options });
    assert.equal(options.method, 'GET', 'counting never writes');
    if (url.pathname === '/api/now/table/sys_import_set') return { result: [{ ...record }] };
    return respond(url, options);
  };
  return { sdk, calls };
}

async function run(kind, sdk, t) {
  const app = makeApp({ sdk });
  // Keep the real SDK prototype rather than spreading away its methods.
  app.sdk = sdk;
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  const command = findCommand(kind === 'groups' ? groupsCmd(wrapHandler) : importCmd(wrapHandler), kind === 'groups' ? 'list' : 'show');
  await command.handler({ app, identifier: id, limit: 20 });
  return { app, lines };
}

for (const kind of ['groups', 'import']) {
  test(`${kind} uses scalar Stats requests with unchanged detail output`, async t => {
    const { sdk, calls } = fixture(async url => {
      await new Promise(resolve => setImmediate(resolve));
      return { result: { stats: { count: url.pathname.endsWith('sys_group_has_role') ? '7' : '12345' } } };
    });
    const { app, lines } = await run(kind, sdk, t);
    const counts = calls.filter(call => call.url.pathname.includes('/stats/'));
    assert.equal(counts.length, kind === 'groups' ? 2 : 1);
    assert.equal(calls.length, kind === 'groups' ? 2 : 2, 'no Table ID download for counting');
    for (const { url } of counts) {
      assert.deepEqual([...url.searchParams], [
        ['sysparm_count', 'true'],
        ['sysparm_query', `${kind === 'groups' ? 'group' : 'sys_import_set'}=${id}`],
      ]);
      assert.equal(url.searchParams.has('sysparm_fields'), false);
      assert.equal(url.searchParams.has('sysparm_limit'), false);
    }
    assert.deepEqual(counts.map(call => call.url.pathname), kind === 'groups'
      ? ['/api/now/stats/sys_user_grmember', '/api/now/stats/sys_group_has_role']
      : ['/api/now/stats/sys_import_set_row']);
    assert.deepEqual(app.lastOk.data, { ...record, _context: {
      instance_url: 'https://dev.example.service-now.com', table: kind === 'groups' ? 'sys_user_group' : 'sys_import_set',
    } });
    if (kind === 'groups') {
      assert.deepEqual(app.lastOk.opts, { summary: 'Group: Example', breadcrumbs: [
        { action: 'members', cmd: `jsn records list --table sys_user_grmember --query "group=${id}"`, description: '12345 member(s)' },
        { action: 'roles', cmd: `jsn records list --table sys_group_has_role --query "group=${id}"`, description: '7 role(s)' },
      ] });
      assert.deepEqual(lines, []);
    } else {
      assert.deepEqual(lines, ['  Import rows: 12345', `    → jsn records list --table sys_import_set_row --query "sys_import_set=${id}" --limit 200`]);
      assert.equal(app.lastOk.opts.summary, 'Import set: Example');
      assert.deepEqual(app.lastOk.opts.breadcrumbs, [{ action: 'list', cmd: 'jsn import list', description: 'Back to all import' }]);
    }
  });

  test(`${kind} fails loudly on malformed Stats without Table fallback or success`, async t => {
    const { sdk, calls } = fixture(() => ({ result: { stats: { count: 'unreadable' } } }));
    await assert.rejects(run(kind, sdk, t), { code: 'invalid_aggregate_count' });
    assert.equal(calls.some(({ url }) => url.searchParams.get('sysparm_fields') === 'sys_id'), false);
  });

  test(`${kind} retains Table counts when Stats is denied`, async t => {
    const { sdk, calls } = fixture(url => {
      if (url.pathname.includes('/stats/')) throw Object.assign(new Error('Stats ACL denied'), { status: 403 });
      assert.equal(url.searchParams.get('sysparm_fields'), 'sys_id');
      assert.equal(url.searchParams.get('sysparm_limit'), '0');
      assert.equal(url.searchParams.get('sysparm_query'), `${kind === 'groups' ? 'group' : 'sys_import_set'}=${id}`);
      return { result: [{ sys_id: 'one' }, { sys_id: 'two' }] };
    });
    const { app, lines } = await run(kind, sdk, t);
    assert.equal(calls.filter(({ url }) => url.pathname.includes('/stats/')).length, kind === 'groups' ? 2 : 1);
    if (kind === 'groups') assert.deepEqual(app.lastOk.opts.breadcrumbs.map(c => c.description), ['2 member(s)', '2 role(s)']);
    else assert.equal(lines[0], '  Import rows: 2');
  });

  test(`${kind} preserves unavailable detail behaviour when both APIs fail`, async t => {
    const { sdk } = fixture(() => { throw new Error('ACL denied'); });
    const { app, lines } = await run(kind, sdk, t);
    if (kind === 'groups') assert.deepEqual(app.lastOk.opts.breadcrumbs, []);
    else assert.deepEqual(lines, ['  Import rows: (unavailable)']);
  });
}

test('group detail counts overlap with at most two active requests', async t => {
  let active = 0, peak = 0;
  const { sdk } = fixture(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return { result: { stats: { count: '1' } } };
  });
  await run('groups', sdk, t);
  assert.equal(peak, 2);
  assert.equal(active, 0);
});

test('aggregateCount validates supported scalar response shapes and measured zero', async () => {
  for (const stats of [{ count: '0' }, { count: 42 }, '{"count":"17"}', { nested: { count: '23' } }]) {
    const { sdk } = fixture(() => ({ result: { stats } }));
    const expected = typeof stats === 'string' ? 17 : stats.nested ? 23 : Number(stats.count);
    assert.equal(await sdk.aggregateCount('task', '', { strict: true }), expected);
  }
});

test('aggregateCount rejects missing, ambiguous, partial and unsafe counts', async () => {
  for (const stats of [undefined, null, '', '{', 'null', '42', [], {}, { count: null },
    { count: '' }, { count: '12oops' }, { count: '1.5' }, { count: '-1' }, { count: true },
    { count: -1 }, { count: 1.5 }, { count: Infinity }, { count: NaN }, { count: '9007199254740992' },
    { a: { count: '1' }, b: { count: '2' } }]) {
    const { sdk } = fixture(() => ({ result: { stats } }));
    await assert.rejects(sdk.aggregateCount('task', '', { strict: true }), { code: 'invalid_aggregate_count' });
  }
});
