import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// Native provider session bootstrap for an OAuth-created, run-owned user.
// This uses the same /angular.do login and get_user session endpoints the JSN
// SDK uses for UI calls. It is not a browser adapter and never reuses a personal
// browser, cookie jar, profile, or credential store.
//
// Credentials and session values stay in memory and in a 0600 headers file
// under the run-owned auth fixture directory. They are never returned in
// reports, logged, or passed as command arguments.

const MAX_COOKIES = 40;
const MAX_TOKEN = 4096;

function origin(ctx) {
  const input = String(ctx.expectedHost || '');
  const url = new URL(input.includes('://') ? input : `https://${input}`);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Provider session adapter requires the explicit HTTPS target origin');
  }
  return url;
}

function jarFrom(response, jar) {
  const values = response.headers.getSetCookie?.() || [];
  for (const value of values) {
    const pair = String(value).split(';', 1)[0].trim();
    const separator = pair.indexOf('=');
    if (separator > 0) jar.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  if (jar.size > MAX_COOKIES) throw new Error('Provider returned too many session cookies');
}

function cookieHeader(jar) {
  if (!jar.size) throw new Error('Provider session bootstrap returned no cookies');
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function writeHeaders(user, token, cookies) {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN || /[\r\n]/.test(token)) {
    throw new Error('Provider session bootstrap returned no usable user token');
  }
  const name = `session-${randomBytes(8).toString('hex')}.txt`;
  const file = path.join(user.root, name);
  await fs.writeFile(file, `X-UserToken: ${token}\nCookie: ${cookies}\n`, { mode: 0o600, flag: 'wx' });
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
    throw new Error('Provider session headers file is not private');
  }
  return file;
}

async function login(ctx, user, fetchImpl) {
  const base = origin(ctx).origin;
  if (!user?.username || !user?.password || !user?.root) throw new Error('Run-owned provider credentials are required');
  const jar = new Map();
  let loginResponse;
  try {
    loginResponse = await fetchImpl(`${base}/angular.do?sysparm_type=view_form.login`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      sysparm_type: 'login',
      'ni.nolog.user_password': 'true',
      user_name: user.username,
      user_password: user.password,
    }).toString(),
    signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new Error('Provider login transport failed');
  }
  jarFrom(loginResponse, jar);
  if (loginResponse.status !== 200) throw new Error('Provider login was rejected for the run-owned account');

  let getuser;
  try {
    getuser = await fetchImpl(`${base}/angular.do?sysparm_type=get_user`, {
      method: 'POST',
      redirect: 'error',
      headers: { Cookie: cookieHeader(jar) },
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new Error('Provider session read transport failed');
  }
  jarFrom(getuser, jar);
  const token = getuser.headers.get('x-usertoken-response') || '';
  const cookies = cookieHeader(jar);
  const headersFile = await writeHeaders(user, token, cookies);
  return { source: 'isolated-provider-login', headersFile, cookies, token, jar };
}

export function createProviderSessionAdapter({ fetchImpl = fetch } = {}) {
  return {
    async acquire({ ctx, user }) {
      return login(ctx, user, fetchImpl);
    },
    async expire({ ctx, session }) {
      if (!session?.cookies || !session?.token) throw new Error('No run-owned provider session to expire');
      let response;
      try {
        response = await fetchImpl(`${origin(ctx).origin}/logout.do`, {
          method: 'POST',
          redirect: 'manual',
          headers: { Cookie: session.cookies, 'X-UserToken': session.token },
          signal: AbortSignal.timeout(30000),
        });
      } catch {
        throw new Error('Provider session expiry transport failed');
      }
      if (![200, 302, 303].includes(response.status)) throw new Error('Provider session expiry was not acknowledged');
    },
    async renew({ ctx, user }) {
      return login(ctx, user, fetchImpl);
    },
  };
}
