import { perfCmdDefinition } from '../command-families.js';
import { errUsageHint, errUsage } from '../errors.js';
import { captureRun, listRuns, getRun, compareRuns, formatRunDetailed, formatRunList, formatComparisonDetailed } from '../perf.js';
import { topTransactionsCmd } from './transactions.js';
import { listSlowPatterns, showSlowPattern, formatSlowPatterns, SLOW_PATTERN_TYPES, SLOW_PATTERN_ORDERS } from '../slow-patterns.js';
import { loadQueryPattern, explainTarget, explainLoadedQuery, formatExplainPlan, suggestIndexForLoadedQuery, formatIndexSuggestion } from '../slow-pattern-plans.js';
import { paginatedSearch } from '../paginated-search.js';
import { canUsePicker, confirmAction } from '../helpers.js';

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
    ...perfCmdDefinition,
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
        command: 'slow',
        describe: 'Rank the platform\'s slow pattern logs (queries, scripts, transactions, events, mutex, cache)',
        builder: (b) => b.strict()
          .option('type', { type: 'string', choices: SLOW_PATTERN_TYPES, default: 'queries', describe: 'Which slow pattern log to read' })
          .option('order-by', { type: 'string', choices: SLOW_PATTERN_ORDERS, default: 'total', describe: 'Rank by total time, run count or average time' })
          .option('since', { type: 'string', describe: 'Only patterns last seen on or after YYYY-MM-DD or "YYYY-MM-DD HH:MM:SS" (UTC, compared with the stored value)' })
          .option('limit', { type: 'number', default: 20, describe: 'Page size (1-200)' })
          .option('offset', { type: 'number', default: 0, describe: 'Nonnegative page offset' })
          .command({
            command: 'show <sys_id>',
            describe: 'Show one slow pattern with its full SQL and stack trace',
            builder: (s) => s.positional('sys_id', { type: 'string', describe: 'Exact 32-character hexadecimal sys_id' }),
            handler: wrap(async (argv, app) => {
              app.requireInstance();
              const data = await showSlowPattern(app.sdk, argv.sys_id);
              Object.defineProperty(data, '_formatted', { value: formatSlowPatterns(data, 'show'), enumerable: false });
              app.ok(data, { summary: `Slow pattern ${argv.sys_id} (${data.table})` });
            }),
          }),
        handler: wrap(async (argv, app) => {
          app.requireInstance();
          const data = await listSlowPatterns(app.sdk, { type: argv.type, orderBy: argv['order-by'], since: argv.since, limit: argv.limit, offset: argv.offset });
          Object.defineProperty(data, '_formatted', { value: formatSlowPatterns(data, 'list'), enumerable: false });
          app.ok(data, {
            summary: `${data.count} slow ${data.type} pattern(s)${data.pagination.has_more ? ', more available' : ''}`,
            breadcrumbs: data.records[0] ? [{ action: 'show', cmd: `jsn perf slow show ${data.records[0].sys_id?.value}`, description: 'Every field and the stack trace for the top pattern' }] : [],
          });
        }),
      })
      .command({
        command: 'explain <sys_id>',
        describe: 'Run Explain Plan for a slow query and read the plan rows back (writes plan rows; needs --force)',
        builder: (b) => b
          .positional('sys_id', { type: 'string', describe: 'Slow query pattern sys_id (32 hex characters)' })
          .option('force', { type: 'boolean', default: false, describe: 'Confirm writing plan rows for this pattern' })
          .epilogue([
            'Runs the platform\'s Explain Plan UI action (GlideAQueryExplanation.explainPlan) through a',
            'background script, then reads the plan rows back from plan_execution and its subclasses',
            '(plan_mysql, plan_postgres, plan_oracle, plan_trino). It writes plan rows and does not',
            'change the slow query record.',
            '',
            'A status that asks for fresh statistics, or an engine that is not enabled, is a failure',
            'carrying the provider\'s message. So is a run that wrote no readable plan rows: an empty',
            'answer is never reported as an empty plan.',
            '',
            'Implemented from the platform UI action; not yet verified against a live instance.',
            'Example: jsn perf explain <sys_id> --force',
          ].join('\n')),
        handler: wrap(async (argv, app) => {
          app.requireInstance();
          const query = await loadQueryPattern(app.sdk, argv.sys_id);
          const target = explainTarget(query.record);
          await confirmAction(
            app,
            argv,
            `Explain plan for slow query ${query.id}${query.label ? ` (${query.label.slice(0, 60)})` : ''}? This writes plan rows on the instance.`,
            { destructive: false, rerun: ['perf', 'explain', query.id] },
          );
          const data = await explainLoadedQuery(app.sdk, query, target);
          Object.defineProperty(data, '_formatted', { value: formatExplainPlan(data), enumerable: false });
          app.ok(data, {
            summary: `Explain plan ${data.status || 'completed'}: ${data.count} plan row(s) in ${data.plan_tables.join(', ')}`,
            breadcrumbs: [{ action: 'show', cmd: `jsn perf slow show ${query.id}`, description: 'Every field and the stack trace for this slow query' }],
          });
        }),
      })
      .command({
        command: 'suggest-index <sys_id>',
        describe: 'Ask the platform for an index suggestion on a slow query and read it back (writes a suggestion; needs --force)',
        builder: (b) => b
          .positional('sys_id', { type: 'string', describe: 'Slow query pattern sys_id (32 hex characters)' })
          .option('force', { type: 'boolean', default: false, describe: 'Confirm writing a suggestion record for this pattern' })
          .epilogue([
            'Runs the platform\'s Suggest Index UI action (SNC.IndexSuggestionAPI.suggestIndex) through a',
            'background script, then reads the sys_index_suggestion record it created. It creates a',
            'suggestion record, not an index: schedule creation, test performance and schedule drop stay',
            'with the platform.',
            '',
            'The API is MySQL-only. An engine that is not enabled, and an answer that asks for fresh',
            'statistics, are failures carrying the provider\'s message; a returned sys_id that cannot be',
            'read back is a failure too.',
            '',
            'Implemented from the platform UI action; not yet verified against a live instance.',
            'Example: jsn perf suggest-index <sys_id> --force',
          ].join('\n')),
        handler: wrap(async (argv, app) => {
          app.requireInstance();
          const query = await loadQueryPattern(app.sdk, argv.sys_id);
          await confirmAction(
            app,
            argv,
            `Suggest an index for slow query ${query.id}${query.label ? ` (${query.label.slice(0, 60)})` : ''}? This writes a suggestion record on the instance.`,
            { destructive: false, rerun: ['perf', 'suggest-index', query.id] },
          );
          const data = await suggestIndexForLoadedQuery(app.sdk, query);
          Object.defineProperty(data, '_formatted', { value: formatIndexSuggestion(data), enumerable: false });
          app.ok(data, {
            summary: `Index suggestion for ${data.suggestion.table_name?.display_value || data.suggestion.table_name} on ${data.suggestion.column_names?.display_value || data.suggestion.column_names}`,
            breadcrumbs: [{ action: 'show', cmd: `jsn perf slow show ${query.id}`, description: 'Every field and the stack trace for this slow query' }],
          });
        }),
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
      app.ok({ command: 'perf', subcommands: ['capture', 'list', 'show', 'compare', 'slow', 'explain', 'suggest-index'] }, { summary: 'Use `jsn perf <subcommand> --help` for details.' });
    }),
  };
}
