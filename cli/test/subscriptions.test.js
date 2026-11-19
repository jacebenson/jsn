import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSchedule, estimateSubscription, formatEstimate } from '../src/subscriptions.js';
import { SDKClient } from '../src/sdk.js';
import { subscriptionsCmd } from '../src/commands/subscriptions.js';
import yargs from '../src/cli-adapter.js';
import { buildCLI } from '../src/cli.js';
import { spawnSync } from 'node:child_process';

function transport(t, options = {}) {
  const definitions = [{ sys_id: 'root', name: 'cmdb_ci', super_class: '' }];
  for (const c of loadSchedule().categories) for (const name of c.classes) {
    if (name === 'cmdb_ci_could_database') continue;
    definitions.push({ sys_id: name, name, super_class: name === 'cmdb_ci_server' ? 'cmdb_ci_computer' : 'root' });
  }
  definitions.push({ sys_id: 'custom', name: 'x_demo_server', super_class: 'cmdb_ci_server' });
  if (options.overlap) definitions.find(d => d.name === 'cmdb_ci_oslv_container').super_class = 'cmdb_ci_server';
  if (options.missingAncestry) definitions.find(d => d.name === 'x_demo_server').super_class = 'hidden';
  if (options.omitClass) definitions.splice(definitions.findIndex(d => d.name === options.omitClass), 1);
  if (options.shortPage) for (let i = 0; i < 1100; i++) definitions.push({ sys_id: `z${String(i).padStart(4, '0')}`, name: `x_extra_${i}`, super_class: '' });
  definitions.sort((a, b) => a.sys_id < b.sys_id ? -1 : 1);
  if (options.badId) definitions[0].sys_id = options.badId === 'missing' ? undefined : options.badId;
  let metadataCounts = 0;
  const sdk = new SDKClient('https://example.invalid', {});
  sdk._setAuth = async () => {};
  const seen = [];
  t.mock.method(globalThis, 'fetch', async request => {
    const url = new URL(request.url);
    seen.push({ method: request.method, path: url.pathname, query: url.searchParams.get('sysparm_query') || '' });
    assert.equal(request.method, 'GET', 'metering must not write instance records');
    const target = url.pathname.split('/').at(-1);
    if (options.denied === target) return new Response('denied', { status: 403 });
    if (options.missing === target) return new Response('missing', { status: 404 });
    let body;
    if (url.pathname.includes('/stats/')) {
      let value = definitions.length;
      if (target === 'cmdb_ci') {
        const classes = (url.searchParams.get('sysparm_query') || '').replace('sys_class_nameIN', '').split(',');
        value = classes.reduce((n, name) => n + ({ cmdb_ci_server: 2, x_demo_server: 1, cmdb_ci_computer: 5, cmdb_ci_cloud_function: 30, cmdb_ci_oslv_container: 15 }[name] || 0), 0);
      }
      if (target === 'sys_db_object') {
        metadataCounts++;
        if (options.unstable && metadataCounts > 1) value++;
      }
      if (options.truncated && target === 'sys_db_object') value++;
      body = options.badStats === target ? { result: { stats: { count: '3oops' } } } : { result: { stats: { count: String(value) } } };
    } else if (target === 'sys_db_object') {
      const offset = Number(url.searchParams.get('sysparm_offset'));
      const limit = Number(url.searchParams.get('sysparm_limit'));
      assert.equal(url.searchParams.get('sysparm_query'), 'ORDERBYsys_id');
      assert.ok(limit <= 1000);
      let page = definitions.slice(offset, offset + Math.min(limit, options.shortPage ? 2 : limit));
      if (options.empty && offset > 0) page = [];
      if (options.duplicate && offset > 0) page = [definitions[0]];
      if (options.unordered) page.reverse();
      body = options.malformed ? {} : { result: page };
    }
    else if (target === 'sys_dictionary') body = { result: options.noDictionary ? [] : [{ name: 'cmdb_ci', element: 'sys_class_name', internal_type: 'sys_class_name' }] };
    else throw new Error('Unexpected transport request');
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return { sdk, seen };
}

async function runRegistered(sdk, args) {
  let output;
  const app = { sdk, requireInstance() {}, ok(data) { output = data; } };
  await yargs(['subscriptions', ...args]).command(subscriptionsCmd(fn => argv => fn(argv, app))).parse();
  return output;
}

test('registered estimate uses SDK GET transport, exact nonoverlapping subclasses and fractional math', async t => {
  const { sdk, seen } = transport(t);
  const r = await runRegistered(sdk, ['estimate', 'ITOM', '--schedule', 'itom-2026-04-09', '--assume-eligible']);
  const category = id => r.categories.find(c => c.category === id);
  assert.equal(category('server').population, 3);
  assert.equal(category('server').illustrative_units, 3);
  assert.equal(category('end_user_device').population, 5);
  assert.equal(category('end_user_device').illustrative_units, 1.25);
  assert.equal(category('faas').illustrative_units, 1.5);
  assert.equal(category('container').illustrative_units, 1.5);
  assert.equal(category('paas').mapping_complete, false);
  assert.equal(category('unresolved_object').population, null);
  assert.equal(r.total_units, null);
  assert.equal(r.status, 'incomplete');
  assert.match(r.applicability, /explicit schedule/);
  assert.match(formatEstimate(r), /end_user_device \| 5 \| 4 \| 1.25/);
  const queries = seen.filter(s => s.path === '/api/now/stats/cmdb_ci').map(s => s.query);
  assert.ok(queries.some(q => q.includes('x_demo_server')));
  assert.ok(queries.includes('sys_class_nameINcmdb_ci_computer'));
  assert.ok(seen.every(s => s.method === 'GET'));
});

test('unknown SKU applicability and eligibility remain explicit with units withheld by default', async t => {
  const { sdk } = transport(t);
  const r = await estimateSubscription(sdk, 'ITOM');
  assert.match(r.applicability, /provisional/);
  assert.match(r.eligibility_assumption, /No eligibility assumed/);
  assert.ok(r.categories.every(c => c.illustrative_units === null));
  assert.equal(r.total_units, null);
});

for (const [label, options, expected] of [
  ['forbidden metadata', { denied: 'sys_db_object' }, 'forbidden'],
  ['missing metadata', { missing: 'sys_db_object' }, 'missing-or-hidden'],
  ['malformed metadata', { malformed: true }, 'malformed'],
  ['malformed aggregate', { badStats: 'cmdb_ci' }, 'malformed'],
  ['forbidden aggregate', { denied: 'cmdb_ci' }, 'forbidden'],
  ['missing field definition', { noDictionary: true }, 'schema_unavailable'],
]) test(`${label} never becomes zero population`, async t => {
  const { sdk } = transport(t, options);
  const r = await estimateSubscription(sdk, 'ITOM', { assumeEligible: true });
  assert.equal(r.categories[0].status, expected);
  assert.equal(r.categories[0].population, null);
  assert.equal(r.categories[0].illustrative_units, null);
  assert.equal(r.total_units, null);
});

test('provider completeness mismatch permits only disclosed partial mapped populations', async t => {
  const { sdk } = transport(t, { truncated: true });
  const r = await estimateSubscription(sdk, 'ITOM', { assumeEligible: true });
  assert.equal(r.coverage.metadata_status, 'partial');
  assert.equal(r.categories[0].status, 'partial-mapping');
  assert.equal(r.categories[0].population, 3);
  assert.equal(r.categories[0].illustrative_units, 3);
  assert.ok(r.categories.every(c => !c.mapping_complete));
  assert.equal(r.total_units, null);
});

test('short metadata page followed by more rows remains honestly partial', async t => {
  const { sdk, seen } = transport(t, { shortPage: true });
  const r = await estimateSubscription(sdk, 'ITOM');
  assert.equal(r.coverage.metadata_status, 'partial');
  assert.ok(r.coverage.visible_definitions > 2);
  assert.ok(r.coverage.visible_definitions < r.coverage.provider_count);
  assert.equal(r.coverage.provider_count_after, r.coverage.provider_count);
  assert.ok(seen.filter(s => s.path === '/api/now/table/sys_db_object').length > 1);
  assert.ok(r.categories.every(c => !c.mapping_complete));
});

for (const options of [
  { shortPage: true, duplicate: true }, { shortPage: true, empty: true },
  { unstable: true }, { unordered: true },
  { badId: 'missing' }, { badId: ' ' }, { badId: 42 }, { badId: 'root' },
]) test(`metadata cannot falsely complete: ${JSON.stringify(options)}`, async t => {
  const { sdk } = transport(t, options);
  const r = await estimateSubscription(sdk, 'ITOM', { assumeEligible: true });
  assert.notEqual(r.coverage.metadata_status, 'provider-count-matched');
  assert.ok(r.categories.every(c => !c.mapping_complete));
  assert.equal(r.total_units, null);
  assert.equal(r.authoritative, false);
});

test('missing resource class remains partial rather than silently complete', async t => {
  const { sdk } = transport(t, { omitClass: 'cmdb_ci_vm_instance' });
  const r = await estimateSubscription(sdk, 'ITOM');
  assert.equal(r.categories[0].status, 'partial-mapping');
  assert.deepEqual(r.categories[0].missing_classes, ['cmdb_ci_vm_instance']);
});

test('cross-category hierarchy ambiguity withholds both affected populations', async t => {
  const { sdk } = transport(t, { overlap: true });
  const r = await estimateSubscription(sdk, 'ITOM', { assumeEligible: true });
  for (const id of ['server', 'container']) {
    const c = r.categories.find(c => c.category === id);
    assert.equal(c.status, 'ambiguous-overlap');
    assert.equal(c.population, null);
    assert.equal(c.illustrative_units, null);
  }
});

test('missing ancestry is skipped, disclosed and never classified as complete', async t => {
  const { sdk } = transport(t, { missingAncestry: true });
  const r = await estimateSubscription(sdk, 'ITOM', { assumeEligible: true });
  assert.equal(r.coverage.skipped_ancestries, 1);
  assert.equal(r.categories[0].population, 2);
  assert.equal(r.categories[0].status, 'partial-mapping');
});

test('unsupported product and SKU refuse before transport with actionable schedule guidance', async () => {
  await assert.rejects(estimateSubscription(null, 'HRSD'), e => e.code === 'unsupported_product' && /schedules/.test(e.hint));
  await assert.rejects(estimateSubscription(null, 'ITOM', { schedule: 'unknown-sku' }), e => e.code === 'unsupported_schedule');
});

test('actual CLI registration, offline JSON and --get preserve schedule provenance', () => {
  const command = buildCLI([]).commandRegistry().commands.find(c => c.name === 'subscriptions');
  assert.deepEqual(command.actions.map(a => a.name), ['schedules', 'estimate']);
  const env = { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' };
  const entry = new URL('../bin/jsn.js', import.meta.url).pathname;
  const json = spawnSync(process.execPath, [entry, 'subscriptions', 'schedules', '--json'], { encoding: 'utf8', env, timeout: 15000 });
  assert.equal(json.status, 0, json.stderr);
  const data = JSON.parse(json.stdout).data;
  assert.equal(data.schedules[0].id, 'itom-2026-04-09');
  const get = spawnSync(process.execPath, [entry, 'subscriptions', 'schedules', '--get', 'data.schedules[0].id'], { encoding: 'utf8', env, timeout: 15000 });
  assert.equal(get.status, 0, get.stderr);
  assert.equal(JSON.parse(get.stdout), data.schedules[0].id);
});

test('real CLI estimate renders identical fractional values through JSON, --get and human output offline', () => {
  const script = `
    import { SDKClient } from ${JSON.stringify(new URL('../src/sdk.js', import.meta.url).href)};
    import { buildCLI } from ${JSON.stringify(new URL('../src/cli.js', import.meta.url).href)};
    SDKClient.prototype._setAuth = async () => {};
    const definitions = [
      {sys_id:'root',name:'cmdb_ci',super_class:''},
      {sys_id:'computer',name:'cmdb_ci_computer',super_class:'root'},
      {sys_id:'server',name:'cmdb_ci_server',super_class:'computer'}
    ];
    globalThis.fetch = async request => {
      if(request.method !== 'GET') throw Error('unexpected write');
      const url = new URL(request.url);
      if(url.hostname !== 'example.invalid') throw Error('unexpected destination');
      let body;
      if(url.pathname === '/api/now/table/sys_db_object') body={result:definitions};
      else if(url.pathname === '/api/now/table/sys_dictionary') body={result:[{name:'cmdb_ci',element:'sys_class_name',internal_type:'sys_class_name'}]};
      else if(url.pathname === '/api/now/stats/sys_db_object') body={result:{stats:{count:'3'}}};
      else if(url.pathname === '/api/now/stats/cmdb_ci') body={result:{stats:{count:url.searchParams.get('sysparm_query') === 'sys_class_nameINcmdb_ci_computer' ? '5' : '2'}}};
      else throw Error('unexpected endpoint');
      return new Response(JSON.stringify(body));
    };
    process.argv = ['node','jsn','subscriptions','estimate','ITOM','--instance','https://example.invalid','--assume-eligible', ...JSON.parse(process.env.SUBSCRIPTION_OUTPUT_ARGS)];
    await buildCLI().parse();
  `;
  const run = args => spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, SUBSCRIPTION_OUTPUT_ARGS: JSON.stringify(args), JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' },
  });
  const json = run(['--json']);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).data.categories[4].illustrative_units, 1.25);
  const get = run(['--get', 'data.categories[4].illustrative_units']);
  assert.equal(get.status, 0, get.stderr);
  assert.equal(JSON.parse(get.stdout), 1.25);
  const human = run(['--styled']);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /end_user_device \| 5 \| 4 \| 1.25/);
  assert.match(human.stdout, /INCOMPLETE/);
});

test('dated ITOM schedule preserves source applicability, ratios and unresolved literal', () => {
  const s = loadSchedule();
  assert.equal(s.effective_for_skus_introduced, '2026-04-09');
  assert.deepEqual(s.categories.map(c => c.resources_per_su), [1, 3, 10, 3, 4, 20, 1, 1, 3, 1, 4]);
  assert.ok(s.categories[1].classes.includes('cmdb_ci_could_database'));
  assert.match(s.source_url, /servicenow.com.*\.pdf$/);
});
