import { deferredFamilyDefinition } from '../command-families.js';
import { confirmAction, getStringField, interactiveList, canUsePicker, quoteShellArg } from '../helpers.js';
import { errUsage } from '../errors.js';
import {
  BACKLOG_DEFAULT_SINCE, EVENT_TABLE,
  describeEvent, formatBacklog, formatEventDetail, formatEventList, getBacklog, listEvents,
} from '../events.js';
import {
  REPROCESS_LIMIT_DEFAULT, REPROCESS_LIMIT_MAX,
  executeReprocess, formatReprocessPreview, formatReprocessResult, planReprocess,
} from '../events-reprocess.js';

function attachFormatted(data, formatted) {
  // Non-enumerable so JSON/CSV keep the full envelope without the visual.
  Object.defineProperty(data, '_formatted', { value: formatted, enumerable: false });
  return data;
}

function listFilterOptions(y) {
  return y
    .option('name', { type: 'string', describe: 'Only this event name' })
    .option('state', { type: 'string', describe: 'Only this state: ready, processed, error or transferred' })
    .option('queue', { type: 'string', describe: "Only this event queue; pass --queue '' for the default queue" })
    .option('table', { type: 'string', describe: 'Only events raised for this table' })
    .option('record', { type: 'string', describe: 'Only events for this record sys_id; needs --table' })
    .option('since', { type: 'string', describe: 'Only events created since this date/time or relative span (24h, 7d)' })
    .option('limit', { alias: 'l', type: 'number', default: 20, describe: 'Maximum events to return (1-500)' });
}

export function eventsCmd(wrap) {
  return {
    ...deferredFamilyDefinition('events'),
    builder: y => y
      .command({
        command: 'list',
        aliases: ['ls'],
        describe: 'List event log entries by name, state, queue, table/record and age (read-only)',
        builder: y => listFilterOptions(y).epilogue([
          'Reads the Events [sysevent] table. The platform rotates it to another shard roughly daily and keeps about a week, so an older event may not be listed.',
          'States: ready (queued), processed, error, transferred (rotated to another shard; the active copy is the one processed).',
          '--record is the sys_id of a record on --table (sysevent.instance).',
          'Examples:',
          '  jsn events list --name flow.fire --state error --limit 20',
          "  jsn events list --queue '' --since 24h",
          '  jsn events list --table incident --record 46f2c2a1b3c4d5e6f708192a3b4c5d6e',
        ].join('\n')),
        handler: wrap(async (argv, app) => {
          app.requireInstance();
          const data = await listEvents(app.sdk, argv);
          data.context = { instance_url: app.getEffectiveInstance(), table: EVENT_TABLE };
          attachFormatted(data, formatEventList(data));
          app.ok(data, {
            summary: `${data.records.length} of ${data.total_matching} matching event(s)${data.has_more ? '; more exist' : ''}`,
          });
        }),
      })
      .command({
        command: 'show [sys-id]',
        describe: 'Show one event with its registry entry, script actions, notifications, timing and tied emails (read-only)',
        builder: y => y
          .positional('sys-id', { type: 'string', describe: 'Event sys_id' })
          .epilogue([
            'Joins the event to its registry entry, the script actions and event notifications registered for its name, and any emails sys_email_log ties to it.',
            'The platform records no failure reason for an error event: sysevent has no error column and syslog has no row at its processing time, so jsn says so instead of guessing.',
            'Timing and node come from the event row (sys_created_on, process_on, processed, claimed_by) in the instance timezone the form shows.',
          ].join('\n')),
        handler: wrap(async (argv, app) => {
          app.requireInstance();
          let sysId = argv['sys-id'];
          if (!sysId && canUsePicker(app, argv)) {
            const picked = await interactiveList({
              app,
              table: EVENT_TABLE,
              singular: 'event',
              columns: ['name', 'state', 'queue', 'process_on', 'sys_created_on'],
              labelField: 'name',
              query: '',
              formatLabel: row => `${getStringField(row, 'name') || '(no name)'}  ${getStringField(row, 'state')}  ${getStringField(row, 'sys_created_on')}`,
            });
            if (picked === undefined) return;
            if (picked) sysId = getStringField(picked, 'sys_id');
          }
          if (!sysId) throw errUsage('Provide an event sys_id: jsn events show <sys_id>, or run jsn events list first.');
          const data = await describeEvent(app.sdk, sysId);
          data.context = { instance_url: app.getEffectiveInstance(), table: EVENT_TABLE };
          attachFormatted(data, formatEventDetail(data));
          const name = data.event.name || '(no name)';
          app.ok(data, {
            summary: `${name} [${data.event.state || 'unknown'}] ${data.event.sys_id}`,
            breadcrumbs: [
              { action: 'list by name', cmd: `jsn events list --name ${quoteShellArg(name)}`, description: 'Other events with this name' },
              { action: 'reprocess', cmd: `jsn events reprocess ${data.event.sys_id} --dry-run`, description: 'Preview queuing this event again (writes nothing)' },
            ],
          });
        }),
      })
      .command({
        command: 'backlog',
        describe: 'Count events by queue and state, separate overdue from scheduled, and show each queue\'s processor (read-only)',
        builder: y => y
          .option('since', { type: 'string', default: BACKLOG_DEFAULT_SINCE, describe: `Window over event creation, as a date/time or relative span (default ${BACKLOG_DEFAULT_SINCE})` })
          .epilogue([
            'Counts events by queue and state over the window, then asks the instance clock which ready events have a passed process_on (overdue) and which are still scheduled.',
            'A ready event with a future process_on is waiting on purpose, not stuck; it is reported separately from overdue ones.',
            'Processors are sys_trigger jobs whose script calls GlideEventManager for the queue or whose job name names it; matched_by records which evidence was used.',
          ].join('\n')),
        handler: wrap(async (argv, app) => {
          app.requireInstance();
          const data = await getBacklog(app.sdk, argv);
          data.context = { instance_url: app.getEffectiveInstance(), table: EVENT_TABLE };
          attachFormatted(data, formatBacklog(data));
          app.ok(data, {
            summary: `Ready: ${data.ready.overdue.count} overdue, ${data.ready.scheduled.count} scheduled; ${data.counts.length} queue/state group(s)`,
          });
        }),
      })
      .command({
        command: 'reprocess [sys-id]',
        describe: 'Queue copies of recorded events again through the platform\'s Reprocess Event UI action (re-runs consumers and can re-send email)',
        builder: y => y
          .strict()
          .positional('sys-id', { type: 'string', describe: 'One event sys_id to reprocess' })
          .option('query', { type: 'string', describe: 'Encoded query selecting events; the batch is capped by --limit' })
          .option('limit', { alias: 'l', type: 'number', default: REPROCESS_LIMIT_DEFAULT, describe: `Maximum events per batch (1-${REPROCESS_LIMIT_MAX})` })
          .option('dry-run', { type: 'boolean', default: false, describe: 'Print the exact events and consumers; write nothing' })
          .epilogue([
            'Runs the instance\'s own Reprocess Event UI action script per selected event through the background-script path.',
            'The original event is not modified: the action inserts a copy, and jsn reads every new copy back.',
            'Reprocessing re-runs the event\'s script actions and can re-send notification emails.',
            'A read-only profile is refused unless --dry-run is passed.',
            'In a non-interactive session, --force is required to confirm the batch.',
            'Examples:',
            '  jsn events reprocess --query "state=error^queue=text_index" --limit 2 --dry-run',
            '  jsn events reprocess 018c4f4c93f81fd016c8fd18dd03d650 --force',
          ].join('\n')),
        handler: wrap(async (argv, app) => {
          app.requireInstance();
          const plan = await planReprocess(app.sdk, argv);
          const previewBase = {
            selection: plan.selection,
            queueable: plan.queueable,
            skipped: plan.skipped,
            consumers: plan.consumers,
            ui_action: {
              sys_id: plan.action.sys_id,
              name: plan.action.name,
              table: plan.action.table,
              condition: plan.action.condition,
              script_characters: plan.action.script.length,
            },
          };
          const preview = { ...previewBase, dry_run: argv.dryRun === true, writes_performed: false };
          preview.context = { instance_url: app.getEffectiveInstance(), table: EVENT_TABLE };
          attachFormatted(preview, formatReprocessPreview(plan));

          if (argv.dryRun === true) {
            app.ok(preview, {
              summary: `Dry run: ${plan.queueable.length} event(s) selected, ${plan.consumers.notifications.length} notification(s) would run again; nothing written`,
            });
            return;
          }

          await confirmAction(app, argv,
            `Reprocess ${plan.queueable.length} event(s)? This re-runs their script actions and can re-send notification emails.`,
            {
              destructive: false,
              rerun: plan.selection.source === 'query'
                ? ['events', 'reprocess', '--query', String(argv.query ?? ''), '--limit', String(plan.selection.limit)]
                : ['events', 'reprocess', plan.selection.events[0].sys_id],
            });

          const result = await executeReprocess(app.sdk, plan);
          const data = {
            ...previewBase,
            dry_run: false,
            ...result,
            context: { instance_url: app.getEffectiveInstance(), table: EVENT_TABLE },
          };
          attachFormatted(data, formatReprocessResult(result));
          app.ok(data, {
            summary: `${data.success_count} queued and verified; ${data.failure_count} failed${data.partial ? '; partial batch' : ''}`,
          });
          if (data.failure_count) process.exitCode = 1;
        }),
      })
      .demandCommand(1, 'Choose list, show, backlog or reprocess'),
  };
}
