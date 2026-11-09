import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../../src/config.js';
import { cliRoot, parseArgs, preflight, selectScenarios, createContext, provenance, privateJSON, summarize, publicProjection, classify } from './support.mjs';

import { beginSuite, endSuite, publicPerformance } from '../../test/acceptance/performance.mjs';
import { bindScenarios, coverageDetails } from './bindings.mjs';

export function coverageGaps(coverage, scenarios, selectedIds, mode, selectedScope = false) {
  return coverageDetails(coverage, scenarios, selectedIds, mode, selectedScope).gaps;
}
export async function executeScenarios(scenarios, ctx, { missing = [], selection = { ids: scenarios.map(s => s.id), full: true }, provenance: source = {}, suiteHooks = null } = {}) {
  const results = [], finished = new Map(), attempted = new Set();
  const report = { schemaVersion: 1, runKey: ctx.runKey, mode: ctx.mode, profile: ctx.profile, expectedHost: ctx.expectedHost, provenance: source, selection, results };
  const save = () => {
    report.summary = summarize(results, missing);
    const perf = ctx.state.get('performance.suite');
    if (perf) report.performance = publicPerformance(perf);
    report.interrupted = ctx.state.get('suite.interrupted') === true;
    privateJSON(path.join(ctx.outputDir, 'private-report.json'), report);
    privateJSON(path.join(ctx.outputDir, 'public-summary.json'), publicProjection(report, perf));
  };
  save();
  const queue = scenarios.filter(s => selection.ids.includes(s.id));
  const interrupt = () => { ctx.state.set('suite.interrupted', true); save(); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    if (suiteHooks) {
      try { await suiteHooks.beginSuite(ctx); } catch { ctx.state.set('performance.hookFailure', true); }
      save();
    }
  while (queue.length) {
    if (ctx.state.get('suite.interrupted')) { missing.push('interrupted:not-run-scenarios'); break; }
    let index = queue.findIndex(s => (s.requires || []).every(id => finished.has(id) || !queue.some(other => other.id === id)));
    if (index < 0) index = 0; // unresolved/cyclic prerequisites become blocked, never executed
    const [scenario] = queue.splice(index, 1);
    const start = performance.now();
    let status = 'passed', detail;
    try {
      if (!scenario.modes.includes(ctx.mode)) status = 'excluded-mode';
      else if (ctx.mode === 'readonly' && scenario.mutates) throw new Error('Mutating scenario declared in readonly mode');
      else if ((scenario.requires || []).some(id => finished.get(id) !== 'passed') || (scenario.mutates && ctx.state.get('writes.unresolved'))) status = 'blocked-prerequisite';
      else {
        attempted.add(scenario.id);
        const outcome = await scenario.run(ctx);
        if (outcome?.status && outcome.status !== 'passed') {
          status = classify({ status: outcome.status, message: '' });
          detail = 'Scenario returned a nonpassing outcome';
        }
      }
    } catch (error) { status = classify(error); detail = String(error?.message || 'Scenario failed').slice(0, 500); }
    const result = { id: scenario.id, status, durationMs: performance.now() - start, detail };
    finished.set(scenario.id, status); results.push(result); save();
  }
  } finally {
    // Provider captures bracket all scenarios even on thrown failures/signals.
    if (suiteHooks) {
      try { await suiteHooks.endSuite(ctx); } catch { ctx.state.set('performance.hookFailure', true); }
    }
    if (ctx.state.get('suite.interrupted')) missing.push('interrupted');
    if (ctx.reconcileWrites) {
      try { if (await ctx.reconcileWrites()) ctx.state.set('cleanup.unresolvedChildren', true); }
      catch { ctx.state.set('cleanup.unresolvedChildren', true); }
    }
    if (!ctx.keep) {
      try { for (const id of await ctx.cleanup()) missing.push(`cleanup:${id}`); }
      catch { missing.push('cleanup:unresolved'); ctx.state.set('cleanup.unresolvedChildren', true); }
    }
    for (const s of [...scenarios].reverse()) {
      if (!attempted.has(s.id) || !s.cleanup || !s.modes.includes(ctx.mode)) continue;
      if (s.id === 'workflows.context' && (ctx.state.get('writes.unresolved') || (!ctx.keep && ctx.state.get('cleanup.unresolvedChildren')))) { missing.push('cleanup:context-retained-for-unresolved-children'); continue; }
      try { await s.cleanup(ctx); } catch { missing.push(`cleanup:${s.id}`); }
    }
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    save();
  }
  return report;
}
export async function loadCatalogRecipe(ctx, file) {
  const stat = await fs.promises.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Catalog recipe must be a regular private file');
  if ((stat.mode & 0o777) !== 0o600 || stat.size > 8192) throw new Error('Catalog recipe must be mode 0600 and <= 8192 bytes');
  let input;
  try { input = JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch { throw new Error('Catalog recipe is not valid JSON'); }
  const allowed = ['actionTypeId', 'inputs', 'triggerInputs'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw new Error('Unknown catalog recipe field');
  if (!/^[a-f0-9]{32}$/i.test(input.actionTypeId || '')) throw new Error('Catalog recipe actionTypeId must be an exact provider sys_id');
  const checkInputs = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Catalog recipe inputs must be objects');
    for (const [key, entry] of Object.entries(value)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,80}$/.test(key)) throw new Error('Invalid catalog recipe input name');
      if (typeof entry !== 'string' || entry.length > 500) throw new Error('Catalog recipe input values must be bounded strings');
    }
    return value;
  };
  const recipe = { actionTypeId: input.actionTypeId.toLowerCase(), inputs: checkInputs(input.inputs) };
  if (input.triggerInputs !== undefined) recipe.triggerInputs = checkInputs(input.triggerInputs);
  ctx.state.set('workflows.catalogRecipe', recipe);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log('Usage: npm --prefix cli run test:acceptance -- --profile NAME --expected-host HOST [--mode readonly|pdi] [--allow-writes] [--preflight] [--keep] [--full] [--release major|minor|patch] [--changed-file PATH] [--output-dir PRIVATE_DIR] [--cli-path VERIFIED_PACKAGE/bin/jsn.js] [--auth-config PRIVATE_JSON] [--catalog-recipe PRIVATE_JSON] [--allow-retained-flows] [--scenario EXACT_ID]');
    return 0;
  }
  // Only configuration lookup occurs before target verification. No auth status,
  // version command, SDK construction or scenario import may precede it.
  const config = loadConfig();
  const target = preflight(options, config);
  options.outputDir ||= path.join(process.env.TMPDIR || process.cwd(), `jsn-acceptance-${Date.now()}`);
  const ctx = createContext(options, target); ctx.keep = !!options.keep;
  if (options.authConfig) {
    const { loadAuthConfig } = await import('../../test/acceptance/auth.mjs');
    await loadAuthConfig(ctx, options.authConfig);
  }
  if (options.allowRetainedFlows) {
    if (options.mode !== 'pdi') throw new Error('--allow-retained-flows requires pdi mode and --allow-writes');
    ctx.state.set('workflows.allowRetainedFlows', true);
  }
  if (options.catalogRecipe) await loadCatalogRecipe(ctx, path.resolve(options.catalogRecipe));
  const source = provenance(ctx.cliPath);
  const scenarios = [], missing = [];
  for (const file of ['read-only.mjs', 'read-only-catalog.mjs', 'resources.mjs', 'workflows.mjs', 'auth.mjs']) {
    const location = path.join(cliRoot, 'test/acceptance', file);
    if (!fs.existsSync(location)) { missing.push(`module:${file}`); continue; }
    const module = await import(pathToFileURL(location));
    if (!Array.isArray(module.scenarios)) throw new Error(`Missing scenarios export: ${file}`);
    scenarios.push(...module.scenarios);
  }
  bindScenarios(scenarios);
  const ids = new Set();
  for (const s of scenarios) {
    if (!s.id || ids.has(s.id) || typeof s.run !== 'function' || !Array.isArray(s.commandPaths) || !Array.isArray(s.sources) || !Array.isArray(s.modes) || typeof s.mutates !== 'boolean' || !Array.isArray(s.requires)) throw new Error(`Invalid or duplicate scenario: ${s.id}`);
    ids.add(s.id);
  }
  let selection = selectScenarios(scenarios, options);
  const inventoryPath = path.join(cliRoot, 'test/acceptance/coverage.json');
  const coverage = fs.existsSync(inventoryPath) ? JSON.parse(fs.readFileSync(inventoryPath, 'utf8')) : null;
  if (!selection.full && !options.scenarios.length) {
    const unresolved = !coverage?.entries?.length || coverage.entries.some(entry => !entry.exclusion && entry.sources?.some(source => options.changed.includes(source)) && !scenarios.some(s => s.commandPaths.includes(entry.path)));
    if (unresolved) selection = { ids: scenarios.map(s => s.id), full: true, reason: 'inventory impact contains unbound command paths' };
  }
  privateJSON(path.join(ctx.outputDir, 'coverage-bindings.json'), {
    schemaVersion: 1, status: 'implemented-not-run',
    scenarios: scenarios.map(s => ({ id: s.id, modes: s.modes, mutates: s.mutates, requires: s.requires, commandPaths: s.commandPaths, assertions: s.coverageBindings || {} })),
    entries: coverage.entries.map(entry => ({ path: entry.path, status: 'not-run', scenarioIds: scenarios.filter(s => s.coverageBindings?.[entry.path]).map(s => s.id) })),
  });
  privateJSON(path.join(ctx.outputDir, 'coverage-gaps.json'), { selectedMode: coverageDetails(coverage, scenarios, scenarios.map(s => s.id), options.mode), fullProduct: coverageDetails(coverage, scenarios, scenarios.map(s => s.id), 'pdi') });
  missing.push(...coverageGaps(coverage, scenarios, selection.ids, options.mode, !selection.full));
  if (options.preflight) {
    const report = { runKey: ctx.runKey, mode: ctx.mode, provenance: source, selection, summary: summarize([], [...missing, 'preflight-only']), results: [] };
    privateJSON(path.join(ctx.outputDir, 'private-report.json'), report);
    privateJSON(path.join(ctx.outputDir, 'public-summary.json'), publicProjection(report));
    console.log(JSON.stringify({ phase: 'preflight', complete: false, selected: selection.ids.length, outputDir: ctx.outputDir }));
    return 2;
  }
  // Mode exclusions are explicit, not executed and not counted as pass.
  const modeScenarios = scenarios.filter(s => s.modes.includes(options.mode));
  const report = await executeScenarios(modeScenarios, ctx, { missing, selection, provenance: source, suiteHooks: { beginSuite, endSuite } });
  console.log(JSON.stringify({ ...report.summary, missing: report.summary.missing.length, outputDir: ctx.outputDir }));
  return report.summary.complete ? 0 : report.results.some(r => r.status.startsWith('failed')) ? 1 : 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(() => { console.error('Acceptance runner refused or failed; inspect private run evidence'); process.exitCode = 1; });
}
