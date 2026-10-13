import { errUsageHint, errUsage } from '../errors.js';
import { captureRun, listRuns, getRun, compareRuns, formatRunDetailed, formatRunList, formatComparisonDetailed } from '../perf.js';
import { topTransactionsCmd } from './transactions.js';
import { paginatedSearch } from '../paginated-search.js';
import { canUsePicker } from '../helpers.js';

/**
 * A picker is only safe when a human is reachable AND the invocation did
 * not ask for machine output (`--json`/`--quiet`) or a one-shot extraction
 * (`--get`). canUsePicker() owns that rule so CI/agent markers and
 * JSN_NO_PROMPTS are honored too.
 */
function pickerEnabled(app, argv = {}) {
  return canUsePicker(app, argv);
}

async function pickRun(app, { exclude = new Set(), message = 'Select a performance capture', argv = {} } = {}) {
  const runs = listRuns({ limit: 1000 }).filter(run => !exclude.has(run.run_id));
  if (!pickerEnabled(app, argv) || runs.length === 0) return null;
  const selected = await paginatedSearch({
    message,
    totalCount: runs.length,
    pageSize: 10,
    source: async (term = '') => {
      const filter = String(term).toLowerCase();
      return runs
        .filter(run => !filter || `${run.run_id} ${run.label || ''} ${run.profile || ''} ${run.instance}`.toLowerCase().includes(filter))
        .map(run => ({
          name: `${run.run_id}  ${run.label || '(unlabeled)'}  [${run.profile || 'default'}]  ${run.instance}`,
          value: run,
        }));
    },
  });
  return selected?.value || null;
}

function requireRun(runId, side) {
  const run = getRun(runId);
  if (!run) throw errUsageHint(`Unknown ${side} run: ${runId}`, 'Run `jsn perf list` to see saved captures.');
  return run;
}

function listHint() {
  return { action: 'list', cmd: 'jsn perf list', description: 'Browse saved performance captures' };
}

function showHint(runId) {
  return { action: 'show', cmd: `jsn perf show ${runId}`, description: 'View this capture again' };
}

function compareHint(runId) {
  return { action: 'compare', cmd: `jsn perf compare ${runId} OTHER_RUN_ID`, description: 'Compare this capture with another run' };
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
          app.ok({ ...run, _formatted: formatRunDetailed(run) }, {
            summary: `Performance capture ${run.run_id}: ${run.status}`,
            breadcrumbs: [listHint(), showHint(run.run_id), compareHint(run.run_id)],
          });
        }),
      })
      .command({
        command: 'list',
        aliases: ['ls'],
        describe: 'List saved performance captures',
        builder: (b) => b.option('limit', { alias: 'l', type: 'number', default: 50, describe: 'Maximum runs to show' }),
        handler: wrap(async (argv, app) => {
          const runs = listRuns({ limit: argv.limit });
          const picked = await pickRun(app, { message: 'Select a performance capture', argv });
          if (picked) {
            const run = getRun(picked.run_id);
            app.ok({ ...run, _formatted: formatRunDetailed(run) }, {
              summary: `Performance capture ${picked.run_id}`,
              breadcrumbs: [listHint(), compareHint(run.run_id)],
            });
            return;
          }
          app.ok({ runs, count: runs.length, _formatted: formatRunList(runs) }, {
            summary: `${runs.length} performance capture(s)`,
            breadcrumbs: [
              { action: 'capture', cmd: 'jsn perf capture --label LABEL', description: 'Create another read-only capture' },
              ...(runs[0] ? [showHint(runs[0].run_id)] : []),
            ],
          });
        }),
      })
      .command({
        command: 'show [run_id]',
        describe: 'Show one saved performance capture',
        handler: wrap(async (argv, app) => {
          // No run ID and no human to pick one: fail with a usable error
          // instead of exiting 0 with no output at all.
          if (!argv.run_id && !pickerEnabled(app, argv)) {
            throw errUsageHint(
              'Missing run ID: `jsn perf show` needs a run ID when prompts are unavailable.',
              'Find a capture with `jsn perf list`, then run `jsn perf show <run_id>`.'
            );
          }
          const run = argv.run_id ? requireRun(argv.run_id, 'target') : await pickRun(app, { argv });
          if (!run) return; // cancelled at the picker
          app.ok({ ...run, _formatted: formatRunDetailed(run) }, {
            summary: `Performance capture ${run.run_id}`,
            breadcrumbs: [listHint(), compareHint(run.run_id)],
          });
        }),
      })
      .command({
        command: 'transactions [subcommand]',
        describe: 'Inspect Client Transaction Timings',
        builder: (b) => b.command(topTransactionsCmd(wrap)),
      })
      .command({
        command: 'compare [baseline] [new]',
        describe: 'Compare exactly two saved captures',
        handler: wrap(async (argv, app) => {
          if (!argv.baseline && !argv.new) {
            if (!pickerEnabled(app, argv)) {
              throw errUsageHint(
                'Compare requires exactly two run IDs when prompts are unavailable.',
                'Run `jsn perf compare <baseline> <new>` with two run IDs from `jsn perf list`.'
              );
            }
            const baseline = await pickRun(app, { message: 'Select the baseline capture', argv });
            if (!baseline) return;
            const newer = await pickRun(app, { exclude: new Set([baseline.run_id]), message: 'Select the new capture', argv });
            if (!newer) return;
            const baselineRun = getRun(baseline.run_id);
            const newerRun = getRun(newer.run_id);
            const result = compareRuns(baselineRun, newerRun);
            app.ok({ ...result, _formatted: formatComparisonDetailed(result) }, {
              summary: `Performance comparison: ${result.status}`,
              breadcrumbs: [listHint(), showHint(baseline.run_id), showHint(newer.run_id)],
            });
            return;
          }
          if (!argv.baseline || !argv.new) throw errUsage('Compare requires exactly two run IDs');
          if (argv.baseline === argv.new) throw errUsage('Compare requires two different run IDs');
          const baseline = requireRun(argv.baseline, 'baseline');
          const newer = requireRun(argv.new, 'new');
          const result = compareRuns(baseline, newer);
          app.ok({ ...result, _formatted: formatComparisonDetailed(result) }, {
            summary: `Performance comparison: ${result.status}`,
            breadcrumbs: [listHint(), showHint(baseline.run_id), showHint(newer.run_id)],
          });
        }),
      }),
    handler: wrap(async (_argv, app) => {
      app.ok({ command: 'perf', subcommands: ['capture', 'list', 'show', 'compare'] }, { summary: 'Use `jsn perf <subcommand> --help` for details.' });
    }),
  };
}
