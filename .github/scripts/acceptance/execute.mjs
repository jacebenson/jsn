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

// Adapter-owned environment bridge for the pinned producer's inner filter.
//
// The pinned createContext deliberately strips SERVICENOW_OAUTH_TOKEN from every
// CLI child and refuses a fixture-supplied token. CI keeps the refreshed token in
// memory only (no credential file), so the adapter adds it back for the
// coordinator launch that uses the seeded private profile. A launch is a
// coordinator launch only when its child XDG_CONFIG_HOME is the exact seeded
// config home; fixture, negative and own-credential actors replace it and are
// left byte-identical. A coordinator config whose single profile does not match
// the selected profile/target fails closed instead of forwarding the token.
export function coordinatorEnvironment({ env, options, target, token, configHome, home, warmSession }) {
  if (!token || !configHome || env?.XDG_CONFIG_HOME !== configHome) return env;
  if (home !== undefined && env.HOME !== home) throw new Error('Coordinator environment binding refused');
  let config;
  try { config = JSON.parse(fs.readFileSync(path.join(configHome, 'servicenow/config.json'), 'utf8')); }
  catch { throw new Error('Coordinator profile binding refused'); }
  const profiles = Object.keys(config.profiles || {});
  const profile = config.profiles?.[options.profile];
  let bound;
  try { bound = new URL(profile?.instance_url ?? '').origin; } catch { bound = ''; }
  if (profiles.length !== 1 || profiles[0] !== options.profile || bound !== target) throw new Error('Coordinator profile target binding refused');
  return { ...env, SERVICENOW_OAUTH_TOKEN: token,
    ...(warmSession === '0' ? { JSN_ALWAYS_WARM_SESSION: '0' } : {}) };
}

export function bridgedRunProcess(runProcess, { options, target, env = process.env }) {
  return (executable, args, opts = {}) => runProcess(executable, args, {
    ...opts,
    env: coordinatorEnvironment({ env: opts.env, options, target: target.target, token: env.SERVICENOW_OAUTH_TOKEN, configHome: env.XDG_CONFIG_HOME, home: env.HOME, warmSession: env.JSN_ALWAYS_WARM_SESSION }),
  });
}

export function bridgedContext(support, options, target, env = process.env) {
  return support.createContext(options, target, { execute: bridgedRunProcess(support.runProcess, { options, target, env }) });
}

export async function main(args = process.argv.slice(2)) {
  const support = await import('../../../cli/scripts/acceptance/support.mjs');
  const { executeScenarios } = await import('../../../cli/scripts/acceptance/run.mjs');
  const { bindScenarios, coverageDetails } = await import('../../../cli/scripts/acceptance/bindings.mjs');
  const hooks = await import('../../../cli/test/acceptance/performance.mjs');
  const { loadConfig } = await import('../../../cli/src/config.js');
  const { adaptCatalog, adaptInventory } = await import('./catalog-v2.mjs');
  const options = support.parseArgs(args);
  const target = support.preflight(options, loadConfig());
  const ctx = bridgedContext(support, options, target);
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
