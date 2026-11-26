import { customizationsCmdDefinition } from '../command-families.js';
import { errUsageHint, errUsage } from '../errors.js';
import { canUsePicker, buildRerunCommand } from '../helpers.js';
import { confirm } from '../prompts.js';
import { invalidateAfterMutation } from '../query-validate.js';
import { paginatedSearch } from '../paginated-search.js';
import { captureReport, listReports, getReport, compareReports, formatReport, formatReportList, formatReportComparison } from '../customizations.js';
import { buildActionableReport, writeCustomizationHtml } from '../customizations-report.js';
import { customizationGuidance, formatCustomizationGuidance } from '../customization-guidance.js';
import { contextFailure } from '../intended-context.js';

// Only capture and revert need an instance. Saved reports never need network access.

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
  const actionable = buildActionableReport(report);
  const triage = actionable.artifacts.map(({ category, category_label, identity, triage: classification }) => ({ category, category_label, identity, ...classification }));
  app.ok({ ...report, interpretation: customizationGuidance(), triage, _formatted: formatReport(report, options) }, { summary: `Customization capture ${report.run_id}: ${report.status}`, breadcrumbs: [listHint, showHint(report.run_id), compareHint(report.run_id)] });
}
export function customizationsCmd(wrap, ui = {}) {
  const prompts = { confirm, canUsePicker, ...ui };
  return {
    ...customizationsCmdDefinition,
    builder: y => y
      .command({ command: 'capture', describe: 'Capture bounded read-only metadata and historical upgrade evidence',
        builder: b => b.option('label', { type: 'string', describe: 'Label for this capture' })
          .option('customer-scope', { type: 'string', array: true, default: [], describe: 'Declared customer-owned scope value or sys_id, repeatable; ownership is not inferred' })
          .option('page-size', { type: 'number', default: 100, describe: 'Records per table page, 1..1000' })
          .option('max-pages', { type: 'number', default: 10, describe: 'Maximum pages per source, 1..100' })
          .epilogue(`${customizationGuidance().capture}\n${formatCustomizationGuidance()}\nExample: jsn customizations capture --label review --customer-scope x_acme_app --json`),
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
        .option('filter', { type: 'string', describe: 'Expand a group shown in the summary (friendly or table name for file types)' })
        .epilogue(`Offline review: inspect coverage, interpretation and triage in --json output.\n${formatCustomizationGuidance()}\nExample: jsn customizations show <run_id> --get data.triage`), handler: wrap(async (argv, app) => {
        const report = argv.run_id ? requireReport(argv.run_id) : await pickReport(app, argv);
        if (report) show(app, report, { groupBy: argv.groupBy, filter: argv.filter || '' });
      }) })
      .command({ command: 'html [run_id]', describe: 'Write a searchable, self-contained HTML review of a saved capture', builder: b => b
        .option('out', { type: 'string', describe: 'Output HTML path (must not already exist)' })
        .epilogue('Offline review with the same interpretation and coverage as show; writes a local file without changing instance records.\nExample: jsn customizations html <run_id> --out review.html'), handler: wrap(async (argv, app) => {
        const report = argv.run_id ? requireReport(argv.run_id) : await pickReport(app, argv);
        if (!report) return;
        const file = writeCustomizationHtml(report, { out: argv.out });
        app.ok({ run_id: report.run_id, file, artifacts: Object.values(report.categories).reduce((total, items) => total + items.length, 0), interpretation: customizationGuidance() }, { summary: `Wrote offline customization review: ${file}`, breadcrumbs: [listHint, showHint(report.run_id)] });
      }) })
      .command({ command: 'compare [baseline] [new]', describe: 'Compare two saved captures from the same instance',
        builder: b => b.epilogue(`Offline metadata/evidence comparison; inspect both captures' coverage before interpreting changes.\n${formatCustomizationGuidance()}\nExample: jsn customizations compare <baseline_id> <new_id> --json`), handler: wrap(async (argv, app) => {
        if (!!argv.baseline !== !!argv.new) throw errUsage('Compare requires exactly two report IDs');
        if (argv.baseline && argv.baseline === argv.new) throw errUsage('Compare requires two different report IDs');
        const baseline = argv.baseline ? requireReport(argv.baseline) : await pickReport(app, argv, null, 'Select the baseline capture');
        if (!baseline) return;
        const newer = argv.new ? requireReport(argv.new) : await pickReport(app, argv, baseline.run_id, 'Select the new capture');
        if (!newer) return;
        if (baseline.instance !== newer.instance) throw errUsage('Customization reports must describe the same instance');
        const result = compareReports(baseline, newer);
        app.ok({ ...result, _formatted: formatReportComparison(result) }, { summary: `Customization comparison: ${result.status}`, breadcrumbs: [listHint, showHint(baseline.run_id), showHint(newer.run_id)] });
      }) })
      .command({ command: 'revert', describe: 'Revert a Store or repository application\'s customised files to their base system versions',
        // Not --app: cli.js sets argv.app to the App context on every command.
        builder: b => b.option('scope', { type: 'string', demandOption: true, describe: 'Application scope, e.g. sn_hr_core' })
          .option('after', { type: 'string', describe: 'Start after this update name, as a preview with more files prints' })
          .option('confirm', { type: 'string', describe: 'Confirmation token from the preview; without it, and without a terminal, only the preview runs' })
          .epilogue(`Previews by default. Reverts up to 100 customised files a run, each through jsn records revert: newest base system version, readback per file. Files added on the instance are listed and never deleted; applications built on this instance are refused. Without a terminal every run, the preview too, needs Global selected and --expect-scope global --expect-update-set naming the selected set: each revert is a global background script, captured in that update set, and the application itself is not selected.\nExample: jsn customizations revert --scope sn_hr_core --expect-scope global --expect-update-set "<set>", then the same with --confirm <token>`),
        handler: wrap(async (argv, app) => {
          app.requireInstance();
          // Each revert is a global background script; the platform captured those in the selected Global update set, and no other selection was proven.
          if (app.mutationContext?.verified && app.mutationContext.application_id !== 'global') throw contextFailure('customizations revert runs each revert as a global background script, captured in the selected update set, so it needs Global selected; nothing was read or reverted.', 'Select Global and the update set to hold the reverts (jsn scopes set global, jsn updatesets set "<set>"), then rerun with --expect-scope global --expect-update-set "<set>".');
          const { previewAppRevert, applyAppRevert, formatAppRevertPreview, formatAppRevert } = await import('../customizations-revert.js');
          const preview = await previewAppRevert(app.sdk, { scope: argv.scope, after: argv.after, instance: app.getEffectiveInstance() });
          const shown = { ...preview, _formatted: formatAppRevertPreview(preview) };
          if (argv.confirm !== undefined) {
            if (argv.confirm !== preview.confirmation_token) throw errUsageHint('The customised files changed since the preview, or the token does not match; nothing was reverted.', `Review a new preview: jsn customizations revert --scope ${argv.scope}${argv.after === undefined ? '' : ` --after ${argv.after}`}`);
          } else if (!preview.plans.length || !prompts.canUsePicker(app, argv)) {
            const revertRerun = after => buildRerunCommand(argv, { rerun: ['customizations', 'revert', '--scope', String(argv.scope),
              ...(after === undefined ? [] : ['--after', String(after)]), '--confirm', String(preview.confirmation_token)] });
            const moreRerun = buildRerunCommand(argv, { rerun: ['customizations', 'revert', '--scope', String(argv.scope), '--after', String(preview.next_after)] });
            app.ok(shown, { summary: preview.plans.length ? `Preview: ${preview.plans.length} file(s) to revert; nothing reverted. Rerun: ${revertRerun(argv.after)}` : preview.more ? `Nothing to revert in this batch; more customised files remain: ${moreRerun}` : 'Nothing to revert' });
            return;
          } else {
            app.ok(shown, { summary: 'Review the files before confirming' });
            if (!await prompts.confirm({ message: `Revert ${preview.plans.length} file(s) of ${preview.application.scope} to their base system versions?`, default: false })) {
              app.ok({ cancelled: true, writes_performed: false }, { summary: 'Cancelled. Nothing was reverted.' });
              return;
            }
          }
          let result;
          try { result = await applyAppRevert(app.sdk, preview); } finally { for (const table of new Set(preview.plans.map(plan => plan.table))) invalidateAfterMutation(app, table); }
          Object.defineProperty(result, '_formatted', { value: formatAppRevert(result), enumerable: false });
          app.ok(result, { summary: `${result.success_count} reverted; ${result.failure_count} failed${result.more ? `; more customised files remain: rerun with --after ${result.next_after}` : ''}` });
          if (result.failure_count) process.exitCode = 1;
        }),
      })
      .epilogue(`${customizationGuidance().capture}\n${formatCustomizationGuidance()}\nStart: jsn customizations capture --help\nReview: jsn customizations show --help\nCompare: jsn customizations compare --help`),
    handler: wrap(async (_argv, app) => app.ok({ command: 'customizations', subcommands: ['capture', 'list', 'show', 'html', 'compare', 'revert'] }, { summary: 'Use `jsn customizations <subcommand> --help` for details.' })),
  };
}
