import { accessAnalyzerCmdDefinition } from '../command-families.js';
import { errUsage } from '../errors.js';
import { listAccessAnalyses, showAccessAnalysis, formatAccessAnalysis } from '../access-analyzer.js';
import { checkAccess, formatAccessCheck } from '../access-check.js';
import { formatAccessRun, parseRunOptions, runAccessAnalysis } from '../access-analyzer-run.js';
import { confirmAction } from '../helpers.js';
import { runImpersonated } from '../impersonation.js';

const userOption = describe => ({ type: 'string', demandOption: true, describe });
const tableOption = describe => ({ type: 'string', demandOption: true, describe });
const recordOption = describe => ({ type: 'string', demandOption: true, describe });

export function accessAnalyzerCmd(wrap) {
  const commands = [
    ['list', 'List saved access analyses, identities, targets and last runs', listAccessAnalyses],
    ['show <id>', 'Show a saved analysis request sys_id (operation outcomes) or an operation result sys_id (ordered checks)', showAccessAnalysis],
  ];
  return {
    ...accessAnalyzerCmdDefinition,
    builder: y => {
      y = y.strict().middleware(argv => {
        if (argv.subcommand) throw errUsage(`Unknown access-analyzer subcommand: ${argv.subcommand}`);
      });
      for (const [command, describe, read] of commands) {
        const mode = command.split(' ')[0];
        y = y.command({ command, describe,
          builder: sub => {
            if (mode !== 'list') sub = sub.positional('id', { type: 'string', describe: 'Exact 32-character hexadecimal sys_id' });
            return sub.option('limit', { type: 'number', default: mode === 'list' ? 20 : 50, describe: 'Page size (1–200)' })
              .option('offset', { type: 'number', default: 0, describe: 'Nonnegative page offset' });
          },
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const options = { limit: argv.limit, offset: argv.offset };
            const data = mode === 'list' ? await read(app.sdk, options) : await read(app.sdk, argv.id, options);
            Object.defineProperty(data, '_formatted', { value: formatAccessAnalysis(data, data.kind || 'list'), enumerable: false });
            const saved = data.kind === 'request' ? 'operation result(s)' : 'check(s)';
            app.ok(data, { summary: `${data.count} saved ${mode === 'list' ? 'analysis request(s)' : saved}${data.pagination.has_more ? ', more available' : ''}` });
          }),
        });
      }
      return y.command({ command: 'check', describe: 'Check live whether a user can read, write or delete a record, and what stops them',
        builder: sub => sub
          .option('user', userOption('user_name or sys_id to check'))
          .option('table', tableOption('Table of the record, such as incident'))
          .option('record', recordOption('The record\'s 32-character sys_id'))
          .option('operations', { type: 'string', default: 'read,write,delete', describe: 'Comma-separated: read, write, delete' }),
        handler: wrap(async (argv, app) => {
          app.requireInstance();
          const asUser = async (sysId, read) => { let rows; await runImpersonated(app, sysId, async () => { rows = await read(app.sdk); }); return rows; };
          const data = await checkAccess(app.sdk, argv, { asUser });
          Object.defineProperty(data, '_formatted', { value: formatAccessCheck(data), enumerable: false });
          app.ok(data, { summary: data.verdict });
        }),
      })
        .command({ command: 'run', describe: 'Run a live access evaluation and print every ACL and business rule checked; --save keeps the analysis',
          builder: sub => sub
            .option('user', userOption('user_name or sys_id to evaluate'))
            .option('table', tableOption('Table of the record, such as incident'))
            .option('record', recordOption('The record\'s 32-character sys_id'))
            .option('operations', { type: 'string', default: 'read,write,delete', describe: 'Comma-separated: read, write, delete' })
            .option('field', { type: 'string', describe: 'Field of the record to evaluate, such as state' })
            .option('save', { type: 'boolean', default: false, describe: 'Persist the analysis through the provider (a mutation; asks for confirmation)' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            if (argv.save) {
              const options = parseRunOptions(argv);
              await confirmAction(app, argv, `Save the Access Analyzer evaluation of ${options.operations.join(', ')} for ${options.user} on ${options.table} ${options.record}${options.field ? `.${options.field}` : ''}?`, {
                destructive: false,
                rerun: ['access-analyzer', 'run', '--user', argv.user, '--table', argv.table, '--record', argv.record, '--operations', options.operations.join(','), ...(options.field ? ['--field', options.field] : []), '--save'],
              });
            }
            const data = await runAccessAnalysis(app.sdk, argv);
            Object.defineProperty(data, '_formatted', { value: formatAccessRun(data), enumerable: false });
            app.ok(data, { summary: data.summary });
          }),
        });
    },
  };
}
