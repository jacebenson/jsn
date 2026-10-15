import { declareCapabilities } from '../capabilities.js';
import { errUsageHint, errUsage } from '../errors.js';
import { canUsePicker } from '../helpers.js';
import { paginatedSearch } from '../paginated-search.js';
import { captureReport, listReports, getReport, compareReports, formatReport, formatReportList, formatReportComparison } from '../customizations.js';

// Only capture needs an instance. Saved reports never need network access.
declareCapabilities('customizations', { noInstance: true, skipDailyChecks: true, mutationSubcommands: [] });
const listHint = { action: 'list', cmd: 'jsn customizations list', description: 'Browse saved customization captures' };
const showHint = id => ({ action: 'show', cmd: `jsn customizations show ${id}`, description: 'Review this saved capture' });
const compareHint = id => ({ action: 'compare', cmd: `jsn customizations compare ${id} OTHER_RUN_ID`, description: 'Compare captured metadata and evidence' });
function requireReport(id) {
  const report = getReport(id);
  if (!report) throw errUsageHint(`Unknown customization report: ${id}`, 'Run `jsn customizations list` to find saved captures.');
  return report;
}
async function pickReport(app, argv, exclude = null, message = 'Select a customization capture') {
  if (!canUsePicker(app, argv)) throw errUsageHint('A report ID is required when prompts are unavailable.', 'Run `jsn customizations list`, then pass the run ID explicitly.');
  const runs = listReports({ limit: 1000 }).filter(run => run.run_id !== exclude);
  if (!runs.length) throw errUsage('No saved customization captures available');
  const picked = await paginatedSearch({ message, totalCount: runs.length, pageSize: 10, source: async (term = '') => runs.filter(run => `${run.run_id} ${run.label} ${run.instance}`.toLowerCase().includes(term.toLowerCase())).map(run => ({ name: `${run.run_id} ${run.label || '(unlabeled)'} ${run.instance}`, value: run })) });
  return picked?.value ? requireReport(picked.value.run_id) : null;
}
function show(app, report, options = {}) {
  app.ok({ ...report, _formatted: formatReport(report, options) }, { summary: `Customization capture ${report.run_id}: ${report.status}`, breadcrumbs: [listHint, showHint(report.run_id), compareHint(report.run_id)] });
}
export function customizationsCmd(wrap) {
  return {
    command: 'customizations [subcommand]',
    describe: 'Capture and compare read-only customization evidence locally',
    builder: y => y
      .command({ command: 'capture', describe: 'Capture bounded read-only metadata and historical upgrade evidence',
        builder: b => b.option('label', { type: 'string', describe: 'Label for this capture' })
          .option('customer-scope', { type: 'string', array: true, default: [], describe: 'Declared customer-owned scope value or sys_id, repeatable; ownership is not inferred' })
          .option('page-size', { type: 'number', default: 100, describe: 'Records per table page, 1..1000' })
          .option('max-pages', { type: 'number', default: 10, describe: 'Maximum pages per source, 1..100' }),
        handler: wrap(async (argv, app) => {
          app.requireInstance();
          if (!Number.isInteger(argv.pageSize) || argv.pageSize < 1 || argv.pageSize > 1000 || !Number.isInteger(argv.maxPages) || argv.maxPages < 1 || argv.maxPages > 100) throw errUsage('page-size must be 1..1000 and max-pages 1..100');
          const customerScopes = Array.isArray(argv.customerScope) ? argv.customerScope : argv.customerScope ? [argv.customerScope] : [];
          const report = await captureReport({ sdk: app.sdk, instance: app.getEffectiveInstance(), profile: app.session?.profileName || '', label: argv.label || '', customerScopes, pageSize: argv.pageSize, maxPages: argv.maxPages });
          show(app, report);
        }),
      })
      .command({ command: 'list', aliases: ['ls'], describe: 'List saved local captures',
        builder: b => b.option('limit', { alias: 'l', type: 'number', default: 50, describe: 'Maximum captures to list' }),
        handler: wrap(async (argv, app) => {
          if (canUsePicker(app, argv)) { const report = await pickReport(app, argv); if (report) show(app, report); return; }
          const runs = listReports({ limit: argv.limit });
          app.ok({ runs, count: runs.length, _formatted: formatReportList(runs) }, { summary: `${runs.length} customization capture(s)`, breadcrumbs: [listHint, ...(runs[0] ? [showHint(runs[0].run_id)] : [])] });
        }),
      })
      .command({ command: 'show [run_id]', describe: 'Review a saved capture offline', builder: b => b
        .option('group-by', { type: 'string', choices: ['type', 'scope', 'updated-by'], default: 'type', describe: 'Group summary by file type, scope or last updater' })
        .option('filter', { type: 'string', describe: 'Expand a group shown in the summary (friendly or table name for file types)' }), handler: wrap(async (argv, app) => {
        const report = argv.run_id ? requireReport(argv.run_id) : await pickReport(app, argv);
        if (report) show(app, report, { groupBy: argv.groupBy, filter: argv.filter || '' });
      }) })
      .command({ command: 'compare [baseline] [new]', describe: 'Compare two saved captures from the same instance', handler: wrap(async (argv, app) => {
        if (!!argv.baseline !== !!argv.new) throw errUsage('Compare requires exactly two report IDs');
        if (argv.baseline && argv.baseline === argv.new) throw errUsage('Compare requires two different report IDs');
        const baseline = argv.baseline ? requireReport(argv.baseline) : await pickReport(app, argv, null, 'Select the baseline capture');
        if (!baseline) return;
        const newer = argv.new ? requireReport(argv.new) : await pickReport(app, argv, baseline.run_id, 'Select the new capture');
        if (!newer) return;
        if (baseline.instance !== newer.instance) throw errUsage('Customization reports must describe the same instance');
        const result = compareReports(baseline, newer);
        app.ok({ ...result, _formatted: formatReportComparison(result) }, { summary: `Customization comparison: ${result.status}`, breadcrumbs: [listHint, showHint(baseline.run_id), showHint(newer.run_id)] });
      }) }),
    handler: wrap(async (_argv, app) => app.ok({ command: 'customizations', subcommands: ['capture', 'list', 'show', 'compare'] }, { summary: 'Use `jsn customizations <subcommand> --help` for details.' })),
  };
}
