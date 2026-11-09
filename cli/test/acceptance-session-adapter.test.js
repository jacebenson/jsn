import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProviderSessionAdapter } from '../scripts/acceptance/session-adapter.mjs';

const TOKEN = 'synthetic-usertoken-value';
const COOKIE_A = 'JSESSIONID=synthetic-session';
const COOKIE_B = 'glide_session_store=synthetic-store';
const host = 'https://pdi.example.test';

function response(status, headers = {}) {
  const h = new Headers(headers);
  return new Response('', { status, headers: h });
}

test('provider session adapter logs in, writes a private header file, expires and renews', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jsn-session-adapter-'));
  await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const adapter = createProviderSessionAdapter({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith('/angular.do?sysparm_type=view_form.login')) {
        assert.match(options.body, /user_name=fixture-user/);
        assert.match(options.body, /user_password=/);
        return response(200, { 'set-cookie': `${COOKIE_A}; Path=/; Secure; HttpOnly` });
      }
      if (url.endsWith('/angular.do?sysparm_type=get_user')) {
        assert.equal(options.headers.Cookie, COOKIE_A);
        return response(200, {
          'set-cookie': `${COOKIE_B}; Path=/; Secure; HttpOnly`,
          'x-usertoken-response': TOKEN
        });
      }
      if (url.endsWith('/logout.do')) {
        assert.match(options.headers.Cookie, /glide_session_store/);
        assert.equal(options.headers['X-UserToken'], TOKEN);
        return response(302, { location: '/logout_success.do' });
      }
      throw new Error(`Unexpected URL ${url}`);
    }
  });
  const ctx = { expectedHost: host };
  const user = { username: 'fixture-user', password: 'synthetic-password', root };

  const session = await adapter.acquire({ ctx, user });
  assert.equal(session.source, 'isolated-provider-login');
  assert.ok(path.isAbsolute(session.headersFile));
  const stat = await fs.lstat(session.headersFile);
  assert.equal(stat.mode & 0o777, 0o600);
  const text = await fs.readFile(session.headersFile, 'utf8');
  assert.match(text, new RegExp(`X-UserToken: ${TOKEN}`));
  assert.match(text, /Cookie: .*glide_session_store=synthetic-store/);

  await adapter.expire({ ctx, session });
  assert.equal(calls.filter(call => call.url.endsWith('/logout.do')).length, 1);

  const renewed = await adapter.renew({ ctx, user });
  assert.equal(renewed.source, 'isolated-provider-login');
  assert.notEqual(renewed.headersFile, session.headersFile);
  assert.equal((await fs.lstat(renewed.headersFile)).mode & 0o777, 0o600);
});

test('provider session adapter rejects a target that is not an explicit HTTPS origin', async () => {
  const adapter = createProviderSessionAdapter({ fetchImpl: async () => response(500) });
  await assert.rejects(
    adapter.acquire({ ctx: { expectedHost: 'http://pdi.example.test' }, user: { username: 'u', password: 'p', root: '/tmp' } }),
    /explicit HTTPS target origin/
  );
});
