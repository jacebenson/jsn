import { checkbox, select, confirm } from '../prompts.js';
import { canUsePicker, interactiveList, getStringField } from '../helpers.js';
import { declareCapabilities } from '../capabilities.js';
import { errUsage } from '../errors.js';
import { discoverSkippedUpdates, reviewSkippedUpdate, prepareSkippedBatch, processSkippedBatch, raw, SKIP_TABLE } from '../skipped-updates.js';

const label = row => `${raw(row.sys_id)}  ${getStringField(row, 'target_name') || getStringField(row, 'file_name')}`;
const selectionOptions = y => y
  .option('ids', { type: 'string', describe: 'Comma-separated literal finding sys_ids, maximum 100' })
  .option('action', { type: 'string', choices: ['retain', 'revert'], describe: 'Explicit selected action, never inferred from recommendations' });

export function renderSkippedPreview(preview) {
  const lines = [`Instance: ${preview.instance}`, `Exact selected batch: ${preview.count} finding(s)`];
  for (const item of preview.selected) {
    lines.push(`\n${item.sys_id}: ${item.artifact.update_name}`, `Action: ${item.action}`, item.operation,
      `Recommendation only: ${item.impact.recommendation.action}. ${item.impact.recommendation.basis}`,
      `State: disposition=${item.finding.disposition}, resolution=${item.finding.resolution_status}`,
      `Evidence: base version ${item.impact.evidence.baseline_version || 'unknown'}, source ${item.impact.evidence.baseline_source_table || 'unknown'}/${item.impact.evidence.baseline_source || 'unknown'}`,
      `Finding: ${preview.instance}/${SKIP_TABLE}.do?sys_id=${item.sys_id}`,
      item.impact.direct_behavior.summary);
    for (const change of item.impact.changes) lines.push(`  ${change.field}: ${JSON.stringify(change.current)} -> ${JSON.stringify(change.base)}`, `  ${change.effect}`);
    for (const dep of item.impact.known_dependencies) lines.push(`  Known dependency: ${dep.table}.${dep.field} / ${dep.sys_id}`);
    for (const gap of item.impact.unknown) lines.push(`  Unknown: ${gap}`);
  }
  lines.push(`\nConfirmation token: ${preview.confirmation_token}`, 'No writes have been performed.');
  return lines.join('\n');
}

export function skippedUpdatesCmd(wrap, ui = {}) {
  declareCapabilities('skipped-updates', { mutationSubcommands: ['process'] });
  const prompts = { checkbox, select, confirm, canUsePicker, interactiveList, ...ui };
  async function showReview(app, id) {
    const review = await reviewSkippedUpdate(app.sdk, id);
    const display = { instance: app.getEffectiveInstance(), selected: [{ ...review, action: 'none', operation: 'Read-only review.' }], count: 1, confirmation_token: 'not applicable' };
    app.ok({ ...review, _formatted: renderSkippedPreview(display) }, { summary: 'Skipped update review; deeper effects remain unknown' });
  }
  async function selection(argv, app, guided) {
    let ids = typeof argv.ids === 'string' ? argv.ids.split(',') : undefined;
    let action = argv.action;
    if (!ids && guided) {
      const page = await discoverSkippedUpdates(app.sdk, { limit: 100, offset: 0 });
      if (!page.count) throw errUsage('No unresolved skipped findings were returned.');
      ids = await prompts.checkbox({ message: `Select findings from this page${page.has_more ? ' (more exist; use list --offset for others)' : ''}`,
        choices: page.findings.map(row => ({ name: label(row), value: raw(row.sys_id) })), required: true });
    }
    if (!ids?.length) throw errUsage('Provide --ids with the exact selected finding sys_ids.');
    if (!action && guided) action = await prompts.select({ message: 'Choose the action for these findings',
      choices: [{ name: 'Retain customization, mark reviewed and retained', value: 'retain' },
        { name: 'Return to base system, discard customization', value: 'revert' }] });
    return { ids, action, instance: app.getEffectiveInstance() };
  }
  return { command: 'skipped-updates', describe: 'Review and process existing unresolved skipped updates across all upgrade history',
    builder: y => y
      .command({ command: 'list', describe: 'Discover unresolved skips instance-wide, independent of new upgrades',
        builder: y => y.option('limit', { type: 'number', default: 100, describe: 'Page size, maximum 500' })
          .option('offset', { type: 'number', default: 0, describe: 'Page offset' }),
        handler: wrap(async (argv, app) => {
          app.requireInstance();
          if (prompts.canUsePicker(app, argv)) {
            const selected = await prompts.interactiveList({ app, table: SKIP_TABLE, singular: 'skipped update',
              columns: ['target_name', 'file_name', 'disposition', 'resolution_status'], labelField: 'target_name',
              query: 'dispositionIN4,104,9,10,11^resolution_statusIN,not_reviewed', formatLabel: label });
            if (selected === undefined) return;
            if (selected) { await showReview(app, raw(selected.sys_id)); return; }
          }
          const page = await discoverSkippedUpdates(app.sdk, argv);
          app.ok(page, { summary: `${page.count} unresolved finding(s) fetched${page.has_more ? '; more available' : ''}. Instance-wide total is not measured.` });
        }) })
      .command({ command: 'review <sys-id>', describe: 'Review artifact evidence, field changes and bounded known dependencies',
        handler: wrap(async (argv, app) => { app.requireInstance();
          await showReview(app, argv['sys-id']);
        }) })
      .command({ command: 'preview', describe: 'Read-only exact batch preview and confirmation token', builder: selectionOptions,
        handler: wrap(async (argv, app) => { app.requireInstance();
          const options = await selection(argv, app, prompts.canUsePicker(app, argv));
          const preview = await prepareSkippedBatch(app.sdk, options);
          app.ok({ ...preview, _formatted: renderSkippedPreview(preview) }, { summary: 'Read-only batch preview; review before confirming' });
        }) })
      .command({ command: 'process', describe: 'Apply selected action after ONE explicit confirmation of the exact preview',
        builder: y => selectionOptions(y).option('confirm', { type: 'string', describe: 'Confirmation token from a previously reviewed exact preview; required in automation' }),
        handler: wrap(async (argv, app) => { app.requireInstance();
          try {
            const guided = prompts.canUsePicker(app, argv);
            const options = await selection(argv, app, guided);
            const result = await processSkippedBatch({ sdk: app.sdk, ...options,
              readOnly: app.session?.readOnly === true, confirmationToken: argv.confirm,
              onPreview: guided ? async preview => app.ok({ ...preview, _formatted: renderSkippedPreview(preview) }, { summary: 'Review exact batch before confirmation' }) : undefined,
              confirm: guided && !argv.confirm ? async () => prompts.confirm({ message: 'Apply exactly this selected batch?', default: false }) : undefined });
            app.ok({ ...result, _formatted: result.cancelled ? 'Cancelled. No writes performed.'
              : result.results.map(row => `${row.sys_id} ${row.action}: ${row.success ? 'verified success' : `FAILED (${row.effect})`}`).join('\n') },
            { summary: `${result.success_count} succeeded; ${result.failure_count} failed${result.partial ? '; partial batch' : ''}` });
            if (result.failure_count) process.exitCode = 1;
          } catch (err) {
            if (err.name === 'ExitPromptError' || err.name === 'AbortPromptError') {
              app.ok({ cancelled: true, writes_performed: false }, { summary: 'Cancelled. No writes performed.' }); return;
            }
            throw err;
          }
        }) })
      .demandCommand(1, 'Choose list, review, preview or process'),
  };
}
