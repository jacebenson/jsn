// Generic command builder for CRUD operations on a ServiceNow table
// Used by incidents, changes, requests, tasks, and most dev subcommands

import { getStringField, formatRecordForDisplay, buildQuerySuffix, resolveFieldsParam, confirmDelete, interactiveList } from '../helpers.js';
import { resolveRecord, resolveSysId } from '../resolve-record.js';
import { FormatAuto } from '../output.js';
import { declareCapabilities } from '../capabilities.js';

export function buildTicketCommands(table, displayName, alias, defaultColumns, stateMap, iconFn, wrap) {
  // Ticket-style CRUD: list/show are reads; create/update/delete mutate.
  // Root-level only (no `jsn dev` spelling).
  declareCapabilities(displayName, { mutationSubcommands: ['create', 'update', 'delete'] });
  return {
    command: `${displayName} [subcommand]`,
    aliases: [table, alias],
    describe: `Manage ${displayName} (e.g. "${displayName} list --query priority=1")`,
    builder: (yargs) => {
      return yargs
        .command({
          command: 'list',
          aliases: ['ls'],
          describe: `List ${table}`,
          builder: (y) => y
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
            if (app.output.getFormat() === FormatAuto && !query && offset === 0) {
              const picked = await interactiveList({
                app, table, singular: displayName.slice(0, -1), columns: defaultColumns, limit,
                labelField: 'number',
                formatLabel: (r) => {
                  let label = `${getStringField(r, 'number')} ${getStringField(r, 'short_description')} | ${getStringField(r, 'state')}`;
                  const assigned = getStringField(r, 'assigned_to');
                  if (assigned) label += ` → ${assigned}`;
                  return label;
                },
              });
              if (picked === undefined || picked === null) return; // cancelled or non-interactive

              const record = picked;
              const number = getStringField(record, 'number');
              record._context = {
                instance_url: app.getEffectiveInstance(),
                table,
              };
              app.ok(record, {
                summary: `${displayName.charAt(0).toUpperCase() + displayName.slice(1)} ${number}`,
                breadcrumbs: [
                  { action: 'update', cmd: `jsn ${alias} update ${number} --data '{...}'`, description: `Update this ${displayName}` },
                  { action: 'list', cmd: `jsn ${alias} list`, description: `Back to all ${table}` },
                ],
              });
              return;
            }

            const params = new URLSearchParams();
            params.set('sysparm_limit', String(limit));
            params.set('sysparm_offset', String(offset));
            params.set('sysparm_display_value', 'all');
            const fields = resolveFieldsParam(columns);
            if (fields) params.set('sysparm_fields', fields);
            const q = query ? query + '^ORDERBYDESCsys_updated_on' : 'ORDERBYDESCsys_updated_on';
            params.set('sysparm_query', q);

            const records = await app.sdk.list(table, params);
            const displayRecords = fields ? records.map(r => formatRecordForDisplay(r, columns)) : records;

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
          handler: wrap(async (argv, app) => {
            const number = argv.number;
            const record = await resolveRecord(app.sdk, { table, identifier: number, matchField: 'number', resource: displayName });
            record._context = {
              instance_url: app.getEffectiveInstance(),
              table,
            };
            app.ok(record, {
              summary: `${displayName.charAt(0).toUpperCase() + displayName.slice(1)} ${number}`,
              breadcrumbs: [
                { action: 'update', cmd: `jsn ${alias} update ${number} --data '{...}'`, description: `Update this ${displayName}` },
                { action: 'list', cmd: `jsn ${alias} list`, description: `Back to all ${table}` },
              ],
            });
          }),
        })
        .command({
          command: 'create',
          describe: `Create a new ${displayName}`,
          builder: (y) => y
            .option('description', { alias: 'd', type: 'string', describe: 'Short description' })
            .option('priority', { type: 'string', describe: 'Priority (1-5)' })
            .option('data', { type: 'string', describe: 'JSON data for additional fields' }),
          handler: wrap(async (argv, app) => {
            const recordData = {};
            if (argv.data) {
              Object.assign(recordData, JSON.parse(argv.data));
            }
            if (argv.description) recordData.short_description = argv.description;
            if (argv.priority) recordData.priority = argv.priority;
            if (!recordData.short_description) {
              throw new Error('short_description is required (use --description or --data)');
            }
            const record = await app.sdk.create(table, recordData);
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
          builder: (y) => y
            .option('data', { type: 'string', demandOption: true, describe: 'JSON data to update' }),
          handler: wrap(async (argv, app) => {
            const number = argv.number;
            const recordData = JSON.parse(argv.data);
            const sysID = await resolveSysId(app.sdk, { table, identifier: number, matchField: 'number', resource: displayName });
            const updated = await app.sdk.update(table, sysID, recordData);
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
          builder: (y) => y.option('force', { type: 'boolean', default: false, describe: 'Skip confirmation' }),
          handler: wrap(async (argv, app) => {
            const number = argv.number;
            await confirmDelete(app, argv, `Delete ${displayName} ${number}`);
            const sysID = await resolveSysId(app.sdk, { table, identifier: number, matchField: 'number', resource: displayName });
            await app.sdk.delete(table, sysID);
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
