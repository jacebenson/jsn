import { declareCapabilities } from '../capabilities.js';

// Raw REST passthrough — can hit any endpoint with any method, so the whole
// command is a mutation surface on read-only profiles.
declareCapabilities('rest', { mutationSubcommands: [''] });

export function restCmd(wrap) {
  return {
    command: 'rest [endpoint]',
    describe: 'Make raw REST API calls',
    builder: (yargs) => {
      return yargs
        .positional('endpoint', {
          type: 'string',
          describe: 'API path, optionally including query parameters; with --table, a record sys_id',
        })
        .option('method', {
          alias: 'X',
          type: 'string',
          default: 'GET',
          describe: 'HTTP method (GET, POST, PUT, DELETE, PATCH)',
        })
        .option('data', {
          alias: 'd',
          type: 'string',
          describe: 'Request body data (JSON string)',
        })
        .option('table', {
          alias: 't',
          type: 'string',
          describe: 'Table name shorthand for api/now/table/{table}',
        })
        .option('raw', {
          type: 'boolean',
          default: false,
          describe: 'Return non-JSON response bodies as text (for XML/HTML diagnostic endpoints)',
        })
        .option('query', {
          type: 'string',
          describe: 'Query parameters string',
        })
        .epilogue([
          'Prefer a specific jsn command or records for normal table operations.',
          'Raw REST is blocked on read-only profiles for every method, including GET.',
          'Examples:',
          '  jsn rest "/api/now/table/incident?sysparm_limit=3" --json',
          '  jsn rest --table incident --query "sysparm_limit=3" --json',
          '  jsn rest /stats.do --raw',
          'Use either query parameters in the endpoint or --query, rather than both.',
        ].join('\n'));
    },
    handler: wrap(async (argv, app) => {
      const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
      const method = (argv.method || 'GET').toUpperCase();

      if (!validMethods.includes(method)) {
        throw new Error(`Invalid HTTP method: ${method} (must be GET, POST, PUT, DELETE, or PATCH)`);
      }

      let endpoint;
      if (argv.table) {
        endpoint = `api/now/table/${argv.table}`;
        if (argv.endpoint) {
          endpoint = `${endpoint}/${argv.endpoint}`;
        }
      } else if (argv.endpoint) {
        endpoint = argv.endpoint;
      } else {
        throw new Error('Either provide an endpoint argument or use --table flag');
      }

      // Trim leading slash from endpoint
      endpoint = endpoint.replace(/^\/+/, '');

      const instance = app.getEffectiveInstance();
      const query = argv.query ? `?${argv.query}` : '';
      const url = `${instance}/${endpoint}${query}`;

      const requestOptions = { method };
      if (argv.data) {
        requestOptions.body = argv.data;
      }

      const result = argv.raw
        ? await app.sdk.rawRequest(url, requestOptions)
        : await app.sdk.request(url, requestOptions);
      app.ok(result, { summary: `${method} ${endpoint}` });
    }),
  };
}
