import { accessAnalyzerCmdDefinition } from '../command-families.js';
import { errUsage } from '../errors.js';
import { listAccessAnalyses, showAccessAnalysis, explainAccessResult, formatAccessAnalysis } from '../access-analyzer.js';

export function accessAnalyzerCmd(wrap) {
  const commands = [
    ['list', 'List saved access analyses, identities, targets and last runs', listAccessAnalyses],
    ['show <request-id>', 'Show saved operation outcomes for a request sys_id', showAccessAnalysis],
    ['explain <result-id>', 'Explain ordered saved checks for an operation result sys_id', explainAccessResult],
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
            if (mode !== 'list') sub = sub.positional(`${mode === 'show' ? 'request' : 'result'}-id`, { type: 'string', describe: 'Exact 32-character hexadecimal sys_id' });
            return sub.option('limit', { type: 'number', default: mode === 'list' ? 20 : 50, describe: 'Page size (1–200)' })
              .option('offset', { type: 'number', default: 0, describe: 'Nonnegative page offset' });
          },
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const options = { limit: argv.limit, offset: argv.offset };
            const data = mode === 'list' ? await read(app.sdk, options) : await read(app.sdk, argv[mode === 'show' ? 'request-id' : 'result-id'], options);
            Object.defineProperty(data, '_formatted', { value: formatAccessAnalysis(data, mode), enumerable: false });
            app.ok(data, { summary: `${data.count} saved ${mode === 'list' ? 'analysis request(s)' : mode === 'show' ? 'operation result(s)' : 'check(s)'}${data.pagination.has_more ? ', more available' : ''}` });
          }),
        });
      }
      return y;
    },
  };
}
