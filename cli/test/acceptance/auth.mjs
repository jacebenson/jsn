import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

const ID = /^[a-f0-9]{32}$/i;
const KEY = /^[a-zA-Z0-9_-]{8,80}$/;
const PRIVATE = 'auth.fixtures';
const value = v => v && typeof v === 'object' ? v.value : v;
const data = r => r?.json?.data ?? r?.json;
const rows = r => data(r)?.records;
const check = (ok, message) => { if (!ok) throw new Error(message); };
export function blocked(reason) { return { status: 'blocked', reason }; }

function origin(ctx) {
  const input = ctx.expectedHost || '';
  const url = new URL(input.includes('://') ? input : `https://${input}`);
  check(url.protocol === 'https:' && !url.username && !url.password && !url.port && url.pathname === '/' && !url.search && !url.hash, 'Invalid explicit auth target origin');
  return url;
}

export function validateAuthConfig(ctx, config = {}) {
  check(ctx.mode === 'pdi', 'Auth fixtures require the explicitly authorized PDI mode');
  check(KEY.test(ctx.runKey || ''), 'Auth fixtures require a safe unique run key');
  check(typeof ctx.command === 'function' && typeof ctx.read === 'function' && typeof ctx.registerArtifact === 'function', 'Missing guarded runner operations');
  check(ctx.state instanceof Map && path.isAbsolute(ctx.outputDir || ''), 'Missing private run state/output directory');
  check(typeof ctx.profile === 'string' && ctx.profile.length > 0, 'Missing explicit OAuth profile');
  check(ctx.expectedHost && !/[\s]/.test(ctx.expectedHost), 'Missing explicit expected hostname');
  origin(ctx);
  check(Object.keys(config).every(k => ['roles', 'domain'].includes(k)), 'Unknown auth fixture configuration');
  check(Array.isArray(config.roles ?? []) && (config.roles ?? []).length <= 8, 'Invalid least-privilege role configuration');
  for (const role of config.roles ?? []) check(/^[a-z0-9_.-]{1,80}$/i.test(role) && !/admin/i.test(role), 'Administrative/invalid roles are forbidden in auth fixtures');
  if (config.domain !== undefined) check(config.domain === 'global' || ID.test(config.domain), 'Invalid observed fixture domain');
  return { roles: [...new Set(config.roles ?? [])], domain: config.domain };
}

export async function loadAuthConfig(ctx, file) {
  check(ctx.mode === 'pdi', 'Auth configuration requires PDI mode');
  const stat = await fs.lstat(file);
  check(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600 && stat.size <= 8192, 'Auth configuration requires a private bounded regular file');
  const input = JSON.parse(await fs.readFile(file, 'utf8'));
  check(Object.keys(input).every(key => ['profile', 'expectedHost', 'roles', 'domain'].includes(key)), 'Unknown auth configuration field');
  check(input.profile === ctx.profile && input.expectedHost === ctx.expectedHost, 'Auth configuration target/profile mismatch');
  const config = validateAuthConfig(ctx, { roles: input.roles, ...(input.domain === undefined ? {} : { domain: input.domain }) });
  ctx.state.set('auth.config', config);
}

async function privateFile(directory, name, body) {
  const target = path.join(directory, name);
  await fs.writeFile(target, typeof body === 'string' ? body : JSON.stringify(body), { mode: 0o600, flag: 'wx' });
  return target;
}

// Mask every ambient credential source. PATH excludes secret-tool, so an
// isolated test profile cannot read/write the desktop keyring. Node is launched
// by the runner using an absolute executable path, not this PATH.
export function fixtureEnvironment(ctx, root, username, password = '') {
  const env = Object.fromEntries(Object.keys(process.env)
    .filter(k => /^SN_.*_(USERNAME|PASSWORD)$/.test(k)).map(k => [k, '']));
  const hostKey = origin(ctx).hostname.replace(/\.service-now\.com.*/, '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return { ...env, SERVICENOW_OAUTH_TOKEN: '', SN_USERNAME: username, SN_PASSWORD: password,
    [`SN_${hostKey}_USERNAME`]: '', [`SN_${hostKey}_PASSWORD`]: '',
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'),
    JSN_DATA_HOME: path.join(root, 'data'), PATH: path.join(root, 'no-keyring'),
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent-jsn-acceptance-bus',
  };
}

async function makeIdentity(ctx, fixture, method = 'basic') {
  const root = path.join(fixture.root, method);
  await fs.mkdir(path.join(root, 'config', 'servicenow'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(root, 'no-keyring'), { mode: 0o700 });
  await privateFile(path.join(root, 'config', 'servicenow'), 'config.json', {
    default_profile: ctx.profile,
    profiles: { [ctx.profile]: { instance_url: origin(ctx).origin, username: fixture.username,
      auth_method: method === 'basic' ? 'basic' : 'gck', read_only: false, skip_confirmations: false,
      ...(fixture.domain ? { domain: fixture.domain } : {}) } },
  });
  return fixtureEnvironment(ctx, root, fixture.username, method === 'basic' ? fixture.password : '');
}

async function assertIdentity(ctx, fixture, env) {
  const result = await ctx.command(['records', 'list', '--table', 'sys_user', '--query',
    'user_name=javascript:gs.getUserName()', '--columns', 'sys_id,user_name', '--limit', '1', '--json'], { env });
  const found = rows(result);
  check(result.exitCode === 0 && Array.isArray(found) && found.length === 1 &&
    value(found[0].sys_id) === fixture.id && value(found[0].user_name) === fixture.username,
  'Auth identity/readback failed; no permission checks may follow');
}

function rejection(result) {
  const error = result?.json?.error;
  // A parser/configuration/timeout failure is not an authentication rejection.
  return result?.exitCode !== 0 && (Number(error?.status ?? error?.statusCode) === 401 ||
    /auth_error|authentication_required|unauthorized/.test(String(error?.code || '')) ||
    /HTTP 401|401 Unauthorized|authentication failed|invalid credentials/i.test(String(error?.message || '')));
}

async function assertPermissions(ctx, fixture, env, other) {
  await assertIdentity(ctx, fixture, env);
  const before = await ctx.read('sys_user', { id: other.id, fields: ['sys_id', 'first_name'], limit: 1 });
  check(value(before?.sys_id) === other.id && Object.hasOwn(before, 'first_name'), 'Denied-operation baseline missing');
  const baselineFirstName = value(before.first_name);
  const marker = `denied_${ctx.runKey}`;
  const result = await ctx.command(['users', 'update', other.id, '--field', `first_name=${marker}`, '--json'], { env,
    expectedDenial: result => result.json?.ok === false && Number(result.json?.error?.status ?? result.json?.error?.statusCode) === 403 });
  const after = await ctx.read('sys_user', { id: other.id, fields: ['sys_id', 'first_name'], limit: 1 });
  check(value(after?.sys_id) === other.id && value(after.first_name) === baselineFirstName, 'Denied operation changed an owned fixture; investigate before retry');
  const error = result?.json?.error;
  check(result.exitCode !== 0 && (Number(error?.status ?? error?.statusCode) === 403 ||
    /403|forbidden|access denied|not authorized|security constraints|insufficient/i.test(String(error?.message || ''))),
  'Expected explicit provider authorization denial, not a local failure or silent success');
  await assertIdentity(ctx, fixture, env); // distinguish ACL denial from unusable auth
}

async function resolveSetup(ctx, config) {
  const status = await ctx.command(['auth', 'status', '--details', '--json']);
  const selected = data(status)?.profiles?.find(p => p.name === ctx.profile);
  check(status.exitCode === 0 && selected?.verified === true && selected?.diagnostics?.auth_method === 'oauth' &&
    selected?.diagnostics?.probe?.status === 'succeeded', 'Verified OAuth bootstrap is required before fixture creation');
  let domain;
  try {
    const visible = await ctx.read('domain', { query: config.domain ? `sys_id=${config.domain}` : '', fields: ['sys_id'], limit: 1 });
    if (!config.domain) return blocked('Domain table is readable; supply an explicitly observed auth.config.domain before account creation');
    check(Array.isArray(visible) && visible.some(row => value(row.sys_id) === config.domain), 'Configured auth domain was not independently observed');
    domain = config.domain;
  } catch (error) {
    if ((error.status && ![400, 404].includes(error.status)) || !/invalid table(?:\s+|:\s*)["'`]?domain\b/i.test(String(error?.message || ''))) throw new Error('Domain context unavailable; no accounts created', { cause: error });
    check(config.domain === undefined, 'Configured domain contradicts observed domain-table absence');
  }
  const roles = [];
  for (const name of config.roles) {
    const found = await ctx.read('sys_user_role', { query: `name=${name}`, fields: ['sys_id', 'name'], limit: 2 });
    check(Array.isArray(found) && found.length === 1 && value(found[0].name) === name && ID.test(value(found[0].sys_id)), 'Requested least-privilege role did not resolve uniquely');
    roles.push(value(found[0].sys_id));
  }
  return { domain, roles };
}

export async function createAuthFixtures(ctx) {
  const config = validateAuthConfig(ctx, ctx.state.get('auth.config'));
  check(!ctx.state.has(PRIVATE), 'Auth fixture setup cannot be retried blindly');
  const setup = await resolveSetup(ctx, config);
  if (setup.status === 'blocked') return setup;
  const root = path.join(ctx.outputDir, 'auth-private');
  await fs.mkdir(root, { mode: 0o700 }); // refuse an existing run directory
  const fixtures = { root, users: [] };
  ctx.state.set(PRIVATE, fixtures);
  for (const kind of ['basic', 'cookie']) {
    const userKey = createHash('sha256').update(ctx.runKey).digest('hex').slice(0, 20);
    const username = `jsna_${userKey}_${kind}`;
    const password = `Aa9!${randomBytes(24).toString('base64url')}`;
    const user = { kind, username, password, root: path.join(root, kind), domain: setup.domain };
    await fs.mkdir(user.root, { mode: 0o700 });
    const payload = { user_name: username, first_name: `acceptance_${ctx.runKey}`, last_name: kind,
      user_password: password, active: true, locked_out: false, password_needs_reset: false,
      web_service_access_only: kind === 'basic', internal_integration_user: false,
      ...(setup.domain ? { sys_domain: setup.domain } : {}) };
    const file = await privateFile(user.root, 'create.json', payload);
    const created = await ctx.command(['users', 'create', '--data-file', file, '--json'], { writeIdentity: { name: username } });
    const id = value(data(created)?.sys_id);
    check(ID.test(id || ''), 'User create returned no exact ID; stop for ownership reconciliation, do not retry');
    user.id = id;
    // Checkpoint before any readback or child link can fail.
    await ctx.registerArtifact({ table: 'sys_user', id, kind: `auth-${kind}-user`, dependsOn: ctx.state.get('workflows.context') ? [ctx.state.get('workflows.context').captureId] : [], cleanupArgs: ['users', 'delete', id, '--force', '--json'] });
    fixtures.users.push(user);
    check(created.exitCode === 0, 'User creation returned an ambiguous failure after allocating an ID');
    const persisted = await ctx.read('sys_user', { id, fields: ['sys_id', 'user_name', 'active', 'locked_out', 'password_needs_reset', 'web_service_access_only', 'internal_integration_user', ...(setup.domain ? ['sys_domain'] : [])], limit: 1 });
    check(value(persisted?.sys_id) === id && value(persisted.user_name) === username, 'Created auth fixture identity was not persisted');
    for (const field of ['active', 'locked_out', 'password_needs_reset', 'web_service_access_only', 'internal_integration_user']) {
      check(Object.hasOwn(persisted, field) && String(value(persisted[field])) === String(payload[field]), 'Auth fixture login settings were dropped or changed');
    }
    if (setup.domain) check(value(persisted.sys_domain) === setup.domain, 'Auth fixture domain was not persisted');
    for (const role of setup.roles) {
      const roleFile = await privateFile(user.root, `role-${role}.json`, { user: id, role });
      const linked = await ctx.command(['records', 'create', '--table', 'sys_user_has_role', '--data-file', roleFile, '--json'], { writeIdentity: { name: `${ctx.runKey}_role_${role}` } });
      const linkId = value(data(linked)?.sys_id);
      check(ID.test(linkId || ''), 'Role assignment returned no exact ID; reconcile before retry');
      await ctx.registerArtifact({ table: 'sys_user_has_role', id: linkId, kind: 'auth-role-link', dependsOn: [id], cleanupArgs: ['records', 'delete', '--sys-id', linkId, '--table', 'sys_user_has_role', '--force', '--json'] });
      check(linked.exitCode === 0, 'Role creation returned ambiguous failure');
      const readback = await ctx.read('sys_user_has_role', { id: linkId, fields: ['sys_id', 'user', 'role'], limit: 1 });
      check(value(readback?.user) === id && value(readback?.role) === role, 'Role assignment readback failed');
    }
    const effective = await ctx.read('sys_user_has_role', { query: `user=${id}`, fields: ['sys_id', 'role.name'], limit: 10 });
    check(Array.isArray(effective) && effective.length < 10 && effective.every(r => typeof value(r['role.name']) === 'string' && !/admin/i.test(value(r['role.name']))), 'Administrative or unobservable inherited fixture roles; auth tests refused');
    if (kind === 'basic') user.env = await makeIdentity(ctx, user);
  }
  return { status: 'passed' };
}

function fixtures(ctx) {
  const stored = ctx.state.get(PRIVATE);
  check(stored?.users?.length === 2, 'OAuth-owned auth fixtures are incomplete');
  return stored.users;
}

async function basicValid(ctx) {
  const [basic, cookie] = fixtures(ctx);
  const login = await ctx.command(['auth', 'login', '--basic', '--no-make-default', '--json'], { env: basic.env });
  check(login.exitCode === 0, 'Basic login failed');
  await assertPermissions(ctx, basic, basic.env, cookie);
  return { status: 'passed' };
}

async function basicInvalid(ctx) {
  const [basic] = fixtures(ctx);
  const result = await ctx.command(['records', 'list', '--table', 'sys_user', '--limit', '1', '--json'], {
    env: { ...basic.env, SN_PASSWORD: `invalid_${randomBytes(24).toString('hex')}` },
  });
  check(rejection(result), 'Invalid Basic credentials were not rejected as authentication failure');
  await assertIdentity(ctx, basic, basic.env);
  return { status: 'passed' };
}

async function basicRotation(ctx) {
  const [basic] = fixtures(ctx);
  const next = `Aa9!${randomBytes(24).toString('base64url')}`;
  const file = await privateFile(basic.root, 'rotate.json', { user_password: next, password_needs_reset: false });
  const update = await ctx.command(['users', 'update', basic.id, '--data-file', file, '--json']);
  check(update.exitCode === 0, 'Owned Basic password rotation failed; reconcile fixture before retry');
  const old = await ctx.command(['records', 'list', '--table', 'sys_user', '--limit', '1', '--json'], { env: basic.env });
  check(rejection(old), 'Revoked Basic password remained usable');
  basic.password = next;
  basic.env = { ...basic.env, SN_PASSWORD: next };
  await assertIdentity(ctx, basic, basic.env);
  return { status: 'passed' };
}

async function cookieValid(ctx) {
  const [other, cookie] = fixtures(ctx);
  const adapter = ctx.state.get('auth.browserAdapter');
  if (typeof adapter?.acquire !== 'function') return blocked('No approved isolated browser-session acquisition adapter for the OAuth-created non-admin user; no personal browser/session may be reused');
  // Adapter owns real login and exact-ID session registration before returning.
  // Its result is a private headers-file, never token/cookie arguments.
  cookie.env = await makeIdentity(ctx, cookie, 'gck');
  const acquired = await adapter.acquire({ ctx, user: cookie, env: cookie.env });
  check(acquired?.source === 'isolated-browser-login' && path.isAbsolute(acquired.headersFile || ''), 'Real isolated browser acquisition evidence is required');
  const relative = path.relative(cookie.root, acquired.headersFile);
  check(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Browser headers must belong to this run-owned account directory');
  const stat = await fs.lstat(acquired.headersFile);
  check(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600, 'Browser headers must be in a private 0600 file');
  const result = await ctx.command(['auth', 'login', '--gck', '--headers-file', acquired.headersFile, '--no-make-default', '--json'], { env: cookie.env });
  check(result.exitCode === 0, 'Cookie login failed');
  cookie.session = acquired;
  await assertPermissions(ctx, cookie, cookie.env, other);
  return { status: 'passed' };
}

async function cookieExpired(ctx) {
  const [, cookie] = fixtures(ctx);
  const adapter = ctx.state.get('auth.browserAdapter');
  if (!cookie.session || typeof adapter?.expire !== 'function' || typeof adapter?.renew !== 'function') {
    return blocked('Requires a real acquired run-owned browser session and approved exact-session expiry/readback plus renewal adapters; corrupting a token is not expiry evidence');
  }
  await adapter.expire({ ctx, user: cookie, session: cookie.session });
  const expired = await ctx.command(['records', 'list', '--table', 'sys_user', '--limit', '1', '--json'], { env: cookie.env });
  check(rejection(expired), 'Expired browser session was not rejected as authentication failure');
  const renewed = await adapter.renew({ ctx, user: cookie, env: cookie.env });
  check(renewed?.source === 'isolated-browser-login' && path.isAbsolute(renewed.headersFile || ''), 'Renewal requires real isolated browser evidence');
  const relative = path.relative(cookie.root, renewed.headersFile);
  check(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Renewed headers must belong to the run-owned account directory');
  const stat = await fs.lstat(renewed.headersFile);
  check(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600, 'Renewed browser headers require mode 0600');
  const refresh = await ctx.command(['auth', 'refresh', '--headers-file', renewed.headersFile, '--json'], { env: cookie.env });
  check(refresh.exitCode === 0, 'Browser-session CLI renewal failed');
  cookie.session = renewed;
  await assertIdentity(ctx, cookie, cookie.env);
  return { status: 'passed' };
}

async function cookieInvalid(ctx) {
  const [, cookie] = fixtures(ctx);
  // This is deliberately invalid synthetic input, not an expired/live session.
  const file = await privateFile(cookie.root, 'invalid-headers.txt', 'X-UserToken: deliberately-invalid\nCookie: JSESSIONID=deliberately-invalid');
  const env = cookie.env ?? await makeIdentity(ctx, cookie, 'gck-invalid');
  const result = await ctx.command(['auth', 'login', '--gck', '--headers-file', file, '--no-make-default', '--json'], { env });
  check(rejection(result), 'Invalid browser credentials were not rejected as authentication failure');
  return { status: 'passed' };
}

const scenario = (id, title, run, requires = ['auth.fixtures']) => ({ id, title,
  commandPaths: ['auth login', 'auth status', 'records list', 'users update'],
  sources: ['cli/src/commands/auth.js', 'cli/src/auth.js', 'cli/src/sdk.js', 'cli/src/commands/users.js'],
  modes: ['pdi'], mutates: true, requires, run: async ctx => {
    const result = await run(ctx);
    if (result?.status === 'blocked') {
      const error = new Error(result.reason);
      error.status = 'blocked-prerequisite';
      throw error;
    }
    return result;
  } });
export const scenarios = [
  { ...scenario('auth.fixtures', 'OAuth-owned least-privilege auth fixtures', createAuthFixtures, ['workflows.context']), commandPaths: ['auth status', 'users create', 'records create', 'records list'],
    async cleanup(ctx) {
      const stored = ctx.state.get(PRIVATE);
      if (!stored) return;
      check(stored.root === path.join(ctx.outputDir, 'auth-private'), 'Credential cleanup path mismatch');
      await fs.rm(stored.root, { recursive: true, force: true });
      for (const user of stored.users) { user.password = undefined; user.env = undefined; user.session = undefined; }
      ctx.state.delete(PRIVATE);
    } },
  scenario('auth.basic-valid-permissions', 'Basic login, exact identity, allowed read and denied owned-user update', basicValid),
  scenario('auth.basic-invalid', 'Invalid Basic credential rejection with valid identity recovery', basicInvalid, ['auth.basic-valid-permissions']),
  scenario('auth.basic-rotation', 'OAuth password revocation and fresh Basic authentication, not session expiry', basicRotation, ['auth.basic-invalid']),
  scenario('auth.basic-expired-session', 'Basic UI-session expiry and recovery', async () => blocked('Basic is stateless at the CLI REST boundary; cached SDK UI-session expiry needs a same-process interactive CLI operation and exact owned-session invalidation adapter, not password rotation'), ['auth.basic-valid-permissions']),
  scenario('auth.cookie-valid-permissions', 'Real non-admin cookie login, identity and permissions', cookieValid),
  scenario('auth.cookie-invalid', 'Invalid cookie rejection', cookieInvalid),
  scenario('auth.cookie-expired-renewal', 'Real owned-cookie expiry and CLI renewal', cookieExpired, ['auth.cookie-valid-permissions']),
];
