// `jsn email queue` / `jsn email why` — read-only sys_email analysis bolted
// onto the existing inbound-email-action command group.
//
// The email group itself is a record profile command (sysevent_in_email_action);
// these two subcommands only read sys_email and related evidence tables and
// never write. The builder wrapper mirrors `tables behavior`.

import { buildEmailQueue, buildEmailWhy } from '../email-analysis.js';
import { formatEmailQueue, formatEmailWhy } from '../email-report.js';

function attachView(data, view) {
  Object.defineProperty(data, '_formatted', { value: view, enumerable: false });
  return data;
}

export function withEmailExtras(command, wrap) {
  const originalBuilder = command.builder;
  command.builder = (yargs) => originalBuilder(yargs)
    .command({
      command: 'queue',
      describe: 'Read-only email queue health: counts by type/state/mailbox over a window, oldest send-ready age, mail accounts and email switches',
      builder: (y) => y
        .option('since', {
          type: 'string', default: '7d',
          describe: 'Count window: relative (24h, 7d, 4w, 1m) or absolute date (YYYY-MM-DD[ HH:MM[:SS]])',
        })
        .epilogue([
          'Read-only: Stats API aggregates over the whole window, plus bounded Table API reads for the oldest send-ready row, switches and mail accounts.',
          'Counts are provider aggregates, never a sample of one page. A table that cannot be read is reported as unavailable, not as zero.',
          'send-ready rows accumulate when outbound mail is off (glide.email.smtp.active=false).',
          'Run "jsn email why <sys_id>" to explain one message.',
        ].join('\n')),
      handler: wrap(async (argv, app) => {
        app.requireInstance();
        const data = await buildEmailQueue(app.sdk, { since: argv.since });
        const instance = app.getEffectiveInstance();
        const summary = data.total === null
          ? `Email queue window ${data.window.since}: total unavailable`
          : `Email queue window ${data.window.since}: ${data.total} email(s)${data.oldest_send_ready?.age ? `, oldest send-ready ${data.oldest_send_ready.age}` : ''}`;
        app.ok(attachView(data, formatEmailQueue(data, { instance })), {
          summary,
          breadcrumbs: [
            { action: 'why', cmd: 'jsn email why <sys_id>', description: 'Explain one email (watermark, inbound actions, log lines)' },
            { action: 'list', cmd: 'jsn email list', description: 'Back to inbound email actions' },
          ],
        });
      }),
    })
    .command({
      command: 'why <identifier>',
      describe: 'Read-only explanation of one sys_email: type/state, watermark source record, inbound action candidates and log evidence',
      builder: (y) => y
        .positional('identifier', { type: 'string', describe: 'sys_email sys_id (32 hex) or exact message_id' })
        .epilogue([
          'Read-only. Inbound skip reasons are not stored on sys_email: candidate actions come from sysevent_in_email_action filtered by the type value (New/Reply) and are configuration evidence, not proof of what ran.',
          'syslog_email is often ACL-restricted; when it cannot be read it is reported as unavailable, not as an absence of log lines.',
          'Notification recipient inclusion/exclusion belongs to notification analysis, not this command.',
        ].join('\n')),
      handler: wrap(async (argv, app) => {
        app.requireInstance();
        const data = await buildEmailWhy(app.sdk, argv.identifier);
        const instance = app.getEffectiveInstance();
        const email = data.email;
        app.ok(attachView(data, formatEmailWhy(data, { instance })), {
          summary: `Email ${email.sys_id}: ${email.type || 'unknown type'} / ${email.state || 'unknown state'}`,
          breadcrumbs: [
            { action: 'queue', cmd: 'jsn email queue', description: 'Queue health and oldest send-ready mail' },
            { action: 'records', cmd: `jsn records get --table sys_email --sys-id ${email.sys_id}`, description: 'Raw email row' },
          ],
        });
      }),
    });
  if (Array.isArray(command.discovery?.benefits)) {
    command.discovery.benefits.push('Read-only queue and why analysis over sys_email (provider aggregates and bounded evidence reads)');
  }
  return command;
}
