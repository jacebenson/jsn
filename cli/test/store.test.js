import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import yargs from '../src/cli-adapter.js';
import { storeCmd } from '../src/commands/store.js';
import { SDKClient } from '../src/sdk.js';
import {
  listApplications, showApplication, operationStatus,
} from '../src/store.js';
import { buildCLI } from '../src/cli.js';
import { errNotFoundHint, renderAppError } from '../src/errors.js';
import { needsMutationContext } from '../src/mutation-context.js';
import { refreshMutationCommands } from '../src/mutations.js';

process.env.JSN_NO_PROMPTS = '1';

const APP = 'a'.repeat(32), TRACKER = 'b'.repeat(32), OTHER = 'c'.repeat(32);

const DETAIL = {
  sys_id: APP, name: 'Demo App', scope: 'x_demo_app', vendor: 'Example', source: 'store',
  is_store_app: 'true', isAppstorePlugin: 'false',
  isInstalled: 'false', version: '', latest_version: '2.0.0', latest_version_display: '2.0.0',
  install_date: 'Jun 12, 2026', update_date: 'Oct 14, 2026', indicators: [],
  versions: ['1.0.0', '2.0.0'], can_install_or_upgrade: 'true',
  can_install_or_upgrade_customization: 'true', needs_app_engine_licensing: 'false',
  price_type: 'free', isSubscriptionApplicable: 'false',
  compatibilities: { minimum_version: 'Washington' },
  dependencies: [{ name: 'Dependency App', version: '1.0.0' }],
};

// Payload shapes below are copied from a live instance (dev366743) so the
// fixtures cannot drift into a shape the endpoint never returns.
const LIST_INSTALLED = {
  sys_id: APP, customization: null, name: 'sn-app-analytics-center', logo: '', vendor: null,
  short_description: 'App Analytics Center', scope: 'sn_analytics_cen', latest_version: '8.4.5',
  products: '[]', indicators: '[]', lob: '[]', ir_query_score: null, version: '8.4.1',
  assigned_version: '8.4.1', update_available: '1', apps_in_jumbo: null, contains_plugins: '0',
  optional_apps_available: null,
};
const LIST_AVAILABLE = {
  sys_id: OTHER, customization: null, name: 'Skill Kit - Prompt Optimizer for Creator Tools', logo: '',
  vendor: 'Work4Flow', short_description: 'Leveraging Agentic AI to refine your prompts', scope: 'x_w4f_sk_prompt_op',
  latest_version: '1.0.2', products: '[]',
  indicators: '[{"id":"not_available_for_instance_type","order":1,"message":"Unavailable for Instance","tooltip":"This application is unavailable on developer instances","type":"error","show_as_filter":true}]',
  lob: '[]', ir_query_score: null, version: null, assigned_version: null, update_available: null,
  apps_in_jumbo: null, contains_plugins: '0', optional_apps_available: '0',
};

function tableFilter(rows, params) {
  const query = params?.sysparm_query || '';
  const limit = Number(params?.sysparm_limit || 50);
  const offset = Number(params?.sysparm_offset || 0);
  return rows.filter(row => query.split('^').filter(Boolean).every(clause => {
    if (clause.startsWith('ORDERBY')) return true;
    const at = clause.indexOf('=');
    if (at < 0) return true;
    return String(row[clause.slice(0, at)] ?? '') === clause.slice(at + 1);
  })).slice(offset, offset + limit);
}

function fixture(options = {}) {
  const tables = new Map();
  const requests = [];
  const output = [];
  let apps = options.apps ?? [];
  let detail = options.detail === undefined ? DETAIL : options.detail;
  let detailStatus = options.detailStatus ?? null;
  let dispatchResult = options.dispatchResult ?? { result: { tracker_id: TRACKER } };
  const progress = [...(options.progress ?? [{ percent_complete: 100, status: '2', status_label: 'Complete', status_message: 'Done' }])];
  const rows = table => { if (!tables.has(table)) tables.set(table, []); return tables.get(table); };
  const sdk = {
    baseURL: 'https://example.invalid',
    get: async (table, id) => rows(table).find(row => row.sys_id === id) || null,
    list: async (table, params) => tableFilter(rows(table), params),
    listStrict: async (table, params) => tableFilter(rows(table), params),
    request: async (url, opts = {}) => {
      requests.push({ url, method: opts.method, body: opts.body });
      const parsed = new URL(url);
      if (parsed.pathname === '/api/sn_appclient/appmanager/apps') return { result: { apps } };
      if (parsed.pathname === '/api/sn_appclient/appmanager/app/install'
        || parsed.pathname === '/api/sn_appclient/appmanager/app/update') {
        options.onDispatch?.(parsed);
        if (options.dispatchError) throw options.dispatchError;
        return dispatchResult;
      }
      if (parsed.pathname.startsWith('/api/sn_appclient/appmanager/app/')) {
        if (detailStatus) throw Object.assign(new Error('denied'), { status: detailStatus });
        return { result: detail ? { app_info_on_instance: detail } : {} };
      }
      if (parsed.pathname.startsWith('/api/sn_cicd/progress/')) {
        return { result: progress.length > 1 ? progress.shift() : progress[0] };
      }
      throw new Error(`Unexpected request ${url}`);
    },
  };
  const app = { sdk, config: { profiles: {} }, ok: (data, meta) => output.push({ data, meta }) };
  const run = args => yargs(['store', ...args])
    .option('profile', { type: 'string' }).option('instance', { type: 'string' }).option('force', { type: 'boolean' })
    .command(storeCmd(fn => argv => fn(argv, app))).parse();
  const dispatches = () => requests.filter(request => /\/app\/(install|update)$/.test(new URL(request.url).pathname));
  return {
    sdk, rows, requests, dispatches, output, run,
    setApps: next => { apps = next; }, setDetail: next => { detail = next; }, setDetailStatus: next => { detailStatus = next; },
  };
}

test('list reads installed and update state from the payload the endpoint actually returns', async () => {
  const f = fixture({ apps: [LIST_INSTALLED] });
  await f.run(['list', '--tab', 'updates', '--limit', '5', '--offset', '10']);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].method, 'POST');
  assert.equal(f.requests[0].body, '{}');
  const params = new URL(f.requests[0].url).searchParams;
  assert.equal(params.get('tab_context'), 'updates');
  assert.equal(params.get('sysparm_limit'), '5');
  assert.equal(params.get('sysparm_offset'), '10');
  assert.equal(params.has('search_key'), false);
  const { data, meta } = f.output[0];
  assert.equal(data.count, 1);
  assert.equal(data.page_full, false);
  assert.deepEqual(data.apps[0], {
    sys_id: APP, name: 'sn-app-analytics-center', scope: 'sn_analytics_cen', vendor: '', source: '',
    version: '8.4.1', latest_version: '8.4.5', installed: true, update_available: true,
    installable: null, is_store_app: null, is_plugin: null, price_type: null,
    needs_app_engine_licensing: null, blocked: false, indicators: [],
    short_description: 'App Analytics Center',
  });
  assert.match(meta.summary, /1 Store application/);
});

test('an available application reports not installed, and its block reason is surfaced', async () => {
  const f = fixture({ apps: [LIST_AVAILABLE] });
  await f.run(['list', '--tab', 'available']);
  const row = f.output[0].data.apps[0];
  assert.equal(row.version, null);
  assert.equal(row.installed, false);
  assert.equal(row.update_available, false);
  assert.equal(row.blocked, true);
  assert.deepEqual(row.indicators, [{
    id: 'not_available_for_instance_type', type: 'error',
    message: 'Unavailable for Instance', tooltip: 'This application is unavailable on developer instances',
  }]);
});

test('the human view renders the applications themselves, not only a count', async () => {
  // Styled output printed the summary and nothing else: the generic renderer
  // only knows `data.records`, so a store payload rendered as an empty block.
  const f = fixture({ apps: [LIST_INSTALLED] });
  await f.run(['list', '--tab', 'installed']);
  const { data } = f.output[0];
  assert.match(data._formatted, /sn_analytics_cen/);
  assert.match(data._formatted, /8\.4\.1/);
  assert.match(data._formatted, /installed, update/);
  // The curated view is a side channel: it must not leak into the JSON payload.
  assert.equal(Object.keys(data).includes('_formatted'), false);
  assert.equal(JSON.stringify(data).includes('NAME'), false);
});

test('the human view of one application shows its version, versions and entitlement', async () => {
  const f = fixture();
  f.rows('sys_store_app').push({ sys_id: APP, name: 'Demo App', scope: 'x_demo_app', version: '1.0.0', active: 'true', install_date: '2025-01-02 03:04:05' });
  f.setDetail({ ...DETAIL, isInstalled: 'true', version: '1.0.0', isInstalledAndUpdateAvailable: 'true' });
  await f.run(['show', 'x_demo_app']);
  const { data } = f.output[0];
  assert.match(data._formatted, /installed 1\.0\.0/);
  assert.match(data._formatted, /versions {5}1\.0\.0, 2\.0\.0/);
  assert.match(data._formatted, /price {8}free/);
});

test('an application identifier is not the App context the CLI attaches to argv', async () => {
  // cli.js installs `(argv) => { argv.app = app }` as a middleware for every
  // command, so a positional named `app` arrives at the handler as the context
  // object. That made `store show/install/update` fail with
  // "store application not found: [object Object]" on every live invocation.
  const f = fixture();
  f.rows('sys_store_app').push({ sys_id: APP, name: 'Demo App', scope: 'x_demo_app', version: '1.0.0', active: 'true', install_date: '2025-01-02 03:04:05' });
  const context = { sdk: f.sdk, config: { profiles: {} }, ok: (data, meta) => f.output.push({ data, meta }) };
  await yargs(['store', 'show', 'x_demo_app'])
    .middleware([argv => { argv.app = context; }])
    .option('profile', { type: 'string' }).option('force', { type: 'boolean' })
    .command(storeCmd(fn => argv => fn(argv, context))).parse();
  assert.equal(f.output.length, 1);
  assert.equal(f.output[0].data.sys_id, APP);
  assert.equal(f.output[0].data.matched_by, 'scope');
});

test('a not_found refusal renders the command-specific hint, not the generic identifier line', () => {
  // The renderer used to drop err.hint for not_found and interpolate the
  // subcommand name instead, so `jsn store show <missing>` told the operator
  // that "show" was not found.
  const rendered = renderAppError(
    errNotFoundHint('store application', 'x_missing', 'Search the Store for it: jsn store search "x_missing".'),
    { identifier: 'show' },
  );
  assert.equal(rendered.exitCode, 1);
  assert.match(rendered.text, /jsn store search "x_missing"/);
  assert.doesNotMatch(rendered.text, /The identifier "show" was not found/);
});

test('search sends the term and refuses missing terms, bad paging and unknown tabs before transport', async () => {
  const f = fixture({ apps: [] });
  await f.run(['search', 'ITSM']);
  assert.equal(new URL(f.requests[0].url).searchParams.get('search_key'), 'ITSM');
  assert.equal(new URL(f.requests[0].url).searchParams.get('tab_context'), 'available_for_you');
  for (const args of [['search', '  '], ['list', '--tab', 'bogus'], ['list', '--limit', '0'],
    ['list', '--limit', '201'], ['list', '--offset', '-1']]) {
    const before = f.requests.length;
    await assert.rejects(f.run(args));
    assert.equal(f.requests.length, before);
  }
});

test('a malformed app list stays unavailable instead of looking empty', async () => {
  const f = fixture();
  f.sdk.request = async () => ({ result: {} });
  await assert.rejects(listApplications(f.sdk, {}), error => error.code === 'store_response_malformed');
});

test('show reports installed version, available versions, entitlement, dependencies and compatibility', async () => {
  const f = fixture();
  f.rows('sys_store_app').push({ sys_id: APP, name: 'Demo App', scope: 'x_demo_app', version: '1.0.0', active: 'true', install_date: '2025-01-02 03:04:05' });
  f.setDetail({ ...DETAIL, isInstalled: 'true', version: '1.0.0', isInstalledAndUpdateAvailable: 'true' });
  await f.run(['show', 'x_demo_app']);
  const { data, meta } = f.output[0];
  // Nothing may advertise a command that is not registered: the lifecycle verbs
  // are gone, so a leftover breadcrumb would send the operator to an error.
  for (const crumb of meta.breadcrumbs) assert.doesNotMatch(crumb.cmd, /^jsn store (install|update)/);
  assert.equal(data.matched_by, 'scope');
  assert.equal(data.installed.version, '1.0.0');
  // The App Client detail reports its own dates; they are not left to a
  // second table read that may not happen.
  assert.equal(data.installed.install_date, 'Jun 12, 2026');
  assert.equal(data.installed.update_date, 'Oct 14, 2026');
  assert.equal(data.blocked, false);
  assert.equal(data.available.latest_version, '2.0.0');
  assert.equal(data.available.update_available, true);
  assert.deepEqual(data.available.versions, ['1.0.0', '2.0.0']);
  assert.equal(data.entitlement.can_install_or_upgrade, true);
  assert.deepEqual(data.dependencies, DETAIL.dependencies);
  assert.deepEqual(data.available.compatibilities, DETAIL.compatibilities);
  assert.equal(data.detail_unavailable, null);
  assert.ok(data.notes.some(note => /does not infer purchase authorization/.test(note)));
});

test('show reports detail unavailability explicitly and still returns the installed row', async () => {
  const f = fixture({ detailStatus: 403 });
  f.rows('sys_store_app').push({ sys_id: APP, name: 'Demo App', scope: 'x_demo_app', version: '1.0.0', active: 'true', install_date: '2025-01-02 03:04:05' });
  await f.run(['show', APP]);
  const { data } = f.output[0];
  assert.equal(data.detail_unavailable, 'forbidden');
  assert.equal(data.installed.version, '1.0.0');
  assert.equal(data.available, null);
  assert.equal(data.entitlement, null);
  assert.ok(data.notes.some(note => /detail is unavailable/.test(note)));
});

test('unknown, ambiguous and company applications are refused with actionable errors', async () => {
  const f = fixture({ apps: [] });
  await assert.rejects(f.run(['show', 'x_missing']), error => error.code === 'not_found' && /store search/.test(error.hint));
  f.rows('sys_store_app').push({ sys_id: APP, name: 'Dup', scope: 'x_dup' }, { sys_id: OTHER, name: 'Dup', scope: 'x_dup' });
  await assert.rejects(f.run(['show', 'x_dup']), error => error.code === 'ambiguous');
  const g = fixture({ apps: [] });
  g.rows('sys_app').push({ sys_id: OTHER, name: 'Company App', scope: 'x_company' });
  await assert.rejects(g.run(['show', 'x_company']), error => error.code === 'store_not_store_app' && /company\/application-repository/.test(error.hint));
});

test('names found only through Store search resolve to the reported sys_id', async () => {
  const f = fixture({ apps: [{ sys_id: APP, name: 'Demo App', scope: 'x_demo_app' }] });
  await f.run(['show', 'Demo App']);
  assert.equal(f.output[0].data.sys_id, APP);
  assert.equal(f.output[0].data.matched_by, 'store_search');
});

test('status normalizes progress and rejects invalid tracker ids before any request', async () => {
  const f = fixture({ progress: [{ percent_complete: 45, status: '1', status_label: 'Running', status_message: 'Installing' }] });
  await f.run(['status', TRACKER]);
  assert.equal(new URL(f.requests[0].url).pathname, `/api/sn_cicd/progress/${TRACKER}`);
  assert.equal(f.output[0].data.percent_complete, 45);
  assert.equal(f.output[0].data.terminal, false);
  assert.equal(f.output[0].data.succeeded, false);
  const before = f.requests.length;
  await assert.rejects(f.run(['status', 'not-a-tracker']), /32-character/);
  assert.equal(f.requests.length, before);

  const failed = fixture({ progress: [{ percent_complete: 100, status: '3', status_label: 'Failed', status_message: 'boom' }] });
  const status = await operationStatus(failed.sdk, TRACKER);
  assert.equal(status.terminal, true);
  assert.equal(status.succeeded, false);
});












test('a failed tracker puts the reason in the summary, not the generic label', async () => {
  const f = fixture({
    progress: [{
      percent_complete: 100, status: '3', status_label: 'Failed',
      status_message: 'Unable to download app package',
    }],
  });
  await f.run(['status', TRACKER]);
  const { meta, data } = f.output[0];
  assert.match(meta.summary, /Unable to download app package/);
  assert.equal(data.succeeded, false);
  assert.equal(data.terminal, true);
});

test('the human view of a tracker reports the reason and the operation detail', async () => {
  const f = fixture({
    progress: [{
      percent_complete: 100, status: '3', status_label: 'Failed',
      status_message: 'Unable to download app package',
      status_detail: 'operation=app_install, baseVersion=2.0.0',
    }],
  });
  await f.run(['status', TRACKER]);
  const { data } = f.output[0];
  assert.match(data._formatted, /Unable to download app package/);
  assert.match(data._formatted, /operation=app_install, baseVersion=2\.0\.0/);
  assert.match(data._formatted, /progress {3}100%/);
});





test('the production transport builds App Client requests and maps HTTP failures', async (t) => {
  const sdk = new SDKClient('https://example.invalid', {});
  const seen = [];
  sdk._setAuth = async request => { request.headers.set('Authorization', 'fixture'); };
  t.mock.method(globalThis, 'fetch', async request => {
    seen.push(request);
    const url = new URL(request.url);
    if (url.pathname === '/api/sn_appclient/appmanager/apps') {
      return new Response(JSON.stringify({ result: { apps: [{ sys_id: APP, name: 'Demo App', scope: 'x_demo_app' }] } }), { status: 200 });
    }
    if (url.pathname.startsWith('/api/now/table/sys_store_app')) {
      return new Response(JSON.stringify({ result: [{ sys_id: APP, name: 'Demo App', scope: 'x_demo_app', version: '1.0.0', active: 'true', install_date: '2025-01-02 03:04:05' }] }), { status: 200 });
    }
    if (url.pathname.startsWith('/api/sn_appclient/appmanager/app/')) return new Response('denied', { status: 403 });
    if (url.pathname.startsWith('/api/sn_cicd/progress/')) {
      return new Response(JSON.stringify({ result: { percent_complete: 100, status: '3', status_label: 'Failed', status_message: 'boom' } }), { status: 200 });
    }
    throw new Error(`Unexpected request ${request.url}`);
  });

  const page = await listApplications(sdk, { tab: 'installed', limit: 3, offset: 6 });
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].headers.get('Accept'), 'application/json');
  assert.equal(seen[0].headers.get('Content-Type'), 'application/json');
  assert.equal(seen[0].headers.get('Authorization'), 'fixture');
  assert.equal(page.apps[0].sys_id, APP);
  assert.equal(new URL(seen[0].url).searchParams.get('tab_context'), 'installed');

  const shown = await showApplication(sdk, 'x_demo_app');
  assert.equal(shown.detail_unavailable, 'forbidden');
  assert.equal(shown.installed.version, '1.0.0');
  assert.equal(seen[2].headers.get('Accept'), 'application/json');

  const status = await operationStatus(sdk, TRACKER);
  assert.equal(status.terminal, true);
  assert.equal(status.succeeded, false);
});

test('store exposes only the read-only surface and registers no mutations', () => {
  const registry = buildCLI([]).commandRegistry();
  const command = registry.commands.find(entry => entry.name === 'store');
  assert.deepEqual(command.actions.map(action => action.name), ['list', 'search', 'show', 'status']);
  // The lifecycle verbs were prototyped, dispatched, and never completed on a
  // real instance (its store credential 403s). They are deliberately absent, so
  // nothing unverified can be invoked.
  assert.equal(refreshMutationCommands().some(path => path.join(' ') === 'store install'), false);
  assert.equal(refreshMutationCommands().some(path => path.join(' ') === 'store update'), false);
  assert.equal(needsMutationContext({ _: ['store', 'list'] }), false);
  assert.equal(needsMutationContext({ _: ['store', 'show', APP] }), false);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-store-ro-'));
  fs.mkdirSync(path.join(home, 'servicenow'));
  fs.writeFileSync(path.join(home, 'servicenow', 'config.json'), JSON.stringify({ default_profile: 'ro', profiles: {
    ro: { instance_url: 'https://example.invalid', auth_method: 'oauth', read_only: true },
  } }));
  try {
    const env = { ...process.env, XDG_CONFIG_HOME: home, JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1', JSN_DATA_HOME: path.join(home, 'data'), JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' };
    const help = spawnSync(process.execPath, ['bin/jsn.js', 'store', '--help'], { encoding: 'utf8', env });
    assert.ifError(help.error);
    assert.equal(help.status, 0);
    for (const verb of ['list', 'search', 'show', 'status']) assert.match(help.stdout, new RegExp(verb));
    for (const verb of ['install', 'update']) assert.doesNotMatch(help.stdout, new RegExp(`^\\s+${verb} `, 'm'));
    const removed = spawnSync(process.execPath, ['bin/jsn.js', 'store', 'install', APP, '--profile', 'ro', '--json'], { encoding: 'utf8', env, timeout: 15000 });
    assert.notEqual(removed.status, 0);
    assert.match(removed.stdout + removed.stderr, /Unknown command/i);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
