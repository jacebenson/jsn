// jsn docs — ServiceNow documentation search.

import fs from 'node:fs';
import process from 'node:process';
import {
  getDocsDbPath, getDocsSourceMarkdownDir, docsDbExists,
  openDocsDb, closeDocsDb, getMeta,
} from './db.js';
import { syncDocs } from './sync.js';
import { refreshDocs } from './refresh.js';
import { embedDocs } from './embed.js';
import { searchDocs } from './search.js';
import { serveDocs } from './serve.js';

function formatBytes(n) {
  if (n == null) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function docsCmd(wrap) {
  return {
    command: 'docs [subcommand]',
    describe: 'Search ServiceNow documentation locally (sync, status, search, serve)',
    builder: (yargs) => {
      return yargs
        .command({
          command: 'sync',
          describe: 'Clone/update ServiceNowDocs and build the docs.db index',
          builder: (y) => y
            .option('no-embed', { type: 'boolean', describe: 'Skip HRR semantic embeddings' })
            .option('no-ingest', { type: 'boolean', describe: 'Clone/pull only; do not rebuild index' }),
          handler: wrap(async (argv, app) => {
            const result = syncDocs({
              markdownDir: getDocsSourceMarkdownDir(),
              dbPath: getDocsDbPath(),
              embed: argv['no-embed'] !== true,
              noIngest: argv['no-ingest'] === true,
            });
            app.ok(result, { summary: 'Docs sync complete' });
          }),
        })
        .command({
          command: 'status',
          describe: 'Show docs database status',
          handler: wrap(async (argv, app) => {
            const dbPath = getDocsDbPath();
            if (!docsDbExists()) {
              app.ok({
                exists: false,
                dbPath,
                message: 'No docs database. Run "jsn docs sync" to build it.',
              }, { summary: 'Docs database not found' });
              return;
            }
            const db = openDocsDb();
            const total = db.prepare('SELECT COUNT(*) AS n FROM docs').get().n;
            const bundles = db.prepare('SELECT COUNT(DISTINCT bundle) AS n FROM docs').get().n;
            const docTypes = db.prepare('SELECT COUNT(DISTINCT doc_type) AS n FROM docs').get().n;
            const embeddings = db.prepare('SELECT COUNT(*) AS n FROM docs WHERE hrr_vector IS NOT NULL').get().n;
            const syncedAt = getMeta(db, 'synced_at');
            const stat = fs.statSync(dbPath);
            closeDocsDb(db);

            app.ok({
              exists: true,
              dbPath,
              size: stat.size,
              sizeHuman: formatBytes(stat.size),
              documents: total,
              bundles,
              docTypes,
              embeddings,
              syncedAt: syncedAt ? new Date(parseInt(syncedAt, 10)).toISOString() : null,
            }, { summary: 'Docs database status' });
          }),
        })
        .command({
          command: 'search <query>',
          describe: 'Search docs (FTS5 + optional HRR hybrid rerank)',
          builder: (y) => y
            .positional('query', { type: 'string', describe: 'Search query' })
            .option('limit', { type: 'number', default: 20, describe: 'Max results' })
            .option('offset', { type: 'number', default: 0, describe: 'Result offset' })
            .option('bundle', { type: 'string', describe: 'Filter by bundle' })
            .option('doc-type', { type: 'string', describe: 'Filter by doc type' })
            .option('mode', { type: 'string', choices: ['keyword', 'hybrid'], default: 'hybrid', describe: 'Search mode' }),
          handler: wrap(async (argv, app) => {
            const result = searchDocs({
              query: argv.query,
              limit: argv.limit,
              offset: argv.offset,
              bundle: argv.bundle,
              docType: argv['doc-type'],
              mode: argv.mode,
            });
            app.ok(result, { summary: `${result.count} result(s) for "${result.query}" (${result.mode})` });
          }),
        })
        .command({
          command: 'serve',
          describe: 'Start the docs search web UI',
          builder: (y) => y
            .option('port', { type: 'number', default: 3000, describe: 'HTTP port' })
            .option('host', { type: 'string', default: '127.0.0.1', describe: 'Bind address' })
            .option('expose', { type: 'boolean', default: false, describe: 'Bind to 0.0.0.0 to expose on the network' }),
          handler: wrap(async (argv, _app) => {
            try {
              const host = argv.expose ? '0.0.0.0' : argv.host;
              await serveDocs({ port: argv.port, host });
            } catch (err) {
              process.stderr.write(`Error: ${err.message}\n`);
              process.exit(1);
            }
          }),
        })
        .command({
          command: 'embed',
          describe: 'Backfill or refresh HRR semantic embeddings',
          handler: wrap(async (argv, app) => {
            const result = embedDocs();
            app.ok(result, { summary: `Embedded ${result.embedded} of ${result.total} docs` });
          }),
        })
        .command({
          command: 'refresh',
          describe: 'Incrementally refresh docs.db from existing source clone',
          handler: wrap(async (argv, app) => {
            const result = refreshDocs({ docsDir: getDocsSourceMarkdownDir() });
            app.ok(result, { summary: `Refresh complete: +${result.added} ~${result.updated} -${result.removed} =${result.unchanged}` });
          }),
        });
    },
    handler: () => {
      process.stdout.write('jsn docs — ServiceNow documentation search\n\n');
      process.stdout.write('Available subcommands:\n');
      process.stdout.write('  sync      Clone/update docs and build index\n');
      process.stdout.write('  status    Show database status\n');
      process.stdout.write('  search    Search docs\n');
      process.stdout.write('  serve     Start web UI\n');
      process.stdout.write('  embed     Backfill HRR embeddings\n');
      process.stdout.write('  refresh   Incrementally refresh from existing source\n');
      process.stdout.write('\nRun "jsn docs <command> --help" for details.\n');
    },
  };
}
