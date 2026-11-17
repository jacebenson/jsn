import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { SDKClient } from '../src/sdk.js';
import { AuthManager } from '../src/auth.js';

const exec = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
const store = { load: () => null, save: () => {}, delete: () => {} };
async function server(t, handler) {
  const s = http.createServer(handler);
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  t.after(() => { s.closeAllConnections(); return new Promise(resolve => s.close(resolve)); });
  return `http://127.0.0.1:${s.address().port}`;
}

test('project cannot bind ambient OAuth or Basic secrets, explicit/global origins can', async t => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jsn-destination-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seen = [];
  const sink = await server(t, (req, res) => {
    seen.push(req.headers);
    res.setHeader('Content-Type', 'application/json');
    res.end('{"result":[]}');
  });
  fs.mkdirSync(path.join(root, '.servicenow'));
  fs.mkdirSync(path.join(root, 'xdg', 'servicenow'), { recursive: true });
  const local = path.join(root, '.servicenow/config.json');
  const global = path.join(root, 'xdg/servicenow/config.json');
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, 'xdg'), XDG_CACHE_HOME: path.join(root, 'cache'), JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1', PATH: path.join(root, 'no-store-utilities') };
  for (const key of Object.keys(env)) if (/^(SERVICENOW_|SN_)/.test(key)) delete env[key];
  const run = async (flags = [], extra = {}) => {
    try { return { ...(await exec(process.execPath, [bin, 'records', 'list', '--table', 'sys_user', '--json', ...flags], { cwd: root, env: { ...env, ...extra } })), code: 0 }; }
    catch (error) { return error; }
  };
  for (const project of [{ instance_url: sink }, { default_profile: 'bait', profiles: { bait: { instance_url: sink } } }]) {
    fs.writeFileSync(local, JSON.stringify(project));
    for (const secrets of [{ SERVICENOW_OAUTH_TOKEN: 'synthetic-ambient' }, { SERVICENOW_USERNAME: 'synthetic-user', SERVICENOW_PASSWORD: 'synthetic-password' }]) {
      const before = seen.length;
      const result = await run([], secrets);
      assert.notEqual(result.code, 0, `project-selected ambient auth must fail; sink received ${seen.length - before} request(s)`);
      assert.equal(seen.length, before, 'untrusted sink sees zero requests/secrets');
    }
  }
  fs.writeFileSync(local, JSON.stringify({ instance_url: sink }));
  assert.equal((await run(['--instance', sink], { SERVICENOW_OAUTH_TOKEN: 'synthetic-explicit' })).code, 0);
  assert.equal(seen.at(-1).authorization, 'Bearer synthetic-explicit');
  assert.equal((await run([], { SERVICENOW_INSTANCE_URL: sink, SERVICENOW_OAUTH_TOKEN: 'synthetic-env-bound' })).code, 0);
  fs.writeFileSync(global, JSON.stringify({ default_profile: 'trusted', profiles: { trusted: { instance_url: sink } } }));
  fs.writeFileSync(local, JSON.stringify({ profiles: { trusted: { instance_url: 'https://project.invalid' } } }));
  assert.equal((await run(['--profile', 'trusted'], { SERVICENOW_OAUTH_TOKEN: 'synthetic-profile' })).code, 0);
  assert.equal(seen.at(-1).authorization, 'Bearer synthetic-profile');
});

test('SDK and OAuth grants reject redirects without sending secrets to sink', async t => {
  const seen = [];
  const sink = await server(t, (req, res) => { seen.push(req.headers); res.end('{"result":[],"access_token":"synthetic"}'); });
  let status = 307;
  let originRequests = 0;
  const origin = await server(t, (req, res) => { originRequests++; res.writeHead(status, { Location: `${sink}/capture` }); res.end(); });
  const sdk = new SDKClient(origin, { getCredentials: () => ({ auth_method: 'gck', access_token: 'synthetic-token', cookies: 'synthetic-cookie' }) });
  const auth = new AuthManager({ getEffectiveInstance: () => origin }, { credentialStore: store });
  for (status of [301, 302, 303, 307, 308]) {
    for (const request of [() => sdk.list('sys_user'), () => sdk.rawRequest(`${origin}/api/now/table/sys_user`, { redirect: 'follow' }), () => sdk.fetchResponse(`${origin}/api/now/table/sys_user`), () => auth.exchangeCode(origin, 'synthetic-client', 'synthetic-code', { code_verifier: 'synthetic-verifier' }), () => auth.refreshToken(origin, { auth_method: 'oauth', refresh_token: 'synthetic-refresh' }, null)]) {
      const before = originRequests;
      await assert.rejects(request);
      assert.equal(originRequests, before + 1, 'request reached selected origin before redirect rejection');
      assert.equal(seen.length, 0, `redirect ${status}: sink sees zero secrets`);
    }
  }
});

test('non-loopback HTTP is rejected before credential lookup or network', async () => {
  let reads = 0;
  const sdk = new SDKClient('http://example.invalid', { getCredentials: () => { reads++; return { auth_method: 'gck', access_token: 'synthetic' }; } });
  await assert.rejects(() => sdk.list('sys_user'), /HTTPS/);
  assert.equal(reads, 0);
  const auth = new AuthManager({ getEffectiveInstance: () => 'http://example.invalid' }, { credentialStore: store });
  await assert.rejects(() => auth.exchangeCode('http://example.invalid', 'client', 'code', { code_verifier: 'verifier' }), /HTTPS/);
  await assert.rejects(() => auth.refreshToken('http://example.invalid', { auth_method: 'oauth', refresh_token: 'synthetic' }), /HTTPS/);
});

test('direct loopback OAuth grants and Basic requests remain supported', async t => {
  const requests = [];
  const origin = await server(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ headers: req.headers, body, path: req.url });
    res.setHeader('Content-Type', 'application/json');
    res.end(req.url === '/oauth_token.do' ? '{"access_token":"synthetic-return","refresh_token":"synthetic-next"}' : '{"result":[]}');
  });
  const saved = [];
  const auth = new AuthManager({ getEffectiveInstance: () => origin }, { credentialStore: { ...store, save: (...args) => saved.push(args) } });
  assert.equal((await auth.exchangeCode(origin, 'client', 'code', { code_verifier: 'verifier' })).access_token, 'synthetic-return');
  assert.equal((await auth.refreshToken(origin, { auth_method: 'oauth', refresh_token: 'synthetic-refresh' }, null)).access_token, 'synthetic-return');
  assert.equal(saved.length, 1);
  const sdk = new SDKClient(origin, { getCredentials: () => ({ auth_method: 'basic', username: 'synthetic-user', password: 'synthetic-password' }) });
  await sdk.list('sys_user');
  assert.equal(requests.at(-1).headers.authorization, `Basic ${Buffer.from('synthetic-user:synthetic-password').toString('base64')}`);
});

test('absolute SDK destinations cannot bypass origin binding', async t => {
  let seen = 0;
  const sink = await server(t, (req, res) => { seen++; res.end('{}'); });
  const sdk = new SDKClient('https://trusted.invalid', { getCredentials: () => { throw new Error('must not read credentials'); } });
  for (const call of [() => sdk.request(`${sink}/api/now/table/sys_user`), () => sdk.rawRequest(`${sink}/capture`), () => sdk.fetchResponse(`${sink}/capture`)]) {
    await assert.rejects(call, /outside the configured instance origin/);
  }
  assert.equal(seen, 0);
});

test('OAuth UI bootstrap cookie redirects never reach another origin', async t => {
  let seen = 0;
  const sink = await server(t, (req, res) => { seen++; res.end('{}'); });
  let posts = 0;
  const origin = await server(t, (req, res) => {
    if (req.url.startsWith('/angular.do') && ++posts === 2) {
      res.writeHead(307, { Location: `${sink}/capture` }); res.end(); return;
    }
    res.setHeader('Set-Cookie', 'JSESSIONID=synthetic-cookie; Path=/');
    res.setHeader('Content-Type', 'application/json'); res.end('{"result":[]}');
  });
  const sdk = new SDKClient(origin, { getCredentials: () => ({ auth_method: 'oauth', access_token: 'synthetic-token' }) });
  await sdk.rawRequest(`${origin}/angular.do`, { method: 'POST' });
  assert.equal(posts, 3, 'bootstrap first/final POSTs and ordinary request exercised');
  assert.equal(seen, 0);
});

test('legacy HTTP escape hatch is an explicit process choice', async t => {
  const original = globalThis.fetch;
  const prior = process.env.JSN_ALLOW_INSECURE_HTTP;
  t.after(() => {
    globalThis.fetch = original;
    if (prior === undefined) delete process.env.JSN_ALLOW_INSECURE_HTTP;
    else process.env.JSN_ALLOW_INSECURE_HTTP = prior;
  });
  let seen = 0;
  globalThis.fetch = async req => {
    seen++;
    assert.equal(new URL(req.url).origin, 'http://legacy.invalid');
    assert.equal(req.redirect, 'error');
    return new Response('{"result":[]}', { headers: { 'Content-Type': 'application/json' } });
  };
  const sdk = new SDKClient('http://legacy.invalid', { getCredentials: () => ({ auth_method: 'gck', access_token: 'synthetic' }) });
  delete process.env.JSN_ALLOW_INSECURE_HTTP;
  await assert.rejects(() => sdk.list('sys_user'), /HTTPS/);
  assert.equal(seen, 0);
  process.env.JSN_ALLOW_INSECURE_HTTP = '1';
  await sdk.list('sys_user');
  assert.equal(seen, 1);
});
