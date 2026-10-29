// jsn docs — ServiceNow documentation search.

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import process from 'node:process';
import { declareCapabilities } from '../../capabilities.js';
import { formatCommandList } from '../../helpers.js';

declareCapabilities('docs', { noInstance: true, skipDailyChecks: true });

function formatBytes(n) {
  if (n == null) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function docsCmd(wrap) {
  return {
    command: 'docs [subcommand]',
    describe: 'Search ServiceNow documentation locally (install, sync, status, search, serve)',
    builder: (yargs) => {
      return yargs
        .command({ command: 'install', describe: 'Install optional docs: raw GitHub files or a verified prebuilt searchable database',
          builder: y => y.option('source', { type: 'string', choices: ['snapshot', 'github', 'skip'], describe: 'Explicit source; raw GitHub estimated ~5 minutes; snapshot estimate comes from manifest' })
            .option('manifest-url', { type: 'string', describe: 'HTTPS snapshot manifest mirror' }),
          handler: wrap(async (argv, app) => {
            const { installDocumentation, offerDocumentation } = await import('./install.js');
            const { canUsePicker } = await import('../../helpers.js');
            const result = argv.source ? await installDocumentation(argv.source, { manifestURL: argv['manifest-url'] })
              : canUsePicker(app, argv) ? await offerDocumentation(app, argv) : await installDocumentation(undefined);
            app.ok(result, { summary: result.skipped ? 'Documentation skipped' : 'Documentation installed' });
          }),
        })
        .command({ command: 'rollback', describe: 'Restore the previously installed local docs database', handler: wrap(async (_argv, app) => {
          const { rollbackSnapshot } = await import('./snapshot.js');
          app.ok(rollbackSnapshot(), { summary: 'Previous documentation index restored' });
        }) })
        .command({
          command: 'sync',
          describe: 'Clone/update ServiceNowDocs and build the docs.db index',
          builder: (y) => y
            .option('no-embed', { type: 'boolean', describe: 'Skip HRR semantic embeddings' })
            .option('no-ingest', { type: 'boolean', describe: 'Clone/pull only; do not rebuild index' }),
          handler: wrap(async (argv, app) => {
            const { getDocsDbPath, getDocsSourceMarkdownDir } = await import('./db.js');
            const { syncDocs } = await import('./sync.js');
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
            const { getDocsDbPath, getDocsSourceDir, getDocsSourceMarkdownDir, docsDbExists, withDocsDb, getDocsIndexStats } = await import('./db.js');
            const dbPath = getDocsDbPath();
            const repoDir = getDocsSourceDir();
            const markdownDir = getDocsSourceMarkdownDir();
            const downloaded = fs.existsSync(path.join(repoDir, '.git')) && fs.existsSync(markdownDir);
            const dbExists = docsDbExists();

            let state, embedded, documents, bundles, docTypes, syncedAt, dbSize;
            if (dbExists) {
              const stats = withDocsDb({}, (db) => getDocsIndexStats(db));
              ({ documents, bundles, docTypes, syncedAt } = stats);
              const stat = fs.statSync(dbPath);
              dbSize = stat.size;

              embedded = stats.embeddedCount >= documents && documents > 0;
              if (embedded) state = 'ready';
              else if (documents > 0) state = 'indexed (not embedded)';
              else state = 'empty';
            } else {
              state = downloaded ? 'not indexed' : 'not downloaded';
              embedded = false;
            }

            // Quick probe to see if the server is running on the default port.
            const served = await new Promise((resolve) => {
              const sock = new net.Socket();
              sock.setTimeout(500);
              sock.on('connect', () => { sock.destroy(); resolve(true); });
              sock.on('error', () => resolve(false));
              sock.on('timeout', () => { sock.destroy(); resolve(false); });
              sock.connect(3000, '127.0.0.1');
            });

            const { docsSnapshotStatus } = await import('./snapshot.js');
            const snapshot = docsSnapshotStatus();
            let available = null;
            try { available = JSON.parse(fs.readFileSync(`${dbPath}.available.json`, 'utf8')); } catch { /* No background update information. */ }
            app.ok({
              state,
              ...(snapshot ? { snapshot: { revision: snapshot.revision, schema: snapshot.schema } } : {}),
              ...(snapshot && available?.installed === snapshot.revision && available.revision !== snapshot.revision ? { updateAvailable: { revision: available.revision, command: 'jsn docs install --source snapshot' } } : {}),
              downloaded: { ok: downloaded, path: repoDir },
              db: { ok: dbExists, path: dbPath },
              embedded: { ok: embedded },
              ...(documents != null && { documents, bundles, docTypes, syncedAt: syncedAt ? new Date(parseInt(syncedAt, 10)).toISOString() : null }),
              ...(dbSize != null && { dbSizeHuman: formatBytes(dbSize) }),
              ...(served && { served: 'http://127.0.0.1:3000' }),
            }, { summary: `Docs database: ${state}` });
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
            const { ensureDocumentation } = await import('./install.js');
            await ensureDocumentation(app, argv);
            const { searchDocs } = await import('./search.js');
            const result = searchDocs({
              query: argv.query,
              limit: argv.limit,
              offset: argv.offset,
              bundle: argv.bundle,
              docType: argv['doc-type'],
              mode: argv.mode,
            });

            // Build a readable text blob for styled TTY output.
            const lines = [];
            for (const r of result.results) {
              const title = r.title || r.path || '(untitled)';
              const snippet = (r.snippet || r.body || '')
                .replace(/\\n/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .substring(0, 200);
              lines.push(`[${r.id}] ${title}`);
              if (snippet) lines.push(`  ${snippet}`);
              lines.push('');
            }

            const hasMore = result.total > result.count;
            if (hasMore) {
              const nextOffset = (result.count + (argv.offset || 0));
              lines.push(`… ${result.total - result.count} more results (use --offset ${nextOffset} for next page)`);
            }

            app.ok({
              _formatted: lines.join('\n'),
              query: result.query,
              mode: result.mode,
              total: result.total,
              count: result.count,
              results: result.results,
            }, { summary: `${result.count} of ${result.total} result(s) for "${result.query}" (${result.mode})` });
          }),
        })
        .command({
          command: 'show <id-or-path>',
          describe: 'Show a documentation page by id or path',
          builder: (y) => y
            .positional('id-or-path', { type: 'string', describe: 'Document id (number) or file path' })
            .option('lines', { type: 'number', default: 80, describe: 'Lines of body to show in terminal (use --json for full content)' }),
          handler: wrap(async (argv, app) => {
            const { getDocByIdOrPath } = await import('./search.js');
            const idOrPath = argv['id-or-path'];
            const row = getDocByIdOrPath(idOrPath);

            if (!row) {
              throw Object.assign(new Error(`No doc found for "${idOrPath}"`), { code: 'not_found' });
            }

            let fm = {};
            try { fm = JSON.parse(row.frontmatter || '{}'); } catch { /* ignore */ }

            const title = row.title || fm.title || row.path || '(untitled)';
            const header = `${title}\n${'─'.repeat(Math.min(title.length, 80))}`;
            const body = row.body || '';
            const bodyLines = body.split('\n');
            const truncated = bodyLines.length > argv.lines;
            const preview = bodyLines.slice(0, argv.lines).join('\n');
            const hint = truncated ? `\n\n… ${bodyLines.length - argv.lines} more lines (use --lines ${bodyLines.length} or --json for full content)` : '';

            app.ok({
              id: row.id,
              path: row.path,
              title: row.title,
              bundle: row.bundle,
              release: row.release,
              canonical_url: fm.canonical_url || null,
              body,
              _formatted: `${header}\n\n${preview}${hint}`,
            }, { summary: `Doc ${row.id}: ${title}` });
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
            const { serveDocs } = await import('./serve.js');
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
            const { embedDocs } = await import('./embed.js');
            const result = embedDocs();
            app.ok(result, { summary: `Embedded ${result.embedded} of ${result.total} docs` });
          }),
        })
        .command({
          command: 'refresh',
          describe: 'Incrementally refresh docs.db from existing source clone',
          handler: wrap(async (argv, app) => {
            const { getDocsSourceMarkdownDir } = await import('./db.js');
            const { refreshDocs } = await import('./refresh.js');
            const result = refreshDocs({ docsDir: getDocsSourceMarkdownDir() });
            app.ok(result, { summary: `Refresh complete: +${result.added} ~${result.updated} -${result.removed} =${result.unchanged}` });
          }),
        })
        .command({
          command: 'community <action>',
          describe: 'Sync ServiceNow Community articles into the searchable docs index',
          builder: (y) => y
            .command({
              command: 'sync',
              describe: 'Fetch community hub pages (+ linked articles with --expand) and index them',
              builder: (yy) => yy
                .option('expand', { type: 'boolean', describe: 'Also fetch every linked community article found on the hub pages' })
                .option('force', { type: 'boolean', describe: 'Re-fetch articles already downloaded' })
                .option('sources', { type: 'string', describe: 'Path to a community-sources.json (default: bundled)' })
                .option('delay-ms', { type: 'number', describe: 'Delay between article fetches (default: 500)' }),
              handler: wrap(async (argv, app) => {
                const { syncCommunity } = await import('./community.js');
                const result = await syncCommunity({
                  sourcesFile: argv.sources,
                  expand: argv.expand === true,
                  force: argv.force === true,
                  delayMs: argv['delay-ms'],
                });
                app.ok(result, {
                  summary: `Community sync: ${result.hubs.length} hub(s), ${result.articles.length} article(s), ${result.skipped.length} skipped, ${result.errors.length} error(s)`,
                });
              }),
            })
            .command({
              command: 'list',
              describe: 'List community docs currently in the index',
              handler: wrap(async (argv, app) => {
                const { listCommunityDocs } = await import('./community.js');
                const result = listCommunityDocs();
                const lines = result.docs.map((d) => `[${d.id}] ${d.title || d.path} (${d.doc_type})`);
                app.ok({
                  _formatted: lines.length ? lines.join('\n') : '(no community docs indexed yet)',
                  total: result.total,
                  docs: result.docs,
                }, { summary: `${result.total} community doc(s) indexed` });
              }),
            })
            .demandCommand(1, 'Specify an action: sync or list'),
        });
    },
    handler: wrap(async (argv, app) => {
      const { getDocsDbPath } = await import('./db.js');
      const subcommands = argv.subcommands || [];
      const summary = 'jsn docs — optional local documentation (install, sync, status, search, show, serve, rollback).';
      app.ok({
        command: 'docs',
        subcommands,
        _formatted: formatCommandList({
          title: summary,
          commands: subcommands,
          footer: [
            'Tip: use "jsn docs serve --expose" to bind to 0.0.0.0 and share on your network.',
            `Docs DB: ${getDocsDbPath()} (run "jsn docs status" for details, or query directly with sqlite3)`,
            'Run "jsn docs <command> --help" for details.',
          ].join('\n'),
        }),
      }, { summary });
    }),
  };
}
