import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { publicPerformance } from '../../test/acceptance/performance.mjs';
import recordProfiles from '../../src/record-command-profiles.js';

function cleanupIdentity(args, table, id) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string') || args[1] !== 'delete') return false;
  const options = new Map(), positionals = [];
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (['--force', '--json'].includes(arg)) continue;
    if (['--table', '--sys-id'].includes(arg)) { if (options.has(arg) || !args[i + 1]) return false; options.set(arg, args[++i]); }
    else if (arg.startsWith('-')) return false;
    else positionals.push(arg);
  }
  const identity = options.get('--sys-id') || positionals[0];
  if (identity !== id || positionals.length > (options.has('--sys-id') ? 0 : 1)) return false;
  if (args[0] === 'records') return options.get('--table') === table;
  if (options.size) return false;
  return (args[0] === 'users' ? 'sys_user' : recordProfiles[args[0]]?.table) === table;
}

export const cliRoot = fileURLToPath(new URL('../../', import.meta.url));
const redirects = /^(SERVICENOW_INSTANCE_URL|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|HTTPS?_PROXY|ALL_PROXY)$/i;
const readonlyCommands = new Set(['auth status', 'records list', 'records get', 'tables list', 'columns list', 'version', 'completion', 'history list']);
export function parseArgs(args) {
  const values = new Set(['mode', 'profile', 'expected-host', 'output-dir', 'release', 'changed-file', 'cli-path', 'auth-config', 'catalog-recipe', 'scenario']);
  const flags = new Set(['allow-writes', 'full', 'preflight', 'keep', 'allow-retained-flows']);
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const result = { mode: 'readonly', release: 'major', changed: [], scenarios: [] };
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || (!values.has(key) && !flags.has(key))) throw new Error(`Unknown argument: ${args[i]}`);
    const name = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (flags.has(key)) result[name] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value: --${key}`);
      if (key === 'changed-file') result.changed.push(value); else if (key === 'scenario') result.scenarios.push(value); else result[name] = value;
    }
  }
  return result;
}
function origin(value) {
  const url = new URL(value.includes('://') ? value : `https://${value}`);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Expected an origin or host only');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('HTTPS required outside loopback');
  return url.origin;
}
export function preflight(options, config, env = process.env) {
  if (!options.profile || !options.expectedHost) throw new Error('Explicit --profile and --expected-host required');
  if (!['readonly', 'pdi'].includes(options.mode)) throw new Error('Invalid mode');
  if (!['major', 'minor', 'patch'].includes(options.release || 'major')) throw new Error('Invalid release');
  if (options.mode === 'pdi' && !options.allowWrites) throw new Error('PDI requires --allow-writes');
  if (options.mode === 'readonly' && options.allowWrites) throw new Error('readonly refuses --allow-writes');
  for (const [key, value] of Object.entries(env)) if (value && redirects.test(key)) throw new Error(`Unsafe environment override: ${key}`);
  const profile = config.profiles?.[options.profile];
  if (!profile?.instance_url) throw new Error('Unknown profile or missing profile target');
  const target = origin(profile.instance_url);
  if (target !== origin(options.expectedHost)) throw new Error('Profile target does not match expected target');
  return { target, profile };
}
export function selectScenarios(scenarios, options) {
  const all = scenarios.map(s => s.id);
  const full = reason => ({ ids: all, full: true, reason });
  if (options.scenarios?.length) {
    const selected = new Set();
    const add = id => {
      if (selected.has(id)) return;
      const scenario = scenarios.find(s => s.id === id);
      if (!scenario) throw new Error('Unknown explicit scenario or dependency');
      selected.add(id);
      for (const dependency of scenario.requires || []) add(dependency);
    };
    options.scenarios.forEach(add);
    return { ids: all.filter(id => selected.has(id)), full: false, reason: 'explicit subset with prerequisites; not full-product acceptance' };
  }
  if (options.full || options.release !== 'patch') return full('explicit/full major or minor');
  if (!options.changed?.length) return full('no changed files provided');
  const selected = new Set();
  for (const source of options.changed) {
    if (/^cli\/src\/[^/]+\.js$/.test(source) || /^cli\/src\/commands\/_(generic|simple|ticket)\.js$/.test(source) || /(^|\/)(package(-lock)?\.json|auth\/)/.test(source)) return full('shared SDK/auth/parser/output or dependency change');
    const matches = scenarios.filter(s => s.sources?.includes(source));
    if (!matches.length) return full(`unresolved impact: ${source}`);
    matches.forEach(s => selected.add(s.id));
  }
  let previous;
  do {
    previous = selected.size;
    // Both prerequisites and dependents of an impacted scenario are relevant.
    for (const s of scenarios) {
      if (selected.has(s.id)) for (const dep of s.requires || []) {
        if (!all.includes(dep)) return full(`unresolved dependency: ${dep}`);
        selected.add(dep);
      }
      if ((s.requires || []).some(dep => selected.has(dep))) selected.add(s.id);
    }
  } while (previous !== selected.size);
  return { ids: all.filter(id => selected.has(id)), full: false, reason: 'source impact and dependency closure' };
}
export class ScenarioError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const outcomes = new Set(['passed', 'failed', 'failed-timeout', 'blocked-prerequisite', 'blocked-access', 'blocked-capability', 'excluded-mode', 'not-run']);
export function classify(error) {
  if (error.status === 'blocked') return 'blocked-prerequisite';
  if (outcomes.has(error.status)) return error.status;
  if (/timed? ?out|timeout/i.test(error.message)) return 'failed-timeout';
  return 'failed';
}
export function assertCommand(result, { exitCode = 0, json = false, human } = {}) {
  assert.equal(result.exitCode, exitCode, 'unexpected CLI exit code');
  if (json) assert.notEqual(result.json, undefined, 'invalid JSON output');
  if (human) assert.ok(human.test(result.stdout), 'Expected human output contract missing');
  return result;
}
export function classifyCommand(result) {
  if (result.timedOut) throw new ScenarioError('failed-timeout', 'CLI timeout');
  if (result.exitCode !== 0) {
    const text = `${result.stderr} ${result.stdout}`;
    if (/403|forbidden|access denied|ACL/i.test(text)) throw new ScenarioError('blocked-access', 'Provider denied access');
    if (/404|not supported|not installed|invalid table/i.test(text)) throw new ScenarioError('blocked-capability', 'Provider capability unavailable');
    throw new ScenarioError('failed', 'CLI command failed; see private receipt');
  }
  return result;
}
export function runProcess(executable, args, { cwd = cliRoot, env = process.env, timeoutMs = 30000, maxBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, overflow = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const collect = stream => data => {
      if (stream === 'out') stdout += data; else stderr += data;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxBytes) { overflow = true; child.kill('SIGKILL'); }
    };
    child.stdout.on('data', collect('out')); child.stderr.on('data', collect('err'));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      let json; try { json = JSON.parse(stdout); } catch { /* validated by caller */ }
      resolve({ exitCode: code ?? -1, stdout, stderr, json, durationMs: performance.now() - start, timedOut, overflow });
    });
  });
}
export function privateJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
export function summarize(results, missing = []) {
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  return { total: results.length, counts, missing, complete: results.length > 0 && missing.length === 0 && results.every(r => r.status === 'passed') };
}
export function publicProjection(report, performanceState) {
  const source = {};
  for (const [key, pattern] of Object.entries({ sourceSHA: /^[a-f0-9]{40}$/, version: /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/, node: /^v\d+\.\d+\.\d+$/, binarySHA256: /^[a-f0-9]{64}$/ })) if (pattern.test(report.provenance[key] || '')) source[key] = report.provenance[key];
  if (typeof report.provenance.sourceDirty === 'boolean') source.sourceDirty = report.provenance.sourceDirty;
  const safeId = id => typeof id === 'string' && /^[a-z][a-z0-9.-]{0,100}$/.test(id);
  const results = report.results.filter(r => safeId(r.id)).map(({ id, status, durationMs }) => ({ id, status: outcomes.has(status) ? status : 'failed', durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0 }));
  const counts = {}; for (const result of results) counts[result.status] = (counts[result.status] || 0) + 1;
  return { schemaVersion: 1, runKey: /^acceptance_[a-f0-9]{32}$/.test(report.runKey) ? report.runKey : 'unknown', mode: ['readonly', 'pdi'].includes(report.mode) ? report.mode : 'unknown', provenance: source,
    platform: 'linux', environment: { domainSeparation: 'UNKNOWN' }, selection: { full: report.selection.full === true, selected: report.selection.ids.filter(safeId) },
    summary: { total: results.length, counts, complete: report.summary.complete === true, missingCount: report.summary.missing.length },
    performance: performanceState ? publicPerformance(performanceState) : null,
    results };
}
export function provenance(cliPath) {
  const repository = path.resolve(cliRoot, '..');
  const git = args => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  return { cliPath, binarySHA256: createHash('sha256').update(fs.readFileSync(cliPath)).digest('hex'),
    sourceSHA: git(['rev-parse', 'HEAD']), sourceDirty: !!git(['status', '--porcelain', '--untracked-files=no']),
    version: JSON.parse(fs.readFileSync(path.join(cliRoot, 'package.json'))).version, node: process.version };
}
export function verifyCliArtifact(cliPath) {
  const own = path.join(cliRoot, 'bin/jsn.js');
  if (fs.realpathSync(cliPath) === fs.realpathSync(own)) return;
  const root = path.resolve(path.dirname(cliPath), '..');
  if (path.resolve(cliPath) !== path.join(root, 'bin/jsn.js')) throw new Error('External artifact must use the canonical bin/jsn.js entrypoint');
  const manifest = base => {
    const files = {};
    const walk = relative => {
      const full = path.join(base, relative), stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error('Artifact source symlinks are unverified');
      if (stat.isDirectory()) for (const name of fs.readdirSync(full).sort()) walk(path.join(relative, name));
      else if (stat.isFile()) files[relative] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      else throw new Error('Artifact has non-file source');
    };
    walk('src'); walk('bin');
    const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
    files.packageIdentity = JSON.stringify([pkg.name, pkg.version, pkg.type, pkg.dependencies, pkg.optionalDependencies, pkg.imports]);
    return files;
  };
  const expected = manifest(cliRoot), actual = manifest(root);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('External artifact source provenance does not match this checkout');
}
export function createContext(options, target, { execute = runProcess } = {}) {
  if (!options.profile || !target?.target || !['readonly', 'pdi'].includes(options.mode)) throw new Error('Verified profile/target/mode required');
  if (options.mode === 'pdi' && !options.allowWrites) throw new Error('PDI requires --allow-writes');
  const outputDir = path.resolve(options.outputDir);
  if (fs.existsSync(path.join(outputDir, 'artifacts.json'))) throw new Error('Output directory already owns an artifact manifest; choose a new run directory');
  if (fs.existsSync(outputDir) && (fs.lstatSync(outputDir).isSymbolicLink() || fs.readdirSync(outputDir).length)) throw new Error('Output directory must be empty and not a symlink');
  verifyCliArtifact(options.cliPath || path.join(cliRoot, 'bin/jsn.js'));
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(outputDir, 0o700);
  const artifacts = [], writeIntents = [], state = new Map();
  let receipt = 0;
  const ctx = { runKey: options.runKey || `acceptance_${randomUUID().replaceAll('-', '')}`, mode: options.mode, profile: options.profile,
    expectedHost: target.target, cliPath: path.resolve(options.cliPath || path.join(cliRoot, 'bin/jsn.js')), outputDir, state };
  const persist = () => privateJSON(path.join(outputDir, 'artifacts.json'), { runKey: ctx.runKey, mode: ctx.mode, profile: ctx.profile, expectedHost: ctx.expectedHost, artifacts, writeIntents });
  const unresolved = () => writeIntents.some(i => i.status !== 'resolved');
  const checkpoint = () => {
    state.set('writes.unresolved', unresolved());
    const file = path.join(outputDir, 'artifacts.json');
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.runKey !== ctx.runKey || saved.profile !== ctx.profile || saved.expectedHost !== ctx.expectedHost) throw new Error('Write journal ownership/target mismatch');
    }
    persist();
  };
  // Only exact-ID absence can settle a dispatched DELETE. A still-present row
  // cannot prove that an earlier request is no longer in flight.
  ctx.reconcileWrites = async () => {
    for (const intent of writeIntents.filter(i => i.status !== 'resolved' && i.action === 'delete' && i.id)) {
      try {
        const found = await ctx.read(intent.table, { query: `sys_id=${intent.id}`, fields: ['sys_id'], limit: 1 });
        if (Array.isArray(found) && found.length === 0) {
          intent.status = 'resolved';
          const artifact = artifacts.find(a => a.table === intent.table && a.id === intent.id);
          if (artifact) artifact.cleaned = true;
        }
      } catch { /* No evidence of absence; never dispatch a retry. */ }
    }
    if (writeIntents.length) checkpoint();
    return unresolved();
  };
  const environment = extra => {
    const allowedEnv = /^(HOME|XDG_CONFIG_HOME|XDG_CACHE_HOME|JSN_DATA_HOME|PATH|DBUS_SESSION_BUS_ADDRESS|SERVICENOW_OAUTH_TOKEN|SN_USERNAME|SN_PASSWORD|SN_[A-Z0-9]+_(USERNAME|PASSWORD))$/;
    for (const [key, value] of Object.entries(extra || {})) {
      if (redirects.test(key) || !allowedEnv.test(key)) throw new Error('Target/config redirection refused');
      if (key === 'SERVICENOW_OAUTH_TOKEN' && value) throw new Error('Fixture OAuth override refused');
      if (key === 'DBUS_SESSION_BUS_ADDRESS' && value !== 'unix:path=/nonexistent-jsn-acceptance-bus') throw new Error('Fixture keyring access refused');
      if (key === 'PATH' && fs.existsSync(value) && fs.readdirSync(value).length) throw new Error('Fixture PATH must be empty');
      if (['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'JSN_DATA_HOME', 'PATH'].includes(key)) {
        const resolved = path.resolve(value);
        if (!resolved.startsWith(`${outputDir}${path.sep}`) || value.includes(path.delimiter)) throw new Error('Fixture environment path must stay within private run directory');
        let ancestor = resolved;
        while (!fs.existsSync(ancestor) && ancestor !== path.dirname(ancestor)) ancestor = path.dirname(ancestor);
        const real = fs.realpathSync(ancestor);
        if (real !== fs.realpathSync(outputDir) && !real.startsWith(`${fs.realpathSync(outputDir)}${path.sep}`)) throw new Error('Fixture environment symlink escapes run directory');
      }
    }
    if (Object.keys(extra || {}).some(key => /^(HOME|PATH|SN_|DBUS_)/.test(key)) && !extra?.XDG_CONFIG_HOME) throw new Error('Fixture credentials require isolated private run config');
    if (extra?.XDG_CONFIG_HOME) {
      const file = path.join(extra.XDG_CONFIG_HOME, 'servicenow/config.json');
      const realFile = fs.realpathSync(file);
      if (fs.lstatSync(file).isSymbolicLink() || !realFile.startsWith(`${fs.realpathSync(outputDir)}${path.sep}`)) throw new Error('Fixture config symlink escapes run directory');
      const fixtureConfig = JSON.parse(fs.readFileSync(file, 'utf8'));
      const selected = fixtureConfig.profiles?.[ctx.profile];
      const profileKeys = new Set(['instance_url', 'username', 'auth_method', 'read_only', 'skip_confirmations', 'domain']);
      if (Object.keys(fixtureConfig).some(key => !['default_profile', 'profiles'].includes(key)) || Object.keys(selected || {}).some(key => !profileKeys.has(key))) throw new Error('Unclassified fixture config refused');
      if (Object.keys(fixtureConfig.profiles || {}).length !== 1 || origin(selected?.instance_url || '') !== target.target) throw new Error('Isolated fixture profile must match selected target');
    }
    // Never inherit deployment/provider/peer credentials into acceptance children.
    // The primary selected profile still uses its normal on-disk/keyring auth;
    // fixture actors replace HOME/config/PATH and disable the session bus.
    const env = {};
    for (const key of ['HOME', 'PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TERM', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) if (process.env[key] !== undefined) env[key] = process.env[key];
    return { ...env, JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_DOCS_CHECK: '1',
      JSN_DATA_HOME: path.join(outputDir, 'data'), XDG_CACHE_HOME: path.join(outputDir, 'cache'), ...extra };
  };
  const launch = async (args, opts = {}, executable = process.execPath) => {
    const result = await execute(executable, args, { cwd: outputDir, env: environment(opts.env), timeoutMs: Math.min(opts.timeoutMs || 30000, 120000) });
    // Arguments and environment intentionally omitted. Even argv may contain secrets.
    privateJSON(path.join(outputDir, `command-${++receipt}.json`), result);
    if (result.timedOut || result.overflow) throw new ScenarioError(result.timedOut ? 'failed-timeout' : 'failed', 'CLI exceeded execution bounds');
    return result;
  };
  ctx.command = async (args, opts = {}) => {
    if (!Array.isArray(args) || args.some(x => typeof x !== 'string')) throw new Error('Command arguments must be strings');
    if (args.some(x => /^(--(instance|profile)(=|$)|-[ip]($|=))/.test(x))) throw new Error('Command target override refused');
    const inventory = JSON.parse(fs.readFileSync(path.join(cliRoot, 'test/acceptance/coverage.json'), 'utf8'));
    const registration = inventory.entries.filter(entry => !entry.path.includes('<') && entry.path.split(' ').every((token, index) => token === args[index])).sort((a, b) => b.path.length - a.path.length)[0];
    if (!registration) throw new Error('Unknown command refused');
    const acceptedFlags = new Set(['--help']);
    for (const id of registration.effectiveOptions) {
      const definition = inventory.optionDefinitions[id];
      for (const name of [definition.name, ...(definition.aliases || [])]) {
        acceptedFlags.add(`${name.length === 1 ? '-' : '--'}${name}`);
        if (definition.type === 'boolean') acceptedFlags.add(`--no-${name}`);
      }
    }
    if (args.some(arg => arg.startsWith('-') && !acceptedFlags.has(arg.split('=')[0]))) throw new Error('Unknown command argument refused');
    const key = args.slice(0, 2).join(' ');
    const catalogRead = (await import('../../test/acceptance/read-only-catalog.mjs')).scenarios.some(s => s.commandPaths.includes(key));
    const allowed = catalogRead || readonlyCommands.has(key) || readonlyCommands.has(args[0]) || ['perf capture', 'perf show', 'perf list', 'perf compare'].includes(key);
    if (ctx.mode === 'readonly' && !allowed) throw new Error('Mutation or unclassified command refused in readonly mode');
    if (args.some(arg => /javascript:|sysparm_(script|processor|action)|\/stats\.do|sys\.scripts\.do/i.test(arg) && arg !== 'user_name=javascript:gs.getUserName()')) throw new Error('Executable query or mutation-shaped GET refused');
    if (args[0] === 'rest' && !(args[1]?.match(/^\/api\/now\/ui\/concoursepicker\/(application|updateset)$/) && args.slice(2).join(' ') === '--method GET --json')) throw new Error('Unclassified REST operation refused');
    if (ctx.mode === 'readonly') {
      const flags = new Set(['--json', '--format', '--query', '--fields', '--columns', '--limit', '--no-count', '--table', '--sys-id', '--details', '--label', '--help', ...(catalogRead ? ['--display-values', '--identifier-field', '--no-essential'] : [])]);
      if (args.some(arg => arg.startsWith('-') && !flags.has(arg))) throw new Error('Unknown readonly argument refused');
    }
    if (args[0] === 'store') throw new Error('Store excluded from live acceptance');
    // Journal before dispatch, never argv, payloads, file contents or credentials.
    // The inventory supplies mutation semantics; auth login is local credential
    // setup, not a provider record allocation.
    let intent;
    if (ctx.mode === 'pdi' && registration.declaredMutation && !['auth', 'rest'].includes(args[0]) && !args.includes('--help')) {
      environment(opts.env); // Validate local confinement before recording a dispatch intent.
      if (unresolved()) throw new ScenarioError('blocked-prerequisite', 'Unresolved write intent; read-only reconciliation required');
      const option = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
      const table = option('--table') || (args[0] === 'users' ? 'sys_user' : recordProfiles[args[0]]?.table) || ({ updatesets: 'sys_update_set', flows: 'sys_hub_flow', catalogitems: 'sc_cat_item', scopes: 'sys_scope' })[args[0]];
      if (!table || !/^[a-zA-Z0-9_]+$/.test(table)) throw new Error('Mutation requires bounded table identity');
      let name = option('--name') || opts.writeIdentity?.name;
      if (!name && option('--data')) {
        const data = JSON.parse(option('--data'));
        name = data.name || data.user_name || data.short_description;
      }
      // A natural key is diagnostic only, never ownership or permission to delete.
      if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,200}$/.test(name)) name = undefined;
      const candidate = option('--sys-id') || args[2];
      intent = { runKey: ctx.runKey, table, action: args[1], name, id: /^[a-f0-9]{32}$/.test(candidate || '') ? candidate : undefined,
        captureId: state.get('workflows.context')?.captureId, status: 'uncertain' };
      writeIntents.push(intent); checkpoint();
    }
    // Explicit --profile is appended even for auth status, whose production
    // implementation filters selectedProfiles before authenticating.
    const result = await launch([ctx.cliPath, ...args, '--profile', ctx.profile, '--instance', target.target], opts);
    if (intent) {
      const acknowledged = result.exitCode === 0 && result.json?.ok === true;
      // Negative tests supply a bounded result validator, not a blanket bypass.
      const denied = result.exitCode !== 0 && typeof opts.expectedDenial === 'function' && opts.expectedDenial(result) === true;
      if (denied) intent.status = 'resolved';
      else if (acknowledged && intent.action === 'create') {
        const allocated = result.json.data?.sys_id?.value ?? result.json.data?.sys_id ?? result.json.data?.flow?.id;
        if (/^[a-f0-9]{32}$/.test(allocated || '')) {
          intent.id = allocated; checkpoint();
          try {
            const found = await ctx.read(intent.table, { id: allocated, fields: ['sys_id'], limit: 1 });
            const record = Array.isArray(found) ? found.length === 1 ? found[0] : null : found;
            if ((record?.sys_id?.value ?? record?.sys_id) === allocated) intent.status = 'acknowledged';
          } catch { /* Allocation acknowledgement without readback remains uncertain. */ }
        }
      } else if (acknowledged && intent.action !== 'delete') intent.status = 'resolved';
      checkpoint();
      if (intent.action === 'delete' && !denied) await ctx.reconcileWrites();
    }
    return result;
  };
  ctx.read = async (table, { id, query, fields = ['sys_id'], limit = 1 } = {}) => {
    if (!/^[a-zA-Z0-9_]+$/.test(table) || (id && !/^[a-f0-9]{32}$/.test(id))) throw new Error('Invalid table or exact ID');
    if (!Number.isInteger(limit) || limit < 1 || limit > (table === 'sys_dictionary' ? 500 : 10) || !Array.isArray(fields) || !fields.length || fields.some(f => !/^[a-zA-Z0-9_.]+$/.test(f))) throw new Error('Unbounded read refused');
    if (query && /javascript:|sysparm_(script|processor|action)/i.test(query)) throw new Error('Executable read query refused');
    const params = new URLSearchParams({ sysparm_limit: String(limit), sysparm_fields: fields.join(','), sysparm_exclude_reference_link: 'true' });
    if (query) params.set('sysparm_query', query);
    const endpoint = `${target.target}/api/now/table/${table}${id ? `/${id}` : ''}?${params}`;
    const script = `import {App} from ${JSON.stringify(pathToFileURL(path.join(cliRoot, 'src/app.js')).href)}; import {loadConfig} from ${JSON.stringify(pathToFileURL(path.join(cliRoot, 'src/config.js')).href)}; const a=new App(loadConfig({profile:${JSON.stringify(ctx.profile)}})); if(a.getEffectiveInstance()!==${JSON.stringify(target.target)}) throw Error('Target drift'); const r=await a.sdk.request(${JSON.stringify(endpoint)}); console.log(JSON.stringify(r));`;
    const response = await launch(['--input-type=module', '-e', script]);
    if (table === 'domain' && response.exitCode !== 0 && /invalid table(?:\s+|:\s*)["'`]?domain\b/i.test(`${response.json?.error?.message || ''} ${response.stderr || ''}`)) throw Object.assign(new Error('Invalid table domain'), { status: 404 });
    const result = classifyCommand(response);
    assertCommand(result, { json: true });
    return result.json.result ?? result.json;
  };
  ctx.registerArtifact = artifact => {
    if (ctx.mode !== 'pdi' || !options.allowWrites) throw new Error('Artifact registration requires write opt-in');
    if (!/^[a-zA-Z0-9_]+$/.test(artifact.table) || !/^[a-f0-9]{32}$/.test(artifact.id) || !artifact.kind) throw new Error('Exact artifact identity required');
    if (artifacts.some(a => a.table === artifact.table && a.id === artifact.id)) throw new Error('Artifact already registered');
    const dependencies = artifact.dependsOn || [];
    if (!Array.isArray(dependencies) || dependencies.some(id => !artifacts.some(a => a.id === id))) throw new Error('Artifact dependency must already be owned');
    const entry = { table: artifact.table, id: artifact.id, kind: artifact.kind, dependsOn: [...dependencies], cleanupArgs: artifact.cleanupArgs ? [...artifact.cleanupArgs] : null, cleaned: false };
    if (entry.cleanupArgs && !cleanupIdentity(entry.cleanupArgs, entry.table, entry.id)) throw new Error('Cleanup must reference exact owned ID and table through a supported delete command');
    artifacts.push({ ...entry, runKey: ctx.runKey, profile: ctx.profile, expectedHost: ctx.expectedHost });
    for (const intent of writeIntents) if (intent.status === 'acknowledged' && intent.table === entry.table && intent.id === entry.id) intent.status = 'resolved';
    checkpoint(); return entry;
  };
  ctx.cleanup = async () => {
    const failures = [], blockedParents = new Set();
    state.set('cleanup.unresolvedChildren', await ctx.reconcileWrites());
    if (unresolved()) return ['unresolved-write-intent'];
    const pending = artifacts.filter(a => !a.cleaned);
    while (pending.length) {
      const index = pending.findIndex(a => !pending.some(other => other !== a && other.dependsOn.includes(a.id)));
      if (index < 0) { failures.push('artifact dependency cycle'); state.set('cleanup.unresolvedChildren', true); break; }
      const [a] = pending.splice(index, 1);
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'artifacts.json'), 'utf8'));
        if (manifest.runKey !== ctx.runKey || manifest.profile !== ctx.profile || manifest.expectedHost !== ctx.expectedHost || a.runKey !== ctx.runKey || a.profile !== ctx.profile || a.expectedHost !== ctx.expectedHost || !manifest.artifacts.some(row => row.id === a.id && row.table === a.table && row.runKey === ctx.runKey)) throw new Error('Cleanup ownership/target mismatch');
        if (a.kind === 'capture-set') {
          // Provider capture members and safe capture-set deletion are not proven.
          // Keep the exact owned set dirty; never delete an active capture set or
          // capture child deletions in the restored user's personal context.
          failures.push(`retained-capture:${a.id}`); persist(); continue;
        }
        if (blockedParents.has(a.id)) throw new Error('Dependent cleanup unresolved');
        const capture = state.get('workflows.context');
        if (capture) {
          const result = classifyCommand(await ctx.command(['rest', '/api/now/ui/concoursepicker/updateset', '--method', 'GET', '--json']));
          if (result.json?.data?.result?.current?.sysId !== capture.captureId) throw new Error('Cleanup capture context drift');
        }
        const before = await ctx.read(a.table, { query: `sys_id=${a.id}`, fields: ['sys_id'], limit: 1 });
        if (!Array.isArray(before)) throw new Error('Invalid cleanup pre-read');
        if (before.length === 0) { a.cleaned = true; persist(); continue; }
        if (before.length !== 1 || (before[0].sys_id?.value ?? before[0].sys_id) !== a.id) throw new Error('Cleanup identity mismatch');
        if (!a.cleanupArgs || !cleanupIdentity(a.cleanupArgs, a.table, a.id)) throw new Error('Missing or invalid exact-ID cleanup command');
        const deleted = await ctx.command(a.cleanupArgs);
        if (a.cleaned) continue; // command reconciliation already proved exact-ID absence
        classifyCommand(deleted);
        let absent = false;
        try { const rows = await ctx.read(a.table, { query: `sys_id=${a.id}`, fields: ['sys_id'], limit: 1 }); absent = Array.isArray(rows) && rows.length === 0; } catch { /* cannot claim absent */ }
        if (!absent) throw new Error('Cleanup readback not absent');
        a.cleaned = true; persist();
      } catch { failures.push(`${a.table}:${a.id}`); state.set('cleanup.unresolvedChildren', true); a.dependsOn.forEach(id => blockedParents.add(id)); persist(); }
    }
    return failures;
  };
  persist();
  return ctx;
}
export async function poll(check, { attempts = 5, intervalMs = 200 } = {}) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 30 || intervalMs < 0 || intervalMs > 5000) throw new Error('Invalid polling bounds');
  for (let i = 0; i < attempts; i++) { const result = await check(); if (result) return result; if (i + 1 < attempts) await new Promise(r => setTimeout(r, intervalMs)); }
  throw new ScenarioError('failed-timeout', 'Bounded polling exhausted');
}
