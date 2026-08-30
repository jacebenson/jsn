import { getStringField, formatRecordForDisplay, interactiveList } from '../../helpers.js';
import { resolveRecord } from '../../resolve-record.js';
import { inspectDecisionTable } from '../../decision-table-inspection.js';
import { declareCapabilities } from '../../capabilities.js';

export const decisiontablesCmd = (wrap) => {
  const name = 'decisiontables';
  const singular = 'decision table';
  declareCapabilities(name, { mutationSubcommands: [], devAlias: false });
  return {
    command: `${name} [subcommand]`,
    aliases: ['decisiontable'],
    describe: 'Read decision tables',
    builder: (yargs) => yargs
      .command({
        command: 'list', aliases: ['ls'], describe: 'List decision tables',
        builder: (y) => y.option('query', { type: 'string', describe: 'Encoded query (e.g. nameLIKEapproval)' })
          .option('limit', { alias: 'l', type: 'number', default: 50, describe: 'Max records' }),
        handler: wrap(async (argv, app) => {
          app.requireInstance();

          const picked = await interactiveList({
            app,
            table: 'sys_decision',
            singular,
            columns: ['name', 'sys_scope'],
            limit: argv.limit,
            query: argv.query || '',
            labelField: 'name',
            message: 'Select a decision table',
            formatLabel: (record) => {
              const recordName = getStringField(record, 'name') || getStringField(record, 'sys_id');
              const scope = getStringField(record, 'sys_scope') || '';
              return (scope && scope.toLowerCase() !== 'global') ? `${recordName} [${scope}]` : recordName;
            },
            promptFn: app.promptFn,
          });
          if (picked === undefined) return;
          if (picked !== null && picked !== undefined) {
            const detail = await inspectDecisionTable(app, picked);
            detail._context = { instance_url: app.getEffectiveInstance(), table: 'sys_decision' };
            app.ok(detail, { summary: `Decision table: ${getStringField(picked, 'name') || getStringField(picked, 'sys_id')}` });
            return;
          }

          const params = new URLSearchParams({
            sysparm_query: argv.query || 'ORDERBYDESCsys_updated_on',
            sysparm_limit: String(argv.limit),
            sysparm_display_value: 'all',
            sysparm_fields: 'sys_id,name,description,active,sys_scope,sys_updated_on',
          });
          const records = await app.sdk.list('sys_decision', params);
          app.ok({ table: 'sys_decision', count: records.length, columns: ['name', 'active', 'sys_scope'], records: records.map((record) => formatRecordForDisplay(record, ['name', 'active', 'sys_scope'])) }, { summary: `${records.length} decision table(s)` });
        }),
      })
      .command({
        command: 'show <identifier>', aliases: ['get'], describe: 'Show a decision table matrix',
        handler: wrap(async (argv, app) => {
          app.requireInstance();
          const table = await resolveRecord(app.sdk, { table: 'sys_decision', identifier: argv.identifier, matchField: 'name', resource: singular });
          const detail = await inspectDecisionTable(app, table);
          detail._context = { instance_url: app.getEffectiveInstance(), table: 'sys_decision' };
          app.ok(detail, { summary: `Decision table: ${getStringField(table, 'name') || argv.identifier}` });
        }),
      }),
    handler: wrap((_argv, app) => {
      app.ok({
        command: name,
        guidance: [`jsn ${name} list`, `jsn ${name} show <name_or_sys_id>`],
      }, { summary: 'Decision tables: choose list or show' });
    }),
  };
};

// Kept as a named export for direct consumers and focused tests.
export { inspectDecisionTable };
