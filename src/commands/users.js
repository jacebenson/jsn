import { formatRecordForDisplay, getStringField, interactiveList, resolveFieldsParam } from '../helpers.js';

export function usersCmd(wrap) {
  return {
    command: 'users [subcommand]',
    aliases: ['user'],
    describe: 'Manage ServiceNow users',
    builder: (yargs) => {
      return yargs
        .command({
          command: 'list',
          aliases: ['ls'],
          describe: 'List users',
          builder: (y) => y
            .option('query', { type: 'string', describe: 'Encoded query (e.g. "nameLIKEincident" or "active=true")' })
            .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns (e.g. "number,short_description")' })
            .option('limit', { alias: 'l', type: 'number', default: 20, describe: 'Max records' }),
          handler: wrap(async (argv, app) => {
            const columns = argv.columns ? argv.columns.split(',') : ['user_name', 'name', 'email', 'active'];
            const query = argv.query || '';

            const picked = await interactiveList({
              app, table: 'sys_user', singular: 'user', columns, limit: argv.limit, query, labelField: 'user_name',
              formatLabel: r => `${getStringField(r, 'user_name')} (${getStringField(r, 'name') || '-'})`,
            });
            if (picked) {
              picked._context = { instance_url: app.getEffectiveInstance(), table: 'sys_user' };
              return app.ok(picked, { summary: `User: ${getStringField(picked, 'user_name')}` });
            }

            const params = new URLSearchParams();
            params.set('sysparm_limit', String(argv.limit));
            params.set('sysparm_display_value', 'all');
            const fields = resolveFieldsParam(columns);
            if (fields) params.set('sysparm_fields', fields);
            if (argv.query) params.set('sysparm_query', argv.query);
            const records = await app.sdk.list('sys_user', params);
            app.ok({
              table: 'sys_user',
              count: records.length,
              columns,
              records: fields ? records.map(r => formatRecordForDisplay(r, columns)) : records,
              context: { instance_url: app.getEffectiveInstance() },
            }, { summary: `${records.length} user(s)` });
          }),
        })
        .command({
          command: 'show <identifier>',
          aliases: ['get'],
          describe: 'Show a user by user_name or sys_id',
          handler: wrap(async (argv, app) => {
            const id = argv.identifier;
            const isSysID = id.length === 32 && /^[0-9a-fA-F]+$/.test(id);
            const params = new URLSearchParams();
            params.set('sysparm_query', isSysID ? `sys_id=${id}` : `user_name=${id}`);
            params.set('sysparm_limit', '1');
            params.set('sysparm_display_value', 'all');
            const records = await app.sdk.list('sys_user', params);
            if (records.length === 0) {
              throw new Error(`User not found: ${id}`);
            }
            app.ok(records[0], { summary: `User ${id}` });
          }),
        })
        .command({
          command: 'create',
          describe: 'Create a new user',
          builder: (y) => y
            .option('username', { alias: 'u', type: 'string', describe: 'Username (e.g. john.doe)' })
            .option('name', { alias: 'n', type: 'string', describe: 'Full name (e.g. John Doe)' })
            .option('email', { alias: 'e', type: 'string', describe: 'Email address' })
            .option('data', { type: 'string', describe: 'JSON data for additional fields' }),
          handler: wrap(async (argv, app) => {
            const recordData = {};
            if (argv.data) {
              Object.assign(recordData, JSON.parse(argv.data));
            }
            if (argv.username) recordData.user_name = argv.username;
            if (argv.name) recordData.name = argv.name;
            if (argv.email) recordData.email = argv.email;
            if (!recordData.user_name) {
              throw new Error('user_name is required (use --username or --data)');
            }
            const record = await app.sdk.create('sys_user', recordData);
            app.ok(record, {
              summary: `Created user ${getStringField(record, 'user_name')}`,
              breadcrumbs: [
                { action: 'view', cmd: `jsn users show ${getStringField(record, 'user_name')}`, description: `View the new user` },
              ],
            });
          }),
        })
        .command({
          command: 'update <identifier>',
          describe: 'Update a user by user_name or sys_id',
          builder: (y) => y
            .option('data', { type: 'string', demandOption: true, describe: 'JSON data to update' }),
          handler: wrap(async (argv, app) => {
            const id = argv.identifier;
            const recordData = JSON.parse(argv.data);
            const isSysID = id.length === 32 && /^[0-9a-fA-F]+$/.test(id);
            const params = new URLSearchParams();
            params.set('sysparm_query', isSysID ? `sys_id=${id}` : `user_name=${id}`);
            params.set('sysparm_limit', '1');
            params.set('sysparm_display_value', 'all');
            params.set('sysparm_fields', 'sys_id');
            const records = await app.sdk.list('sys_user', params);
            if (records.length === 0) {
              throw new Error(`User not found: ${id}`);
            }
            const sysID = getStringField(records[0], 'sys_id');
            const updated = await app.sdk.update('sys_user', sysID, recordData);
            app.ok(updated, {
              summary: `Updated user ${id}`,
              breadcrumbs: [
                { action: 'view', cmd: `jsn users show ${id}`, description: `View the updated user` },
              ],
            });
          }),
        })
        .command({
          command: 'delete <identifier>',
          describe: 'Delete a user by user_name or sys_id',
          handler: wrap(async (argv, app) => {
            const id = argv.identifier;
            const isSysID = id.length === 32 && /^[0-9a-fA-F]+$/.test(id);
            const params = new URLSearchParams();
            params.set('sysparm_query', isSysID ? `sys_id=${id}` : `user_name=${id}`);
            params.set('sysparm_limit', '1');
            params.set('sysparm_fields', 'sys_id');
            const records = await app.sdk.list('sys_user', params);
            if (records.length === 0) {
              throw new Error(`User not found: ${id}`);
            }
            const sysID = getStringField(records[0], 'sys_id');
            await app.sdk.delete('sys_user', sysID);
            app.ok({ identifier: id, message: 'User deleted' }, {
              summary: `Deleted user ${id}`,
            });
          }),
        });
    },
    handler: () => {},
  };
}
