// TOTP MFA challenge during Basic authentication (issue #402).
//
// There is no live MFA-enabled instance in this workspace, so these tests pin
// the protocol shape the challenge implementation accepts, using a mock HTTP
// transport that replays login-page/JSON variants. They also pin the parts
// that must not change for non-MFA Basic logins.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SDKClient } from '../src/sdk.js';
import { PromptCancelled } from '../src/prompts.js';
import {
  buildMfaVerificationBody, extractMfaFormTokens, mfaVerificationOutcome,
  normalizeTotpCode, parseLoginStatus,
} from '../src/auth/mfa.js';
import { errMfaRequired, renderAppError } from '../src/errors.js';

const BASE = 'https://mfa.invalid';
const CODE = '123456';

function respond({ status = 200, body = '', headers = {}, cookies = [] } = {}) {
  const responseHeaders = new Headers(headers);
  for (const cookie of cookies) responseHeaders.append('set-cookie', cookie);
  return new Response(body, { status, headers: responseHeaders });
}

function jsonLogin(status, message = '') {
  return respond({
    body: JSON.stringify({ status, message }),
    headers: { 'content-type': 'application/json' },
    cookies: ['JSESSIONID=login-secret; Path=/'],
  });
}

function mfaForm({ csrf = 'CK-1', nonce = 'NONCE-1' } = {}) {
  return respond({
    body: `<html><form><input name="sysparm_ck" type="hidden" value="${csrf}"><input type="hidden" name="sysparm_process_nonce" value="${nonce}"></form></html>`,
    headers: { 'content-type': 'text/html' },
    cookies: ['JSESSIONID=challenge-secret; Path=/'],
  });
}

/**
 * Install a fetch mock that routes the four login endpoints plus table calls.
 * Every call records method, path, headers and body for continuity assertions.
 */
function installTransport(t, {
  login = () => jsonLogin('mfa_code_required'),
  form = () => mfaForm(),
  verify = () => respond({ status: 302, headers: { location: '/navpage.do' }, cookies: ['JSESSIONID=session-secret; Path=/'] }),
  table = () => respond({ body: JSON.stringify({ result: { sys_id: 'rec-1' } }) }),
} = {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (request) => {
    const url = new URL(request.url);
    const body = request.body ? await request.text() : '';
    const call = { method: request.method, path: url.pathname, search: url.search, headers: request.headers, body };
    calls.push(call);
    if (call.path === '/angular.do' && url.searchParams.get('sysparm_type') === 'view_form.login') return login(call);
    if (call.path === '/angular.do' && url.searchParams.get('sysparm_type') === 'get_user') {
      return respond({ headers: { 'x-usertoken-response': 'user-token-1' }, cookies: ['JSESSIONID=session-secret; Path=/'] });
    }
    if (call.path === '/validate_multifactor_auth_code.do') return form(call);
    if (call.path === '/validate_mfa_code.do') return verify(call);
    return table(call);
  });
  return calls;
}

function basicClient(opts = {}) {
  return new SDKClient(BASE, {
    getCredentials: async () => ({ auth_method: 'basic', username: 'admin', password: 'fixture-password' }),
  }, opts);
}

describe('MFA login protocol helpers', () => {
  it('recognizes the challenge distinct from wrong credentials', () => {
    assert.deepEqual(parseLoginStatus(JSON.stringify({ status: 'mfa_code_required' })),
      { status: 'mfa_code_required', message: '' });
    assert.deepEqual(parseLoginStatus(JSON.stringify({ status: 'error', message: 'Incorrect user name or password.' })),
      { status: 'error', message: 'Incorrect user name or password.' });
    // An HTML login page or garbage body must not be guessed at.
    for (const body of ['', '<html>login</html>', 'null', '[]', '"mfa_code_required"']) {
      assert.equal(parseLoginStatus(body), null);
    }
  });

  it('extracts the challenge CSRF and nonce in either attribute order', () => {
    assert.deepEqual(
      extractMfaFormTokens('<input name="sysparm_ck" type="hidden" value="CK-1"><input value="N-1" name="sysparm_process_nonce">'),
      { csrf: 'CK-1', processNonce: 'N-1' },
    );
    assert.deepEqual(extractMfaFormTokens('<html></html>'), { csrf: '', processNonce: '' });
  });

  it('requires an explicit redirect for success and treats x-mfa_token: invalid as rejection', () => {
    assert.equal(mfaVerificationOutcome({ status: 302 }), 'success');
    assert.equal(mfaVerificationOutcome({ status: 302, mfaToken: 'invalid' }), 'invalid');
    assert.equal(mfaVerificationOutcome({ status: 200, mfaToken: 'invalid' }), 'invalid');
    assert.equal(mfaVerificationOutcome({ status: 200 }), 'unexpected');
    assert.equal(mfaVerificationOutcome({ status: 500 }), 'unexpected');
  });

  it('normalizes spaced or hyphenated codes and rejects other shapes', () => {
    assert.equal(normalizeTotpCode('123456'), CODE);
    assert.equal(normalizeTotpCode(' 123 456 '), CODE);
    assert.equal(normalizeTotpCode('123-456'), CODE);
    assert.equal(normalizeTotpCode('12345'), '');
    assert.equal(normalizeTotpCode('1234567'), '');
    assert.equal(normalizeTotpCode('abcdef'), '');
  });

  it('does not put the code in any field except the verification response', () => {
    const body = buildMfaVerificationBody({ csrf: 'CK', processNonce: 'N', code: CODE });
    assert.equal(body.get('txtResponse'), CODE);
    assert.equal(body.get('sysparm_ck'), 'CK');
    assert.equal(body.get('sysparm_process_nonce'), 'N');
    assert.equal(body.get('sys_action'), 'sysverb_validate_mfa_code');
    assert.equal(body.get('sys_mfa_factor_validate'), 'TOTP');
  });
});

describe('Basic authentication with a TOTP challenge', () => {
  it('prompts once, keeps the challenge cookie jar, and authenticates the pending request', async (t) => {
    const calls = installTransport(t);
    const prompts = [];
    const client = basicClient({
      canInteract: () => true,
      promptMfaCode: async ({ message }) => { prompts.push(message); return CODE; },
    });
    const result = await client.request(`${BASE}/api/now/table/incident?sysparm_limit=1`);
    assert.deepEqual(result, { result: { sys_id: 'rec-1' } });
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /6-digit/);
    assert.match(prompts[0], /mfa\.invalid/);

    const paths = calls.map(call => `${call.method} ${call.path}`);
    assert.deepEqual(paths, [
      'POST /angular.do',
      'GET /validate_multifactor_auth_code.do',
      'POST /validate_mfa_code.do',
      'POST /angular.do',
      'GET /api/now/table/incident',
    ]);

    // The challenge GET reuses the cookie from the login POST...
    assert.match(calls[1].headers.get('cookie'), /JSESSIONID=login-secret/);
    // ...and the verification POST carries the rotated challenge cookie.
    assert.match(calls[2].headers.get('cookie'), /JSESSIONID=challenge-secret/);
    assert.doesNotMatch(calls[2].headers.get('cookie'), /login-secret/);
    // CSRF/nonce from that exact GET are bound into the POST.
    const verifyBody = new URLSearchParams(calls[2].body);
    assert.equal(verifyBody.get('sysparm_ck'), 'CK-1');
    assert.equal(verifyBody.get('sysparm_process_nonce'), 'NONCE-1');
    assert.equal(verifyBody.get('txtResponse'), CODE);

    // The actual operation uses the authenticated session, never Basic.
    const request = calls[4];
    assert.match(request.headers.get('cookie'), /JSESSIONID=session-secret/);
    assert.equal(request.headers.get('x-usertoken'), 'user-token-1');
    assert.equal(request.headers.get('authorization'), null);
  });

  it('does not prompt or challenge for an ordinary wrong password', async (t) => {
    const calls = installTransport(t, {
      login: () => jsonLogin('error', 'Incorrect user name or password.'),
      table: () => respond({ status: 401, body: 'denied' }),
    });
    let prompts = 0;
    const client = basicClient({ canInteract: () => true, promptMfaCode: async () => { prompts++; return CODE; } });
    await assert.rejects(client.request(`${BASE}/api/now/table/incident`),
      (error) => error.code === 'auth_error' && error.status === 401);
    assert.equal(prompts, 0);
    assert.equal(calls.some(call => call.path.startsWith('/validate_mfa')), false);
    // Existing behavior is preserved: the operation itself is still attempted
    // (and fails with a 401) rather than being turned into an MFA prompt.
    assert.equal(calls.at(-1).path, '/api/now/table/incident');
  });

  it('retries a rejected code with a fresh code and completes within the bound', async (t) => {
    const codes = ['111111', '222222', '333333'];
    const calls = installTransport(t, {
      verify: (call) => new URLSearchParams(call.body).get('txtResponse') === codes.at(-1)
        ? respond({ status: 302, cookies: ['JSESSIONID=session-secret; Path=/'] })
        : respond({ status: 200, headers: { 'x-mfa_token': 'invalid' } }),
    });
    const prompted = [];
    const client = basicClient({
      canInteract: () => true,
      promptMfaCode: async ({ message }) => {
        prompted.push(message);
        return codes[prompted.length - 1];
      },
    });
    await client.request(`${BASE}/api/now/table/incident`);
    assert.equal(prompted.length, 3);
    assert.match(prompted[1], /Code rejected/);
    assert.match(prompted[2], /attempt 3 of 3/);
    assert.equal(calls.filter(call => call.path === '/validate_mfa_code.do').length, 3);
  });

  it('fails after the bounded attempts without sending the pending operation', async (t) => {
    const calls = installTransport(t, {
      verify: () => respond({ status: 200, headers: { 'x-mfa_token': 'invalid' } }),
    });
    let prompts = 0;
    const mutations = [];
    const client = basicClient({
      canInteract: () => true,
      promptMfaCode: async () => { prompts++; return '444444'; },
      onMutation: (event) => mutations.push(event),
    });
    await assert.rejects(client.create('incident', { short_description: 'must not run' }),
      (error) => error.code === 'mfa_code_rejected' && /after 3 attempts/.test(error.message));
    assert.equal(prompts, 3);
    assert.equal(calls.filter(call => call.path === '/validate_mfa_code.do').length, 3);
    assert.equal(calls.some(call => call.path === '/api/now/table/incident'), false);
    assert.deepEqual(mutations, []);
  });

  it('propagates cancellation without sending the operation or recording a mutation', async (t) => {
    const calls = installTransport(t);
    const mutations = [];
    const client = basicClient({
      canInteract: () => true,
      promptMfaCode: async () => { throw new PromptCancelled(); },
      onMutation: (event) => mutations.push(event),
    });
    await assert.rejects(client.create('incident', { short_description: 'cancelled' }),
      (error) => error.name === 'PromptCancelled');
    assert.equal(calls.some(call => call.path === '/api/now/table/incident'), false);
    assert.deepEqual(mutations, []);
    assert.equal(calls.some(call => call.path === '/validate_mfa_code.do'), false);

    const rendered = renderAppError(new PromptCancelled());
    assert.equal(rendered.exitCode, 0);
    assert.equal(rendered.text, 'Cancelled.\n');
  });

  it('fails promptly with a structured mfa_required error when no human is reachable', async (t) => {
    const calls = installTransport(t);
    let prompts = 0;
    const client = basicClient({ canInteract: () => false, promptMfaCode: async () => { prompts++; return CODE; } });
    await assert.rejects(client.request(`${BASE}/api/now/table/incident`), (error) => {
      assert.equal(error.code, 'mfa_required');
      assert.equal(error.notSent, true);
      assert.match(error.message, /interactive prompt/i);
      assert.match(error.hint, /--oauth/);
      assert.match(error.hint, /--gck/);
      return true;
    });
    assert.equal(prompts, 0);
    assert.equal(calls.some(call => call.path === '/validate_multifactor_auth_code.do'), false);
    assert.equal(calls.some(call => call.path === '/api/now/table/incident'), false);
  });

  it('caches the challenge failure so later requests cannot re-prompt or burn codes', async (t) => {
    const calls = installTransport(t);
    let prompts = 0;
    const client = basicClient({ canInteract: () => false, promptMfaCode: async () => { prompts++; return CODE; } });
    await assert.rejects(client.request(`${BASE}/api/now/table/incident`), (error) => error.code === 'mfa_required');
    await assert.rejects(client.request(`${BASE}/api/now/table/problem`), (error) => error.code === 'mfa_required');
    assert.equal(prompts, 0);
    assert.equal(calls.filter(call => call.path === '/angular.do' && call.search.includes('view_form.login')).length, 1);
  });

  it('never leaks the code, cookies, or tokens into diagnostics', async (t) => {
    installTransport(t, {
      verify: () => respond({ status: 200, headers: { 'x-mfa_token': 'invalid' } }),
    });
    const client = basicClient({ canInteract: () => true, promptMfaCode: async () => '987654' });
    let failure;
    try {
      await client.request(`${BASE}/api/now/table/incident`);
    } catch (error) {
      failure = error;
    }
    const rendered = JSON.stringify({ ...failure, stack: undefined });
    for (const secret of ['987654', 'fixture-password', 'JSESSIONID', 'login-secret', 'challenge-secret', 'user-token-1', 'CK-1', 'NONCE-1']) {
      assert.equal(rendered.includes(secret), false, `diagnostics leaked ${secret}`);
    }
    assert.match(rendered, /mfa_code_rejected/);
  });

  it('does not start the request timeout while the human is entering a code', async (t) => {
    installTransport(t);
    const client = basicClient({
      timeout: 20,
      canInteract: () => true,
      // A prompt that outlives the request timeout: the operation must still
      // run, because authentication time is not instance-operation time.
      promptMfaCode: async () => { await new Promise(resolve => setTimeout(resolve, 60)); return CODE; },
    });
    const result = await client.request(`${BASE}/api/now/table/incident`);
    assert.deepEqual(result, { result: { sys_id: 'rec-1' } });
  });

  it('reports an expired/absent challenge form instead of guessing', async (t) => {
    const calls = installTransport(t, { form: () => respond({ body: '<html>session expired</html>' }) });
    const client = basicClient({ canInteract: () => true, promptMfaCode: async () => CODE });
    await assert.rejects(client.request(`${BASE}/api/now/table/incident`),
      (error) => error.code === 'mfa_code_rejected' && /did not return a usable MFA verification form/.test(error.message));
    assert.equal(calls.some(call => call.path === '/validate_mfa_code.do'), false);
    assert.equal(calls.some(call => call.path === '/api/now/table/incident'), false);
  });

  it('rejects unexpected verification responses as failures, not success', async (t) => {
    installTransport(t, { verify: () => respond({ status: 500, body: 'gateway' }) });
    const client = basicClient({ canInteract: () => true, promptMfaCode: async () => CODE });
    await assert.rejects(client.request(`${BASE}/api/now/table/incident`),
      (error) => error.code === 'mfa_code_rejected' && /HTTP 500/.test(error.message));
  });

  it('preserves non-MFA Basic session warming', async (t) => {
    const calls = installTransport(t, {
      login: () => jsonLogin('success'),
      table: () => respond({ body: JSON.stringify({ result: [] }) }),
    });
    let prompts = 0;
    const client = basicClient({ canInteract: () => true, promptMfaCode: async () => { prompts++; return CODE; } });
    const cookies = await client._warmSession();
    assert.match(cookies, /JSESSIONID=session-secret/);
    assert.equal(client.sessionUserToken, 'user-token-1');
    assert.equal(prompts, 0);
    assert.equal(calls.some(call => call.path.startsWith('/validate_mfa')), false);
  });
});

describe('MFA error rendering', () => {
  it('renders mfa_required as an auth-class failure with actionable guidance', () => {
    const text = renderAppError(errMfaRequired(BASE));
    assert.equal(text.stream, 'stderr');
    assert.equal(text.exitCode, 1);
    assert.match(text.text, /Error \(mfa_required\)/);
    assert.match(text.text, /Hint: .*interactive terminal/);
    assert.doesNotMatch(text.text, /fixture-password|JSESSIONID/);
  });

  it('keeps the existing auth label for auth_error', () => {
    const error = new Error('Authentication rejected for the active profile (HTTP 401).');
    error.code = 'auth_error';
    const text = renderAppError(error);
    assert.match(text.text, /^Error \(auth\):/);
    assert.equal(text.exitCode, 1);
  });
});
