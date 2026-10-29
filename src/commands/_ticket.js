// Generic command builder for CRUD operations on a ServiceNow table
// Used by incidents, changes, requests, tasks, and most dev subcommands

import { getStringField, formatRecordForDisplay, buildQuerySuffix, resolveFieldsParam, confirmDelete, interactiveList, canPrompt, buildRecordPayload } from '../helpers.js';
import { getRecord, listRecords, recordListParams, createRecord, updateRecord, deleteRecord, recordOptions } from '../records-engine.js';
import { resolveSysId } from '../resolve-record.js';
import { FormatAuto } from '../output.js';
import { declareCapabilities } from '../capabilities.js';

export function buildTicketCommands(table, displayName, alias, defaultColumns, stateMap, iconFn, wrap, opts = {}) {
  // Ticket-style CRUD: list/show are reads; create/update/delete mutate.
  // Root-level command only.
  declareCapabilities(displayName, { mutationSubcommands: ['create', 'update', 'delete'] });
  return {
    command: `${displayName} [subcommand]`,
    aliases: [table, alias],
    describe: `Manage ${displayName} (e.g. "${displayName} list --query priority=1")`,
    discovery: { table, defaultColumns, benefits: ['Configured list columns', 'Ticket-specific create/update flags'] },
    builder: (yargs) => {
      return yargs
        .command({
          command: 'list',
          aliases: ['ls'],
          describe: `List ${table}`,
          builder: (y) => recordOptions(y)
            .option('query', { type: 'string', describe: 'Encoded query (e.g. "nameLIKEincident" or "active=true")' })
            .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns (e.g. "number,short_description")' })
            .option('limit', { alias: 'l', type: 'number', default: 20, describe: 'Max records' })
            .option('offset', { alias: 'o', type: 'number', default: 0, describe: 'Offset for pagination' }),
          handler: wrap(async (argv, app) => {
            const query = argv.query || '';
            const columns = argv.columns ? argv.columns.split(',') : defaultColumns;
            const limit = argv.limit;
            const offset = argv.offset;

            // Interactive picker in TTY with auto format and no explicit query/offset
            if (canPrompt() && app.output.getFormat() === FormatAuto && !query && offset === 0) {
              const pickerColumns = ['sys_id', 'number', 'short_description', 'state', 'assigned_to'];
              const picked = await interactiveList({
                app, table, singular: displayName.slice(0, -1), columns: pickerColumns, limit,
                labelField: 'number',
                formatLabel: (r) => {
                  let label = `${getStringField(r, 'number')} ${getStringField(r, 'short_description')} | ${getStringField(r, 'state')}`;
                  const assigned = getStringField(r, 'assigned_to');
                  if (assigned) label += ` → ${assigned}`;
                  return label;
                },
                formatValue: (r) => r,
              });
              if (picked === undefined) return; // user cancelled
              if (picked === null) {
                // canPrompt() passed, so null means the table is empty.
                app.ok({
                  table,
                  count: 0,
                  columns: pickerColumns,
                  records: [],
                  pagination: { limit, offset: 0 },
                  context: { instance_url: app.getEffectiveInstance() },
                }, {
                  summary: `0 ${table}(s)`,
                  breadcrumbs: [
                    { action: 'create', cmd: `jsn ${alias} create --description "..."`, description: `Create a new ${displayName}` },
                  ],
                });
                return;
              }

              const record = picked;
              const number = getStringField(record, 'number');
              record._context = {
                instance_url: app.getEffectiveInstance(),
                table,
              };
              app.ok(record, {
                summary: `${displayName.charAt(0).toUpperCase() + displayName.slice(1)} ${number}`,
                breadcrumbs: [
                  { action: 'update', cmd: `jsn ${alias} update ${number} -f state=2`, description: `Update this ${displayName}` },
                  { action: 'list', cmd: `jsn ${alias} list`, description: `Back to all ${table}` },
                ],
              });
              return;
            }

            const fields = resolveFieldsParam(columns);
            const q = query ? query + '^ORDERBYDESCsys_updated_on' : 'ORDERBYDESCsys_updated_on';
            const params = recordListParams({ limit, offset, fields, query: q });

            const records = await listRecords(app.sdk, { table, params, displayValues: argv.displayValues ?? opts.referenceMode });
            const displayRecords = fields && !argv.displayValues && opts.listProjection !== 'full' ? records.map(r => formatRecordForDisplay(r, columns)) : records;

            const breadcrumbs = [
              { action: 'create', cmd: `jsn ${alias} create --description "..."`, description: `Create a new ${displayName}` },
              { action: 'filter', cmd: `jsn ${alias} list --query "priority=1"`, description: 'Filter: critical only' },
            ];

            if (records.length === limit) {
              breadcrumbs.push({
                action: 'next',
                cmd: `jsn ${alias} list --limit ${limit} --offset ${offset + limit}${buildQuerySuffix(query)}`,
                description: `Next page (offset ${offset + limit})`,
              });
            }
            if (offset > 0) {
              breadcrumbs.push({
                action: 'prev',
                cmd: `jsn ${alias} list --limit ${limit} --offset ${Math.max(0, offset - limit)}${buildQuerySuffix(query)}`,
                description: 'Previous page',
              });
            }

            app.ok({
              table,
              count: records.length,
              columns,
              records: displayRecords,
              pagination: { limit, offset },
              context: { instance_url: app.getEffectiveInstance() },
            }, {
              summary: `${records.length} ${table}(s)`,
              breadcrumbs,
            });
          }),
        })
        .command({
          command: 'show <number>',
          aliases: ['get'],
          describe: `Show a specific ${displayName}`,
          builder: y => recordOptions(y),
          handler: wrap(async (argv, app) => {
            const number = argv.number;
            const record = await getRecord(app.sdk, { table, identifier: number, identifierField: argv.identifierField, displayValues: argv.displayValues ?? opts.referenceMode, matchField: opts.identifierField || 'number', resource: displayName });
            record._context = {
              instance_url: app.getEffectiveInstance(),
              table,
            };
            app.ok(record, {
              summary: `${displayName.charAt(0).toUpperCase() + displayName.slice(1)} ${number}`,
              breadcrumbs: [
                { action: 'update', cmd: `jsn ${alias} update ${number} -f state=2`, description: `Update this ${displayName}` },
                { action: 'list', cmd: `jsn ${alias} list`, description: `Back to all ${table}` },
              ],
            });
          }),
        })
        .command({
          command: 'create',
          describe: `Create a new ${displayName}`,
          builder: (y) => recordOptions(y, false)
            .option('description', { alias: 'd', type: 'string', describe: 'Short description' })
            .option('priority', { type: 'string', describe: 'Priority (1-5)' })
            .option('data', { type: 'string', describe: 'JSON data for additional fields' })
            .option('data-file', { type: 'string', describe: 'Read JSON payload from file' })
            .option('data-stdin', { type: 'boolean', describe: 'Read JSON payload from stdin' })
            .option('field', { alias: 'f', type: 'string', array: true, describe: 'Set a field as name=value; repeatable' }),
          handler: wrap(async (argv, app) => {
            const recordData = buildRecordPayload(argv, { required: false });
            if (argv.description) recordData.short_description = argv.description;
            if (argv.priority) recordData.priority = argv.priority;
            if (!recordData.short_description) {
              throw new Error('short_description is required (use --description, -f short_description=..., or --data)');
            }
            const record = await createRecord(app.sdk, { table, data: recordData });
            app.ok(record, {
              summary: `Created ${displayName} ${getStringField(record, 'number')}`,
              breadcrumbs: [
                { action: 'view', cmd: `jsn ${alias} show ${getStringField(record, 'number')}`, description: `View the new ${displayName}` },
              ],
            });
          }),
        })
        .command({
          command: 'update <number>',
          describe: `Update a ${displayName}`,
          builder: (y) => recordOptions(y, false)
            .option('data', { type: 'string', describe: 'JSON data to update' })
            .option('data-file', { type: 'string', describe: 'Read JSON payload from file' })
            .option('data-stdin', { type: 'boolean', describe: 'Read JSON payload from stdin' })
            .option('field', { alias: 'f', type: 'string', array: true, describe: 'Set a field as name=value; repeatable' }),
          handler: wrap(async (argv, app) => {
            const number = argv.number;
            const recordData = buildRecordPayload(argv);
            const sysID = await resolveSysId(app.sdk, { table, identifier: number, identifierField: argv.identifierField, displayValues: argv.displayValues ?? opts.referenceMode, matchField: opts.identifierField || 'number', resource: displayName });
            const updated = await updateRecord(app.sdk, { table, record: { sys_id: sysID }, data: recordData });
            app.ok(updated, {
              summary: `Updated ${displayName} ${number}`,
              breadcrumbs: [
                { action: 'view', cmd: `jsn ${alias} show ${number}`, description: `View the updated ${displayName}` },
              ],
            });
          }),
        })
        .command({
          command: 'delete <number>',
          describe: `Delete a ${displayName}`,
          builder: (y) => recordOptions(y, false).option('force', { type: 'boolean', default: false, describe: 'Skip confirmation' }),
          handler: wrap(async (argv, app) => {
            const number = argv.number;
            await confirmDelete(app, argv, `Delete ${displayName} ${number}`);
            const sysID = await resolveSysId(app.sdk, { table, identifier: number, identifierField: argv.identifierField, displayValues: argv.displayValues ?? opts.referenceMode, matchField: opts.identifierField || 'number', resource: displayName });
            await deleteRecord(app.sdk, { table, record: { sys_id: sysID } });
            app.ok({ number, message: `${displayName.charAt(0).toUpperCase() + displayName.slice(1)} deleted` }, {
              summary: `Deleted ${displayName} ${number}`,
            });
          }),
        })

    },
    handler: () => {
      const singular = displayName.endsWith('s') ? displayName.slice(0, -1) : displayName;
      const article = singular.startsWith('a') || singular.startsWith('e') || singular.startsWith('i') || singular.startsWith('o') || singular.startsWith('u') ? 'an' : 'a';
      console.log(`Manage ${displayName} from the ${table} table.`);
      console.log('');
      console.log('Available subcommands:');
      console.log(`  list                  List ${displayName}`);
      console.log(`  show <number or sys_id>  Show ${article} ${singular} by number or sys_id`);
      console.log(`  create                Create ${article} ${singular}`);
      console.log(`  update <identifier>   Update ${article} ${singular}`);
      console.log(`  delete <identifier>   Delete ${article} ${singular}`);
      console.log('');
      console.log(`Run "jsn ${displayName} <command> --help" for details.`);
    }, // Default handler
  };
}
