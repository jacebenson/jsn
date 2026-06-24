import { formatRecordForDisplay, getStringField, interactiveList, resolveFieldsParam } from '../helpers.js';

export function groupsCmd(wrap) {
  return {
    command: 'groups [subcommand]',
    aliases: ['group'],
    describe: 'Manage ServiceNow groups',
    builder: (yargs) => {
      return yargs
        .command({
          command: 'list',
          aliases: ['ls'],
          describe: 'List groups',
          builder: (y) => y
            .option('query', { type: 'string', describe: 'Encoded query (e.g. "nameLIKEincident" or "active=true")' })
            .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns (e.g. "number,short_description")' })
            .option('limit', { alias: 'l', type: 'number', default: 20, describe: 'Max records' }),
          handler: wrap(async (argv, app) => {
            const columns = argv.columns ? argv.columns.split(',') : ['name', 'manager', 'email'];
            const query = argv.query || '';

            const picked = await interactiveList({
              app, table: 'sys_user_group', singular: 'group', columns, limit: argv.limit, query, labelField: 'name',
              formatLabel: r => `${getStringField(r, 'name')} ${getStringField(r, 'manager') ? '→ ' + getStringField(r, 'manager') : ''}`,
            });
            if (picked) {
              picked._context = { instance_url: app.getEffectiveInstance(), table: 'sys_user_group' };
              return app.ok(picked, { summary: `Group: ${getStringField(picked, 'name')}` });
            }

            const params = new URLSearchParams();
            params.set('sysparm_limit', String(argv.limit));
            params.set('sysparm_display_value', 'all');
            const fields = resolveFieldsParam(columns);
            if (fields) params.set('sysparm_fields', fields);
            if (argv.query) params.set('sysparm_query', argv.query);
            const records = await app.sdk.list('sys_user_group', params);
            app.ok({
              table: 'sys_user_group',
              count: records.length,
              columns,
              records: fields ? records.map(r => formatRecordForDisplay(r, columns)) : records,
              context: { instance_url: app.getEffectiveInstance() },
            }, { summary: `${records.length} group(s)` });
          }),
        })
        .command({
          command: 'show <name>',
          aliases: ['get'],
          describe: 'Show a group by name or sys_id',
          handler: wrap(async (argv, app) => {
            const id = argv.name;
            const isSysID = id.length === 32 && /^[0-9a-fA-F]+$/.test(id);
            const params = new URLSearchParams();
            params.set('sysparm_query', isSysID ? `sys_id=${id}` : `name=${id}`);
            params.set('sysparm_limit', '1');
            params.set('sysparm_display_value', 'all');
            const records = await app.sdk.list('sys_user_group', params);
            if (records.length === 0) {
              throw new Error(`Group not found: ${id}`);
            }
            app.ok(records[0], { summary: `Group ${id}` });
          }),
        })
        .command({
          command: 'create',
          describe: 'Create a new group',
          builder: (y) => y
            .option('name', { alias: 'n', type: 'string', describe: 'Group name' })
            .option('manager', { type: 'string', describe: 'Manager name or sys_id' })
            .option('data', { type: 'string', describe: 'JSON data for additional fields' }),
          handler: wrap(async (argv, app) => {
            const recordData = {};
            if (argv.data) {
              Object.assign(recordData, JSON.parse(argv.data));
            }
            if (argv.name) recordData.name = argv.name;
            if (argv.manager) recordData.manager = argv.manager;
            if (!recordData.name) {
              throw new Error('name is required (use --name or --data)');
            }
            const record = await app.sdk.create('sys_user_group', recordData);
            app.ok(record, {
              summary: `Created group ${getStringField(record, 'name')}`,
              breadcrumbs: [
                { action: 'view', cmd: `jsn groups show ${getStringField(record, 'name')}`, description: `View the new group` },
              ],
            });
          }),
        })
        .command({
          command: 'update <name>',
          describe: 'Update a group by name or sys_id',
          builder: (y) => y
            .option('data', { type: 'string', demandOption: true, describe: 'JSON data to update' }),
          handler: wrap(async (argv, app) => {
            const id = argv.name;
            const recordData = JSON.parse(argv.data);
            const isSysID = id.length === 32 && /^[0-9a-fA-F]+$/.test(id);
            const params = new URLSearchParams();
            params.set('sysparm_query', isSysID ? `sys_id=${id}` : `name=${id}`);
            params.set('sysparm_limit', '1');
            params.set('sysparm_fields', 'sys_id');
            const records = await app.sdk.list('sys_user_group', params);
            if (records.length === 0) {
              throw new Error(`Group not found: ${id}`);
            }
            const sysID = getStringField(records[0], 'sys_id');
            const updated = await app.sdk.update('sys_user_group', sysID, recordData);
            app.ok(updated, {
              summary: `Updated group ${id}`,
              breadcrumbs: [
                { action: 'view', cmd: `jsn groups show ${id}`, description: `View the updated group` },
              ],
            });
          }),
        })
        .command({
          command: 'delete <name>',
          describe: 'Delete a group by name or sys_id',
          handler: wrap(async (argv, app) => {
            const id = argv.name;
            const isSysID = id.length === 32 && /^[0-9a-fA-F]+$/.test(id);
            const params = new URLSearchParams();
            params.set('sysparm_query', isSysID ? `sys_id=${id}` : `name=${id}`);
            params.set('sysparm_limit', '1');
            params.set('sysparm_fields', 'sys_id');
            const records = await app.sdk.list('sys_user_group', params);
            if (records.length === 0) {
              throw new Error(`Group not found: ${id}`);
            }
            const sysID = getStringField(records[0], 'sys_id');
            await app.sdk.delete('sys_user_group', sysID);
            app.ok({ identifier: id, message: 'Group deleted' }, {
              summary: `Deleted group ${id}`,
            });
          }),
        });
    },
    handler: () => {},
  };
}
