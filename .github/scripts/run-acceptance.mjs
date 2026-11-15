// Local readonly adapter: immutable scenario bytes, separately verified executable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HARNESS_SHA, FILES } from './acceptance/prepare.mjs';
import { publishResults, validateProjection } from './acceptance/publish.mjs';
import { loadConfig } from '../../cli/src/config.js';
import { AuthManager } from '../../cli/src/auth.js';
import { environmentOAuth, validatedOrigin } from './oauth-environment.mjs';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const exactVersion = /^\d+\.\d+\.\d+(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
export function parseOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--publish') { if (options.publish) throw Error(); options.publish = true; continue; }
    if (!['--version', '--profile', '--target', '--output', '--result'].includes(key) || options[key.slice(2)] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw Error();
    options[key.slice(2)] = args[++i];
  }
  if (options.result) { if (!options.publish || Object.keys(options).some(k => !['result', 'publish'].includes(k))) throw Error(); return options; }
  if (!options.output || !options.target || !/^[a-z][a-z0-9-]{0,30}$/.test(options.target) || (options.version !== undefined && !exactVersion.test(options.version))) throw Error();
  if (!options.profile && !process.env.SERVICENOW_INSTANCE_URL) throw Error();
  return options;
}
export async function acquireArtifact(version, temporary) {
  if (!version) {
    const root = path.join(ROOT, 'cli');
    return { root, identity: { kind: 'checkout', version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version, sourceSHA: git(['rev-parse', 'HEAD']), sourceDirty: !!git(['status', '--porcelain', '--untracked-files=no']), integrity: null } };
  }
  if (!exactVersion.test(version)) throw Error();
  const response = await fetch(`https://registry.npmjs.org/@jacebenson%2fjsn/${version}`, { signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (!response.ok) throw Error();
  const metadata = await response.json();
  if (metadata.name !== '@jacebenson/jsn' || metadata.version !== version || !/^[a-f0-9]{40}$/.test(metadata.gitHead || '') || !/^sha512-[A-Za-z0-9+/]+=*$/.test(metadata.dist?.integrity || '')) throw Error();
  const url = new URL(metadata.dist.tarball);
  if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org') throw Error();
  const tar = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (!tar.ok) throw Error();
  const bytes = Buffer.from(await tar.arrayBuffer());
  if (bytes.length > 32 * 1024 * 1024 || `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== metadata.dist.integrity) throw Error();
  const archive = path.join(temporary, 'artifact.tgz'); fs.writeFileSync(archive, bytes, { mode: 0o600 });
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim().split('\n');
  if (entries.some(name => !name.startsWith('package/') || name.split('/').includes('..'))) throw Error();
  const install = path.join(temporary, 'install'); fs.mkdirSync(install);
  execFileSync('npm', ['install', '--prefix', install, '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', archive], { timeout: 180000, stdio: 'ignore' });
  const root = path.join(install, 'node_modules/@jacebenson/jsn');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  if (pkg.version !== version || pkg.name !== metadata.name) throw Error();
  return { root, identity: { kind: 'npm', version, sourceSHA: metadata.gitHead, sourceDirty: false, integrity: metadata.dist.integrity } };
}
async function credentials(options) {
  const config = loadConfig();
  const profile = options.profile ? config.profiles?.[options.profile] : null;
  if (options.profile && !profile) throw Error();
  const origin = validatedOrigin(profile?.instance_url || process.env.SERVICENOW_INSTANCE_URL, { allowLocal: true });
  const manager = new AuthManager({ getEffectiveInstance: () => origin, getUsername: () => profile?.username });
  let creds = await manager.getCredentialsFor(origin, profile?.username, { username: profile?.username, authMethod: profile?.auth_method, refresh: false });
  if (creds.auth_method === 'oauth' && (process.env.SERVICENOW_OAUTH_REFRESH_TOKEN || creds.refresh_token)) {
    const refreshed = await environmentOAuth({ ...process.env, SERVICENOW_INSTANCE_URL: origin, SERVICENOW_OAUTH_TOKEN: creds.access_token, SERVICENOW_OAUTH_REFRESH_TOKEN: process.env.SERVICENOW_OAUTH_REFRESH_TOKEN || creds.refresh_token }, { allowLocal: true, warn: () => {} });
    creds = { ...creds, access_token: refreshed.accessToken };
  }
  if (!['oauth', 'basic'].includes(creds.auth_method)) throw Error();
  return { origin, creds };
}
export async function runLocal(options) {
  const output = path.resolve(options.output);
  if (fs.existsSync(output)) throw Error();
  const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jsn-local-acceptance-')); fs.chmodSync(temporary, 0o700);
  try {
    const artifact = await acquireArtifact(options.version, temporary);
    const { origin, creds } = await credentials(options);
    const home = path.join(temporary, 'home'), config = path.join(home, 'config');
    fs.mkdirSync(path.join(config, 'servicenow'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(config, 'servicenow/config.json'), JSON.stringify({ default_profile: 'acceptance', profiles: { acceptance: { instance_url: origin, auth_method: creds.auth_method, read_only: true, ephemeral: true } } }), { mode: 0o600 });
    const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: path.join(home, 'cache'), JSN_DATA_HOME: path.join(home, 'data'), DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent-jsn-acceptance-bus', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_DOCS_CHECK: '1', ...(creds.auth_method === 'oauth' ? { SERVICENOW_OAUTH_TOKEN: creds.access_token } : { SN_USERNAME: creds.username, SN_PASSWORD: creds.password }) };
    // Stage byte-identical producer resources beside the current harness imports.
    const harness = path.join(temporary, 'harness'); fs.mkdirSync(harness);
    fs.cpSync(path.join(ROOT, 'cli'), path.join(harness, 'cli'), { recursive: true, filter: file => !file.includes(`${path.sep}node_modules`) });
    fs.symlinkSync(path.join(ROOT, 'cli/node_modules'), path.join(harness, 'cli/node_modules'), 'dir');
    for (const file of FILES) { const dest = path.join(harness, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, execFileSync('git', ['show', `${HARNESS_SHA}:${file}`], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })); }
    const support = await import(pathToFileURL(path.join(harness, 'cli/scripts/acceptance/support.mjs')));
    const executable = path.join(artifact.root, 'bin/jsn.js');
    const measurements = [];
    const command = async args => {
      // Deliberately narrow adapter, not the producer's same-source override.
      const key = args.slice(0, 2).join(' ');
      if (!(['version', 'completion'].includes(args[0]) || ['history list', 'records list', 'records get'].includes(key))) throw Error();
      if (args.some(x => /^(--(?:profile|instance)|-[ip])(?:=|$)/.test(x) || /javascript:|sysparm_script/i.test(x))) throw Error();
      const result = await support.runProcess(process.execPath, [executable, ...args, '--profile', 'acceptance'], { cwd: temporary, env, timeoutMs: 30000, maxBytes: 2 * 1024 * 1024 });
      measurements.push({ format: args.includes('--json') ? 'machine' : 'human', durationMs: result.durationMs, outputBytes: Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) });
      return result;
    };
    const actual = await command(['version', '--json']);
    if (actual.exitCode !== 0 || actual.json?.data?.version !== artifact.identity.version) throw Error();
    const headers = creds.auth_method === 'oauth' ? { Authorization: `Bearer ${creds.access_token}` } : { Authorization: `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}` };
    const ctx = { state: new Map(), command, read: async (table, { id, fields, limit }) => {
      if (table !== 'sys_db_object' || !/^[a-f0-9]{32}$/.test(id)) throw Error();
      const url = new URL(`/api/now/table/${table}/${id}`, origin); url.search = new URLSearchParams({ sysparm_fields: fields.join(','), sysparm_limit: String(limit) }).toString();
      const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(15000) }); if (!response.ok) throw Error(); return (await response.json()).result;
    } };
    const { scenarios } = await import(pathToFileURL(path.join(harness, 'cli/test/acceptance/read-only.mjs')));
    // local.version embeds checkout version equality; the actual artifact check
    // above replaces that assumption without modifying immutable producer bytes.
    const selected = scenarios.filter(s => s.id !== 'local.version');
    const results = [];
    for (const scenario of selected) {
      if (scenario.mutates || !scenario.modes.includes('readonly')) throw Error();
      const start = performance.now(); let status = 'passed';
      try { await scenario.run(ctx); } catch (error) { status = support.classify(error); }
      results.push({ id: scenario.id, status, durationMs: performance.now() - start });
    }
    const release = { family: null, version: null, build: null, patch: null, hotfix: null, source: 'sys_properties.name,value via bounded records list', fields: {}, reason: 'metadata-unavailable-or-unrecognized' };
    try {
      const metadata = await command(['records', 'list', '--table', 'sys_properties', '--query', 'nameSTARTSWITHglide.build', '--fields', 'name,value', '--limit', '10', '--no-count', '--json']);
      const rows = metadata.json?.data?.records;
      if (metadata.exitCode === 0 && metadata.json?.ok === true && Array.isArray(rows)) {
        const raw = v => typeof v === 'object' && v !== null ? v.value : v;
        for (const row of rows) {
          const name = raw(row.name), value = raw(row.value);
          if (name === 'glide.buildname' && /^(?:australia|zurich|yokohama|xanadu|washingtondc|vancouver|utah|tokyo|sandiego|rome|quebec|paris|orlando|newyork|madrid|london|kingston|jakarta|istanbul|helsinki|geneva|fuji|eureka|dublin|calgary|berlin|aspen)$/i.test(value || '')) { release.family = value; release.fields.family = name; }
          if (name === 'glide.buildtag' && /^glide-[a-z0-9_-]{1,180}$/i.test(value || '')) { release.build = value; release.fields.build = name; }
        }
        // Do not infer version/patch/hotfix from a build string: no verified
        // provider contract for those independent fields exists in this source.
        release.reason = 'version-patch-hotfix-not-independently-exposed';
      }
    } catch { /* Only the closed unavailable reason is retained. */ }
    const counts = {}; for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
    const payload = { schemaVersion: 2, runKey: `acceptance_${randomUUID().replaceAll('-', '')}`, mode: 'readonly', provenance: { sourceSHA: artifact.identity.sourceSHA, version: artifact.identity.version, node: process.version, binarySHA256: sha(fs.readFileSync(executable)), sourceDirty: artifact.identity.sourceDirty }, platform: 'linux', environment: { domainSeparation: 'UNKNOWN' }, selection: { full: false, selected: selected.map(s => s.id) }, summary: { total: results.length, counts, complete: false, missingCount: 1 }, performance: null, results };
    Object.assign(payload.provenance, { artifactKind: artifact.identity.kind, registryIntegrity: artifact.identity.integrity, harnessSHA: git(['rev-parse', 'HEAD']), producerSHA: HARNESS_SHA, target: options.target });
    validateProjection(payload);
    fs.mkdirSync(output, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(output, 'public-summary.json'), JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.writeFileSync(path.join(output, 'local-summary.json'), JSON.stringify({ runKey: payload.runKey, target: options.target, harness: { producerSHA: HARNESS_SHA, adapterSHA: git(['rev-parse', 'HEAD']) }, testedArtifact: artifact.identity, coverage: 'partial-readonly-first-slice', executableVersionVerified: true, release, measurements, tokens: { status: 'unavailable', tokenizer: null } }, null, 2), { mode: 0o600 });
    return { file: path.join(output, 'public-summary.json'), summary: payload.summary };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  const result = options.result ? { file: path.resolve(options.result) } : await runLocal(options);
  if (result.summary) console.log(JSON.stringify(result.summary));
  if (options.publish) { const publication = await publishResults({ file: result.file, url: process.env.JSN_ACCEPTANCE_INGEST_URL, token: process.env.JSN_ACCEPTANCE_INGEST_TOKEN }); console.log(JSON.stringify(publication)); if (!publication.ok) return 1; }
  return result.summary?.counts.failed || result.summary?.counts['failed-timeout'] ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().then(code => { process.exitCode = code; }).catch(() => { console.error('Local acceptance refused or failed; no provider diagnostics retained'); process.exitCode = 1; });
