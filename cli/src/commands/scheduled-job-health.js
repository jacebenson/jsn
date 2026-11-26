// `scheduledjobs health` and `scheduledjobs why <job>`: read-only scheduler
// diagnosis over sys_trigger. The profile's other verbs stay CRUD on sysauto_script.

import { readSchedulerHealth, explainScheduledJob, formatSchedulerHealth, formatScheduledJobWhy, OVERDUE_MINUTES } from '../scheduled-job-health.js';
import { FormatAuto, FormatStyled } from '../output.js';

const READ_ONLY = 'This reads only, with GET requests, and never runs, recovers or changes a job.';
const HEALTH_EPILOGUE = [
  READ_ONLY,
  'Reads: sys_cluster_state (live nodes), sys_trigger, sysauto_script and syslog_transaction.',
  `Overdue: Ready or Queued triggers whose next action is more than ${OVERDUE_MINUTES} minutes past. Disabled and startup triggers, and the ALL NODES, ACTIVE NODES and PRIMARY NODES template rows (whose next action stays stale by design), are left out.`,
  'Erroring: state Error or Permanent Error, or a recorded error count.',
  'Dead node: a parent trigger pinned to a node that sys_cluster_state does not show online. The scheduled jobs dashboard counts only missing nodes as stuck; an offline node is flagged here too.',
  'Inactive user: active jobs whose Run as user is inactive. Long runs: scheduler rows in syslog_transaction over 3,600,000 ms in the last 7 days.',
].join('\n');
const WHY_EPILOGUE = [
  READ_ONLY,
  'Finds the job in sysauto_script (its child classes included) by name or sys_id, then its sys_trigger rows by document_key; with no job definition, a sys_trigger row by name or sys_id.',
  'Then reads the Run as user, sys_cluster_state, the last windows in sys_scheduler_job_history (when the instance has it; kept 7 days) and scheduler rows over an hour in syslog_transaction.',
  'Findings: job_inactive, no_trigger, on_demand, ran_once, trigger_disabled, paused, error_state, errors_recorded, overdue, dead_node, inactive_run_as, run_as_missing, conditional, long_run. jsn does not evaluate a conditional job\'s condition script.',
].join('\n');

// Non-enumerable, so piped JSON from the auto format does not repeat the view.
const view = (app, data, format) => {
  if ([FormatAuto, FormatStyled].includes(app.output.getFormat())) Object.defineProperty(data, '_formatted', { value: format(data), enumerable: false, configurable: true });
  return data;
};

export function withScheduledJobHealth(command, wrap) {
  const originalBuilder = command.builder;
  command.builder = (yargs) => originalBuilder(yargs)
    .command({
      command: 'health',
      describe: 'Scheduler health: overdue, erroring and stuck triggers, inactive Run as users, runs over an hour (read-only)',
      discoveryTasks: [{
        phrases: ['scheduled job not running', 'stuck scheduled jobs', 'scheduler health', 'sys_trigger overdue', 'job pinned to dead node', 'scheduled jobs dashboard'],
        args: ['--json'],
        description: 'List overdue, erroring and stuck sys_trigger rows and other scheduler trouble',
      }],
      builder: (y) => y.strict()
        .option('limit', { type: 'number', default: 20, describe: 'Rows to show per category (1-500)' })
        .epilogue(HEALTH_EPILOGUE),
      handler: wrap(async (argv, app) => {
        app.requireInstance();
        const data = await readSchedulerHealth(app.sdk, { limit: argv.limit });
        app.ok(view(app, data, formatSchedulerHealth), {
          summary: `Scheduler health: ${data.flagged} flagged (${data.overdue.items.length} overdue, ${data.erroring.items.length} erroring, ${data.dead_node.items.length} on a dead node, ${data.inactive_run_as.items.length} inactive Run as, ${data.long_running.items.length} over an hour)`,
          breadcrumbs: [{ action: 'show', cmd: 'jsn scheduledjobs why "<name>"', description: 'Explain why one job did not run' }],
        });
      }),
    })
    .command({
      command: 'why <job>',
      describe: "Why a scheduled job did not run: its trigger, node, Run as user, history and long runs (read-only)",
      discoveryTasks: [{
        phrases: ['why did my scheduled job not run', 'scheduled job did not run', 'job never ran', 'sys_trigger for job'],
        args: ['<job>', '--json'],
        description: 'Explain why one scheduled job did not run',
      }],
      builder: (y) => y.strict()
        .positional('job', { type: 'string', describe: 'Scheduled job name or sys_id (sysauto_script or sys_trigger)' })
        .epilogue(WHY_EPILOGUE),
      handler: wrap(async (argv, app) => {
        app.requireInstance();
        const data = await explainScheduledJob(app.sdk, argv.job);
        const name = data.job?.name || data.triggers[0].name;
        app.ok(view(app, data, formatScheduledJobWhy), {
          summary: data.findings.length ? `${name}: ${data.findings.map(f => f.code).join(', ')}` : `${name}: no cause found`,
          breadcrumbs: [
            ...(data.job ? [{ action: 'show', cmd: `jsn scheduledjobs show ${data.job.sys_id}`, description: 'Show the job definition' }] : []),
            { action: 'list', cmd: 'jsn scheduledjobs health', description: 'Scheduler health across all jobs' },
          ],
        });
      }),
    });
  if (Array.isArray(command.discovery?.benefits)) {
    command.discovery.benefits.push('Scheduler diagnosis (read-only): jsn scheduledjobs health, and jsn scheduledjobs why <job> for one job');
  }
  return command;
}
