// Adapter-owned scheduling: the pinned producer still owns classification,
// reporting, hooks, cleanup and every command/source safety guard.
const eligible = s => /^readonly\.catalog\.[a-z]+\.(list|show)$/.test(s.id)
  && s.mutates === false && s.modes.includes('readonly') && !s.cleanup;

export function concurrentCatalog(scenarios, { concurrency = 4 } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw Error('Invalid readonly concurrency');
  const durations = new Map();
  const adapted = [...scenarios];
  // A noncatalog scenario is a barrier, not merely another queue member.
  for (let start = 0; start < scenarios.length;) {
    if (!eligible(scenarios[start])) { start++; continue; }
    let end = start;
    while (end < scenarios.length && eligible(scenarios[end])) end++;
    const group = scenarios.slice(start, end);
    const ids = new Set(group.map(s => s.id));
    // Unknown external prerequisites stay entirely under the serial producer.
    if (group.some(s => (s.requires || []).some(id => !ids.has(id)))) { start = end; continue; }
    let completion;
    const outcomes = new Map();
    const execute = async ctx => {
      const pending = [...group], active = new Set();
      const launch = s => {
        const task = (async () => {
          const began = performance.now();
          try { outcomes.set(s.id, { value: await s.run(ctx) }); }
          catch (error) { outcomes.set(s.id, { error }); }
          finally { durations.set(s.id, performance.now() - began); }
        })();
        active.add(task);
        task.then(() => active.delete(task));
      };
      while (pending.length || active.size) {
        if (ctx.state?.get('suite.interrupted')) pending.length = 0;
        let dispatched = false;
        for (let i = 0; i < pending.length && active.size < concurrency;) {
          const s = pending[i], requires = s.requires || [];
          if (!requires.every(id => outcomes.has(id))) { i++; continue; }
          pending.splice(i, 1); dispatched = true;
          if (requires.some(id => {
            const result = outcomes.get(id);
            return Object.hasOwn(result, 'error') || result.value?.status && result.value.status !== 'passed';
          })) outcomes.set(s.id, { value: { status: 'blocked-prerequisite' } });
          else launch(s);
        }
        if (active.size) await Promise.race(active);
        else if (pending.length && !dispatched) {
          // Cycles cannot become success or dispatch provider operations.
          for (const s of pending.splice(0)) outcomes.set(s.id, { value: { status: 'blocked-prerequisite' } });
        }
      }
    };
    for (let i = start; i < end; i++) {
      const s = scenarios[i];
      adapted[i] = { ...s, async run(ctx) {
        if (ctx.mode !== 'readonly') return s.run(ctx);
        completion ||= execute(ctx);
        await completion; // Drain every dispatched operation before producer cleanup.
        const outcome = outcomes.get(s.id);
        if (outcome && Object.hasOwn(outcome, 'error')) throw outcome.error;
        return outcome?.value;
      } };
    }
    start = end;
  }
  return { scenarios: adapted, durations };
}

export async function executeReadonlyScenarios(executeScenarios, support, scenarios, ctx, options) {
  const selected = new Set(options.selection.ids);
  const scheduled = concurrentCatalog(scenarios.filter(s => selected.has(s.id)));
  const report = await executeScenarios(scheduled.scenarios, ctx, options);
  // Producer reporting remains in catalog order; cached runs must retain actual
  // execution time rather than the near-zero time spent returning their result.
  for (const result of report.results) {
    if (scheduled.durations.has(result.id)) result.durationMs = scheduled.durations.get(result.id);
  }
  const perf = ctx.state.get('performance.suite');
  support.privateJSON(`${ctx.outputDir}/private-report.json`, report);
  support.privateJSON(`${ctx.outputDir}/public-summary.json`, support.publicProjection(report, perf));
  return report;
}
