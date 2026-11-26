import { formatRecordForDisplay, resolveFieldsParam, buildRerunCommand } from '../helpers.js';
import { errUsage } from '../errors.js';
import { deferredFamilyDefinition } from '../command-families.js';
import { addUserRoles, removeUserRoles, formatUserRoles, userRolesSummary } from '../user-role-grants.js';

// add/remove write direct sys_user_has_role rows; the mutation guard keys off command-families.

const targetOptions = (y) => y.strict()
  .option('role', { alias: 'r', type: 'string', demandOption: true, describe: 'Role name or sys_id (required)' })
  .option('user', { alias: 'u', type: 'string', array: true, demandOption: true, describe: 'User name or sys_id; repeat or comma-separate, up to 100 (required)' })
  .option('yes', { type: 'boolean', default: false, describe: 'Write the change; without it, show what would change' });

function writeHandler(wrap, op, run) {
  return wrap(async (argv, app) => {
    app.requireInstance();
    const data = await run(app.sdk, { role: argv.role, user: argv.user, yes: argv.yes, expectCount: argv.expectCount });
    if (data.rerun) data.rerun = buildRerunCommand(argv, { rerun: data.rerun });
    Object.defineProperty(data, '_formatted', { value: formatUserRoles(data, op), enumerable: false });
    app.ok(data, { summary: userRolesSummary(data, op) });
    if (data.verified === false) process.exitCode = 1;
  });
}

export function userRolesCmd(wrap) {
  return {
    ...deferredFamilyDefinition('userroles'),
    builder: (yargs) => yargs
      .command({
        command: 'list',
        aliases: ['ls'],
        describe: 'List user role rows, direct and inherited',
        builder: (y) => y.strict()
          .option('query', { type: 'string', describe: 'Encoded query (e.g. "user.user_name=abel.tuter^inherited=false")' })
          .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns' })
          .option('limit', { alias: 'l', type: 'number', default: 20, describe: 'Max records (1-1000)' }),
        handler: wrap(async (argv, app) => {
          if (!Number.isSafeInteger(argv.limit) || argv.limit < 1 || argv.limit > 1000) throw errUsage('--limit must be an integer from 1 to 1000.');
          app.requireInstance();
          const columns = argv.columns ? argv.columns.split(',') : ['user.user_name', 'role.name', 'inherited', 'state'];
          const fields = resolveFieldsParam(columns);
          const params = new URLSearchParams({ sysparm_limit: String(argv.limit + 1), sysparm_display_value: 'all' });
          if (fields) params.set('sysparm_fields', fields);
          if (argv.query) params.set('sysparm_query', argv.query);
          const rows = await app.sdk.listStrict('sys_user_has_role', params);
          const records = rows.slice(0, argv.limit);
          app.ok({
            table: 'sys_user_has_role', count: records.length, columns,
            records: fields ? records.map(r => formatRecordForDisplay(r, columns)) : records,
            pagination: { limit: argv.limit, has_more: rows.length > argv.limit },
            context: { instance_url: app.getEffectiveInstance() },
          }, { summary: `${records.length} user role(s)` });
        }),
      })
      .command({
        command: 'add',
        describe: 'Grant a role directly to users, skipping any who already hold it directly; previews without --yes',
        builder: (y) => targetOptions(y).epilogue('Creates one sys_user_has_role row per user, then reads them back and exits nonzero unless every grant is there. A role a user holds only through a group still gets a direct row.'),
        handler: writeHandler(wrap, 'add', addUserRoles),
      })
      .command({
        command: 'remove',
        describe: 'Remove direct role grants from users; inherited rows are never removed; previews without --yes',
        builder: (y) => targetOptions(y)
          .option('expect-count', { type: 'number', describe: 'Required with --yes: the number of direct rows the preview listed' })
          .epilogue('Deletes only rows with inherited=false, and only when their count equals --expect-count; then reads them back and exits nonzero if any is still there. A role held through a group stays until the group membership or group role changes.'),
        handler: writeHandler(wrap, 'remove', removeUserRoles),
      }),
  };
}
