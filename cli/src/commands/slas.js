import { deferredFamilyDefinition } from '../command-families.js';
import { errUsage } from '../errors.js';
import { listSlas, showSla, taskSlas, formatSlas } from '../slas.js';

export function slasCmd(wrap) {
  const respond = (app, data, mode, summary) => {
    Object.defineProperty(data, '_formatted', { value: formatSlas(data, mode), enumerable: false });
    app.ok(data, { summary });
  };
  return {
    ...deferredFamilyDefinition('slas'),
    builder: y => y.strict().middleware(argv => {
      if (argv.subcommand) throw errUsage(`Unknown slas subcommand: ${argv.subcommand}`);
    }).command({ command: 'list', describe: 'List SLA definitions with their table, type, duration, schedule, active flag and scope',
      builder: sub => sub.option('table', { type: 'string', describe: 'Only definitions for this table (collection), e.g. incident' })
        .option('active', { type: 'boolean', describe: 'Only active definitions (--no-active: only inactive)' })
        .option('limit', { type: 'number', default: 50, describe: 'Page size (1–200)' })
        .option('offset', { type: 'number', default: 0, describe: 'Nonnegative page offset' }),
      handler: wrap(async (argv, app) => {
        app.requireInstance();
        const data = await listSlas(app.sdk, { table: argv.table, active: argv.active, limit: argv.limit, offset: argv.offset });
        respond(app, data, 'list', `${data.count} SLA definition(s)${data.pagination.has_more ? ', more available' : ''}`);
      }),
    }).command({ command: 'show <definition>', describe: 'Show one SLA definition: start, pause, stop, reset and cancel conditions, schedule, time zone source, retroactive start and flow',
      builder: sub => sub.positional('definition', { type: 'string', describe: 'SLA definition name or 32-character sys_id' }),
      handler: wrap(async (argv, app) => {
        app.requireInstance();
        const data = await showSla(app.sdk, argv.definition);
        respond(app, data, 'show', `${data.name} on ${data.table}${data.active ? '' : ' (inactive)'}`);
      }),
    }).command({ command: 'task <task>', describe: 'List the task SLAs on one record: stage, breach, start and breach times, business elapsed and time left',
      builder: sub => sub.positional('task', { type: 'string', describe: 'Task number (INC0010001) or 32-character task sys_id' }),
      handler: wrap(async (argv, app) => {
        app.requireInstance();
        const data = await taskSlas(app.sdk, argv.task);
        respond(app, data, 'task', `${data.task.number || data.task.sys_id}: ${data.count} task SLA(s)${data.count ? `, ${data.breached} breached` : ''}${data.breach_unknown ? `, ${data.breach_unknown} breach unknown` : ''}${data.more ? ', more not shown' : ''}`);
      }),
    }),
  };
}
