import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import test from 'node:test';
import { producerEnvironment } from '../scripts/acceptance/config.mjs';
import { seedProfile } from '../scripts/acceptance/ci.mjs';
import { adaptCatalog, adaptInventory } from '../scripts/acceptance/catalog-v2.mjs';
import { bridgedContext, coordinatorEnvironment } from '../scripts/acceptance/execute.mjs';
import { prepare, HARNESS_SHA, FILES } from '../scripts/acceptance/prepare.mjs';

// Real pinned-producer subprocess regressions for the environment-only OAuth
// handoff. Synthetic loopback only; no live provider, secret or credential file.
const root = fileURLToPath(new URL('../../', import.meta.url));
const fresh = `fresh-coordinator-${'a'.repeat(24)}`;
const stale = `stale-outer-${'b'.repeat(24)}`;
const ghToken = `gh-${'c'.repeat(24)}`;
const ingestToken = `ingest-${'d'.repeat(24)}`;
const password = `fixture-pass-${'e'.repeat(16)}`;

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-env-bridge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }

async function loopback(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

// Clone the checkout and expose the already fetched pinned producer object through
// alternates, then stage its exact bytes. Skips only when the object is genuinely
// absent (shallow CI clones without the pin).
async function stage(t) {
  const dir = temporary(t);
  execFileSync('git', ['clone', '--quiet', '--shared', '--no-hardlinks', root, dir]);
  fs.mkdirSync(path.join(dir, '.git/objects/info'), { recursive: true });
  const objects = path.resolve(root, execFileSync('git', ['rev-parse', '--git-path', 'objects'], { cwd: root, encoding: 'utf8' }).trim());
  fs.writeFileSync(path.join(dir, '.git/objects/info/alternates'), `${objects}\n`);
  try { execFileSync('git', ['-C', dir, 'cat-file', '-e', HARNESS_SHA], { stdio: 'ignore' }); }
  catch { t.skip('Pinned historical producer absent in shallow checkout; run full-history integration locally'); return null; }
  prepare(dir);
  fs.symlinkSync(path.join(root, 'cli/node_modules'), path.join(dir, 'cli/node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const support = await import(pathToFileURL(path.join(dir, 'cli/scripts/acceptance/support.mjs')).href);
  return { dir, support };
}

const supportURL = dir => pathToFileURL(path.join(dir, 'cli/scripts/acceptance/support.mjs')).href;
const adapterURL = () => pathToFileURL(path.join(root, '.github/scripts/acceptance/execute.mjs')).href;

async function seeded(dir, profile) {
  const privateRoot = path.join(dir, 'private');
  fs.mkdirSync(privateRoot, { mode: 0o700 });
  const configHome = await seedProfile(privateRoot, { profile });
  return { privateRoot, configHome };
}

test('pinned producer child filter drops the coordinator token and the real CLI cannot authenticate', async t => {
  const staged = await stage(t);
  if (!staged) return;
  const { dir } = staged;
  const requests = [];
  const origin = await loopback(t, (req, res) => {
    requests.push(req.headers.authorization);
    if (req.headers.authorization !== `Bearer ${fresh}`) { json(res, 401, { error: { message: 'mock authentication rejected' } }); return; }
    json(res, 200, { result: [{ sys_id: 'f'.repeat(32), name: 'sys_db_object' }] });
  });
  const { privateRoot, configHome } = await seeded(dir, { instance_url: origin, read_only: true });
  const producerEnv = { ...producerEnvironment(process.env, privateRoot, configHome), SERVICENOW_OAUTH_TOKEN: fresh };
  const options = { profile: 'acceptance-ci', expectedHost: origin, mode: 'readonly', outputDir: path.join(dir, 'unbridged-run') };
  // Unmodified pinned context: no adapter bridge, no credential file, no keyring.
  const script = `
    import fs from 'node:fs';
    import * as support from ${JSON.stringify(supportURL(dir))};
    const options = ${JSON.stringify(options)};
    const config = JSON.parse(fs.readFileSync(process.env.XDG_CONFIG_HOME + '/servicenow/config.json', 'utf8'));
    const seen = [];
    const ctx = support.createContext(options, support.preflight(options, config), {
      execute: (exe, args, opts) => { seen.push(opts.env); return support.runProcess(exe, args, opts); },
    });
    let failed = null;
    try { await ctx.read('sys_db_object', { fields: ['sys_id'] }); } catch (error) { failed = String(error.message).slice(0, 80); }
    const direct = await support.runProcess(process.execPath, [${JSON.stringify(path.join(dir, 'cli/bin/jsn.js'))},
      'records', 'list', '--table', 'sys_db_object', '--json', '--profile', 'acceptance-ci', '--instance', options.expectedHost], { env: seen[0] });
    console.log(JSON.stringify({ readFailed: failed !== null, message: failed, dispatches: seen.length,
      tokenPresent: 'SERVICENOW_OAUTH_TOKEN' in seen[0], tokenValue: seen[0].SERVICENOW_OAUTH_TOKEN ?? null,
      direct: { exitCode: direct.exitCode, ok: direct.json?.ok ?? null, out: direct.stdout.slice(0, 300), err: direct.stderr.slice(0, 300) } }));
  `;
  const result = await staged.support.runProcess(process.execPath, ['--input-type=module', '-e', script], { env: producerEnv });
  assert.equal(result.exitCode, 0, result.stderr.replaceAll(fresh, '[redacted]'));
  assert.equal(result.json.readFailed, true, 'an unbridged coordinator read must fail');
  assert.match(result.json.message, /failed/i);
  assert.equal(result.json.dispatches, 1);
  assert.equal(result.json.tokenPresent, false, 'the pinned filter drops SERVICENOW_OAUTH_TOKEN');
  assert.equal(result.json.tokenValue, null);
  assert.notEqual(result.json.direct.exitCode, 0);
  // The pinned filter drops the token, so the real CLI cannot authenticate: it
  // either reports no credentials or refuses the unsafe sandbox store path. Both
  // are genuine failures; never fabricate an authenticated envelope.
  assert.notEqual(result.json.direct.ok, true, JSON.stringify(result.json.direct));
  assert.match(`${result.json.direct.out}${result.json.direct.err}`, /not authenticated|credential/i, JSON.stringify(result.json.direct));
  assert.ok(!requests.includes(`Bearer ${fresh}`), 'no CLI child request may carry the dropped token');
});

test('adapter bridge authenticates coordinator children with the fresh token, never the stale outer value', async t => {
  const staged = await stage(t);
  if (!staged) return;
  const { dir } = staged;
  const requests = [];
  const origin = await loopback(t, (req, res) => {
    requests.push({ method: req.method, authorization: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${fresh}`) { json(res, 401, { error: { message: 'mock authentication rejected' } }); return; }
    json(res, 200, { result: [{ sys_id: 'f'.repeat(32), name: 'sys_db_object' }] });
  });
  const { privateRoot, configHome } = await seeded(dir, { instance_url: origin, read_only: true });
  // Job-like outer environment: stale token, deployment credentials, proxies and
  // Node injection. The allowlist must drop all of it before the producer starts.
  const outer = { ...process.env, JSN_ALWAYS_WARM_SESSION: '0', SERVICENOW_OAUTH_TOKEN: stale, SERVICENOW_OAUTH_REFRESH_TOKEN: `refresh-${stale}`,
    SERVICENOW_INSTANCE_URL: origin, GH_TOKEN: ghToken, GITHUB_TOKEN: ghToken, JSN_ACCEPTANCE_INGEST_TOKEN: ingestToken,
    HTTPS_PROXY: 'http://proxy.invalid:3128', HTTP_PROXY: 'http://proxy.invalid:3128', NODE_OPTIONS: '--no-warnings',
    NODE_EXTRA_CA_CERTS: '/nonexistent/ca.pem', JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE: '1' };
  const producerEnv = { ...producerEnvironment(outer, privateRoot, configHome), SERVICENOW_OAUTH_TOKEN: fresh };
  for (const key of ['SERVICENOW_OAUTH_REFRESH_TOKEN', 'SERVICENOW_INSTANCE_URL', 'GH_TOKEN', 'GITHUB_TOKEN',
    'JSN_ACCEPTANCE_INGEST_TOKEN', 'HTTPS_PROXY', 'HTTP_PROXY', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE']) {
    assert.equal(producerEnv[key], undefined, `producer environment leaked ${key}`);
  }
  assert.equal(producerEnv.SERVICENOW_OAUTH_TOKEN, fresh);
  assert.ok(!JSON.stringify(producerEnv).includes(stale), 'the stale token must not survive allowlisting');
  const options = { profile: 'acceptance-ci', expectedHost: origin, mode: 'readonly', outputDir: path.join(dir, 'bridged-run') };
  // Production bridge wiring with an observing runProcess; no other difference.
  const script = `
    import fs from 'node:fs';
    import * as support from ${JSON.stringify(supportURL(dir))};
    import { bridgedContext, observeScenario } from ${JSON.stringify(adapterURL())};
    const options = ${JSON.stringify(options)};
    const config = JSON.parse(fs.readFileSync(process.env.XDG_CONFIG_HOME + '/servicenow/config.json', 'utf8'));
    const seen = [];
    const capture = (exe, args, opts) => { seen.push(opts.env); return support.runProcess(exe, args, opts); };
    const ctx = bridgedContext({ ...support, runProcess: capture }, options, support.preflight(options, config));
    await ctx.read('sys_db_object', { fields: ['sys_id', 'name'] });
    const listed = await ctx.command(['records', 'list', '--table', 'sys_db_object', '--limit', '1', '--no-count', '--json']);
    await observeScenario({ id: 'readonly.records', run: async c => { await c.read('sys_db_object', { fields: ['sys_id'] }); } }).run(ctx);
    const child = await support.runProcess(process.execPath, ['--input-type=module', '-e',
      'console.log(JSON.stringify({plaintext:process.env.JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE??null,keys:Object.keys(process.env)}))'], { env: seen[0] });
    const probe = child.json || {};
    console.log(JSON.stringify({
      allFresh: seen.every(env => env.SERVICENOW_OAUTH_TOKEN === ${JSON.stringify(fresh)}),
      anyStale: seen.some(env => env.SERVICENOW_OAUTH_TOKEN === ${JSON.stringify(stale)}),
      dispatches: seen.length,
      plaintext: seen.map(env => env.JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE ?? null),
      listed: { exitCode: listed.exitCode, ok: listed.json?.ok ?? null },
      evidence: fs.existsSync(${JSON.stringify(path.join(options.outputDir, 'executed.jsonl'))}),
      probe: { plaintext: probe.plaintext ?? 'absent',
        leaked: (probe.keys || []).filter(k => /^(SERVICENOW_OAUTH_REFRESH_TOKEN|SERVICENOW_INSTANCE_URL|GH_TOKEN|GITHUB_TOKEN|JSN_ACCEPTANCE_INGEST_TOKEN|HTTPS?_PROXY|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE)$/.test(k)) },
    }));
  `;
  const result = await staged.support.runProcess(process.execPath, ['--input-type=module', '-e', script], { env: producerEnv });
  assert.equal(result.exitCode, 0, result.stderr.replaceAll(fresh, '[redacted]'));
  assert.equal(result.json.allFresh, true, 'every coordinator child carries the fresh token');
  assert.equal(result.json.anyStale, false, 'no coordinator child carries the stale token');
  assert.ok(result.json.dispatches >= 3);
  assert.equal(result.json.listed.exitCode, 0);
  assert.equal(result.json.listed.ok, true);
  assert.equal(result.json.evidence, true, 'a successful ctx.read records authenticated scenario evidence');
  assert.ok(result.json.plaintext.every(value => value === null), 'plaintext credential storage is never enabled');
  assert.equal(result.json.probe.plaintext, 'absent');
  assert.deepEqual(result.json.probe.leaked, []);
  assert.ok(requests.length > 0);
  assert.ok(requests.every(entry => entry.authorization === `Bearer ${fresh}`));
  assert.ok(!requests.some(entry => entry.authorization === `Bearer ${stale}`), 'the provider never saw the stale token');
  assert.ok(!(result.stdout + result.stderr).includes(fresh));
  assert.ok(!(result.stdout + result.stderr).includes(stale));
  // No credential JSON or credentials directory anywhere under the private root.
  const files = [];
  const walk = target => { for (const name of fs.readdirSync(target)) { const full = path.join(target, name); if (fs.statSync(full).isDirectory()) walk(full); else files.push(full); } };
  walk(privateRoot);
  assert.deepEqual(files.map(file => path.relative(privateRoot, file)), ['config/servicenow/config.json']);
  assert.ok(!fs.existsSync(path.join(configHome, 'servicenow/credentials')));
  assert.ok(!files.some(file => fs.readFileSync(file, 'utf8').includes(fresh)));
});

test('coordinator bridge fails closed on profile/target binding mismatches and leaves fixture env untouched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-env-binding-'));
  try {
    const base = path.join(dir, 'coordinator');
    fs.mkdirSync(path.join(base, 'servicenow'), { recursive: true, mode: 0o700 });
    const origin = 'http://127.0.0.1:9';
    const options = { profile: 'acceptance-ci' };
    const childEnv = { HOME: path.dirname(base), XDG_CONFIG_HOME: base, XDG_CACHE_HOME: path.join(dir, 'cache') };
    const write = profiles => fs.writeFileSync(path.join(base, 'servicenow/config.json'), JSON.stringify({ auth_method: 'oauth', default_profile: 'acceptance-ci', profiles }), { mode: 0o600 });
    write({ 'acceptance-ci': { instance_url: origin, read_only: true } });
    const bound = coordinatorEnvironment({ env: childEnv, options, target: origin, token: fresh, configHome: base, home: path.dirname(base) });
    assert.equal(bound.SERVICENOW_OAUTH_TOKEN, fresh);
    assert.equal(bound.JSN_ALWAYS_WARM_SESSION, undefined, 'ordinary coordinator launches retain the cookie-backed default');
    const stateless = coordinatorEnvironment({ env: childEnv, options, target: origin, token: fresh, configHome: base, home: path.dirname(base), warmSession: '0' });
    assert.equal(stateless.JSN_ALWAYS_WARM_SESSION, '0', 'an explicit stateless fixture opt-out survives the pinned child filter');
    assert.equal(childEnv.JSN_ALWAYS_WARM_SESSION, undefined, 'the bridge never mutates the pinned environment');
    assert.equal(childEnv.SERVICENOW_OAUTH_TOKEN, undefined, 'the pinned child env object is never mutated');
    // Wrong expected target, profile name and HOME all refuse instead of leaking.
    assert.throws(() => coordinatorEnvironment({ env: childEnv, options, target: 'http://127.0.0.1:8', token: fresh, configHome: base, home: path.dirname(base) }), /binding refused/);
    assert.throws(() => coordinatorEnvironment({ env: childEnv, options: { profile: 'other' }, target: origin, token: fresh, configHome: base, home: path.dirname(base) }), /binding refused/);
    assert.throws(() => coordinatorEnvironment({ env: { ...childEnv, HOME: '/elsewhere' }, options, target: origin, token: fresh, configHome: base, home: path.dirname(base) }), /binding refused/);
    // A second profile in the seeded config is not a coordinator config either.
    write({ 'acceptance-ci': { instance_url: origin }, extra: { instance_url: origin } });
    assert.throws(() => coordinatorEnvironment({ env: childEnv, options, target: origin, token: fresh, configHome: base, home: path.dirname(base) }), /binding refused/);
    // Fixture/own-credential launches replace XDG_CONFIG_HOME: byte-identical env.
    const fixture = { HOME: path.join(dir, 'fixture'), XDG_CONFIG_HOME: path.join(dir, 'fixture/config'), SERVICENOW_OAUTH_TOKEN: '' };
    assert.equal(coordinatorEnvironment({ env: fixture, options, target: origin, token: fresh, configHome: base, home: path.dirname(base) }), fixture);
    assert.equal(coordinatorEnvironment({ env: fixture, options, target: origin, token: fresh, configHome: base, home: path.dirname(base), warmSession: '0' }), fixture, 'coordinator opt-out must not change fixture actors');
    assert.equal(coordinatorEnvironment({ env: childEnv, options, target: origin, token: '', configHome: base, home: path.dirname(base) }), childEnv);
    assert.equal(coordinatorEnvironment({ env: childEnv, options, target: origin, token: fresh, configHome: undefined }), childEnv);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fixture launches reach the CLI child without the coordinator token and keep their own Basic auth', async t => {
  const staged = await stage(t);
  if (!staged) return;
  const { dir } = staged;
  const authorizations = [];
  const paths = [];
  const expectedBasic = `Basic ${Buffer.from(`fixture-user:${password}`).toString('base64')}`;
  const origin = await loopback(t, (req, res) => {
    authorizations.push(req.headers.authorization);
    paths.push(`${req.method} ${req.url} auth=${req.headers.authorization ? 'set' : 'none'}`);
    if (req.headers.authorization !== expectedBasic) { json(res, 401, { error: { message: 'mock authentication rejected' } }); return; }
    json(res, 200, { result: [{ sys_id: 'f'.repeat(32), name: 'incident' }] });
  });
  const { privateRoot, configHome } = await seeded(dir, { instance_url: origin, read_only: true });
  const producerEnv = { ...producerEnvironment(process.env, privateRoot, configHome), SERVICENOW_OAUTH_TOKEN: fresh };
  const options = { profile: 'acceptance-ci', expectedHost: origin, mode: 'readonly', outputDir: path.join(dir, 'fixture-run') };
  const script = `
    import fs from 'node:fs';
    import * as support from ${JSON.stringify(supportURL(dir))};
    import { bridgedContext } from ${JSON.stringify(adapterURL())};
    const options = ${JSON.stringify(options)};
    const config = JSON.parse(fs.readFileSync(process.env.XDG_CONFIG_HOME + '/servicenow/config.json', 'utf8'));
    const seen = [];
    const capture = (exe, args, opts) => { seen.push(opts.env); return support.runProcess(exe, args, opts); };
    const ctx = bridgedContext({ ...support, runProcess: capture }, options, support.preflight(options, config));
    const fixtureRoot = ${JSON.stringify(path.join(options.outputDir, 'auth-private'))};
    fs.mkdirSync(fixtureRoot + '/config/servicenow', { recursive: true, mode: 0o700 });
    fs.mkdirSync(fixtureRoot + '/no-keyring', { mode: 0o700 });
    fs.mkdirSync(fixtureRoot + '/cache', { mode: 0o700 });
    fs.writeFileSync(fixtureRoot + '/config/servicenow/config.json', JSON.stringify({ default_profile: 'acceptance-ci',
      profiles: { 'acceptance-ci': { instance_url: options.expectedHost, username: 'fixture-user', auth_method: 'basic', read_only: false } } }), { mode: 0o600 });
    const env = { SERVICENOW_OAUTH_TOKEN: '', SN_USERNAME: 'fixture-user', SN_PASSWORD: ${JSON.stringify(password)},
      HOME: fixtureRoot, XDG_CONFIG_HOME: fixtureRoot + '/config', XDG_CACHE_HOME: fixtureRoot + '/cache',
      JSN_DATA_HOME: fixtureRoot + '/data', PATH: fixtureRoot + '/no-keyring',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent-jsn-acceptance-bus' };
    const good = await ctx.command(['records', 'list', '--table', 'sys_db_object', '--limit', '1', '--json'], { env });
    const bad = await ctx.command(['records', 'list', '--table', 'sys_db_object', '--limit', '1', '--json'],
      { env: { ...env, SN_PASSWORD: 'wrong-' + ${JSON.stringify(password)} } });
    console.log(JSON.stringify({ good: { exitCode: good.exitCode, ok: good.json?.ok ?? null },
      bad: { exitCode: bad.exitCode, ok: bad.json?.ok ?? null },
      tokens: seen.map(child => child.SERVICENOW_OAUTH_TOKEN ?? null),
      configHomes: seen.map(child => child.XDG_CONFIG_HOME) }));
  `;
  const result = await staged.support.runProcess(process.execPath, ['--input-type=module', '-e', script], { env: producerEnv });
  assert.equal(result.exitCode, 0, result.stderr.replaceAll(fresh, '[redacted]'));
  assert.equal(result.json.good.exitCode, 0, 'the fixture Basic launch must authenticate');
  assert.equal(result.json.good.ok, true);
  assert.notEqual(result.json.bad.exitCode, 0, 'an invalid fixture password must not be authenticated');
  assert.equal(result.json.bad.ok, false);
  assert.equal(result.json.tokens.length, 2);
  assert.ok(result.json.tokens.every(value => value === ''), 'fixture launches never receive the coordinator token');
  assert.ok(result.json.configHomes.every(value => value.startsWith(path.join(options.outputDir, 'auth-private'))));
  assert.equal(authorizations.filter(value => value === expectedBasic).length >= 1, true, `the provider saw the fixture Basic credentials: ${paths.join(' | ')}`);
  assert.ok(!authorizations.includes(`Bearer ${fresh}`));
  // A Basic login may open a UI session first (unauthenticated login form), so
  // only the authenticated requests are constrained: never the coordinator token.
  assert.ok(paths.length >= 1);
});

test('retired history command really exits 2 at this checkout and only its obligation leaves the catalog', async t => {
  const dir = temporary(t);
  const bin = path.join(root, 'cli/bin/jsn.js');
  const env = { PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: path.join(dir, 'config'),
    XDG_CACHE_HOME: path.join(dir, 'cache'), JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' };
  for (const args of [['history', 'list', '--json'], ['history', '--json']]) {
    const result = spawnSync(process.execPath, [bin, ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 2, `${args.join(' ')} must exit 2`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'usage_error');
    assert.match(parsed.error, /Unknown command: history/);
  }
  // Exact selection path used by ci.mjs over the real pinned catalog modules.
  const staged = await stage(t);
  if (!staged) return;
  const raw = [];
  for (const name of ['read-only', 'read-only-catalog', 'resources', 'workflows', 'auth']) {
    const module = await import(pathToFileURL(path.join(staged.dir, `cli/test/acceptance/${name}.mjs`)).href);
    raw.push(...module.scenarios);
  }
  const adapted = adaptCatalog(raw);
  const rawReadonly = raw.filter(s => s.modes.includes('readonly')).map(s => s.id);
  const adaptedReadonly = adapted.filter(s => s.modes.includes('readonly')).map(s => s.id);
  // Exactly the retired history obligation leaves; completion is replaced by a
  // help-based discovery scenario and nothing is added as authenticated success.
  assert.deepEqual(rawReadonly.filter(id => !adaptedReadonly.includes(id)).sort(), ['local.completion', 'local.history-empty']);
  assert.deepEqual(adaptedReadonly.filter(id => !rawReadonly.includes(id)), ['local.discovery-help']);
  assert.equal(adaptedReadonly.length, rawReadonly.length - 1);
  assert.ok(!adapted.some(s => (s.commandPaths || []).includes('history list')));
  assert.ok(adaptedReadonly.includes('readonly.records'));
  // 5.5.6 and earlier npm artifacts keep the original history obligation.
  const legacy = adaptCatalog(raw, { kind: 'npm', version: '5.5.6' }).filter(s => s.modes.includes('readonly')).map(s => s.id);
  assert.ok(legacy.includes('local.history-empty'));
  const inventory = JSON.parse(fs.readFileSync(path.join(staged.dir, 'cli/test/acceptance/coverage.json'), 'utf8'));
  const retained = new Set(adaptInventory(inventory).entries.map(entry => entry.path));
  assert.deepEqual(inventory.entries.filter(entry => !retained.has(entry.path)).map(entry => entry.path), ['completion', 'history', 'history list', 'history prune']);
});

test('staged pinned producer bytes remain identical to the pinned commit', async t => {
  const staged = await stage(t);
  if (!staged) return;
  for (const file of FILES) {
    const pinned = execFileSync('git', ['show', `${HARNESS_SHA}:${file}`], { cwd: staged.dir, maxBuffer: 16 * 1024 * 1024 });
    assert.deepEqual(fs.readFileSync(path.join(staged.dir, file)), pinned, `staged producer bytes changed: ${file}`);
  }
  assert.throws(() => prepare(staged.dir), /already exists/);
});
