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
  listApplications, showApplication, operationStatus, waitForOperation, verifyInstalledVersion,
} from '../src/store.js';
import { buildCLI } from '../src/cli.js';
import { needsMutationContext } from '../src/mutation-context.js';
import { refreshMutationCommands } from '../src/mutations.js';

process.env.JSN_NO_PROMPTS = '1';

const APP = 'a'.repeat(32), TRACKER = 'b'.repeat(32), OTHER = 'c'.repeat(32);

const DETAIL = {
  sys_id: APP, name: 'Demo App', scope: 'x_demo_app', vendor: 'Example', source: 'store',
  is_store_app: 'true', isAppstorePlugin: 'false',
  isInstalled: 'false', version: '', latest_version: '2.0.0', latest_version_display: '2.0.0',
  versions: ['1.0.0', '2.0.0'], can_install_or_upgrade: 'true',
  can_install_or_upgrade_customization: 'true', needs_app_engine_licensing: 'false',
  price_type: 'free', isSubscriptionApplicable: 'false',
  compatibilities: { minimum_version: 'Washington' },
  dependencies: [{ name: 'Dependency App', version: '1.0.0' }],
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

test('list maps tabs to App Client contexts and projects stable fields', async () => {
  const f = fixture({ apps: [{ sys_id: APP, name: 'Demo App', scope: 'x_demo_app', vendor: 'Example', isInstalled: 'true', version: '1.0.0', latest_version: '2.0.0', isInstalledAndUpdateAvailable: 'true', can_install_or_upgrade: 'true', isAppstorePlugin: 'false' }] });
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
    sys_id: APP, name: 'Demo App', scope: 'x_demo_app', vendor: 'Example', source: '',
    version: '1.0.0', latest_version: '2.0.0', installed: true, update_available: true,
    installable: true, is_store_app: null, is_plugin: false, price_type: null,
    needs_app_engine_licensing: false, short_description: null,
  });
  assert.match(meta.summary, /1 Store application/);
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
  const { data } = f.output[0];
  assert.equal(data.matched_by, 'scope');
  assert.equal(data.installed.version, '1.0.0');
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

test('install requires an exact version, a not-installed app and an offered version before dispatch', async () => {
  const f = fixture();
  f.rows('sys_store_app').push({ sys_id: APP, name: 'Demo App', scope: 'x_demo_app', version: '', active: 'true' });
  await assert.rejects(f.run(['install', 'x_demo_app', '--force']), error => error.code === 'usage_error' && /--version/.test(error.message));
  await assert.rejects(f.run(['install', 'x_demo_app', '--version', '9.9.9', '--force']),
    error => error.code === 'store_version_unavailable' && /1\.0\.0, 2\.0\.0/.test(error.hint));
  assert.deepEqual(f.dispatches(), []);

  f.setDetail({ ...DETAIL, isInstalled: 'true', version: '1.0.0' });
  await assert.rejects(f.run(['install', 'x_demo_app', '--version', '2.0.0', '--force']),
    error => error.code === 'store_already_installed' && /store update/.test(error.hint));
  assert.deepEqual(f.dispatches(), []);
});

test('an application the Store client reports as not installable is refused with the reported flags', async () => {
  const f = fixture({ detail: { ...DETAIL, can_install_or_upgrade: 'false' } });
  f.rows('sys_store_app').push({ sys_id: APP, name: 'Demo App', scope: 'x_demo_app', version: '' });
  await assert.rejects(f.run(['install', 'x_demo_app', '--version', '2.0.0', '--force']),
    error => error.code === 'store_app_not_installable' && /entitlement/.test(error.hint));
  assert.deepEqual(f.dispatches(), []);
});

test('dry-run resolves the exact operation, sends nothing and needs no confirmation', async () => {
  const f = fixture();
  f.rows('sys_store_app').push({ sys_id: APP, name: 'Demo App', scope: 'x_demo_app', version: '' });
  await f.run(['install', 'x_demo_app', '--version', '2.0.0', '--dry-run', '--demo-data']);
  const { data } = f.output[0];
  assert.equal(data.dry_run, true);
  assert.equal(data.dispatched, false);
  assert.equal(data.requested_version, '2.0.0');
  assert.equal(data.demo_data, true);
  assert.equal(data.app.sys_id, APP);
  assert.deepEqual(f.dispatches(), []);
});

test('install without --force requires confirmation before dispatch', async () => {
  const f = fixture();
  f.rows('sys_store_app').push({ sys_id: APP, name: 'Demo App', scope: 'x_demo_app', version: '' });
  await assert.rejects(f.run(['install', 'x_demo_app', '--version', '2.0.0']),
    error => error.code === 'confirmation_required' && /--force/.test(error.hint));
  assert.deepEqual(f.dispatches(), []);
});

test('a submitted install reports the tracker and never claims completion', async () => {
  const f = fixture();
  f.rows('sys_store_app').push({ sys_id: APP, name: 'Demo App', scope: 'x_demo_app', version: '' });
  await f.run(['install', 'x_demo_app', '--version', '2.0.0', '--force', '--profile', 'pdi']);
  assert.equal(f.dispatches().length, 1);
  const url = new URL(f.dispatches()[0].url);
  assert.equal(url.pathname, '/api/sn_appclient/appmanager/app/install');
  assert.equal(url.searchParams.get('app_id'), APP);
  assert.equal(url.searchParams.get('version'), '2.0.0');
  assert.equal(url.searchParams.get('load_demo_data'), 'false');
  const { data, meta } = f.output[0];
  assert.equal(data.tracker_id, TRACKER);
  assert.equal(data.succeeded, null);
  assert.equal(data.verification, null);
  assert.match(meta.summary, /submitted: tracker .* not a completed installation/);
  assert.ok(meta.breadcrumbs.every(b => b.cmd.endsWith('--profile pdi')));
});

test('a submission without a tracker id is an error and is not retried', async () => {
  const f = fixture({ dispatchResult: { result: { message: 'accepted' } } });
  f.rows('sys_store_app').push({ sys_id: APP, name: 'Demo App', scope: 'x_demo_app', version: '' });
  await assert.rejects(f.run(['install', 'x_demo_app', '--version', '2.0.0', '--force']),
    error => error.code === 'store_tracker_missing' && /do not resubmit/i.test(error.hint));
  assert.equal(f.dispatches().length, 1);
});

test('waiting polls the tracker and verifies the version on the installed record', async () => {
  const f = fixture({
    progress: [
      { percent_complete: 20, status: '1', status_label: 'Running' },
      { percent_complete: 100, status: '2', status_label: 'Complete', status_message: 'Installed' },
    ],
    onDispatch: () => { f.rows('sys_store_app')[0].version = '2.0.0'; },
  });
  f.rows('sys_store_app').push({ sys_id: APP, name: 'Demo App', scope: 'x_demo_app', version: '', active: 'true' });
  await f.run(['install', 'x_demo_app', '--version', '2.0.0', '--force', '--wait', '--timeout', '30', '--poll-interval', '0']);
  const { data, meta } = f.output[0];
  assert.equal(data.succeeded, true);
  assert.deepEqual(data.verification, {
    verified: true, expected_version: '2.0.0', installed_version: '2.0.0',
    active: true, source: 'sys_store_app', reason: 'version_confirmed',
  });
  assert.match(meta.summary, /verified on sys_store_app/);
  assert.equal(f.requests.filter(r => r.url.includes('/sn_cicd/progress/')).length, 2);
});

test('a tracker success without the reported version is a verification failure', async () => {
  const f = fixture({ progress: [{ percent_complete: 100, status: '2', status_label: 'Complete' }] });
  f.rows('sys_store_app').push({ sys_id: APP, name: 'Demo App', scope: 'x_demo_app', version: '' });
  await assert.rejects(f.run(['install', 'x_demo_app', '--version', '2.0.0', '--force', '--wait', '--timeout', '30', '--poll-interval', '0']),
    error => error.code === 'store_verification_failed' && error.message.includes(TRACKER) && /reads back version/.test(error.message));
  assert.equal(f.requests.filter(r => r.url.includes('/app/install')).length, 1);
});

test('a failed tracker reports the failure and keeps the tracker id', async () => {
  const f = fixture({ progress: [{ percent_complete: 100, status: '3', status_label: 'Failed', status_message: 'Install failed' }] });
  f.rows('sys_store_app').push({ sys_id: APP, name: 'Demo App', scope: 'x_demo_app', version: '' });
  await assert.rejects(f.run(['install', 'x_demo_app', '--version', '2.0.0', '--force', '--wait', '--timeout', '30', '--poll-interval', '0']),
    error => error.code === 'store_operation_failed' && error.message.includes(TRACKER) && error.hint.includes(TRACKER));
});

test('an unreadable installed record yields unverified, not success', async () => {
  const f = fixture();
  f.rows('sys_store_app').push({ sys_id: APP, name: 'Demo App', scope: 'x_demo_app', version: '' });
  const get = f.sdk.get;
  f.sdk.get = async (table, id) => { if (table === 'sys_store_app') throw Object.assign(new Error('denied'), { status: 403 }); return get(table, id); };
  const verification = await verifyInstalledVersion(f.sdk, { sys_id: APP }, '2.0.0', { attempts: 2, intervalMs: 0 });
  assert.equal(verification.verified, null);
  assert.equal(verification.reason, 'readback_unavailable');
});

test('an expired wait retains the tracker and does not cancel or resubmit', async () => {
  const f = fixture({ progress: [{ percent_complete: 40, status: '1', status_label: 'Running' }] });
  let clock = 0;
  const result = await waitForOperation(f.sdk, TRACKER, {
    timeoutMs: 1000, pollIntervalMs: 500, now: () => clock, wait: async ms => { clock += Math.max(ms, 1000); },
  });
  assert.equal(result.wait_timed_out, true);
  assert.equal(result.tracker_id, TRACKER);
  assert.equal(f.requests.filter(r => r.url.includes('/app/install')).length, 0);
});

test('update defaults to the reported latest version, refuses no-ops and dispatches the update endpoint', async () => {
  const f = fixture();
  f.rows('sys_store_app').push({ sys_id: APP, name: 'Demo App', scope: 'x_demo_app', version: '1.0.0', active: 'true', install_date: '2025-01-02 03:04:05' });
  f.setDetail({ ...DETAIL, isInstalled: 'true', version: '1.0.0' });
  await assert.rejects(f.run(['update', 'x_demo_app', '--version', '1.0.0', '--force']),
    error => error.code === 'store_version_unchanged');
  assert.deepEqual(f.dispatches(), []);
  await f.run(['update', 'x_demo_app', '--force']);
  const url = new URL(f.dispatches()[0].url);
  assert.equal(url.pathname, '/api/sn_appclient/appmanager/app/update');
  assert.equal(url.searchParams.get('version'), '2.0.0');
  assert.equal(url.searchParams.has('load_demo_data'), false);
  assert.equal(f.output[0].data.from_version, '1.0.0');
  assert.equal(f.output[0].data.requested_version, '2.0.0');
});

test('update refuses applications that are not installed', async () => {
  const f = fixture();
  f.rows('sys_store_app').push({ sys_id: APP, name: 'Demo App', scope: 'x_demo_app', version: '' });
  await assert.rejects(f.run(['update', 'x_demo_app', '--version', '2.0.0', '--force']),
    error => error.code === 'store_not_installed' && /store install/.test(error.hint));
  assert.deepEqual(f.dispatches(), []);
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

test('store is discoverable with lifecycle verbs and read-only profiles block only the mutations', () => {
  const registry = buildCLI([]).commandRegistry();
  const command = registry.commands.find(entry => entry.name === 'store');
  assert.deepEqual(command.actions.map(action => action.name), ['list', 'search', 'show', 'status', 'install', 'update']);
  assert.ok(refreshMutationCommands().some(path => path.join(' ') === 'store install'));
  assert.ok(refreshMutationCommands().some(path => path.join(' ') === 'store update'));
  // Store installs are runtime App Client requests, not captured metadata edits.
  assert.equal(needsMutationContext({ _: ['store', 'install', APP] }), false);
  assert.equal(needsMutationContext({ _: ['store', 'list'] }), false);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-store-ro-'));
  fs.mkdirSync(path.join(home, 'servicenow'));
  fs.writeFileSync(path.join(home, 'servicenow', 'config.json'), JSON.stringify({ default_profile: 'ro', profiles: {
    ro: { instance_url: 'https://example.invalid', auth_method: 'oauth', read_only: true },
  } }));
  try {
    const env = { ...process.env, XDG_CONFIG_HOME: home, JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1', JSN_DATA_HOME: path.join(home, 'data'), JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' };
    for (const args of [['install', APP, '--version', '2.0.0'], ['update', APP, '--version', '2.0.0']]) {
      const result = spawnSync(process.execPath, ['bin/jsn.js', 'store', ...args, '--profile', 'ro', '--json'], { encoding: 'utf8', env, timeout: 15000 });
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /read.only/i);
    }
    const help = spawnSync(process.execPath, ['bin/jsn.js', 'store', '--help'], { encoding: 'utf8', env });
    assert.ifError(help.error);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /install/);
    assert.match(help.stdout, /status/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
