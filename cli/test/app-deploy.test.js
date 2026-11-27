// `jsn app deploy` — the package backend's install path (#399).
//
// The instance contract under test: the exact query string and multipart fields
// the platform's app upload processor accepts, a redirect and an HTML body are
// hard failures (never "install started"), the install tracker's own verdict
// decides, and a deploy is only reported after the application row and every
// packaged record have been read back and compared with what was uploaded.
//
// Every case injects a fake transport at the SDK seam the rest of the suite
// uses: a real SDKClient whose session warm-up, rawRequest and list are
// replaced. Nothing here resolves a hostname or opens a socket, and no test
// signs in to anything.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { yargs } from '../src/cli-adapter.js';
import { appCmd } from '../src/commands/app.js';
import { readAppProject } from '../src/app-project.js';
import { extractRecordSource, recordSymbolName } from '../src/app-record-js.js';
import {
  buildPackageZip, recordVerificationFields, scopeVerificationFields,
  buildRecordXml, buildScopeXml,
} from '../src/app-build-package.js';
import {
  deployAppPackage, executionTrackerFrom, isRedirectFailure, uploadForm, uploadQueryParams,
} from '../src/app-deploy.js';
import { SDKClient } from '../src/sdk.js';
import { writeAppProject, happyProjectSpec, cliEnv, SYS_ID_A, SYS_ID_B, APP_SYS_ID, TRICKY_SCRIPT } from './support/app-project-fixtures.js';

const CLI = path.resolve('bin/jsn.js');
const SCOPE = 'x_1_demo';
const INSTANCE = 'https://dev00000.service-now.com';
const TRACKER = 'trk1234567890';

// The shared fixture app.yaml has no `app.version` and an update-set backend.
const PACKAGE_APP_YAML = [
  'version: 1',
  'app:',
  '  name: Demo App',
  '  scope: x_1_demo',
  `  sys_id: ${APP_SYS_ID}`,
  '  version: 1.2.3',
  'backend: package',
  '',
].join('\n');

const FORM_HTML = '<html><form action="/sys_upload.do" method="post">'
  + '<input name="sysparm_ck" type="hidden" value="tok-abc">'
  + '<input type="file" name="attachFile"></form></html>';

function projectFor(t, overrides = {}) {
  const root = writeAppProject(t, happyProjectSpec({ appYaml: PACKAGE_APP_YAML, ...overrides }));
  return readAppProject(root);
}

/** A record row as the Table API returns it with display_value=false. */
function rowFromFields(fields) {
  return Object.fromEntries(fields.map(field => [field.name, field.value]));
}

/**
 * The fake transport.
 *
 * `instance` describes what the instance holds after the install; `behaviour`
 * controls the upload/tracker responses. Every request is captured in `calls`
 * as { method, url, headers, form } so the contract can be asserted exactly.
 */
function fakeTransport({
  upload = { body: JSON.stringify({ executionTracker: TRACKER }) },
  progress = [{ result: { status: '2', successful: true, percent_complete: 100 } }],
  scopeExists = false,
  instance = null,
  scopeHTML = FORM_HTML,
} = {}) {
  const calls = [];
  const queue = [...progress];
  const sdk = new SDKClient(INSTANCE, null);
  sdk._warmSession = async () => 'JSESSIONID=session-cookie';

  sdk.rawRequest = async (url, opts = {}) => {
    const call = {
      method: opts.method || 'GET',
      url,
      headers: opts.headers || {},
      form: opts.body instanceof FormData ? opts.body : null,
    };
    calls.push(call);
    if (call.method === 'GET') return scopeHTML;
    if (upload instanceof Error) throw upload;
    if (upload.redirect === true) {
      // Exactly what the SDK transport produces for a 3xx: fetch is called with
      // redirect:'error', so undici rejects with a TypeError whose cause says
      // "unexpected redirect" and no status is available.
      const error = new TypeError('fetch failed');
      error.cause = new Error('unexpected redirect');
      throw error;
    }
    return upload.body;
  };

  sdk.request = async () => {
    if (!queue.length) throw new Error('tracker polled after it was terminal');
    return queue.shift();
  };

  sdk.list = async (table, params) => {
    calls.push({ method: 'READ', table, query: params?.get('sysparm_query'), fields: params?.get('sysparm_fields') });
    if (table === 'sys_scope') {
      return scopeExists ? [{ sys_id: APP_SYS_ID }] : [];
    }
    if (!instance) return [];
    const query = String(params?.get('sysparm_query') || '');
    if (table === 'sys_app') {
      if (!('sys_app' in instance)) return [];
      return [instance.sys_app];
    }
    const match = query.match(/^sys_id=([0-9a-f]{32})$/);
    const found = instance.records?.[`${table}/${match?.[1]}`];
    return found ? [found] : [];
  };
  return { sdk, calls };
}

/** What the instance holds when the install went exactly as uploaded. */
function installedInstance(project, { patchScope = {}, patchRecord = {} } = {}) {
  const app = project.app;
  const records = {};
  for (const record of project.records) {
    records[`${record.table}/${record.sys_id}`] = {
      ...rowFromFields(recordVerificationFields(record, app)),
      ...(patchRecord[record.sys_id] || {}),
    };
  }
  return {
    sys_app: { ...rowFromFields(scopeVerificationFields(project)), ...patchScope },
    records,
  };
}

async function deploy(project, transport, options = {}) {
  return deployAppPackage({
    sdk: transport.sdk,
    project,
    demoData: options.demoData === true,
    options: { tracker: { wait: async () => {}, ...(options.tracker || {}) }, ...(options.options || {}) },
  });
}

// ── the wire contract ───────────────────────────────────────────────────

test('upload query params and form fields match the connector exactly', () => {
  const app = { scope: SCOPE, sys_id: APP_SYS_ID, version: '1.2.3' };
  const params = uploadQueryParams({ app, registerScope: true });
  assert.deepEqual([...params], [
    ['sysparm_track_fluent_install', 'true'],
    ['sysparm_async_fluent_install', 'true'],
    ['sysparm_request_type', 'custom_app'],
    ['sysparm_fluent_scope_id', APP_SYS_ID],
    ['sysparm_fluent_scope_name', SCOPE],
    ['sysparm_fluent_app_version', '1.2.3'],
    ['sysparm_register_scope', 'true'],
  ]);
  // An existing scope is never registered a second time.
  assert.equal(uploadQueryParams({ app, registerScope: false }).has('sysparm_register_scope'), false);

  const zip = Buffer.from('PK-not-really');
  const form = uploadForm({ app, zip, csrf: 'tok-abc', demoData: false });
  assert.deepEqual([...form.keys()], ['upload_type', 'load_demo', 'sysparm_ck', 'attachFile']);
  assert.equal(form.get('upload_type'), 'file');
  assert.equal(form.get('load_demo'), 'false');
  assert.equal(form.get('sysparm_ck'), 'tok-abc');
  assert.equal(form.get('attachFile').name, `${SCOPE}_1.2.3.zip`);
  assert.equal(uploadForm({ app, zip, csrf: 't', demoData: true }).get('load_demo'), 'true');
});

test('deploy sends the processor request with the zip, the session and the CSRF token', async t => {
  const project = projectFor(t);
  const transport = fakeTransport({ instance: installedInstance(project) });
  const report = await deploy(project, transport);

  assert.equal(report.uploaded, true);
  const page = transport.calls.find(call => call.method === 'GET');
  assert.equal(page.url, `${INSTANCE}/upload.do?sysparm_target=sys_app`);
  assert.equal(page.headers.Cookie, 'JSESSIONID=session-cookie');

  const post = transport.calls.find(call => call.method === 'POST');
  const url = new URL(post.url);
  assert.equal(url.pathname, '/sn_appclient_upload_processor.do');
  assert.deepEqual([...url.searchParams.keys()], [
    'sysparm_track_fluent_install', 'sysparm_async_fluent_install', 'sysparm_request_type',
    'sysparm_fluent_scope_id', 'sysparm_fluent_scope_name', 'sysparm_fluent_app_version',
    'sysparm_register_scope',
  ]);
  assert.equal(url.searchParams.get('sysparm_fluent_scope_id'), APP_SYS_ID);
  assert.equal(url.searchParams.get('sysparm_fluent_scope_name'), SCOPE);
  assert.equal(url.searchParams.get('sysparm_fluent_app_version'), '1.2.3');
  assert.equal(url.searchParams.get('sysparm_register_scope'), 'true');
  assert.equal(post.headers.Cookie, 'JSESSIONID=session-cookie');
  assert.equal(post.headers['X-UserToken'], 'tok-abc');
  assert.equal(post.form.get('sysparm_ck'), 'tok-abc');
  assert.equal(post.form.get('upload_type'), 'file');
  assert.equal(post.form.get('load_demo'), 'false');
  assert.equal(post.form.get('attachFile').name, `${SCOPE}_1.2.3.zip`);

  // The bytes on the wire are the artifact `app build --backend package` writes.
  const uploaded = Buffer.from(await post.form.get('attachFile').arrayBuffer());
  const expected = buildPackageZip(project, { now: new Date() });
  assert.equal(uploaded.length, expected.zip.length);
  assert.equal(uploaded.includes(Buffer.from('/scope/sys_app_')), true);
});

test('an existing scope is not registered again and demo data is a form field', async t => {
  const project = projectFor(t);
  const transport = fakeTransport({ scopeExists: true, instance: installedInstance(project) });
  await deploy(project, transport, { demoData: true });
  const post = transport.calls.find(call => call.method === 'POST');
  assert.equal(new URL(post.url).searchParams.has('sysparm_register_scope'), false);
  assert.equal(post.form.get('load_demo'), 'true');
  const scopeRead = transport.calls.find(call => call.table === 'sys_scope');
  assert.equal(scopeRead.query, `scope=${SCOPE}`);
});

// ── the failure rules ───────────────────────────────────────────────────

test('a 302 is a hard failure that says the app was not installed', async t => {
  const project = projectFor(t);
  const transport = fakeTransport({ upload: { redirect: true } });
  await assert.rejects(deploy(project, transport), error => {
    assert.equal(error.code, 'api_error');
    assert.match(error.message, /app was not installed/);
    assert.match(error.message, /redirect/i);
    assert.match(`${error.message} ${error.hint}`, /session or CSRF conflict|Re-authenticate/);
    return true;
  });
  assert.equal(transport.calls.some(call => call.method === 'POST'), true);
  // The scope-existence probe is a READ that happens before the upload; what must
  // not happen is a readback of the app or its records.
  assert.equal(transport.calls.some(call => call.method === 'READ' && call.table !== 'sys_scope'), false,
    'no readback after a refused upload');
});

test('a 200 with HTML is a failure, not an install', async t => {
  const project = projectFor(t);
  const transport = fakeTransport({ upload: { body: '<html><body>Log in</body></html>' } });
  await assert.rejects(deploy(project, transport), error => {
    assert.equal(error.code, 'api_error');
    assert.match(error.message, /HTML document/);
    assert.match(error.message, /not started|not installed/i);
    return true;
  });
  assert.equal(transport.calls.some(call => call.method === 'READ' && call.table !== 'sys_scope'), false);
});

test('JSON without executionTracker is not an install response', async t => {
  const project = projectFor(t);
  const transport = fakeTransport({ upload: { body: JSON.stringify({ result: { status: 'ok' } }) } });
  await assert.rejects(deploy(project, transport), /without an executionTracker/);
});

test('a failing tracker fails the deploy even though the upload answered 200', async t => {
  const project = projectFor(t);
  const transport = fakeTransport({
    instance: installedInstance(project),
    progress: [{ result: { status: '3', successful: false, status_label: 'Failed', error: 'Install failed: missing dependency' } }],
  });
  await assert.rejects(deploy(project, transport), error => {
    assert.equal(error.code, 'api_error');
    assert.match(error.message, /did not succeed/);
    assert.match(error.message, /missing dependency/);
    return true;
  });
  assert.equal(transport.calls.some(call => call.method === 'READ' && call.table === 'sys_app'), false);
});

test('the tracker is polled to a terminal state before readback', async t => {
  const project = projectFor(t);
  const transport = fakeTransport({
    instance: installedInstance(project),
    progress: [
      { result: { status: '1', percent_complete: 10, links: { progress: { id: TRACKER } } } },
      { result: { status: '1', percent_complete: 80, links: { progress: { id: TRACKER } } } },
      { result: { status: '2', successful: true, percent_complete: 100 } },
    ],
  });
  const report = await deploy(project, transport);
  assert.equal(report.tracker.label, 'successful');
  assert.equal(report.records.verified, project.records.length);
});

test('a redirect-shaped transport error is classified without a status', () => {
  const redirect = new TypeError('fetch failed');
  redirect.cause = new Error('unexpected redirect');
  assert.equal(isRedirectFailure(redirect), true);
  assert.equal(isRedirectFailure({ status: 302 }), true);
  assert.equal(isRedirectFailure(new Error('connection reset')), false);
});

test('executionTracker is read only from an install response', () => {
  assert.equal(executionTrackerFrom(JSON.stringify({ executionTracker: TRACKER })), TRACKER);
  assert.equal(executionTrackerFrom(JSON.stringify({ result: { executionTracker: TRACKER } })), TRACKER);
  assert.equal(executionTrackerFrom(JSON.stringify({ tracker: TRACKER })), '');
  assert.equal(executionTrackerFrom('<html></html>'), '');
  assert.equal(executionTrackerFrom(''), '');
});

// ── readback ────────────────────────────────────────────────────────────

test('the happy path reports n of n records verified and the exact identity', async t => {
  const project = projectFor(t);
  const transport = fakeTransport({ instance: installedInstance(project) });
  const report = await deploy(project, transport);

  assert.equal(report.records.verified, project.records.length);
  assert.equal(report.records.total, project.records.length);
  assert.equal(report.app_verified, true);
  assert.equal(report.sys_id, APP_SYS_ID);
  assert.equal(report.scope, SCOPE);
  assert.equal(report.version, '1.2.3');
  assert.equal(report.written_to_instance, true);

  // Every packaged record was read back by sys_id, not by name.
  const reads = transport.calls.filter(call => call.method === 'READ' && call.table !== 'sys_scope');
  assert.equal(reads.length, project.records.length + 1);
  assert.equal(reads[0].table, 'sys_app');
  assert.equal(reads[0].query, `scope=${SCOPE}`);
  assert.deepEqual(reads.slice(1).map(call => call.query).sort(),
    [SYS_ID_A, SYS_ID_B].map(id => `sys_id=${id}`).sort());
});

test('a readback field mismatch is a failed deploy listing every disagreement', async t => {
  const project = projectFor(t);
  const instance = installedInstance(project);
  instance.records[`sys_script/${SYS_ID_A}`].condition = 'active=false';
  instance.records[`sys_script_include/${SYS_ID_B}`].api_name = 'x_1_demo.Other';
  const transport = fakeTransport({ instance });

  await assert.rejects(deploy(project, transport), error => {
    assert.equal(error.code, 'api_error');
    // Both records disagree, so neither can count as verified.
    assert.match(error.message, /0 of 2 records verified/);
    assert.match(error.message, /condition: uploaded "active=true", instance has "active=false"/);
    assert.match(error.message, /api_name: uploaded "x_1_demo\.DemoHelper", instance has "x_1_demo\.Other"/);
    assert.match(error.message, /never reports a mismatched install as deployed/);
    assert.match(error.hint, /re-run/);
    return true;
  });
});

test('a script whose stored bytes differ is a failure, CRLF and BOM included', async t => {
  const project = projectFor(t);
  const instance = installedInstance(project);
  const key = `sys_script/${SYS_ID_A}`;
  // The instance normalized CRLF to LF: one byte shorter per line.
  instance.records[key].script = TRICKY_SCRIPT.replaceAll('\r\n', '\n');
  const transport = fakeTransport({ instance });

  await assert.rejects(deploy(project, transport), error => {
    assert.match(error.message, /stored script is not the uploaded script/);
    assert.match(error.message, /first difference at byte/);
    return true;
  });
});

test('a missing sys_app row or a scope owned by another app is a failure', async t => {
  const project = projectFor(t);
  const missing = fakeTransport({ instance: { records: {} } });
  await assert.rejects(deploy(project, missing), /expected exactly one row for scope/);

  const wrongApp = fakeTransport({
    instance: { ...installedInstance(project), sys_app: { ...installedInstance(project).sys_app, sys_id: 'f'.repeat(32) } },
  });
  await assert.rejects(deploy(project, wrongApp), /the scope x_1_demo belongs to f{32}/);
});

test('a record the instance does not hold is a failure, not a skipped check', async t => {
  const project = projectFor(t);
  const instance = installedInstance(project);
  delete instance.records[`sys_script_include/${SYS_ID_B}`];
  const transport = fakeTransport({ instance });
  await assert.rejects(deploy(project, transport), /expected exactly one record, the instance returned 0/);
});

test('the verification field lists are exactly what the documents carry', async t => {
  // The deploy reads back the same lists the writer emits; this pins the
  // single-source-of-truth claim instead of trusting it.
  const project = projectFor(t);
  const scopeXml = buildScopeXml(project);
  for (const field of scopeVerificationFields(project)) {
    assert.match(scopeXml, new RegExp(`<${field.name}[ >][^<]*>${field.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</${field.name}>|`
      + `<${field.name}>${field.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</${field.name}>`));
  }
  for (const record of project.records) {
    const xml = buildRecordXml(record, project.app);
    const names = [...xml.matchAll(/<([a-z_]+)[\s>]/g)].map(match => match[1]);
    assert.deepEqual(names.filter(name => name !== 'record_update' && name !== record.table),
      recordVerificationFields(record, project.app).map(field => field.name));
  }
});

// ── the command ─────────────────────────────────────────────────────────

async function runDeploy(args, app) {
  await yargs(['app', ...args]).strictCommands().strictOptions()
    .option('json', { type: 'boolean' }).option('format', { type: 'string' })
    .option('get', { type: 'string' })
    .option('profile', { type: 'string' }).option('instance', { type: 'string' })
    .command(appCmd(handler => argv => handler(argv, app)))
    .fail((message, error) => { throw error || new Error(message); }).parse();
}

function commandApp(transport, { instance = INSTANCE } = {}) {
  return {
    sdk: transport.sdk,
    ok: () => {},
    requireInstance: () => {},
    getEffectiveInstance: () => instance,
    config: { profiles: {}, activeProfile: null },
  };
}

test('without --yes the deploy refuses and uploads nothing', async t => {
  const project = projectFor(t);
  const transport = fakeTransport({ instance: installedInstance(project) });
  const previous = process.env.JSN_NO_PROMPTS;
  process.env.JSN_NO_PROMPTS = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.JSN_NO_PROMPTS;
    else process.env.JSN_NO_PROMPTS = previous;
  });
  await assert.rejects(
    runDeploy(['deploy', '--dir', project.root, '--json'], commandApp(transport)),
    error => {
      assert.equal(error.code, 'confirmation_required');
      assert.match(error.message, /Pass --yes/);
      assert.match(error.hint, /--dir/);
      return true;
    },
  );
  assert.deepEqual(transport.calls, [], 'nothing may reach the instance before confirmation');
});

test('a build error uploads nothing and asks nothing', async t => {
  // No app.version: the package backend cannot build this project.
  const root = writeAppProject(t, happyProjectSpec({
    appYaml: PACKAGE_APP_YAML.replace('  version: 1.2.3\n', ''),
  }));
  const transport = fakeTransport({});
  await assert.rejects(
    runDeploy(['deploy', '--dir', root, '--yes', '--json'], commandApp(transport)),
    error => {
      assert.equal(error.code, 'invalid_project');
      assert.match(error.message, /app\.version/);
      return true;
    },
  );
  assert.deepEqual(transport.calls, [], 'a build failure must not reach the instance');
});

test('a project that declares the update-set backend is refused with the other path', async t => {
  const root = writeAppProject(t, happyProjectSpec());
  const transport = fakeTransport({});
  await assert.rejects(
    runDeploy(['deploy', '--dir', root, '--yes', '--json'], commandApp(transport)),
    error => {
      assert.equal(error.code, 'usage_error');
      assert.match(error.message, /update-set/);
      assert.match(error.hint, /updatesets/);
      return true;
    },
  );
  assert.deepEqual(transport.calls, []);
});

test('--yes runs the deploy and reports the verified counts', async t => {
  const project = projectFor(t);
  const transport = fakeTransport({ instance: installedInstance(project) });
  const app = commandApp(transport);
  let reported = null;
  app.ok = (data, opts) => { reported = { data, opts }; };
  await runDeploy(['deploy', '--dir', project.root, '--yes', '--json'], app);

  assert.equal(reported.data.uploaded, true);
  assert.equal(reported.data.records.verified, project.records.length);
  assert.equal(reported.data.records.total, project.records.length);
  assert.equal(reported.data.scope, SCOPE);
  assert.equal(reported.data.version, '1.2.3');
  assert.equal(reported.data.sys_id, APP_SYS_ID);
  assert.match(reported.opts.summary, /records verified 2\/2/);
  assert.match(reported.opts.summary, /tracker successful/);
  assert.match(reported.opts.summary, /app sys_id/);
});

test('a read-only profile blocks app deploy before the handler runs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-app-deploy-readonly-'));
  try {
    fs.mkdirSync(path.join(dir, 'servicenow'));
    fs.writeFileSync(path.join(dir, 'servicenow', 'config.json'), JSON.stringify({
      default_profile: 'ro',
      active_profile: 'ro',
      profiles: { ro: { instance_url: 'https://example.invalid', auth_method: 'gck', read_only: true } },
    }));
    const run = spawnSync(process.execPath, [CLI, 'app', 'deploy', '--dir', dir, '--yes', '--json'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...cliEnv(dir), XDG_CONFIG_HOME: dir },
    });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    const envelope = JSON.parse(run.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, 'read_only');
    assert.match(envelope.error, /read-only/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('app deploy still requires an instance', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-app-deploy-noinstance-'));
  try {
    const run = spawnSync(process.execPath, [CLI, 'app', 'deploy', '--dir', dir, '--yes', '--json'], {
      encoding: 'utf8', timeout: 15000,
      env: cliEnv(dir),
    });
    assert.equal(run.status, 2, run.stdout + run.stderr);
    const envelope = JSON.parse(run.stdout);
    assert.equal(envelope.ok, false);
    assert.match(`${envelope.error} ${envelope.hint || ''}`, /instance|profile/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── the confirmation gate and the reader's hostile-input rules ────────────

test('a declined install confirmation stops before any upload', async t => {
  const { confirmDeployInstall } = await import('../src/commands/app.js');
  const project = projectFor(t);
  let asked = null;
  const declined = await confirmDeployInstall({ dir: '.', yes: false }, {
    getEffectiveInstance: () => INSTANCE,
  }, project, {
    confirm: async (argv, app, question) => { asked = question; return false; },
  });
  assert.match(asked, /This writes to the instance/);
  assert.equal(declined, false, 'a declined answer must not let the deploy proceed');

  const accepted = await confirmDeployInstall({ dir: '.', yes: true }, {
    getEffectiveInstance: () => INSTANCE,
  }, project, { confirm: async () => true });
  assert.equal(accepted, true);
});

test('a code path that resolves outside the project through a link is refused', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-app-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'records', 'sys_script_include'), { recursive: true });
  fs.mkdirSync(path.join(root, 'code'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app.yaml'), 'version: 1\napp:\n  name: A\n  scope: global\nbackend: update-set\n');
  fs.writeFileSync(path.join(root, 'records', 'sys_script_include', 'U.json'), JSON.stringify({
    sys_id: 'a'.repeat(32), table: 'sys_script_include',
    fields: { name: 'U' }, code: { script: 'code/evil.js' },
  }));
  const outside = path.join(root, '..', `jsn-outside-${process.pid}.js`);
  fs.writeFileSync(outside, 'var stolen = 1;\n');
  t.after(() => fs.rmSync(outside, { force: true }));
  try {
    fs.symlinkSync(outside, path.join(root, 'code', 'evil.js'));
  } catch {
    t.skip('symlinks are unavailable on this host');
    return;
  }
  assert.throws(() => readAppProject(root), /resolves outside the project root through a link/);
});

test('metadata that would trap the host is refused inside the bounded context', () => {
  const source = [
    'var U = 1;',
    '',
    'export default {',
    `  sys_id: '${'a'.repeat(32)}',`,
    "  table: 'sys_script_include',",
    '  fields: new Proxy({}, { getPrototypeOf() { for (;;) {} } }),',
    '  script: U,',
    '};',
    '',
  ].join('\n');
  const started = Date.now();
  const result = extractRecordSource(source);
  assert.equal(result.ok, false);
  assert.match(result.error, /cannot read the default export/);
  assert.ok(Date.now() - started < 5000, 'validation must not hang on a hostile trap');
});

test('a regular expression after a control statement does not confuse extraction', () => {
  const body = "function U() {\n  if (true) /}/.test('}');\n  return 'ok';\n}\n";
  const source = body + `\nexport default {\n  sys_id: '${'a'.repeat(32)}',\n  table: 'sys_script_include',\n  fields: { name: 'U' },\n  script: U,\n};\n`;
  const result = extractRecordSource(source);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.body, body);
  assert.equal(recordSymbolName(result.metadata.script), 'U');
});

test('slash classification preserves the record body', () => {
  const cases = [
    "if (true) {} /}/.test('}');",
    "if (false) {} else {} /}/.test('}');",
    "try {} catch {} finally {} /}/.test('}');",
    "if (true) { {} /}/.test('}'); } /}/.test('}');",
    'var half = obj.return / 2;',
    'var half = obj?.in / 2;',
    'var half = obj.if() / 2;',
    'class C { #return = 8; half() { return this.#return / 2; } }',
    'var half = {} / 2;',
    'var half = function () {} / 2;',
    'for (var i = obj.of / 2; i; i--) {}',
    'for (; of / 2; ) {}',
    'for (const of of /}/.exec(text)) {}',
    'async function each() { for await (const item of /}/.exec(text)) {} /}/.test("}"); }',
    'var text = `${obj.throw / 2}`;',
    'var text = `${(() => { if (true) {} /[}`]/.test("}"); return 1; })()}`;',
  ];
  for (const statement of cases) {
    const body = `\uFEFFvar U = 1;\r\n  ${statement}\r\n`;
    const result = extractRecordSource(`${body}\r\nexport default { script: U };\r\n`);
    assert.equal(result.ok, true, `${statement}: ${result.error}`);
    assert.equal(result.body, body);
    assert.equal(recordSymbolName(result.metadata.script), 'U');
  }
});

test('division after a keyword property preserves the metadata literal', () => {
  const literal = '{ fields: { half: ({ return: 8 }).return / 2 } }';
  const result = extractRecordSource(`export default ${literal};\n`);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.literal, literal);
  assert.equal(result.metadata.fields.half, 4);
});
