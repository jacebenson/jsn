import { deferredFamilyDefinition } from '../command-families.js';
import { errUsage } from '../errors.js';
import { listConnections, showConnection, formatConnections } from '../connections.js';

export function connectionsCmd(wrap) {
  const credential = c => c.credential ? `${c.credential.name}${c.credential.type ? ` (${c.credential.type})` : ''}` : 'no credential';
  return {
    ...deferredFamilyDefinition('connections'),
    builder: y => y.strict().middleware(argv => {
      if (argv.subcommand) throw errUsage(`Unknown connections subcommand: ${argv.subcommand}`);
    }).command({ command: 'list', describe: 'List HTTP connections with their alias, URL, and credential name and type',
      builder: sub => sub.option('limit', { type: 'number', default: 50, describe: 'Page size (1–200)' })
        .option('offset', { type: 'number', default: 0, describe: 'Nonnegative page offset' }),
      handler: wrap(async (argv, app) => {
        app.requireInstance();
        const data = await listConnections(app.sdk, { limit: argv.limit, offset: argv.offset });
        Object.defineProperty(data, '_formatted', { value: formatConnections(data, 'list'), enumerable: false });
        app.ok(data, { summary: `${data.count} HTTP connection(s)${data.pagination.has_more ? ', more available' : ''}` });
      }),
    }).command({ command: 'show <connection>', describe: 'Show one HTTP connection\'s alias, credential and, for OAuth, its profile and application registry',
      builder: sub => sub.positional('connection', { type: 'string', describe: 'Connection name or 32-character sys_id' }),
      handler: wrap(async (argv, app) => {
        app.requireInstance();
        const data = await showConnection(app.sdk, argv.connection);
        Object.defineProperty(data, '_formatted', { value: formatConnections(data, 'show'), enumerable: false });
        app.ok(data, { summary: `${data.name} uses ${credential(data)}` });
      }),
    }),
  };
}
