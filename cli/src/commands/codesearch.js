// GraphQL read-only queries; no sn_codesearch engine or Flow downloads.
import { searchGraphQL } from '../codesearch-graphql.js';

export function renderCodeSearch(data) {
  const out = [`${data.recordCount} record(s), ${data.fieldCount} field(s), ${data.matchCount} match(es) — ${data.status}`];
  for (const row of data.records) {
    out.push(`${row.table}  ${row.name}  .${row.field}  (lines ${row.lines})`);
    if (row.context) out.push(`    ${row.context}`);
  }
  if (!data.records.length) out.push(`No visible code matches for "${data.term}".`);
  const gaps = data.coverage.filter((item) => item.status !== 'complete');
  for (const gap of gaps) {
    out.push(`${gap.table}: ${gap.status} (${gap.reason})`);
    if (gap.unsupportedFields?.length) out.push(`    Unsupported fields: ${gap.unsupportedFields.join(', ')}`);
  }
  if (data.configuration.status !== 'complete') out.push(`Search configuration: ${data.configuration.reason}`);
  out.push(data.hint);
  return out.join('\n') + '\n';
}

export function codesearchCmd(wrap) {
  return {
    command: 'codesearch [subcommand]',
    aliases: ['codesearch'],
    describe: 'Search code across ServiceNow artifacts with read-only GraphQL queries',
    builder: (yargs) => yargs.command({
      command: 'search <term>',
      describe: 'Search code; Flow internals require separate jsn flows search',
      builder: (y) => y
        .positional('term', { type: 'string', describe: 'Literal case-insensitive search term (no encoded-query separators)' })
        .option('limit', { alias: 'l', type: 'number', default: 100, describe: 'Max matching records (coverage is partial when reached)' })
        .option('table', { alias: 't', type: 'string', describe: 'Restrict to a curated or configured source table' })
        .option('scope', { alias: 's', type: 'string', describe: 'Restrict to an app scope (e.g. x_my_app)' })
        .option('search-group', { type: 'string', default: 'sn_devstudio.Studio Search Group', describe: 'Layer configured fields and filters from this group over the curated catalog' })
        .option('all-scopes', { type: 'boolean', default: true, describe: 'Search all scopes; false requires --scope' })
        .option('page-size', { type: 'number', default: 250, describe: 'GraphQL page window size (max 1000)' })
        .option('max-pages', { type: 'number', default: 20, describe: 'Maximum pages per table (max 1000)' })
        .option('max-requests', { type: 'number', default: 1000, describe: 'Data-call budget including configuration, excluding SDK auth/bootstrap (max 10000)' }),
      handler: wrap(async (argv, app) => {
        const data = await searchGraphQL(app, argv);
        Object.defineProperty(data, '_formatted', { value: renderCodeSearch(data), enumerable: false });
        app.ok(data, { summary: `${data.recordCount} record(s), ${data.fieldCount} field(s), ${data.matchCount} match(es) — ${data.status}` });
      }),
    }).demandCommand(1, 'Specify a subcommand: search'),
    handler: () => {},
  };
}
