import { errUsageHint, errUsage } from '../errors.js';
import { captureRun, listRuns, getRun, compareRuns, formatRun, formatRunList, formatComparison } from '../perf.js';

function requireRun(runId, side) {
  const run = getRun(runId);
  if (!run) throw errUsageHint(`Unknown ${side} run: ${runId}`, 'Run `jsn perf list` to see saved captures.');
  return run;
}

export function perfCmd(wrap) {
  return {
    command: 'perf [subcommand]',
    aliases: ['performance'],
    describe: 'Capture and compare read-only ServiceNow performance summaries',
    builder: (y) => y
      .command({
        command: 'capture',
        describe: 'Capture one read-only performance snapshot',
        builder: (b) => b.option('label', { type: 'string', describe: 'Human-readable label for this run' }),
        handler: wrap(async (argv, app) => {
          app.requireInstance();
          const run = await captureRun({
            sdk: app.sdk,
            instance: app.getEffectiveInstance(),
            profile: app.session?.profileName || app.context?.profileName || '',
            username: app.session?.username || '',
            label: argv.label || '',
            options: { label: argv.label || '' },
          });
          app.ok({ ...run, _formatted: formatRun(run) }, { summary: `Performance capture ${run.run_id}: ${run.status}` });
        }),
      })
      .command({
        command: 'list',
        aliases: ['ls'],
        describe: 'List saved performance captures',
        builder: (b) => b.option('limit', { alias: 'l', type: 'number', default: 50, describe: 'Maximum runs to show' }),
        handler: wrap(async (argv, app) => {
          const runs = listRuns({ limit: argv.limit });
          app.ok({ runs, count: runs.length, _formatted: formatRunList(runs) }, { summary: `${runs.length} performance capture(s)` });
        }),
      })
      .command({
        command: 'show <run_id>',
        describe: 'Show one saved performance capture',
        handler: wrap(async (argv, app) => {
          const run = requireRun(argv.run_id, 'target');
          app.ok({ ...run, _formatted: formatRun(run) }, { summary: `Performance capture ${run.run_id}` });
        }),
      })
      .command({
        command: 'compare <baseline> <new>',
        describe: 'Compare exactly two saved captures',
        handler: wrap(async (argv, app) => {
          if (argv.baseline === argv.new) throw errUsage('Compare requires two different run IDs');
          const baseline = requireRun(argv.baseline, 'baseline');
          const newer = requireRun(argv.new, 'new');
          const result = compareRuns(baseline, newer);
          app.ok({ ...result, _formatted: formatComparison(result) }, { summary: `Performance comparison: ${result.status}` });
        }),
      }),
    handler: wrap(async (_argv, app) => {
      app.ok({ command: 'perf', subcommands: ['capture', 'list', 'show', 'compare'] }, { summary: 'Use `jsn perf <subcommand> --help` for details.' });
    }),
  };
}
