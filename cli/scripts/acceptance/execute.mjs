// Observe real pinned scenario execution without changing its results or schema.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  for (const name of ['read-only', 'read-only-catalog', 'resources', 'workflows', 'auth']) {
    const { scenarios } = await import(`../../test/acceptance/${name}.mjs`);
    scenarios.forEach(observeScenario);
  }
  const { main } = await import('./run.mjs');
  main().then(code => { process.exitCode = code; }).catch(() => { console.error('Acceptance execution refused'); process.exitCode = 1; });
}
