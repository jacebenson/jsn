// jsn docs — public hosted documentation, with no local index or instance login.
import { searchHostedDocs, getHostedDoc, getHostedDocsStatus, docsServiceUrl } from './client.js';
import { declareCapabilities } from '../../capabilities.js';
import { formatCommandList } from '../../helpers.js';
import { AppError } from '../../errors.js';

declareCapabilities('docs', { noInstance: true, skipDailyChecks: true });

export function docsCmd(wrap) {
  return {
    command: 'docs [subcommand]',
    describe: 'Search and read hosted ServiceNow documentation (no account or download needed)',
    builder: (yargs) => yargs
      .command({
        command: 'status',
        describe: 'Show the documentation service index and sync status',
        handler: wrap(async (_argv, app) => {
          const data = await getHostedDocsStatus();
          app.ok(data, { summary: `Documentation service: ${data.state}` });
        }),
      })
      .command({
        command: 'search <query>',
        describe: 'Search the hosted documentation library',
        builder: y => y
          .positional('query', { type: 'string', describe: 'Search words (up to 200 characters)' })
          .option('limit', { type: 'number', default: 20, describe: 'Results per page (1–50)' })
          .option('offset', { type: 'number', default: 0, describe: 'Result offset (0–10000)' })
          .option('bundle', { type: 'string', describe: 'Filter by documentation bundle' }),
        handler: wrap(async (argv, app) => {
          const result = await searchHostedDocs({ query: argv.query, limit: argv.limit, offset: argv.offset, bundle: argv.bundle });
          const lines = [];
          for (const row of result.results) {
            lines.push(`[${row.id}] ${row.title || row.path}`, `  ${row.path}`);
            const summary = String(row.summary || row.snippet || '').replace(/\s+/g, ' ').trim();
            if (summary) lines.push(`  ${summary}`);
            lines.push('');
          }
          const next = result.offset + result.count;
          if (result.count && next < result.total && next <= 10000) lines.push(`… ${result.total - next} more results (use --offset ${next} for the next page)`);
          if (!result.count) lines.push('No matching documents. Try fewer words or a different term.');
          if (result.count) lines.push('Read with "jsn docs show <exact-path>"; IDs can be pinned with --revision.');
          app.ok({ ...result, _formatted: lines.join('\n') + '\n' }, { summary: `${result.count} of ${result.total} result(s) for "${result.query}"` });
        }),
      })
      .command({
        command: 'show <id-or-path>',
        describe: 'Read a hosted document by ID or exact path',
        builder: y => y
          .positional('id-or-path', { type: 'string', describe: 'Document ID or exact path returned by search' })
          .option('revision', { type: 'string', describe: 'Require the index revision returned by search (recommended with IDs)' })
          .option('lines', { type: 'number', default: 80, describe: 'Preview lines (1–10000); JSON always contains the full Markdown body' }),
        handler: wrap(async (argv, app) => {
          const maxLines = argv.lines ?? 80;
          if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > 10000) throw new AppError('usage_error', 'Use --lines 1–10000.');
          const row = await getHostedDoc(argv['id-or-path'], { revision: argv.revision });
          const title = row.title || row.path;
          const lines = row.body.split('\n');
          const hint = lines.length > maxLines ? `\n\n… ${lines.length - maxLines} more lines (use --lines ${Math.min(lines.length, 10000)} or --json for full content)` : '';
          app.ok({ ...row, _formatted: `${title}\n${'─'.repeat(Math.min(title.length, 80))}\n\n${lines.slice(0, maxLines).join('\n')}${hint}\n` }, { summary: `Doc ${row.id}: ${title}` });
        }),
      }),
    handler: wrap(async (argv, app) => {
      const summary = 'jsn docs — search and read hosted ServiceNow documentation.';
      const subcommands = argv.subcommands || [];
      app.ok({
        command: 'docs', subcommands,
        _formatted: formatCommandList({ title: summary, commands: subcommands,
          footer: `Service: ${docsServiceUrl()}\nSet JSN_DOCS_URL to use another deployment (for example http://localhost:3000).\nThe service syncs GitHub daily. No local database download or ServiceNow login is needed.`,
        }),
      }, { summary });
    }),
  };
}
