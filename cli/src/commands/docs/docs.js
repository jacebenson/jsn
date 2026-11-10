// Documentation search always uses the same API, hosted or self-hosted.
import { searchHostedDocs, getHostedDoc, getHostedDocsStatus, configuredDocsService } from './client.js';
import { documentationService } from './local.js';
import { startDocumentationServer } from './server.js';
import { declareCapabilities } from '../../capabilities.js';
import { AppError } from '../../errors.js';
import { resolveDocsRelease } from './db.js';
import { listDocsReleases } from './releases.js';

declareCapabilities('docs', { noInstance: true, skipDailyChecks: true });

async function search(argv, app) {
  const query = Array.isArray(argv.query) ? argv.query.join(' ') : argv.query;
  const result = await searchHostedDocs({ query, limit: argv.limit, offset: argv.offset, bundle: argv.bundle, release: resolveDocsRelease(argv.release, app.config), serviceUrl: await documentationService(app.config, resolveDocsRelease(argv.release, app.config)) });
  const summary = `${result.count} of ${result.total} result(s) for "${result.query}" in ${result.release}`;
  const lines = [summary, ''];
  for (const row of result.results) {
    lines.push(`[${row.id}] ${row.title || row.path}`, `  ${row.path}`);
    const summary = String(row.summary || row.snippet || '').replace(/\s+/g, ' ').trim();
    if (summary) lines.push(`  ${summary}`);
    lines.push('');
  }
  const next = result.offset + result.count;
  if (result.count && next < result.total && next <= 10000) lines.push(`… ${result.total - next} more results (use --offset ${next} for the next page)`);
  if (!result.count) lines.push('No matching documents. Try fewer words or a different term.');
  if (result.count) lines.push('Read with "jsn docs --path <exact-path>"; IDs can be pinned with --revision.');
  app.ok({ ...result, _formatted: lines.join('\n') + '\n' }, { summary });
}
async function read(argv, app) {
  const maxLines = argv.lines ?? 80;
  if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > 10000) throw new AppError('usage_error', 'Use --lines 1–10000.');
  const row = await getHostedDoc(argv.path || argv['id-or-path'], { revision: argv.revision, release: resolveDocsRelease(argv.release, app.config), serviceUrl: await documentationService(app.config, resolveDocsRelease(argv.release, app.config)) });
  const title = row.title || row.path;
  const lines = row.body.split('\n');
  const hint = lines.length > maxLines ? `\n\n… ${lines.length - maxLines} more lines (use --lines ${Math.min(lines.length, 10000)} or --json for full content)` : '';
  app.ok({ ...row, _formatted: `Doc ${row.id}: ${title} in ${row.release}\n${'─'.repeat(Math.min(title.length, 80))}\n\n${lines.slice(0, maxLines).join('\n')}${hint}\n` }, { summary: `Doc ${row.id}: ${title} in ${row.release}` });
}

export function docsCmd(wrap) {
  return {
    command: 'docs [query..]',
    defaultPositionals: true,
    describe: 'Search ServiceNow documentation (hosted by default; configure your service in setup)',
    builder: y => y
      .usage('Usage: jsn docs "search terms" [options]')
      .positional('query', { type: 'string', describe: 'Search words (up to 200 characters)' })
      .option('release', { type: 'string', describe: 'Documentation family (docs.release config, otherwise australia)' })
      .option('serve', { type: 'boolean', describe: 'Run the shared documentation server (downloads its index automatically)' })
      .option('host', { type: 'string', default: '127.0.0.1', describe: 'Server bind address with --serve' })
      .option('port', { type: 'number', default: 3000, describe: 'Server port with --serve' })
      .option('limit', { type: 'number', default: 20, describe: 'Results per page (1–50)' })
      .option('offset', { type: 'number', default: 0, describe: 'Result offset (0–10000)' })
      .option('bundle', { type: 'string', describe: 'Filter by documentation bundle' })
      .option('path', { type: 'string', describe: 'Read an exact document path or ID from search results' })
      .option('revision', { type: 'string', describe: 'Require the revision returned by search (recommended with IDs)' })
      .option('lines', { type: 'number', default: 80, describe: 'Preview lines; JSON contains the full Markdown body' })
      .command({ command: 'releases', describe: 'List locally installed documentation families', handler: wrap(async (_argv, app) => {
        const releases = listDocsReleases();
        app.ok({ releases, _formatted: releases.length ? releases.map(row => `${row.release}${row.default ? ' (default)' : ''}  ${row.revision || 'unknown'}  ${row.documents} documents  ${row.indexPath}`).join('\n') + '\n' : 'No local documentation families installed.\n' }, { summary: `${releases.length} local documentation release(s)` });
      }) })
      .command({ command: 'sync', describe: 'Clone or update a documentation family and its local index',
        builder: y => y.option('embed', { type: 'boolean', default: true }).option('ingest', { type: 'boolean', default: true }),
        handler: wrap(async (argv, app) => {
          const { syncDocs } = await import('./sync.js');
          const release = resolveDocsRelease(argv.release, app.config);
          app.ok({ ...syncDocs({ release, embed: argv.embed, noIngest: argv.ingest === false }), release });
        }),
      })
      // Compatibility spellings remain callable without becoming another menu.
      .command({ command: 'install', hidden: true,
        builder: y => y.option('source', { type: 'string', choices: ['snapshot', 'github', 'skip'] })
          .option('manifest-url', { type: 'string' }),
        handler: wrap(async (argv, app) => {
          const { installDocumentation } = await import('./install.js');
          app.ok(await installDocumentation(argv.source, { manifestURL: argv['manifest-url'], release: resolveDocsRelease(argv.release, app.config), serviceUrl: configuredDocsService(app.config) }));
        }),
      })
      .command({ command: 'search <query..>', hidden: true, handler: wrap(search) })
      .command({ command: 'show <id-or-path>', hidden: true, handler: wrap(read) })
      .command({ command: 'status', hidden: true, handler: wrap(async (argv, app) => {
        const data = await getHostedDocsStatus({ release: resolveDocsRelease(argv.release, app.config), serviceUrl: await documentationService(app.config, resolveDocsRelease(argv.release, app.config)) });
        app.ok(data, { summary: `Documentation service: ${data.state} in ${data.release}` });
      }) }),
    handler: wrap(async (argv, app) => {
      if (argv.serve) {
        if (!Number.isInteger(argv.port) || argv.port < 0 || argv.port > 65535) throw new AppError('usage_error', 'Use a port between 0 and 65535.');
        const release = resolveDocsRelease(argv.release, app.config);
        const { server, url } = await startDocumentationServer({ host: argv.host, port: argv.port, release });
        app.ok({ url, release, state: 'listening' }, { summary: `Documentation server started for ${release}; the index updates automatically.` });
        for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
        return;
      }
      if (argv.path) return read(argv, app);
      if (argv.query?.length) return search(argv, app);
      const service = await documentationService(app.config, resolveDocsRelease(argv.release, app.config));
      const summary = 'Search ServiceNow documentation';
      app.ok({ command: 'docs', service,
        _formatted: `jsn docs "search terms"\njsn docs --path <exact-path>\n\nService: ${service}\nChange documentation preferences in jsn setup → Defaults and documentation.\nNo ServiceNow connection is needed. Hosted mode downloads no database.\n`,
      }, { summary });
    }),
  };
}
