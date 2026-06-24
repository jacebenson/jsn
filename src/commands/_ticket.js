// Generic command builder for CRUD operations on a ServiceNow table
// Used by incidents, changes, requests, tasks, and most dev subcommands

import { getStringField, formatRecordForDisplay, buildQuerySuffix, resolveFieldsParam } from '../helpers.js';
import search from '@inquirer/search';
import { isTTY, FormatAuto } from '../output.js';

export function buildTicketCommands(table, displayName, alias, defaultColumns, stateMap, iconFn, wrap) {
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
            const isInteractive = isTTY(process.stdout) && isTTY(process.stdin);
            if (isInteractive && app.output.getFormat() === FormatAuto && !query && offset === 0) {
              const pickerColumns = ['sys_id', 'number', 'short_description', 'state', 'assigned_to'];
              const pickerParams = new URLSearchParams();
              pickerParams.set('sysparm_limit', String(limit));
              pickerParams.set('sysparm_offset', '0');
              pickerParams.set('sysparm_display_value', 'all');
              pickerParams.set('sysparm_fields', pickerColumns.join(','));
              pickerParams.set('sysparm_query', 'ORDERBYDESCsys_updated_on');

              const pickerRecords = await app.sdk.list(table, pickerParams);
              if (pickerRecords.length === 0) {
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

              const choices = pickerRecords.map((record) => {
                const number = getStringField(record, 'number');
                const desc = getStringField(record, 'short_description');
                const state = getStringField(record, 'state');
                const assigned = getStringField(record, 'assigned_to');
                let label = `${number} ${desc} | ${state}`;
                if (assigned) {
                  label += ` → ${assigned}`;
                }
                return { name: label, value: number };
              });

              let selectedNumber;
              try {
                selectedNumber = await search({
                  message: `Select a ${displayName.slice(0, -1)}:`,
                  source: async (input) => {
                    if (!input) return choices;
                    const term = input.toLowerCase();
                    return choices.filter(c => c.name.toLowerCase().includes(term));
                  },
                });
              } catch (err) {
                if (err.name === 'ExitPromptError' || (err.message && err.message.includes('force closed'))) {
                  return;
                }
                throw err;
              }

              if (selectedNumber) {
                const showParams = new URLSearchParams();
                showParams.set('sysparm_query', `number=${selectedNumber}`);
                showParams.set('sysparm_display_value', 'all');
                showParams.set('sysparm_limit', '1');
                const showRecords = await app.sdk.list(table, showParams);
                if (showRecords.length === 0) {
                  throw new Error(`${displayName} not found: ${selectedNumber}`);
                }
                const record = showRecords[0];
                record._context = {
                  instance_url: app.getEffectiveInstance(),
                  table,
                };
                app.ok(record, {
                  summary: `${displayName.charAt(0).toUpperCase() + displayName.slice(1)} ${selectedNumber}`,
                  breadcrumbs: [
                    { action: 'update', cmd: `jsn ${alias} update ${selectedNumber} --data '{...}'`, description: `Update this ${displayName}` },
                    { action: 'list', cmd: `jsn ${alias} list`, description: `Back to all ${table}` },
                  ],
                });
              }
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
            const params = new URLSearchParams();
            params.set('sysparm_query', `number=${number}`);
            params.set('sysparm_display_value', 'all');
            params.set('sysparm_limit', '1');
            const records = await app.sdk.list(table, params);
            if (records.length === 0) {
              throw new Error(`${displayName} not found: ${number}`);
            }
            const record = records[0];
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
            const findParams = new URLSearchParams();
            findParams.set('sysparm_query', `number=${number}`);
            findParams.set('sysparm_limit', '1');
            const records = await app.sdk.list(table, findParams);
            if (records.length === 0) {
              throw new Error(`${displayName} not found: ${number}`);
            }
            const sysID = getStringField(records[0], 'sys_id');
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
          handler: wrap(async (argv, app) => {
            const number = argv.number;
            const findParams = new URLSearchParams();
            findParams.set('sysparm_query', `number=${number}`);
            findParams.set('sysparm_limit', '1');
            const records = await app.sdk.list(table, findParams);
            if (records.length === 0) {
              throw new Error(`${displayName} not found: ${number}`);
            }
            const sysID = getStringField(records[0], 'sys_id');
            await app.sdk.delete(table, sysID);
            app.ok({ number, message: `${displayName.charAt(0).toUpperCase() + displayName.slice(1)} deleted` }, {
              summary: `Deleted ${displayName} ${number}`,
            });
          }),
        })

    },
    handler: () => {}, // Handled by subcommands
  };
}
