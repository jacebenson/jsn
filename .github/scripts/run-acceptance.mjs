// Local isolated full/read-only adapter: immutable scenario bytes, separately verified executable.
import fs from 'node:fs';
import { adaptCatalog, adaptInventory } from './acceptance/catalog-v2.mjs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fullPlan, guardFullContext, runContextScenario, scenarioPolicy } from './acceptance/full-safety.mjs';
import { preserveRecovery } from './acceptance/recovery.mjs';
import { selectExactScenario } from './acceptance/select.mjs';
import { flowCommandDiagnostic } from './acceptance/flow-diagnostic.mjs';
import { contextAdapterV1 } from './acceptance/context-v1.mjs';
import { HARNESS_SHA, FILES } from './acceptance/prepare.mjs';
import { publishResults, validateProjection } from './acceptance/publish.mjs';
import { loadConfig } from '../../cli/src/config.js';
import { AuthManager } from '../../cli/src/auth.js';
import { environmentOAuth, validatedOrigin } from './oauth-environment.mjs';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const exactVersion = /^\d+\.\d+\.\d+(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/;
class LocalFailure extends Error {}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
export function parseOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--plan') { options.plan = true; continue; }
    if (key === '--publish') { if (options.publish) throw Error(); options.publish = true; continue; }
    if (!['--version', '--profile', '--target', '--output', '--result', '--mode', '--scenario'].includes(key) || options[key.slice(2)] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw Error();
    options[key.slice(2)] = args[++i];
  }
  if (options.result) { if (!options.publish || Object.keys(options).some(k => !['result', 'publish'].includes(k))) throw Error(); return options; }
  if (options.mode && !['readonly', 'full'].includes(options.mode)) throw Error('mode: use full or readonly');
  options.mode ||= 'full';
  if (!options.target || !/^[a-z][a-z0-9-]{0,30}$/.test(options.target) || (options.version !== undefined && !exactVersion.test(options.version))) throw Error();
  if (!options.profile && !process.env.SERVICENOW_INSTANCE_URL) throw Error();
  options.output ||= path.join(os.homedir(), 'private-acceptance', `${options.target}-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`);
  return options;
}
export function selectedExitCode(summary) {
  if (Object.keys(summary.counts).some(status => !['passed', 'failed', 'failed-timeout', 'blocked-prerequisite', 'blocked-access', 'blocked-capability', 'excluded-mode', 'not-run'].includes(status))) return 1;
  if (summary.counts.failed || summary.counts['failed-timeout']) return 1;
  return summary.total > 0 && summary.counts.passed === summary.total ? 0 : 2;
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
  if (options.profile && !profile) throw new LocalFailure('profile: selected profile does not exist; configure it before running acceptance');
  const origin = validatedOrigin(profile?.instance_url || process.env.SERVICENOW_INSTANCE_URL, { allowLocal: true });
  const manager = new AuthManager({ getEffectiveInstance: () => origin, getUsername: () => profile?.username });
  let creds = await manager.getCredentialsFor(origin, profile?.username, { username: profile?.username, authMethod: profile?.auth_method, refresh: false });
  if (creds.auth_method === 'oauth' && (process.env.SERVICENOW_OAUTH_REFRESH_TOKEN || creds.refresh_token)) {
    const refreshed = await environmentOAuth({ ...process.env, SERVICENOW_INSTANCE_URL: origin, SERVICENOW_OAUTH_TOKEN: creds.access_token, SERVICENOW_OAUTH_REFRESH_TOKEN: process.env.SERVICENOW_OAUTH_REFRESH_TOKEN || creds.refresh_token }, { allowLocal: true, warn: () => {} });
    creds = { ...creds, access_token: refreshed.accessToken };
  }
  if (!['oauth', 'basic'].includes(creds.auth_method)) throw new LocalFailure('auth: readonly local acceptance requires usable OAuth or Basic credentials; authenticate the selected profile');
  return { origin, creds };
}
export function stageHarness(temporary, version) {
  // Stage byte-identical producer resources beside the current harness imports.
  const harness = path.join(temporary, 'harness'); fs.mkdirSync(harness);
  fs.cpSync(path.join(ROOT, 'cli'), path.join(harness, 'cli'), { recursive: true, filter: file => !file.includes(`${path.sep}node_modules`) });
  fs.symlinkSync(path.join(ROOT, 'cli/node_modules'), path.join(harness, 'cli/node_modules'), 'dir');
  for (const file of FILES) { const dest = path.join(harness, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, execFileSync('git', ['show', `${HARNESS_SHA}:${file}`], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })); }
  // Expected version belongs to the separately verified candidate, not the
  // pinned producer. No producer or SDK source bytes are rewritten.
  const packageFile = path.join(harness, 'cli/package.json');
  const harnessPackage = JSON.parse(fs.readFileSync(packageFile));
  harnessPackage.version = version;
  fs.writeFileSync(packageFile, JSON.stringify(harnessPackage));
  return harness;
}
export async function runLocal(options) {
  const mode = options.mode === 'readonly' ? 'readonly' : 'pdi';
  const output = path.resolve(options.output || path.join(os.homedir(), 'private-acceptance', `${options.target}-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`));
  if (output === ROOT || output.startsWith(`${ROOT}${path.sep}`)) throw Error('output: choose a directory outside the repository');
  if (fs.existsSync(output)) throw Error('output: directory already exists; omit --output for a unique run directory');
  try { fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 }); fs.mkdirSync(output, { mode: 0o700 }); }
  catch { throw new LocalFailure('output: unable to create a private run directory; check parent-directory permissions'); }
  const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jsn-local-acceptance-')); fs.chmodSync(temporary, 0o700);
  let recoveryContext;
  let stage = 'npm artifact';
  try {
    const artifact = await acquireArtifact(options.version, temporary);
    console.log(`Tested version: ${artifact.identity.version} (${artifact.identity.kind})`);
    stage = 'profile/auth';
    const { origin, creds } = options.plan ? { origin: 'https://plan.invalid', creds: {} } : await credentials(options);
    stage = 'harness preparation';
    const home = path.join(temporary, 'home'), config = path.join(home, 'config');
    fs.mkdirSync(path.join(config, 'servicenow'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(config, 'servicenow/config.json'), JSON.stringify({ default_profile: 'acceptance', profiles: { acceptance: { instance_url: origin, auth_method: creds.auth_method, read_only: mode === 'readonly', ephemeral: true } } }), { mode: 0o600 });
    const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: path.join(home, 'cache'), JSN_DATA_HOME: path.join(home, 'data'), DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent-jsn-acceptance-bus', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_DOCS_CHECK: '1', ...(creds.auth_method === 'oauth' ? { SERVICENOW_OAUTH_TOKEN: creds.access_token } : { SN_USERNAME: creds.username, SN_PASSWORD: creds.password }) };
    const harness = stageHarness(temporary, artifact.identity.version);
    const support = await import(pathToFileURL(path.join(harness, 'cli/scripts/acceptance/support.mjs')));
    const { executeScenarios } = await import(pathToFileURL(path.join(harness, 'cli/scripts/acceptance/run.mjs')));
    const hooks = await import(pathToFileURL(path.join(harness, 'cli/test/acceptance/performance.mjs')));
    const executable = path.join(artifact.root, 'bin/jsn.js');
    const measurements = [];
    const ownExecutable = path.join(harness, 'cli/bin/jsn.js');
    const execute = async (node, args, opts) => {
      // createContext retains its source guard and complete command/GET safety
      // checks. Only its canonical CLI launch is routed to the verified package.
      // Independent SDK readbacks continue to use the trusted harness SDK.
      const candidate = args[0] === ownExecutable;
      const fixture = opts.env.XDG_CONFIG_HOME?.startsWith(path.join(temporary, 'private-run') + path.sep);
      const childEnv = fixture ? { ...env, ...opts.env } : { ...opts.env, ...env };
      for (const key of ['JSN_DATA_HOME', 'XDG_CACHE_HOME']) if (opts.env[key]) childEnv[key] = opts.env[key];
      const result = await support.runProcess(node, candidate ? [executable, ...args.slice(1)] : args, { ...opts, env: childEnv });
      measurements.push({ passed: result.exitCode === 0, format: args.includes('--json') ? 'machine' : 'human', durationMs: result.durationMs, outputBytes: Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) });
      return result;
    };
    stage = 'candidate version';
    const actual = await execute(process.execPath, [ownExecutable, 'version', '--json'], { cwd: temporary, env, timeoutMs: 30000 });
    if (actual.exitCode !== 0 || actual.json?.data?.version !== artifact.identity.version) throw Error();
    let allScenarios = [];
    for (const name of ['read-only', 'read-only-catalog', 'resources', 'workflows', 'auth']) allScenarios.push(...(await import(pathToFileURL(path.join(harness, `cli/test/acceptance/${name}.mjs`)))).scenarios);
    const { bindScenarios, coverageDetails } = await import(pathToFileURL(path.join(harness, 'cli/scripts/acceptance/bindings.mjs')));
    allScenarios = adaptCatalog(allScenarios, artifact.identity);
    bindScenarios(allScenarios);
    const selected = selectExactScenario(mode === 'pdi' ? allScenarios : allScenarios.filter(s => s.modes.includes('readonly')), options.scenario);
    if (options.plan) {
      fs.writeFileSync(path.join(output, 'run-plan.json'), JSON.stringify(fullPlan(selected, mode), null, 2), { mode: 0o600 });
      return { file: path.join(output, 'run-plan.json'), planned: true };
    }
    const selection = support.selectScenarios(allScenarios, { full: true, mode });
    if (mode === 'readonly' && selected.some(s => s.mutates)) throw Error('harness: mutating scenario declared readonly');
    const selectedIds = selection.ids.filter(id => selected.some(s => s.id === id));
    const inventory = adaptInventory(JSON.parse(fs.readFileSync(path.join(harness, 'cli/test/acceptance/coverage.json'))), artifact.identity);
    const coverage = coverageDetails(inventory, allScenarios, selectedIds, mode);
    const missing = coverage.gaps;
    const omitted = allScenarios.filter(s => s.modes.includes('readonly') && !selectedIds.includes(s.id)).map(s => s.id);
    stage = 'readonly suite';
    const privateRun = path.join(temporary, 'private-run');
    const contextOptions = { mode, allowWrites: mode === 'pdi', profile: 'acceptance', expectedHost: origin, outputDir: privateRun };
    support.preflight(contextOptions, JSON.parse(fs.readFileSync(path.join(config, 'servicenow/config.json'))), {});
    const ctx = support.createContext(contextOptions, { target: origin }, { execute });
    recoveryContext = ctx;
    // The pinned context enforces this option internally but does not expose it.
    // The versioned context adapter also checks the same preflighted approval.
    ctx.allowWrites = contextOptions.allowWrites;
    if (mode === 'pdi') {
      guardFullContext(ctx, { inventory, receiptFile: path.join(output, 'cleanup-receipt.json'), target: options.target });
      ctx.state.set('workflows.allowRetainedFlows', true);
    }
    const command = ctx.command;
    // Immutable catalog bytes remain staged unchanged. Context v1 is an
    // explicit harness scenario replacement; candidate create still executes
    // through the normal command guard and dependency/finally executor.
    const restoreContext = async snapshot => {
      const original = ctx.state.get('workflows.originalContext');
      if (!original || snapshot.application !== original.application || snapshot.updateset !== original.updateset || !/^[a-f0-9]{32}$/.test(snapshot.updateset)) throw Error('Only exact snapshotted session restoration is permitted');
      const moduleURL = file => JSON.stringify(pathToFileURL(path.join(harness, 'cli/src', file)).href);
      const script = `import {App} from ${moduleURL('app.js')}; import {loadConfig} from ${moduleURL('config.js')}; import {restoreOriginalContext} from ${JSON.stringify(new URL('./acceptance/context-v1.mjs', import.meta.url).href)}; const a=new App(loadConfig({profile:'acceptance'})); if(a.getEffectiveInstance()!==${JSON.stringify(origin)}) throw Error('Target drift'); await restoreOriginalContext(a.sdk,${JSON.stringify(snapshot)}); console.log(JSON.stringify({ok:true}));`;
      const response = await support.runProcess(process.execPath, ['--input-type=module', '-e', script], { cwd: temporary, env, timeoutMs: 30000 });
      if (response.exitCode !== 0 || response.json?.ok !== true) throw Error('Exact context restoration failed');
    };
    const adapted = selected.map(s => s.id === 'workflows.context' ? contextAdapterV1(s, restoreContext) : s);
    const progressing = adapted.map(s => ({ ...s, async run(context) {
      console.log(`[${selectedIds.indexOf(s.id) + 1}/${selected.length}] ${s.id} running`);
      const reason = mode === 'pdi' && scenarioPolicy(s);
      if (reason) throw new support.ScenarioError('blocked-prerequisite', reason);
      if (s.id === 'workflows.context') return runContextScenario(context, s.run);
      if (s.id !== 'workflows.flow-lifecycle') return s.run(context);
      const original = context.command;
      let last = null;
      context.command = async (args, opts) => {
        last = { stage: args.slice(0, 2).join('.'), outcome: 'cli-threw' };
        const result = await original(args, opts);
        last = flowCommandDiagnostic(args, result);
        context.state.set('safety.flowDiagnostic', last);
        return result;
      };
      try { return await s.run(context); }
      catch (error) {
        context.state.set('safety.flowDiagnostic', { ...last, failure: error.code === 'ERR_ASSERTION' ? 'assertion' : ['blocked-prerequisite','blocked-access','blocked-capability'].includes(error.status) ? error.status : 'operation' });
        throw error;
      } finally { context.command = original; }
    } }));
    const report = await executeScenarios(progressing, ctx, { missing: [...missing], selection: { ...selection, ids: selectedIds }, provenance: artifact.identity, suiteHooks: hooks });
    if (mode === 'pdi') {
      const receiptFile = path.join(output, 'cleanup-receipt.json');
      const receipt = fs.existsSync(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile)) : { runKey:ctx.runKey, target:options.target, status:'unresolved-write-intent', countsUnavailable:true };
      receipt.sessionRestoration = ctx.state.has('workflows.originalContext') ? (ctx.state.has('workflows.context') ? 'unresolved' : 'verified-by-provider-readback') : 'not-changed';
      fs.writeFileSync(receiptFile, JSON.stringify(receipt,null,2), {mode:0o600});
    }
    for (const [index, result] of report.results.entries()) console.log(`[${index + 1}/${selected.length}] ${result.id} ${result.status} ${Math.round(result.durationMs)}ms`);
    const results = report.results.map(({ id, status, durationMs }) => ({ id, status, durationMs }));
    const release = { family: null, version: null, build: null, patch: null, hotfix: null, source: 'sys_properties.name,value via bounded records list', fields: {}, reason: 'metadata-unavailable-or-unrecognized' };
    try {
      const metadata = await command(['records', 'list', '--table', 'sys_properties', '--query', 'nameSTARTSWITHglide.build', '--fields', 'name,value', '--limit', '10', '--no-count', '--json']);
      const rows = metadata.json?.data?.records ?? metadata.json?.data;
      if (metadata.exitCode === 0 && metadata.json?.ok === true && Array.isArray(rows)) {
        const raw = v => typeof v === 'object' && v !== null ? v.value : v;
        for (const row of rows) {
          const name = raw(row.name), value = raw(row.value);
          if (name === 'glide.buildname' && /^(?:australia|zurich|yokohama|xanadu|washingtondc|vancouver|utah|tokyo|sandiego|rome|quebec|paris|orlando|newyork|madrid|london|kingston|jakarta|istanbul|helsinki|geneva|fuji|eureka|dublin|calgary|berlin|aspen)$/i.test(value || '')) { release.family = value; release.fields.family = name; }
          if (name === 'glide.buildtag' && /^glide-[a-z0-9_-]{1,180}$/i.test(value || '')) { release.build = value; release.fields.build = name; }
        }
        // Do not infer version/patch/hotfix from a build string: no verified
        // provider contract for those independent fields exists in this source.
        if (release.family !== null || release.build !== null) release.reason = 'version-patch-hotfix-not-independently-exposed';
      }
    } catch { /* Only the closed unavailable reason is retained. */ }
    const counts = {}; for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
    const payload = { schemaVersion: 2, runKey: `acceptance_${randomUUID().replaceAll('-', '')}`, mode, provenance: { sourceSHA: artifact.identity.sourceSHA, version: artifact.identity.version, node: process.version, binarySHA256: sha(fs.readFileSync(executable)), sourceDirty: artifact.identity.sourceDirty }, platform: 'linux', environment: { domainSeparation: 'UNKNOWN' }, selection: { full: !options.scenario, selected: selectedIds }, summary: { total: results.length, counts, complete: report.summary.missing.length === 0 && results.every(r => r.status === 'passed'), missingCount: report.summary.missing.length }, performance: ctx.state.has('performance.suite') ? hooks.publicPerformance(ctx.state.get('performance.suite')) : null, results };
    Object.assign(payload.provenance, { artifactKind: artifact.identity.kind, registryIntegrity: artifact.identity.integrity, harnessSHA: git(['rev-parse', 'HEAD']), producerSHA: HARNESS_SHA, target: options.target });
    payload.environment.release = release;
    stage = 'report schema';
    validateProjection(payload);
    stage = 'output permission';
    fs.mkdirSync(output, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(output, 'public-summary.json'), JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.writeFileSync(path.join(output, 'local-summary.json'), JSON.stringify({ runKey: payload.runKey, target: options.target, harness: { producerSHA: HARNESS_SHA, adapterSHA: git(['rev-parse', 'HEAD']), contextAdapter: mode === 'pdi' ? { version: 1, candidateOperation: 'updatesets create --scope global', restoration: 'trusted-sdk-official-picker-exact-snapshot-id', notCandidateEvidence: ['updatesets set', 'scopes set'], producerBytesUnchanged: true } : null }, testedArtifact: artifact.identity, coverage: { scope: options.scenario ? 'exact-scenario-with-dependencies' : mode === 'pdi' ? 'full-catalog' : 'full-readonly-catalog', selectedPassed: selectedExitCode(payload.summary) === 0, catalogScenarios: allScenarios.length, applicableSelectedMode: selected.filter(s => s.modes.includes(mode)).length, excludedMutationScenarios: mode === 'readonly' ? allScenarios.filter(s => !s.modes.includes('readonly')).map(s => s.id) : [], omittedReadonly: omitted, obligations: { ...coverage.counts, interpretation: 'static inventory requirement and option-assertion gaps; not a scenario or test count' }, missing: report.summary.missing }, scenarioOutcomes: report.results.map(r => ({ id:r.id, status:r.status, diagnostic: r.id === 'workflows.context' ? ctx.state.get('safety.contextDiagnostic') ?? null : r.id === 'workflows.flow-lifecycle' ? ctx.state.get('safety.flowDiagnostic') ?? null : null, reason: r.status.startsWith('blocked') ? scenarioPolicy({id:r.id}) || (r.id.startsWith('auth.') ? 'Requires verified OAuth bootstrap, observed domain and provider-supported isolated Basic/cookie session prerequisites; dependencies may be blocked' : 'Required provider capability, dictionary or prerequisite scenario unavailable; never inferred passed') : null })), executableVersionVerified: true, release, measurements, humanMeasurementsPassed: measurements.filter(m => m.format === 'human' && m.passed).length, tokens: { status: 'unavailable', tokenizer: null } }, null, 2), { mode: 0o600 });
    return { file: path.join(output, 'public-summary.json'), summary: payload.summary };
  } catch (error) {
    if (error instanceof LocalFailure) throw error;
    const reasons = {
      'npm artifact': 'exact version unavailable, registry unreachable, integrity mismatch or npm installation failed; verify the version and npm connectivity',
      'profile/auth': 'profile target or credentials unavailable; authenticate the selected OAuth or Basic profile',
      'harness preparation': 'pinned producer or CLI dependencies unavailable; fetch the pinned revision and run npm --prefix cli ci --ignore-scripts',
      'candidate version': 'candidate executable did not report the verified exact package version',
      'readonly suite': 'guarded producer could not finish; check the local harness and private scratch-directory permissions',
      'report schema': 'result projection failed the publication schema; no unvalidated report saved',
      'output permission': 'unable to save private summary files; check run-directory permissions',
    };
    throw new LocalFailure(`${stage}: ${reasons[stage]}`);
  } finally {
    // A failed preservation must not erase the only remaining recovery source.
    if (recoveryContext) preserveRecovery(recoveryContext, output, options.target);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  const result = options.result ? { file: path.resolve(options.result) } : await runLocal(options);
  if (result.planned) console.log(`Plan saved: ${result.file}`);
  if (result.summary) {
    console.log(JSON.stringify(result.summary));
    const directory = path.dirname(result.file), name = path.basename(directory);
    const location = !args.includes('--output') && path.dirname(directory) === path.join(os.homedir(), 'private-acceptance') && /^[a-z0-9.TZ-]+$/.test(name) ? `$HOME/private-acceptance/${name}` : 'the explicit output directory';
    console.log(`Saved public-summary.json and local-summary.json in ${location}`);
  }
  if (options.publish && !result.planned) { const publication = await publishResults({ file: result.file, url: process.env.JSN_ACCEPTANCE_INGEST_URL, token: process.env.JSN_ACCEPTANCE_INGEST_TOKEN }); console.log(JSON.stringify(publication)); if (!publication.ok) return 1; }
  return result.summary ? selectedExitCode(result.summary) : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().then(code => { process.exitCode = code; }).catch(error => { console.error(/^(mode|output|profile|auth|npm artifact|profile\/auth|harness preparation|candidate version|readonly suite|report schema|output permission):/.test(error.message) ? error.message : 'options: use --version EXACT --profile NAME --target LABEL; output defaults to a unique private directory'); process.exitCode = 1; });
