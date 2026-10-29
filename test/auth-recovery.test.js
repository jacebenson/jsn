import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { App } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { createAuthRecovery } from '../src/auth-recovery.js';
import { applySession } from '../src/session.js';
import { OutputWriter } from '../src/output.js';
import { errAPI, renderAppError } from '../src/errors.js';

const instance = 'https://recovery.invalid';
const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
const secrets = ['fixture-access-secret', 'fixture-refresh-secret', 'fixture-cookie-secret', 'fixture-password-secret', 'fixture-gck-secret'];
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('SN_') || key.startsWith('SERVICENOW_')) delete process.env[key];
  }
});
afterEach(() => { process.env = savedEnv; });

function fixture(t, method = 'oauth', { reauth, interactive, accept = true, refreshToken = true, argv = {}, renewError } = {}) {
  const profile = { instance_url: instance, username: 'selected-user', auth_method: method, reauth };
  const app = new App({ ...createConfig(), activeProfile: 'selected', profiles: { selected: profile } });
  const credentials = new Map([
    ['selected-user', { auth_method: method, username: 'selected-user', access_token: secrets[0],
      refresh_token: refreshToken ? secrets[1] : undefined, cookies: `JSESSIONID=${secrets[2]}`, password: secrets[3] }],
    ['other-user', { auth_method: 'oauth', access_token: 'other-access', refresh_token: 'other-refresh' }],
  ]);
  app.auth.credentialStore = {
    load: (url, user) => { assert.equal(url, instance); return structuredClone(credentials.get(user)); },
    save: (url, value, user) => { assert.equal(url, instance); credentials.set(user, structuredClone(value)); },
  };
  const counts = { calls: 0, refreshes: 0, browsers: 0, prompts: 0 };
  const originalRefresh = app.auth.refreshToken.bind(app.auth);
  t.mock.method(app.auth, 'refreshToken', async (...args) => { counts.refreshes++; return originalRefresh(...args); });
  const recoveryOptions = {
    app, session: app.session, argv: () => argv,
    prompt: async ({ default: defaultValue }) => { assert.equal(defaultValue, false); counts.prompts++; return accept; },
    renewBrowser: async (request) => {
      assert.deepEqual(request, { profile: 'selected', browser: true });
      counts.browsers++;
      if (renewError) throw renewError;
      credentials.set('selected-user', { auth_method: 'gck', access_token: secrets[4], cookies: 'JSESSIONID=replaced' });
    },
  };
  if (interactive !== undefined) recoveryOptions.canInteract = () => interactive;
  app.sdk.recovery = createAuthRecovery(recoveryOptions);
  // These tests isolate the real-command retry from the existing bootstrap.
  // The separate bootstrap test below exercises session reconstruction.
  t.mock.method(app.sdk, '_warmSession', async () => 'JSESSIONID=warmed');
  app.sdk.sessionUserToken = 'warmed-token';
  function respond(statuses = [401, 200], { refreshStatus = 200, fail } = {}) {
    t.mock.method(globalThis, 'fetch', async (request, options) => {
      const url = typeof request === 'string' ? request : request.url;
      if (url.endsWith('/oauth_token.do')) {
        assert.equal(new URLSearchParams(options.body).get('refresh_token'), credentials.get('selected-user').refresh_token);
        return new Response(JSON.stringify({ access_token: 'refreshed-access', refresh_token: 'refreshed-refresh' }), { status: refreshStatus });
      }
      counts.calls++;
      if (fail) throw fail;
      const status = statuses[Math.min(counts.calls - 1, statuses.length - 1)];
      return new Response(status === 200 ? '{"result":{"success":true}}' : secrets.join(' '), { status });
    });
  }
  return { app, sdk: app.sdk, counts, credentials, respond };
}

function actionable(error, command = 'jsn auth refresh --profile selected') {
  assert.equal(error.code, 'auth_error');
  assert.equal(error.status, 401);
  assert.equal(error.profile, 'selected');
  assert.match(error.message, /profile selected/);
  assert.ok(error.hint.includes(command));
  assert.equal(error.recovery, command);
  return true;
}

for (const method of ['request', 'rawRequest']) {
  test(`OAuth 401 refreshes exactly once and retries ${method}`, async t => {
    const f = fixture(t); f.respond();
    const result = await f.sdk[method](`${instance}/api/work`);
    assert.ok(result);
    assert.deepEqual(f.counts, { calls: 2, refreshes: 1, browsers: 0, prompts: 0 });
    assert.equal(f.credentials.get('selected-user').access_token, 'refreshed-access');
  });
}

for (const method of ['request', 'rawRequest']) {
  test(`concurrent OAuth 401s share one refresh and replay both ${method} calls once`, async t => {
    const f = fixture(t); f.respond([401, 401, 200, 200]);
    const results = await Promise.all([
      f.sdk[method](`${instance}/api/first`),
      f.sdk[method](`${instance}/api/second`),
    ]);
    for (const result of results) {
      if (method === 'rawRequest') assert.deepEqual(JSON.parse(result), { result: { success: true } });
      else assert.deepEqual(result, { result: { success: true } });
    }
    assert.deepEqual(f.counts, { calls: 4, refreshes: 1, browsers: 0, prompts: 0 });
  });

  test(`later OAuth 401 reuses successful recovery for ${method} without refreshing again`, async t => {
    const f = fixture(t); f.respond([401, 200, 401, 200]);
    await f.sdk[method](`${instance}/api/first`);
    const result = await f.sdk[method](`${instance}/api/second`);
    if (method === 'rawRequest') assert.deepEqual(JSON.parse(result), { result: { success: true } });
    else assert.deepEqual(result, { result: { success: true } });
    assert.deepEqual(f.counts, { calls: 4, refreshes: 1, browsers: 0, prompts: 0 });
  });
}

test('failed OAuth recovery is shared by concurrent and later requests without another refresh', async t => {
  const f = fixture(t); f.respond([401], { refreshStatus: 400 });
  const results = await Promise.allSettled([
    f.sdk.request(`${instance}/api/first`),
    f.sdk.request(`${instance}/api/second`),
  ]);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    actionable(result.reason);
    assert.equal(result.reason, results[0].reason);
  }
  await assert.rejects(f.sdk.request(`${instance}/api/later`), error => {
    actionable(error);
    assert.equal(error, results[0].reason);
    return true;
  });
  assert.deepEqual(f.counts, { calls: 3, refreshes: 1, browsers: 0, prompts: 0 });
});

test('concurrent GCK confirm 401s share one prompt and browser renewal', async t => {
  const f = fixture(t, 'gck', { reauth: 'confirm', interactive: true });
  f.respond([401, 401, 200, 200, 401, 200]);
  const results = await Promise.all([
    f.sdk.request(`${instance}/api/first`),
    f.sdk.request(`${instance}/api/second`),
  ]);
  for (const result of results) assert.deepEqual(result, { result: { success: true } });
  assert.deepEqual(f.counts, { calls: 4, refreshes: 0, browsers: 1, prompts: 1 });
  assert.deepEqual(await f.sdk.request(`${instance}/api/later`), { result: { success: true } });
  assert.deepEqual(f.counts, { calls: 6, refreshes: 0, browsers: 1, prompts: 1 });
});

for (const accept of [true, false]) {
  test(`failed GCK recovery never repeats the prompt or browser flow; accept=${accept}`, async t => {
    const f = fixture(t, 'gck', {
      reauth: 'confirm', interactive: true, accept, renewError: new Error('browser renewal failed'),
    });
    f.respond([401]);
    let firstError;
    await assert.rejects(f.sdk.request(`${instance}/api/first`), error => {
      actionable(error, 'jsn auth refresh --profile selected --browser');
      firstError = error;
      return true;
    });
    await assert.rejects(f.sdk.request(`${instance}/api/later`), error => {
      actionable(error, 'jsn auth refresh --profile selected --browser');
      assert.equal(error, firstError);
      return true;
    });
    assert.deepEqual(f.counts, { calls: 2, refreshes: 0, browsers: accept ? 1 : 0, prompts: 1 });
  });
}

test('OAuth second 401 is final with profile-specific recovery guidance', async t => {
  const f = fixture(t); f.respond([401, 401]);
  await assert.rejects(f.sdk.request(`${instance}/api/work`), actionable);
  assert.equal(f.counts.calls, 2); assert.equal(f.counts.refreshes, 1);
});

test('OAuth without a refresh token never retries', async t => {
  const f = fixture(t, 'oauth', { refreshToken: false }); f.respond();
  await assert.rejects(f.sdk.request(`${instance}/api/work`), actionable);
  assert.equal(f.counts.calls, 1); assert.equal(f.counts.refreshes, 0);
});

test('failed OAuth refresh is redacted, actionable and never replays the command', async t => {
  const f = fixture(t); f.respond([401], { refreshStatus: 400 });
  await assert.rejects(f.sdk.request(`${instance}/api/work`), error => {
    actionable(error); assert.match(error.hint, /jsn auth login --profile selected/); return true;
  });
  assert.equal(f.counts.calls, 1); assert.equal(f.counts.refreshes, 1);
});

test('Basic 401 never refreshes or retries and names the verified Basic login command', async t => {
  const f = fixture(t, 'basic'); f.respond();
  await assert.rejects(f.sdk.request(`${instance}/api/work`), error => {
    actionable(error, `jsn auth login --basic ${instance} --profile selected`);
    assert.match(error.hint, /SN_USERNAME\/SN_PASSWORD/); return true;
  });
  assert.equal(f.counts.calls, 1); assert.equal(f.counts.refreshes, 0);
});

test('interactive GCK auto renews once and retries with replaced credentials', async t => {
  const f = fixture(t, 'gck', { reauth: 'auto', interactive: true }); f.respond();
  assert.deepEqual(await f.sdk.request(`${instance}/api/work`), { result: { success: true } });
  assert.deepEqual(f.counts, { calls: 2, refreshes: 0, browsers: 1, prompts: 0 });
});

for (const reauth of [undefined, 'confirm']) {
  for (const accept of [true, false]) {
    test(`GCK ${reauth ?? 'default'} prompts once; accept=${accept}`, async t => {
      const f = fixture(t, 'gck', { reauth, interactive: true, accept }); f.respond();
      if (accept) await f.sdk.request(`${instance}/api/work`);
      else await assert.rejects(f.sdk.request(`${instance}/api/work`), error => actionable(error, 'jsn auth refresh --profile selected --browser'));
      assert.equal(f.counts.prompts, 1); assert.equal(f.counts.browsers, accept ? 1 : 0);
      assert.equal(f.counts.calls, accept ? 2 : 1);
    });
  }
}

test('GCK never policy rejects immediately even with an interactive terminal', async t => {
  const f = fixture(t, 'gck', { reauth: 'never', interactive: true }); f.respond();
  await assert.rejects(f.sdk.request(`${instance}/api/work`), error => actionable(error, 'jsn auth refresh --profile selected --browser'));
  assert.deepEqual(f.counts, { calls: 1, refreshes: 0, browsers: 0, prompts: 0 });
});

for (const mode of ['no-tty', 'json', 'quiet', 'csv', 'markdown', 'get', 'CI', 'CODEX_AGENT']) {
  test(`GCK auto never prompts in ${mode}; settles promptly with a safe JSON envelope`, async t => {
    for (const stream of [process.stdin, process.stdout]) {
      const descriptor = Object.getOwnPropertyDescriptor(stream, 'isTTY');
      Object.defineProperty(stream, 'isTTY', { configurable: true, value: mode !== 'no-tty' });
      t.after(() => {
        if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
        else delete stream.isTTY;
      });
    }
    for (const key of ['JSN_NO_PROMPTS', 'CI', 'NONINTERACTIVE', 'GITHUB_ACTIONS', 'CLAUDE_CODE', 'COPILOT_AGENT', 'VSCODE_AGENT', 'CURSOR_AGENT', 'CODEX_AGENT', 'GITHUB_COPILOT_AGENT', 'TERM']) delete process.env[key];
    if (mode === 'CI' || mode === 'CODEX_AGENT') process.env[mode] = '1';
    const f = fixture(t, 'gck', { reauth: 'auto', argv: mode === 'get' ? { get: 'result' } : {} });
    if (['json', 'quiet', 'csv', 'markdown'].includes(mode)) f.app.output.setFormat(mode);
    f.respond();
    let timer;
    try {
      await assert.rejects(Promise.race([
        f.sdk.request(`${instance}/api/work`),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('did not settle promptly')), 250); }),
      ]), error => {
        actionable(error, 'jsn auth refresh --profile selected --browser');
        let json = '';
        new OutputWriter({ format: 'json', writer: { write: text => { json += text; } } }).err(error);
        const envelope = JSON.parse(json);
        assert.equal(envelope.profile, 'selected'); assert.equal(envelope.status, 401);
        assert.equal(envelope.recovery, error.recovery);
        assert.equal(envelope.ok, false);
        return true;
      });
    } finally { clearTimeout(timer); }
    assert.equal(f.counts.browsers, 0); assert.equal(f.counts.prompts, 0);
  });
}

test('403 is forbidden, includes ACL guidance, and never invokes recovery', async t => {
  const f = fixture(t); f.respond([403]);
  t.mock.method(f.sdk.recovery, 'recover', () => assert.fail('recovery on 403'));
  await assert.rejects(f.sdk.request(`${instance}/api/work`), error => {
    assert.equal(error.code, 'forbidden'); assert.equal(error.status, 403);
    assert.match(error.hint, /authorization\/ACL\/role problem, not a login problem/);
    assert.match(renderAppError(error).text, /not a login problem/); return true;
  });
  assert.equal(f.counts.calls, 1);
});

for (const method of ['GET', 'POST']) {
  for (const failure of ['network', 'abort', 'timeout', '500']) {
    test(`${method} ${failure} never recovers or retries`, async t => {
      const f = fixture(t);
      const fail = failure === 'network' ? new TypeError('fetch failed')
        : failure === 'abort' ? new DOMException('Aborted', 'AbortError') : undefined;
      f.respond([500], { fail });
      if (failure === 'timeout') {
        f.sdk.timeout = 10;
        t.mock.method(globalThis, 'fetch', request => {
          f.counts.calls++;
          return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
        });
      }
      t.mock.method(f.sdk.recovery, 'recover', () => assert.fail('recovery on uncertain outcome'));
      await assert.rejects(f.sdk.request(`${instance}/api/work`, { method, ...(method === 'POST' ? { body: '{}' } : {}) }));
      assert.equal(f.counts.calls, 1); assert.equal(f.counts.refreshes, 0);
    });
  }
}

test('POST 401 permits exactly one replay, never a third attempt', async t => {
  const f = fixture(t); f.respond([401, 401]);
  await assert.rejects(f.sdk.request(`${instance}/api/work`, { method: 'POST', body: '{"value":"unchanged"}' }), actionable);
  assert.equal(f.counts.calls, 2); assert.equal(f.counts.refreshes, 1);
});

test('POST success after 401 is returned; a 500 on retry is final', async t => {
  const f = fixture(t); f.respond();
  assert.deepEqual(await f.sdk.create('fixture', { name: 'value' }), { success: true });
  assert.equal(f.counts.calls, 2); assert.equal(f.counts.refreshes, 1);
  // This SDK already recovered; the later 401 replays without another refresh.
  f.counts.calls = 0; f.counts.refreshes = 0; f.respond([401, 500]);
  await assert.rejects(f.sdk.create('fixture', {}), { code: 'api_error', status: 500 });
  assert.equal(f.counts.calls, 2); assert.equal(f.counts.refreshes, 0);
});

test('selected SDK identity stays pinned even if the active profile changes', async t => {
  const f = fixture(t);
  const other = structuredClone(f.credentials.get('other-user'));
  f.app.config.profiles.other = { instance_url: instance, username: 'other-user', auth_method: 'oauth' };
  const selectedSdk = f.sdk;
  applySession(f.app, { profile: 'other' });
  f.respond();
  await selectedSdk.request(`${instance}/api/work`);
  assert.deepEqual(f.credentials.get('other-user'), other);
  assert.equal(f.credentials.get('selected-user').access_token, 'refreshed-access');
});

test('auth text and JSON never contain credential values or provider response bodies', async t => {
  const f = fixture(t); f.respond([401, 401]);
  await assert.rejects(f.sdk.request(`${instance}/api/work`), error => {
    let json = '';
    new OutputWriter({ format: 'json', writer: { write: value => { json += value; } } }).err(error);
    const text = renderAppError(error).text;
    for (const secret of secrets) {
      assert.ok(!text.includes(secret)); assert.ok(!json.includes(secret));
    }
    assert.match(text, /selected/); assert.match(json, /jsn auth refresh --profile selected/);
    return true;
  });
  for (const status of [401, 403]) for (const secret of secrets) assert.ok(!String(errAPI(status, secrets.join(' '))).includes(secret));
});

test('successful GCK command makes exactly one request with no preflight or recovery', async t => {
  const f = fixture(t, 'gck'); f.respond([200]);
  t.mock.method(f.sdk.recovery, 'recover', () => assert.fail('successful command recovery'));
  await f.sdk.request(`${instance}/api/work`);
  assert.equal(f.counts.calls, 1); assert.equal(f.counts.refreshes, 0);
});

test('bootstrap raw responses never invoke recovery', async t => {
  const f = fixture(t); f.respond([401]);
  t.mock.method(f.sdk.recovery, 'recover', () => assert.fail('bootstrap recovery'));
  assert.equal((await f.sdk.fetchResponse(`${instance}/bootstrap`)).status, 401);
  assert.equal((await f.sdk._fetchWithAuth(`${instance}/bootstrap`)).status, 401);
  assert.equal(f.counts.refreshes, 0);
});

test('OAuth retry discards cached cookies and reconstructs the existing session', async t => {
  const f = fixture(t);
  f.sdk._warmSession.mock.restore();
  f.sdk.oauthCookies = 'JSESSIONID=stale'; f.sdk.sessionUserToken = 'stale-token';
  let commands = 0, bootstrap = 0;
  t.mock.method(globalThis, 'fetch', async (request) => {
    const url = typeof request === 'string' ? request : request.url;
    if (url.endsWith('/oauth_token.do')) return new Response('{"access_token":"fresh","refresh_token":"new-refresh"}');
    if (url.includes('angular.do')) {
      bootstrap++;
      return new Response('{}', { headers: { 'set-cookie': 'JSESSIONID=fresh; Path=/', 'x-usertoken-response': 'fresh-token' } });
    }
    if (url.includes('sys_scope')) {
      assert.equal(request.headers.get('Authorization'), 'Bearer fresh'); bootstrap++;
      return new Response('{}');
    }
    commands++;
    assert.equal(request.headers.get('Cookie'), commands === 1 ? 'JSESSIONID=stale' : 'JSESSIONID=fresh');
    assert.equal(request.headers.get('X-UserToken'), commands === 1 ? 'stale-token' : 'fresh-token');
    return new Response(commands === 1 ? '' : '{}', { status: commands === 1 ? 401 : 200 });
  });
  await f.sdk.request(`${instance}/api/work`);
  assert.equal(commands, 2); assert.equal(bootstrap, 3); assert.equal(f.counts.refreshes, 1);
});

function isolatedCLI(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'jsn recovery test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const preload = path.join(directory, 'offline.mjs');
  writeFileSync(preload, `globalThis.fetch = () => { throw new Error('unexpected network call'); };\n`);
  const env = { ...process.env, XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, HOME: directory,
    JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1', PATH: '' };
  const run = args => spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, cli, ...args], { cwd: directory, env, encoding: 'utf8', timeout: 5000 });
  return { directory, run };
}

test('docs and local auth status work without an instance, credentials, network or recovery', t => {
  const { run } = isolatedCLI(t);
  for (const args of [['docs', '--json'], ['auth', 'status', '--local', '--json']]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
    assert.doesNotMatch(result.stderr + result.stdout, /unexpected network|auth_error/);
  }
});

test('GCK recovery uses canonical refresh/login, preserves settings and emits no extra envelope', async t => {
  const { directory } = isolatedCLI(t);
  const previousCwd = process.cwd();
  process.env.XDG_CONFIG_HOME = directory;
  process.chdir(directory);
  try {
    const f = fixture(t, 'gck', { reauth: 'auto' });
    f.app.config.profiles.selected.read_only = true;
    f.app.config.profiles.selected.skip_confirmations = false;
    f.app.config.profiles.selected.include_counts = false;
    const before = structuredClone(f.app.config);
    const sdk = f.sdk;
    let browsers = 0;
    t.mock.module('../src/browser-launch.js', { namedExports: {
      chooseBrowser: async () => ({ name: 'Fixture browser', executable: '/never-launched' }),
    } });
    t.mock.method(f.app.auth, 'loginWithBrowser', async (url, options, username) => {
      assert.equal(url, instance); assert.equal(username, 'selected-user');
      assert.equal(options.launch, true);
      browsers++;
      const creds = { auth_method: 'gck', username, access_token: secrets[4], cookies: 'JSESSIONID=replaced' };
      f.app.auth.saveCredentials(url, creds, username);
      return creds;
    });
    t.mock.method(f.app, 'getSDKForProfile', () => ({ getCurrentUser: async () => ({ user_name: 'selected-user' }) }));
    t.mock.method(f.app, 'ok', () => assert.fail('renewal emitted a second envelope'));
    sdk.recovery = createAuthRecovery({ app: f.app, session: f.app.session, canInteract: () => true });
    f.respond();
    await sdk.request(`${instance}/api/work`);
    assert.equal(browsers, 1); assert.equal(f.counts.calls, 2);
    assert.equal(f.app.sdk, sdk);
    assert.deepEqual(f.app.config, before);
    assert.equal(f.credentials.get('selected-user').access_token, secrets[4]);
  } finally { process.chdir(previousCwd); }
});

test('auth modify persists reauth idempotently and rejects invalid policy without changing config', t => {
  const { directory, run } = isolatedCLI(t);
  const configFile = path.join(directory, 'servicenow', 'config.json');
  // saveConfig creates only the private fixture directory, never real config.
  const app = new App({ ...createConfig(), profiles: { selected: { instance_url: instance, auth_method: 'gck' } } });
  process.env.XDG_CONFIG_HOME = directory;
  const previousCwd = process.cwd(); process.chdir(directory);
  t.after(() => process.chdir(previousCwd));
  // CLI fixture seed is plain profile metadata, not credentials.
  return import('../src/config.js').then(({ saveConfig }) => {
    saveConfig(app.config);
    for (const reauth of ['auto', 'confirm', 'never']) {
      for (let repeat = 0; repeat < 2; repeat++) {
        const result = run(['auth', 'modify', '--profile', 'selected', '--reauth', reauth, '--json']);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).data.reauth, reauth);
        assert.equal(JSON.parse(readFileSync(configFile)).profiles.selected.reauth, reauth);
      }
    }
    const before = readFileSync(configFile, 'utf8');
    assert.equal(run(['auth', 'modify', '--profile', 'selected', '--reauth', 'always', '--json']).status, 2);
    assert.equal(readFileSync(configFile, 'utf8'), before);
  });
});
