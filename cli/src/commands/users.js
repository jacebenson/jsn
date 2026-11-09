import { formatRecordForDisplay, getStringField, interactiveList, resolveFieldsParam, buildRecordPayload } from '../helpers.js';
import { resolveRecord, resolveSysId } from '../resolve-record.js';
import { declareCapabilities } from '../capabilities.js';
import { AppError } from '../errors.js';

declareCapabilities('users', { mutationSubcommands: ['create', 'update', 'delete'] });

const PASSWORD_FIELDS = ['user_password', 'password'];

function hasPasswordPayload(recordData) {
  return PASSWORD_FIELDS.some(field => Object.hasOwn(recordData, field));
}

// Provider error bodies can echo the submitted password. Never copy the
// original error, cause, or response body across the public boundary: build a
// fresh, actionable error that keeps only the code, status, and recovery hint.
function safePasswordWriteError(error, action) {
  const status = Number.isInteger(error?.status) ? error.status : 0;
  const code = typeof error?.code === 'string' && error.code ? error.code : 'api_error';
  let hint = 'The provider response is withheld because it can contain the submitted password.';
  if (code === 'auth_error') hint = 'Run: jsn auth login';
  else if (code === 'forbidden') hint = 'This is an authorization/ACL/role problem, not a login problem. Check access to this endpoint.';
  else if (code === 'network_error') hint = 'Check your internet connection and instance URL.';
  else if (status >= 500) hint = 'The ServiceNow instance may be experiencing issues. Try again later.';
  else if (status >= 400) hint = 'Check the user fields and instance validation rules, then retry with a corrected payload.';
  const safe = new AppError(code, `User ${action} failed while setting a password${status ? ` (HTTP ${status})` : ''}. The instance rejected the request; verify the user before retrying.`, hint, status);
  if (code === 'auth_error') safe.recovery = 'jsn auth login';
  return safe;
}

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
              const sysID = getStringField(picked, 'sys_id') || '';
              picked._context = { instance_url: app.getEffectiveInstance(), table: 'sys_user' };
              return app.ok(picked, {
                summary: `User: ${getStringField(picked, 'user_name')}`,
                breadcrumbs: [
                  { action: 'preferences', cmd: `jsn records list --table sys_user_preference --query "user=${sysID}"`, description: 'User preferences' },
                  { action: 'groups', cmd: `jsn records list --table sys_user_grmember --query "user=${sysID}"`, description: 'Group memberships' },
                ],
              });
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
            const record = await resolveRecord(app.sdk, { table: 'sys_user', identifier: id, matchField: 'user_name', resource: 'User' });
            app.ok(record, { summary: `User ${id}` });
          }),
        })
        .command({
          command: 'create',
          describe: 'Create a new user',
          builder: (y) => y
            .option('username', { alias: 'u', type: 'string', describe: 'Username (e.g. john.doe)' })
            .option('name', { alias: 'n', type: 'string', describe: 'Full name (e.g. John Doe)' })
            .option('email', { alias: 'e', type: 'string', describe: 'Email address' })
            .option('data', { type: 'string', describe: 'JSON data for additional fields' })
            .option('data-file', { type: 'string', describe: 'Read JSON payload from file' })
            .option('data-stdin', { type: 'boolean', describe: 'Read JSON payload from stdin' })
            .option('field', { alias: 'f', type: 'string', array: true, describe: 'Set a field as name=value; repeatable' }),
          handler: wrap(async (argv, app) => {
            const recordData = buildRecordPayload(argv, { required: false });
            if (argv.username) recordData.user_name = argv.username;
            if (argv.name) recordData.name = argv.name;
            if (argv.email) recordData.email = argv.email;
            if (!recordData.user_name) {
              throw new Error('user_name is required (use --username or --data)');
            }
            const record = await app.sdk.create('sys_user', recordData, { inputDisplayValue: Object.hasOwn(recordData, 'user_password') })
              .catch(error => { throw hasPasswordPayload(recordData) ? safePasswordWriteError(error, 'create') : error; });
            const safeRecord = { ...record };
            delete safeRecord.user_password;
            delete safeRecord.password;
            app.ok(safeRecord, {
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
            .option('data', { type: 'string', describe: 'JSON data to update' })
            .option('data-file', { type: 'string', describe: 'Read JSON payload from file' })
            .option('data-stdin', { type: 'boolean', describe: 'Read JSON payload from stdin' })
            .option('field', { alias: 'f', type: 'string', array: true, describe: 'Set a field as name=value; repeatable' }),
          handler: wrap(async (argv, app) => {
            const id = argv.identifier;
            const recordData = buildRecordPayload(argv);
            const sysID = await resolveSysId(app.sdk, { table: 'sys_user', identifier: id, matchField: 'user_name', resource: 'User' });
            const updated = await app.sdk.update('sys_user', sysID, recordData, { inputDisplayValue: Object.hasOwn(recordData, 'user_password') })
              .catch(error => { throw hasPasswordPayload(recordData) ? safePasswordWriteError(error, 'update') : error; });
            const safeUpdated = { ...updated };
            delete safeUpdated.user_password;
            delete safeUpdated.password;
            app.ok(safeUpdated, {
              summary: `Updated user ${id}`,
              breadcrumbs: [
                { action: 'view', cmd: `jsn users show ${id}`, description: 'View the updated user' },
              ],
            });
          }),
        })
        .command({
          command: 'delete <identifier>',
          describe: 'Delete a user by user_name or sys_id',
          handler: wrap(async (argv, app) => {
            const id = argv.identifier;
            const sysID = await resolveSysId(app.sdk, { table: 'sys_user', identifier: id, matchField: 'user_name', resource: 'User' });
            await app.sdk.delete('sys_user', sysID);
            app.ok({ identifier: id, message: 'User deleted' }, {
              summary: `Deleted user ${id}`,
            });
          }),
        });
    },
    handler: () => {
      console.log('Manage ServiceNow users from the sys_user table.');
      console.log('');
      console.log('Available subcommands:');
      console.log('  list                  List users');
      console.log('  show <name or sys_id>  Show a user by user_name or sys_id');
      console.log('  create                Create a new user');
      console.log('  update <identifier>   Update a user');
      console.log('  delete <identifier>   Delete a user');
      console.log('');
      console.log('Run "jsn users <command> --help" for details.');
    },
  };
}
