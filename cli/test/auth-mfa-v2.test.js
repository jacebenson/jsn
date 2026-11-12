import test from 'node:test';
import assert from 'node:assert/strict';
import { SDKClient } from '../src/sdk.js';
import { interactiveList } from '../src/helpers.js';
import { renderAppError } from '../src/errors.js';
import { PassThrough } from 'node:stream';
import { mfaCode } from '../src/prompts.js';
import { recordsCmd } from '../src/commands/records.js';
import { App } from '../src/app.js';

function interactiveTerminal(t) {
  for (const stream of [process.stdin, process.stdout]) {
    const descriptor = Object.getOwnPropertyDescriptor(stream, 'isTTY');
    Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
    t.after(() => { if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor); else delete stream.isTTY; });
  }
  for (const key of ['CI', 'NONINTERACTIVE', 'GITHUB_ACTIONS', 'JSN_NO_PROMPTS', 'TERM', 'CLAUDE_CODE', 'COPILOT_AGENT', 'VSCODE_AGENT', 'CURSOR_AGENT', 'CODEX_AGENT', 'GITHUB_COPILOT_AGENT']) {
    const value = process.env[key];
    delete process.env[key];
    t.after(() => { if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  }
}

const credentials = { auth_method: 'basic', username: 'fixture-user', password: 'fixture-password' };
const form = '<input name="sysparm_ck" value="fixture-csrf"><input name="sysparm_process_nonce" value="fixture-nonce">';
const reply = (body, status = 200, headers = {}) => new Response(body, { status, headers });
function harness(t, { failure = '', canInteract = true, prompt, timeout = 100, invalid = false } = {}) {
  const requests = [], mutations = [];
  let prompts = 0;
  t.mock.method(globalThis, 'fetch', async request => {
    requests.push(request);
    const url = new URL(request.url);
    const delayedStage = {
      'verify-timeout': '/validate_mfa_code.do',
      'user-timeout': '/angular.do',
      'identity-timeout': '/api/now/table/sys_user',
    }[failure];
    if (url.pathname === delayedStage && url.searchParams.get('sysparm_type') !== 'view_form.login') {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(reply('{}')), 80);
        request.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
      });
    }
    if (url.searchParams.get('sysparm_type') === 'view_form.login') return reply('{"status":"mfa_code_required"}', 200, { 'Set-Cookie': 'session=pending' });
    if (url.pathname === '/validate_multifactor_auth_code.do') {
      assert.equal(request.headers.get('Authorization'), null);
      assert.match(request.headers.get('Cookie'), /session=pending/);
      if (failure === 'transport') throw new TypeError('secret transport detail');
      if (failure === 'timeout') return new Promise((resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        // Bound the unfixed fixture too, so red cannot hang the test runner.
        setTimeout(() => resolve(reply(form)), 80);
      });
      if (failure === 'body-timeout') return new Response(new ReadableStream({ start(controller) { setTimeout(() => { controller.enqueue(new TextEncoder().encode(form)); controller.close(); }, 80); } }));
      return reply(failure === 'form' ? 'unusable' : form, 200, { 'Set-Cookie': 'route=fixture' });
    }
    if (url.pathname === '/validate_mfa_code.do') {
      assert.equal(request.headers.get('Authorization'), null);
      assert.match(request.headers.get('Cookie'), /route=fixture/);
      const body = new URLSearchParams(await request.text());
      assert.equal(body.get('sysparm_ck'), 'fixture-csrf');
      assert.equal(body.get('sysparm_process_nonce'), 'fixture-nonce');
      assert.equal(body.get('txtResponse'), '123456');
      if (invalid) return reply('', 200, { 'x-mfa_token': 'invalid' });
      return reply('', 302, { Location: failure === 'login' ? '/login.do' : '/navpage.do', 'Set-Cookie': 'session=verified' });
    }
    if (url.searchParams.get('sysparm_type') === 'get_user') {
      assert.equal(request.headers.get('Authorization'), null);
      return reply(failure === 'guest' || failure === 'login' ? 'guest' : '{}', 200,
        failure === 'guest' || failure === 'login' ? {} : { 'x-usertoken-response': 'fixture-token' });
    }
    if (url.pathname === '/api/now/table/sys_user') return reply(JSON.stringify({ result: [{ user_name: failure === 'identity' ? 'other-user' : 'fixture-user' }] }));
    assert.equal(request.headers.get('Authorization'), null, 'pending operation must use the verified cookie session');
    assert.match(request.headers.get('Cookie'), /session=verified/);
    assert.equal(request.headers.get('X-UserToken'), 'fixture-token');
    return reply('{"result":{"sys_id":"fixture-created"}}');
  });
  const client = new SDKClient('https://fixture.invalid', { getCredentials: async () => credentials }, {
    timeout, canInteract: () => canInteract,
    promptMfaCode: async () => { prompts++; return prompt ? prompt() : '123456'; },
    onMutation: event => mutations.push(event),
  });
  return { client, requests, mutations, prompts: () => prompts };
}

test('public raw response waits for verified MFA and leaves its body unread', async t => {
  const h = harness(t);
  const response = await h.client.fetchResponse('https://fixture.invalid/api/now/wfa_fluent/activate_flows', { method: 'POST' });
  assert.equal(response.bodyUsed, false);
  assert.deepEqual(await response.json(), { result: { sys_id: 'fixture-created' } });
  assert.equal(h.prompts(), 1);
});

test('Basic REST operations complete MFA, rotate cookies, verify identity and then dispatch', async t => {
  const h = harness(t);
  assert.equal((await h.client.create('incident', { short_description: 'fixture' })).sys_id, 'fixture-created');
  assert.equal(h.prompts(), 1);
  assert.equal(h.mutations.length, 1);
});
for (const failure of ['transport', 'form', 'login', 'guest', 'identity', 'timeout', 'body-timeout', 'verify-timeout', 'user-timeout', 'identity-timeout']) {
  test(`recognized MFA ${failure} is terminal before dispatch and stays terminal`, async t => {
    const h = harness(t, { failure, timeout: failure.includes('timeout') ? 10 : 100 });
    await assert.rejects(h.client.create('incident', {}), e => e.code === 'mfa_code_rejected' && e.notSent === true && !e.message.includes('secret'));
    const before = h.requests.length;
    await assert.rejects(h.client.create('incident', {}), { code: 'mfa_code_rejected' });
    assert.equal(h.requests.length, before);
    assert.equal(h.mutations.length, 0);
    assert.ok(!h.requests.some(r => new URL(r.url).pathname === '/api/now/table/incident'));
    if (failure.includes('timeout')) assert.ok(h.requests.some(r => r.signal.aborted));
  });
}
test('noninteractive MFA is actionable, stable and never dispatches', async t => {
  const h = harness(t, { canInteract: false });
  await assert.rejects(h.client.create('incident', {}), e => e.code === 'mfa_required' && /--json\/--get/.test(e.hint));
  assert.equal(h.prompts(), 0);
  assert.equal(h.mutations.length, 0);
});
test('rejected codes stop at three attempts without recording a mutation', async t => {
  const h = harness(t, { invalid: true });
  await assert.rejects(h.client.create('incident', {}), { code: 'mfa_code_rejected' });
  assert.equal(h.prompts(), 3);
  assert.equal(h.mutations.length, 0);
});
test('human typing does not consume the pending operation deadline', async t => {
  const h = harness(t, { timeout: 25, prompt: async () => { await new Promise(r => setTimeout(r, 70)); return '123456'; } });
  await h.client.create('incident', {});
  assert.equal(h.mutations.length, 1);
});
test('Escape through interactive records count path keeps Cancelled without fallback', async t => {
  const cancelled = Object.assign(new Error('Cancelled.'), { name: 'PromptCancelled' });
  const h = harness(t, { prompt: () => { throw cancelled; } });
  const app = { requireInstance() {}, output: { getFormat: () => 'auto' }, sdk: h.client };
  await assert.rejects(interactiveList({ app, table: 'sys_user', singular: 'user', columns: ['user_name'], promptFn: async () => null }), e => {
    assert.equal(e, cancelled);
    assert.equal(renderAppError(e).exitCode, 0);
    return true;
  });
  assert.equal(h.requests.length, 1);
});
test('interactive records preserves structured MFA errors before aggregate fallback', async t => {
  const h = harness(t, { canInteract: false });
  const app = { requireInstance() {}, output: { getFormat: () => 'auto' }, sdk: h.client };
  await assert.rejects(interactiveList({ app, table: 'sys_user', singular: 'user', columns: ['user_name'], promptFn: async () => null }), { code: 'mfa_required' });
  assert.equal(h.requests.length, 1);
});

test('actual records list handler preserves Escape from the masked code prompt', async t => {
  interactiveTerminal(t);
  const input = new PassThrough(), output = new PassThrough();
  let visible = '';
  output.on('data', chunk => { visible += chunk; });
  const h = harness(t, { prompt: () => {
    const pending = mfaCode({ message: 'Authenticator code' }, { input, output });
    setImmediate(() => input.write('\x1b'));
    return pending;
  } });
  let handler;
  const registration = { command(command) { if (command.command === 'list') handler = command.handler; return this; } };
  recordsCmd(fn => fn).builder(registration);
  const app = { requireInstance() {}, output: { getFormat: () => 'auto' }, sdk: h.client,
    ok() { assert.fail('cancelled records command must not report success'); } };
  await assert.rejects(handler({ table: 'sys_user', limit: 20 }, app), e => {
    assert.equal(e.name, 'PromptCancelled');
    assert.deepEqual(renderAppError(e), { stream: 'stderr', text: 'Cancelled.\n', exitCode: 0 });
    return true;
  });
  assert.equal(h.requests.length, 1);
  assert.equal(h.mutations.length, 0);
  assert.equal(input.listenerCount('keypress'), 0);
  assert.doesNotMatch(visible, /fixture-password|123456/);
});

for (const name of ['PromptCancelled', 'mfa_required', 'mfa_code_rejected']) {
  test(`aggregate fallback preserves ${name} from the list probe`, async () => {
    const error = Object.assign(new Error('fixture'), name === 'PromptCancelled' ? { name } : { code: name });
    const app = { requireInstance() {}, output: { getFormat: () => 'auto' }, sdk: {
      aggregateCount: async () => { throw new Error('count unavailable'); },
      list: async () => { throw error; },
    } };
    await assert.rejects(interactiveList({ app, table: 'sys_user', singular: 'user', columns: [], promptFn: async () => null }), e => e === error);
  });
}

for (const mode of ['json', 'get']) {
  test(`App-created Basic client refuses MFA in ${mode} output even with a TTY`, async t => {
    interactiveTerminal(t);
    const h = harness(t);
    const app = { auth: { createProfileProvider: () => ({ getCredentials: async () => credentials }) },
      output: { getFormat: () => mode === 'json' ? 'json' : 'auto' },
      _authArgv: mode === 'get' ? { get: 'data' } : {}, recordMutation: () => assert.fail('not sent'),
    };
    const client = App.prototype.getSDKForProfile.call(app, 'https://fixture.invalid');
    await assert.rejects(client.create('incident', {}), { code: 'mfa_required' });
    assert.equal(h.requests.length, 1);
  });
}
for (const path of ['/api/now/table/incident', '/api/now/stats/incident', '/api/now/v1/batch']) {
  test(`Basic MFA gate precedes ${path} without the warm override`, async t => {
    const h = harness(t, { canInteract: false });
    await assert.rejects(h.client.request(`https://fixture.invalid${path}`), { code: 'mfa_required' });
    assert.equal(h.requests.length, 1);
  });
}
for (const [label, status, body, expected] of [
  ['bad credentials', 401, '{"status":"failure"}', 'auth_error'],
  ['ACL', 403, '{"status":"failure"}', 'forbidden'],
  ['proxy text', 502, 'gateway unavailable', 'api_error'],
]) {
  test(`${label} is not misclassified as an MFA challenge`, async t => {
    let prompted = 0;
    const client = new SDKClient('https://fixture.invalid', { getCredentials: async () => credentials }, {
      promptMfaCode: () => { prompted++; assert.fail('not an MFA challenge'); },
    });
    t.mock.method(globalThis, 'fetch', async () => reply(body, status));
    await assert.rejects(client.list('incident'), { code: expected });
    assert.equal(prompted, 0);
  });
}
test('ordinary transport failure is not classified as MFA', async t => {
  const failure = new TypeError('offline fixture');
  const client = new SDKClient('https://fixture.invalid', { getCredentials: async () => credentials });
  t.mock.method(globalThis, 'fetch', async () => { throw failure; });
  await assert.rejects(client.list('incident'), e => e === failure);
});
