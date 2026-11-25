import { docsCmdDefinition } from '../../command-families.js';
// Documentation search always uses the same API, hosted or self-hosted.
import { searchHostedDocs, getHostedDoc, getHostedDocsStatus, configuredDocsService, searchInput, docInput } from './client.js';
import { documentationService } from './local.js';

import { docLink } from '../../docs-links.js';
import { AppError } from '../../errors.js';
import { resolveDocsRelease } from './db.js';
import { listDocsReleases } from './releases.js';
import { chooseDocsRelease } from './instance-release.js';



function presented(data, text) {
  return Object.defineProperty(data, '_formatted', { value: text, enumerable: false });
}
// The release, and why when nothing named it: "brazil (the instance's release)".
const label = (release, choice) => choice.note ? `${release} (${choice.note})` : release;
// Only when jsn chose, so a named release prints what it printed before.
const why = choice => choice.note ? { release_source: choice.source, release_note: choice.note } : {};

async function search(argv, app) {
  const query = Array.isArray(argv.query) ? argv.query.join(' ') : argv.query;
  // Input is checked before the release is chosen, which may ask the instance and the service.
  searchInput({ query, limit: argv.limit, offset: argv.offset });
  const choice = await chooseDocsRelease(argv, app);
  const result = await searchHostedDocs({ query, limit: argv.limit, offset: argv.offset, bundle: argv.bundle, release: choice.release, serviceUrl: await documentationService(app.config, choice.release) });
  const summary = `${result.count} of ${result.total} result(s) for "${result.query}" in ${label(result.release, choice)}`;
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
  app.ok({ ...result, ...why(choice), _formatted: lines.join('\n') + '\n' }, { summary });
}
async function read(argv, app) {
  const maxLines = argv.lines ?? 80;
  if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > 10000) throw new AppError('usage_error', 'Use --lines 1–10000.');
  docInput(argv.path || argv['id-or-path'], { outline: argv.outline, section: argv.section });
  const choice = await chooseDocsRelease(argv, app);
  const row = Object.assign(await getHostedDoc(argv.path || argv['id-or-path'], { outline: argv.outline, section: argv.section, revision: argv.revision, release: choice.release, serviceUrl: await documentationService(app.config, choice.release) }), why(choice));
  const title = row.title || row.path;
  const provenance = `${row.path}\nRelease: ${label(row.release, choice)} | Revision: ${row.revision}\nService: ${row.service}`;
  if (row.outline) {
    const text = row.outline.map(h => `${'  '.repeat(h.ancestors.length)}${h.title}  [lines ${h.start_line}–${h.end_line}]\n${'  '.repeat(h.ancestors.length)}  ${h.id}`).join('\n');
    return app.ok(presented(row, `${title}\n${provenance}\n\n${text || 'No selectable headings.'}\n\nUse --section '<ID>' with this --path. Selection includes preamble and ancestor introductions.\nOther sections and linked prerequisites may still matter.\nRetrieval: ${row.retrieval.execution}; full document transferred: ${row.retrieval.full_document_transferred}\n`));
  }
  const lines = row.body.split('\n');
  const hint = lines.length > maxLines ? `\n\n… ${lines.length - maxLines} more lines (use --lines ${Math.min(lines.length, 10000)} or --json for full content)` : '';
  const content = row.section ? row.body : lines.slice(0, maxLines).join('\n') + hint;
  const context = row.section ? `\nComplete selected subtree: ${row.section.title}\n${row.retrieval.context_policy}\nOther sections to check: ${row.retrieval.context_sections.map(h => h.title).join('; ') || 'none'}.\nUse --outline to retrieve their IDs.\nSemantic answer completeness: unknown. Retrieval: ${row.retrieval.execution}.\n` : '';
  app.ok(presented(row, `Doc ${row.id}: ${title} in ${row.release}\n${provenance}${context}\n${content}\n`), { summary: `Doc ${row.id}: ${title} in ${row.release}` });
}

export function docsCmd(wrapHandler) {
  // The adapter tolerates unknown options; retired server flags must fail closed
  // on every docs spelling rather than becoming an accidental search request.
  const wrap = handler => wrapHandler(async (argv, app) => {
    for (const name of ['serve', 'no-serve', 'host', 'no-host', 'port', 'no-port']) {
      if (Object.hasOwn(argv, name)) throw new AppError('usage_error', `Unknown option --${name}: the CLI documentation server flags have been removed. Use terminal search or configure a documentation service in jsn setup.`);
    }
    return handler(argv, app);
  });
  return {
    ...docsCmdDefinition,
    builder: y => y
      .usage('Usage: jsn docs "search terms" [options]')
      .epilogue(`Documentation for this command: ${docLink('docs')}`)
      .positional('query', { type: 'string', describe: 'Search words (up to 200 characters)' })
      .option('release', { type: 'string', describe: "Documentation family (docs.release config, else the instance's family if the docs have it, else the newest they have)" })

      .option('limit', { type: 'number', default: 20, describe: 'Results per page (1–50)' })
      .option('offset', { type: 'number', default: 0, describe: 'Result offset (0–10000)' })
      .option('bundle', { type: 'string', describe: 'Filter by documentation bundle' })
      .option('path', { type: 'string', describe: 'Read an exact document path or ID from search results' })
      .option('revision', { type: 'string', describe: 'Require the revision returned by search (recommended with IDs)' })
      .option('outline', { type: 'boolean', describe: 'List revision-bound section IDs for --path, without document body' })
      .option('section', { type: 'string', describe: 'Read a complete subtree by outline ID or exact unique heading; includes ancestor introductions' })
      .option('lines', { type: 'number', default: 80, describe: 'Full-document human preview lines; JSON and selected sections are not truncated' })
      .command({ command: 'releases', describe: 'List locally installed documentation families', handler: wrap(async (_argv, app) => {
        const releases = listDocsReleases();
        app.ok({ releases, _formatted: releases.length ? releases.map(row => `${row.release}${row.default ? ' (default)' : ''}  ${row.revision || 'unknown'}  ${row.documents} documents  ${row.indexPath}`).join('\n') + '\n' : 'No local documentation families installed.\n' }, { summary: `${releases.length} local documentation release(s)` });
      }) })
      .command({ command: 'sync', describe: 'Clone or update a documentation family and its local index',
        // Declared here too so discover, which leaves a self-running parent's options off its children, still offers it.
        builder: y => y.option('release', { type: 'string', describe: 'Documentation family (docs.release config, otherwise australia)' })
          .option('embed', { type: 'boolean', default: true }).option('ingest', { type: 'boolean', default: true }),
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
        const choice = await chooseDocsRelease(argv, app);
        const data = { ...await getHostedDocsStatus({ release: choice.release, serviceUrl: await documentationService(app.config, choice.release) }), ...why(choice) };
        app.ok(data, { summary: `Documentation service: ${data.state} in ${label(data.release, choice)}` });
      }) }),
    handler: wrap(async (argv, app) => {

      if ((argv.outline || argv.section !== undefined) && !argv.path) throw new AppError('usage_error', 'Use --path with --outline or --section.');
      if (argv.path) return read(argv, app);
      if (argv.query?.length) return search(argv, app);
      const service = await documentationService(app.config, resolveDocsRelease(argv.release, app.config));
      const summary = 'Search ServiceNow documentation';
      app.ok({ command: 'docs', service,
        _formatted: `jsn docs "search terms"\njsn docs --path <exact-path>\n\nService: ${service}\nChange documentation preferences in jsn setup → Defaults and documentation.\nNo ServiceNow connection is needed; with a profile selected and no release named, the instance's release is used when the documentation has it. Hosted mode downloads no database.\n`,
      }, { summary });
    }),
  };
}
