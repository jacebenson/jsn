// jsn snippets — named query snippets stored locally in the config dir.
// Save a table+query (with optional columns) under a name, then run it later
// against the active profile. No instance contact for save/list/delete/show.

import fs from 'node:fs';
import path from 'node:path';
import { globalConfigDir } from '../config.js';
import { resolveFieldsParam } from '../helpers.js';

function snippetsPath() {
  const dir = globalConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'snippets.json');
}

function loadSnippets() {
  try {
    const raw = fs.readFileSync(snippetsPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {};
  }
}

function saveSnippets(map) {
  fs.writeFileSync(snippetsPath(), JSON.stringify(map, null, 2) + '\n', { mode: 0o600 });
}

export function snippetsCmd(wrap) {
  return {
    command: 'snippets [subcommand]',
    describe: 'Save and re-run named query snippets (stored locally, no instance contact except run)',
    builder: (yargs) => {
      return yargs
        .command({
          command: 'save <name>',
          describe: 'Save a named query snippet',
          builder: (y) => y
            .positional('name', { describe: 'Snippet name', type: 'string' })
            .option('table', { type: 'string', demandOption: true, describe: 'Table name' })
            .option('query', { type: 'string', describe: 'Encoded query (e.g. "priority=1^active=true")' })
            .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns' })
            .option('limit', { type: 'number', describe: 'Max records (default: unlimited / SDK default)' }),
          handler: wrap(async (argv, app) => {
            const snippets = loadSnippets();
            snippets[argv.name] = {
              table: argv.table,
              query: argv.query || '',
              columns: argv.columns ? argv.columns.split(',') : undefined,
              limit: argv.limit,
              saved_at: new Date().toISOString(),
            };
            saveSnippets(snippets);
            app.ok({ name: argv.name, ...snippets[argv.name] }, { summary: `Saved snippet "${argv.name}"` });
          }),
        })
        .command({
          command: 'run <name>',
          describe: 'Run a saved query snippet against the active profile (read-only)',
          builder: (y) => y
            .positional('name', { describe: 'Snippet name', type: 'string' })
            .option('query', { type: 'string', describe: 'Override the encoded query' })
            .option('limit', { type: 'number', describe: 'Override max records' })
            .option('json', { type: 'boolean', describe: 'Force JSON output' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const snippets = loadSnippets();
            const snip = snippets[argv.name];
            if (!snip) {
              const err = new Error(`Snippet "${argv.name}" not found`);
              err.code = 'not_found';
              throw err;
            }
            const columns = snip.columns || [];
            const query = argv.query || snip.query || '';
            const limit = argv.limit || snip.limit || 20;
            const params = new URLSearchParams();
            params.set('sysparm_limit', String(limit));
            params.set('sysparm_offset', '0');
            params.set('sysparm_display_value', 'all');
            const fields = columns.length ? resolveFieldsParam(columns) : undefined;
            if (fields) params.set('sysparm_fields', fields);
            if (query) params.set('sysparm_query', query);
            const records = await app.sdk.list(snip.table, params);
            app.ok({
              table: snip.table,
              query,
              columns,
              count: records.length,
              records,
              context: { instance_url: app.getEffectiveInstance() },
            }, { summary: `${records.length} record(s) from ${snip.table} (snippet "${argv.name}")` });
          }),
        })
        .command({
          command: 'list',
          describe: 'List saved snippets',
          handler: wrap(async (argv, app) => {
            const snippets = loadSnippets();
            const entries = Object.entries(snippets).map(([name, s]) => ({
              name,
              table: s.table,
              query: s.query || '',
            }));
            app.ok({ count: entries.length, snippets: entries }, { summary: `${entries.length} saved snippet(s)` });
          }),
        })
        .command({
          command: 'show <name>',
          describe: 'Show a saved snippet definition',
          handler: wrap(async (argv, app) => {
            const snippets = loadSnippets();
            const snip = snippets[argv.name];
            if (!snip) {
              const err = new Error(`Snippet "${argv.name}" not found`);
              err.code = 'not_found';
              throw err;
            }
            app.ok({ name: argv.name, ...snip }, { summary: `Snippet "${argv.name}"` });
          }),
        })
        .command({
          command: 'delete <name>',
          describe: 'Delete a saved snippet',
          builder: (y) => y.option('force', { type: 'boolean', default: false, describe: 'Skip confirmation' }),
          handler: wrap(async (argv, app) => {
            const { confirmDelete } = await import('../helpers.js');
            await confirmDelete(app, argv, `Delete snippet "${argv.name}"?`);
            const snippets = loadSnippets();
            if (!(argv.name in snippets)) {
              const err = new Error(`Snippet "${argv.name}" not found`);
              err.code = 'not_found';
              throw err;
            }
            delete snippets[argv.name];
            saveSnippets(snippets);
            app.ok({ name: argv.name, deleted: true }, { summary: `Deleted snippet "${argv.name}"` });
          }),
        });
    },
    handler: () => {
      console.log('Named query snippets (stored locally).');
      console.log('');
      console.log('Available subcommands:');
      console.log('  save <name>       Save a table+query snippet');
      console.log('  run <name>        Run a snippet against the active profile');
      console.log('  list              List saved snippets');
      console.log('  show <name>       Show a snippet definition');
      console.log('  delete <name>     Delete a snippet');
      console.log('');
      console.log('Run "jsn snippets <command> --help" for details.');
    },
  };
}
