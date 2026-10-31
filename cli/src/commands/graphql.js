import fs from 'node:fs';
import { declareCapabilities } from '../capabilities.js';

// GraphQL documents may contain mutations. Gate the whole command so normal
// instance/auth and read-only protections apply without attempting AST parsing.
declareCapabilities('graphql', { mutationSubcommands: [''] });

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

export async function resolveGraphQLInput(argv) {
  const sources = [
    argv.document !== undefined,
    argv.query !== undefined,
    argv.queryFile !== undefined,
    argv.stdin === true,
  ].filter(Boolean).length;
  if (sources !== 1) {
    throw new Error('Provide exactly one GraphQL document via positional document, --query, --query-file, or --stdin');
  }

  let query;
  if (argv.document !== undefined) query = argv.document;
  else if (argv.query !== undefined) query = argv.query;
  else if (argv.queryFile !== undefined) query = fs.readFileSync(argv.queryFile, 'utf-8');
  else query = await readStdin();

  query = String(query || '').trim();
  if (!query) throw new Error('GraphQL document must not be empty');
  return query;
}

export function parseGraphQLVariables(value) {
  if (value === undefined) return {};
  let variables;
  try {
    variables = JSON.parse(value);
  } catch {
    throw new Error('--variables must be valid JSON');
  }
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) {
    throw new Error('--variables must be a JSON object');
  }
  return variables;
}

export function graphqlCmd(wrap) {
  return {
    command: 'graphql [document]',
    describe: 'Execute a GraphQL document against ServiceNow Now GraphQL',
    builder: (yargs) => yargs
      .positional('document', {
        describe: 'GraphQL document string',
        type: 'string',
      })
      .option('query', {
        type: 'string',
        describe: 'GraphQL document string (alternative to positional)',
      })
      .option('query-file', {
        type: 'string',
        describe: 'Read the GraphQL document from a file',
      })
      .option('variables', {
        type: 'string',
        describe: 'GraphQL variables as a JSON object',
      })
      .option('stdin', {
        type: 'boolean',
        describe: 'Read the GraphQL document from stdin',
      }),
    handler: wrap(async (argv, app) => {
      const query = await resolveGraphQLInput(argv);
      const variables = parseGraphQLVariables(argv.variables);
      const endpoint = `${app.getEffectiveInstance()}/api/now/graphql`;
      const result = await app.sdk.request(endpoint, {
        method: 'POST',
        body: JSON.stringify({ query, variables }),
      });
      const errorCount = Array.isArray(result?.errors) ? result.errors.length : 0;
      app.ok(result, {
        summary: errorCount
          ? `GraphQL returned ${errorCount} error(s)`
          : 'GraphQL request succeeded',
      });
    }),
  };
}
