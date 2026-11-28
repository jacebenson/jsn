import { formatRecordForDisplay, getStringField, interactiveList, resolveFieldsParam, buildRecordPayload, quoteShellArg, buildRerunCommand, confirmDelete } from '../helpers.js';
import { deferredFamilyDefinition } from '../command-families.js';
import { resolveRecord, resolveSysId } from '../resolve-record.js';
import { listUserRoles, explainUserRoles, formatUserRoleWhy } from '../user-roles.js';
import { explainUserAccess, formatUserAccess, userAccessSummary, unlockUser, formatUserUnlock, userUnlockSummary } from '../user-access.js';
import { basicAuthReport, formatBasicAuthReport } from '../basic-auth-report.js';
import { errUsage } from '../errors.js';

export function usersCmd(wrap) {
  return {
    ...deferredFamilyDefinition('users'),
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
          command: 'roles <identifier>',
          describe: 'List a user\'s roles; --why shows how each is granted (direct, contained role, group)',
          builder: (y) => y
            .option('why', { type: 'boolean', describe: 'Show every path to each role from the User Role Inheritance API (needs user_admin)' })
            .option('role', { alias: 'r', type: 'string', describe: 'Only this role (name or sys_id)' })
            .option('limit', { alias: 'l', type: 'number', describe: 'Max role rows without --why (1-1000, default 100)' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const id = argv.identifier;
            if (argv.why && argv.limit !== undefined) throw errUsage('--limit applies to the role list; --why always shows every path.');
            if (argv.why) {
              const data = await explainUserRoles(app.sdk, id, { role: argv.role });
              Object.defineProperty(data, '_formatted', { value: formatUserRoleWhy(data, quoteShellArg(id)), enumerable: false });
              return app.ok(data, { summary: `${data.count} role(s), ${data.path_count} path(s) for ${data.user.user_name}` });
            }
            const data = await listUserRoles(app.sdk, id, { role: argv.role, limit: argv.limit });
            const who = `${data.user.user_name}${data.role ? ` (role ${data.role.name})` : ''}`;
            app.ok(data, {
              summary: data.count ? `${data.count} role row(s) for ${who}${data.pagination.has_more ? ', more available (raise --limit or narrow with --role)' : ''}`
                : `No visible role rows for ${who}; row ACLs can hide rows, so this does not prove the user lacks a role (--why asks the platform)`,
              breadcrumbs: [{ action: 'why', cmd: `jsn users roles ${quoteShellArg(id)} --why${argv.role ? ` --role ${quoteShellArg(argv.role)}` : ''}`, description: 'How each role is granted' }],
            });
          }),
        })
        .command({
          command: 'access <identifier>',
          describe: 'Explain why a user cannot sign in (locked out, inactive, password reset, web services only) with recent login.failed events',
          builder: (y) => y.strict().option('limit', { alias: 'l', type: 'number', default: 10, describe: 'Max login.failed events (1-100)' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const data = await explainUserAccess(app.sdk, argv.identifier, { limit: argv.limit });
            Object.defineProperty(data, '_formatted', { value: formatUserAccess(data), enumerable: false });
            app.ok(data, { summary: userAccessSummary(data) });
          }),
        })
        .command({
          command: 'unlock <identifier>',
          describe: 'Unlock a locked-out user: clear locked_out and zero failed_attempts; previews without --yes',
          builder: (y) => y.strict().option('yes', { type: 'boolean', default: false, describe: 'Write the change; without it, show what would change' })
            .epilogue('Refuses a user who is not locked out, and leaves password_needs_reset as it is. After the write it reads the user back and exits nonzero unless both fields changed.'),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const data = await unlockUser(app.sdk, argv.identifier, { yes: argv.yes });
            if (data.rerun) data.rerun = buildRerunCommand(argv, { rerun: data.rerun });
            Object.defineProperty(data, '_formatted', { value: formatUserUnlock(data), enumerable: false });
            app.ok(data, { summary: userUnlockSummary(data) });
          }),
        })
        .command({
          command: 'basic-auth',
          describe: 'List accounts the platform recorded using Basic Auth and whether enforcement will block them (read-only)',
          builder: (y) => y
            .option('blocked', { type: 'boolean', default: false, describe: 'Only accounts enforcement would block' })
            .option('limit', { alias: 'l', type: 'number', default: 200, describe: 'Max exception rows to show (1-1000)' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const data = await basicAuthReport(app.sdk, { blocked: argv.blocked === true, limit: argv.limit });
            Object.defineProperty(data, '_formatted', { value: formatBasicAuthReport(data), enumerable: false });
            const policy = data.policy;
            const switches = policy.readable ? `active=${policy.active}, enforce=${policy.enforce}` : 'policy not readable';
            app.ok(data, {
              summary: !data.exception_table.readable
                ? `Basic Auth restriction ${switches}; exception table not readable (${data.exception_table.error}), so per-account verdicts are unknown`
                : `Basic Auth restriction ${switches}; ${data.counts.total} exception row(s): ${data.counts.blocked} blocked, ${data.counts.allowed} allowed, ${data.counts.unknown} unknown`,
              breadcrumbs: [
                { action: 'account', cmd: 'jsn users show <user>', description: 'Inspect one recorded account' },
                { action: 'mid', cmd: 'jsn midservers add --help', description: 'Single-account diagnosis used by MID setup' },
              ],
            });
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
            .option('data', { type: 'string', describe: 'JSON data to update' })
            .option('data-file', { type: 'string', describe: 'Read JSON payload from file' })
            .option('data-stdin', { type: 'boolean', describe: 'Read JSON payload from stdin' })
            .option('field', { alias: 'f', type: 'string', array: true, describe: 'Set a field as name=value; repeatable' }),
          handler: wrap(async (argv, app) => {
            const id = argv.identifier;
            const recordData = buildRecordPayload(argv);
            const sysID = await resolveSysId(app.sdk, { table: 'sys_user', identifier: id, matchField: 'user_name', resource: 'User' });
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
          builder: (y) => y.option('force', { type: 'boolean', default: false, describe: 'Skip confirmation' }),
          handler: wrap(async (argv, app) => {
            const id = argv.identifier;
            const sysID = await resolveSysId(app.sdk, { table: 'sys_user', identifier: id, matchField: 'user_name', resource: 'User' });
            await confirmDelete(app, argv, `Delete user ${id}`, { rerun: ['users', 'delete', id] });
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
      console.log('  roles <identifier>    List a user\'s roles; --why shows how each is granted');
      console.log('  access <identifier>   Explain why a user cannot sign in');
      console.log('  unlock <identifier>   Unlock a locked-out user (preview by default)');
      console.log('  basic-auth            Accounts recorded using Basic Auth and their enforcement verdict');
      console.log('  create                Create a new user');
      console.log('  update <identifier>   Update a user');
      console.log('  delete <identifier>   Delete a user');
      console.log('');
      console.log('Run "jsn users <command> --help" for details.');
    },
  };
}
