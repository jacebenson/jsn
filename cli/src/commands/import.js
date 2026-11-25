import { buildDevCmd } from './_generic.js';
import { getStringField, quoteShellArg } from '../helpers.js';
import { errUsage } from '../errors.js';
import { declareCapabilities } from '../capabilities.js';
import { readImportFile, checkStagingTable, loadImportRows, loadRerun, formatLoad, activeTransformMaps, readImportSet, checkTransformable,
  transformImportSet, transformResult } from '../import-sets.js';
import { detailCount } from './_detail-count.js';

export const importCmd = (wrap) => withWrites(buildDevCmd('import', 'sys_import_set', ['imports', 'imp'],
  ['name', 'sys_target_table', 'state', 'sys_created_on'], wrap, {
    singular: 'import set',
    readOnly: true,
    extraSubcommands: [{ name: 'load', description: 'Load rows into a staging table and transform them' },
      { name: 'transform', description: 'Rerun the transform maps on an existing import set' }],
    formatLabel: (r) => {
      const name = getStringField(r, 'name') || '';
      const table = getStringField(r, 'sys_target_table') || '';
      return table ? `${name} [${table}]` : name;
    },
    onShow: async (record, app) => {
      const sysID = getStringField(record, 'sys_id') || '';
      if (!sysID) return;
      try {
        const count = await detailCount(app.sdk, 'sys_import_set_row', `sys_import_set=${sysID}`);
        console.log(`  Import rows: ${count}`);
        console.log(`    → jsn records list --table sys_import_set_row --query "sys_import_set=${sysID}" --limit 200`);
      } catch (error) {
        if (error.code === 'invalid_aggregate_count') throw error;
        console.log(`  Import rows: (unavailable)`);
      }
    },
  }), wrap);

function withWrites(base, wrap) {
  // Loaded rows and transformed targets are data, not customizations.
  declareCapabilities('import', { mutationContext: 'operational', queryTable: 'sys_import_set', mutationSubcommands: ['load', 'transform'] });
  return {
    ...base,
    builder: y => base.builder(y)
      .command({
        command: 'load <table>',
        describe: 'Load .json or .csv rows into a staging table through the Import Set API; preview by default',
        builder: yy => yy
          .positional('table', { type: 'string', describe: 'Staging table (extends sys_import_set_row)' })
          .option('file', { type: 'string', demandOption: true, describe: 'Rows as .json (array, or { "records": [...] }) or .csv with a header row' })
          .option('yes', { type: 'boolean', default: false, describe: 'Send the rows; each one is transformed as it loads' })
          .option('limit', { type: 'number', default: 200, describe: 'Safety cap: refuse a file with more rows than this' })
          .epilogue('Keys are the staging table\'s column names. Without --yes, checks the file, the columns and the active transform maps, and sends nothing.\n'
            + 'With --yes, posts one row at a time (POST /api/now/import/<table>), which transforms it synchronously, and prints each outcome:\n'
            + 'inserted, updated, ignored, skipped or error, with the target table and sys_id. Stops at the first failed request.'),
        handler: wrap(async (argv, app) => {
          if (!/^[a-zA-Z0-9_]+$/.test(argv.table || '')) throw errUsage('The staging table name must be letters, digits and underscores.');
          const rows = readImportFile(argv.file, argv.limit);
          const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
          const maps = await checkStagingTable(app.sdk, argv.table, columns);
          if (!argv.yes) {
            const rerun = loadRerun(argv.table, argv.file, argv.limit);
            return app.ok({ dry_run: true, staging_table: argv.table, rows: rows.length, columns, transform_maps: maps, rerun }, {
              summary: `Dry run: ${rows.length} row(s) would load into ${argv.table} through ${maps.length} transform map(s); nothing sent`,
              breadcrumbs: [{ action: 'load', cmd: rerun, description: 'Send the rows' }],
            });
          }
          const data = await loadImportRows(app.sdk, argv.table, rows);
          Object.defineProperty(data, '_formatted', { value: formatLoad(data), enumerable: false });
          const counts = Object.entries(data.counts).map(([status, n]) => `${n} ${status}`).join(', ');
          const failed = data.failed > 0 || data.not_sent > 0;
          app.ok(data, {
            summary: failed ? `Import load had errors: ${data.failed} row(s) failed, ${data.not_sent} not sent (${counts})`
              : `Loaded ${data.total} row(s) into ${argv.table}: ${counts}`,
            breadcrumbs: data.import_sets.map(set => ({ action: 'rows', cmd: `jsn records list --table sys_import_set_row --query "sys_import_set.number=${set}"`, description: `Rows of ${set}` })),
          });
          if (failed) process.exitCode = 1;
        }),
      })
      .command({
        command: 'transform <import_set>',
        describe: 'Rerun the active transform maps on an import set and report each row as read back; preview by default',
        builder: yy => yy
          .positional('import_set', { type: 'string', describe: 'Import set number (ISET0010001) or sys_id' })
          .option('yes', { type: 'boolean', default: false, describe: 'Run the transform' })
          .option('limit', { type: 'number', default: 200, describe: 'Safety cap: refuse a set with more rows than this' })
          .epilogue('Runs on a loaded set with pending rows, or a processed set, which is set back to loaded first as the Reprocess action does\n'
            + '(the platform then sets every row back to pending). A web service set stays loading until the platform closes it.\n'
            + 'Afterwards re-reads the set and its rows and reports what they show, not what the transform call returned.'),
        handler: wrap(async (argv, app) => {
          const id = argv.import_set || '';
          if (!/^[a-zA-Z0-9]+$/.test(id)) throw errUsage('The import set must be its number (ISET0010001) or its 32-hex sys_id.');
          if (!Number.isSafeInteger(argv.limit) || argv.limit < 1) throw errUsage('--limit must be a positive safe integer.');
          const before = await readImportSet(app.sdk, id, argv.limit);
          checkTransformable(before, argv.limit);
          const { set } = before;
          const maps = await activeTransformMaps(app.sdk, set.table_name);
          if (!maps.length) throw errUsage(`No active transform map for ${set.table_name} is visible to this identity (none exists, or sys_transform_map is ACL-hidden). Nothing transformed.`);
          if (!argv.yes) {
            const rerun = ['jsn', 'import', 'transform', set.number, '--limit', String(argv.limit), '--yes'].map(quoteShellArg).join(' ');
            return app.ok({ dry_run: true, import_set: set.number, sys_id: set.sys_id, staging_table: set.table_name, state: set.state,
              rows: before.rows.length, transform_maps: maps, rerun }, {
              summary: `Dry run: ${before.rows.length} row(s) of ${set.number} would be transformed through ${maps.length} transform map(s); nothing run`,
              breadcrumbs: [{ action: 'transform', cmd: rerun, description: 'Run the transform' }],
            });
          }
          const transformError = await transformImportSet(app.sdk, set);
          const after = await readImportSet(app.sdk, set.sys_id, argv.limit).catch(error => {
            throw errUsage(`The transform ran, but ${set.number} could not be read back (${error.message}); inspect its rows before retrying.`);
          });
          const data = transformResult(after.set, after.rows, transformError);
          Object.defineProperty(data, '_formatted', { value: formatLoad({ ...data, import_sets: [data.import_set], not_sent: 0 }), enumerable: false });
          const counts = Object.entries(data.counts).map(([status, n]) => `${n} ${status}`).join(', ');
          const problems = [transformError && 'the transformer reported an error', data.state !== 'processed' && `the set is ${data.state}, not processed`,
            after.rows.length !== before.rows.length && `${after.rows.length} of ${before.rows.length} row(s) read back`,
            data.failed && `${data.failed} row(s) failed`].filter(Boolean);
          app.ok(data, {
            summary: problems.length ? `Import transform had errors: ${problems.join('; ')} (${counts})` : `Transformed ${data.import_set}: ${data.total} row(s), ${counts}`,
            breadcrumbs: [{ action: 'rows', cmd: `jsn records list --table sys_import_set_row --query "sys_import_set=${data.sys_id}"`, description: `Rows of ${data.import_set}` }],
          });
          if (problems.length) process.exitCode = 1;
        }),
      }),
  };
}
