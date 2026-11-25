import { buildDevCmd } from './_generic.js';
import { getStringField } from '../helpers.js';
import { errUsage } from '../errors.js';
import { declareCapabilities } from '../capabilities.js';
import { readImportFile, checkStagingTable, loadImportRows, loadRerun, formatLoad } from '../import-sets.js';

export const importCmd = (wrap) => withWrites(buildDevCmd('import', 'sys_import_set', ['imports', 'imp'],
  ['name', 'sys_target_table', 'state', 'sys_created_on'], wrap, {
    singular: 'import set',
    readOnly: true,
    extraSubcommands: [{ name: 'load', description: 'Load rows into a staging table and transform them' }],
    formatLabel: (r) => {
      const name = getStringField(r, 'name') || '';
      const table = getStringField(r, 'sys_target_table') || '';
      return table ? `${name} [${table}]` : name;
    },
    onShow: async (record, app) => {
      const sysID = getStringField(record, 'sys_id') || '';
      if (!sysID) return;
      try {
        const rp = new URLSearchParams();
        rp.set('sysparm_query', `sys_import_set=${sysID}`);
        rp.set('sysparm_limit', '0'); rp.set('sysparm_fields', 'sys_id');
        const rows = await app.sdk.list('sys_import_set_row', rp);
        console.log(`  Import rows: ${rows.length}`);
        console.log(`    → jsn records list --table sys_import_set_row --query "sys_import_set=${sysID}" --limit 200`);
      } catch {
        console.log(`  Import rows: (unavailable)`);
      }
    },
  }), wrap);

function withWrites(base, wrap) {
  // Loaded rows and transformed targets are data, not customizations.
  declareCapabilities('import', { mutationContext: 'operational', queryTable: 'sys_import_set', mutationSubcommands: ['load'] });
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
      }),
  };
}
