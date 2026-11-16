// Observe real pinned scenario execution without changing its results or schema.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { testedVersion } from './tested-version.mjs';

export function observeScenario(scenario) {
  const original = scenario.run;
  scenario.run = async ctx => {
    let authenticated = false;
    const read = ctx.read, command = ctx.command;
    ctx.read = async (...args) => { const value = await read(...args); authenticated = true; return value; };
    ctx.command = async (...args) => {
      const value = await command(...args);
      if (['list', 'get', 'show'].includes(args[0][1]) && !['auth', 'history', 'perf'].includes(args[0][0]) && !args[0].includes('--help') && value.exitCode === 0 && value.json?.ok === true) authenticated = true;
      return value;
    };
    try { return await original(ctx); }
    finally {
      ctx.read = read; ctx.command = command;
      if (authenticated) fs.appendFileSync(path.join(ctx.outputDir, 'executed.jsonl'), JSON.stringify({ runKey: ctx.runKey, id: scenario.id }) + '\n', { mode: 0o600 });
    }
  };
  return scenario;
}

export async function main(args = process.argv.slice(2)) {
  const support = await import('../../../cli/scripts/acceptance/support.mjs');
  const { executeScenarios } = await import('../../../cli/scripts/acceptance/run.mjs');
  const { bindScenarios, coverageDetails } = await import('../../../cli/scripts/acceptance/bindings.mjs');
  const hooks = await import('../../../cli/test/acceptance/performance.mjs');
  const { loadConfig } = await import('../../../cli/src/config.js');
  const { adaptCatalog, adaptInventory } = await import('./catalog-v2.mjs');
  const options = support.parseArgs(args);
  const ctx = support.createContext(options, support.preflight(options, loadConfig()));
  if (options.mode === 'pdi' && options.allowWrites) {
    const { createProviderSessionAdapter } = await import('../../../cli/scripts/acceptance/session-adapter.mjs');
    ctx.state.set('auth.browserAdapter', createProviderSessionAdapter());
  }
  const catalog = [];
  for (const name of ['read-only', 'read-only-catalog', 'resources', 'workflows', 'auth']) {
    const { scenarios } = await import(`../../../cli/test/acceptance/${name}.mjs`);
    catalog.push(...adaptCatalog(scenarios));
  }
  bindScenarios(catalog);
  const inventory = adaptInventory(JSON.parse(fs.readFileSync(path.join(support.cliRoot, 'test/acceptance/coverage.json'))));
  const selection = support.selectScenarios(catalog, options);
  const coverage = coverageDetails(inventory, catalog, selection.ids, options.mode, !selection.full);
  // Retain checkout source identity independently of the executed CLI version.
  const provenance = { ...support.provenance(ctx.cliPath), version: testedVersion(ctx.cliPath) };
  const report = await executeScenarios(catalog.filter(s => s.modes.includes(options.mode)).map(observeScenario), ctx, {
    missing: coverage.gaps, selection, provenance, suiteHooks: hooks,
  });
  return report.summary.complete ? 0 : report.results.some(r => r.status.startsWith('failed')) ? 1 : 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(() => { console.error('Acceptance execution refused'); process.exitCode = 1; });
}
