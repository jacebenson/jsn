import { formatRecordForDisplay, getStringField, resolveFieldsParam, assertSafeExactMatch, confirmDelete, quoteShellArg, buildRerunCommand } from '../helpers.js';
import { deferredFamilyDefinition } from '../command-families.js';
import { addGroupRole, formatGroupRolePreview, groupRolePreviewSummary } from '../group-role-grants.js';

// add/remove write sys_group_has_role; the mutation guard (instance +
// read-only profile) and the delete confirmation both key off this.

export function groupRolesCmd(wrap) {
  return {
    ...deferredFamilyDefinition('grouproles'),
    builder: (yargs) => {
      return yargs
        .command({
          command: 'list',
          aliases: ['ls'],
          describe: 'List group roles',
          builder: (y) => y
            .option('query', { type: 'string', describe: 'Encoded query (e.g. "nameLIKEincident" or "active=true")' })
            .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns (e.g. "number,short_description")' })
            .option('limit', { alias: 'l', type: 'number', default: 20, describe: 'Max records' }),
          handler: wrap(async (argv, app) => {
            const columns = argv.columns ? argv.columns.split(',') : ['group.name', 'role.name'];
            const params = new URLSearchParams();
            params.set('sysparm_limit', String(argv.limit));
            params.set('sysparm_display_value', 'all');
            const fields = resolveFieldsParam(columns);
            if (fields) params.set('sysparm_fields', fields);
            if (argv.query) params.set('sysparm_query', argv.query);
            const records = await app.sdk.list('sys_group_has_role', params);
            app.ok({
              table: 'sys_group_has_role',
              count: records.length,
              columns,
              records: fields ? records.map(r => formatRecordForDisplay(r, columns)) : records,
              context: { instance_url: app.getEffectiveInstance() },
            }, { summary: `${records.length} group role(s)` });
          }),
        })
        .command({
          command: 'add',
          describe: 'Add a role to a group; previews without --yes',
          builder: (y) => y
            .option('group', { alias: 'g', type: 'string', demandOption: true, describe: 'Group name or sys_id (required)' })
            .option('role', { alias: 'r', type: 'string', demandOption: true, describe: 'Role name or sys_id (required)' })
            .option('yes', { type: 'boolean', default: false, describe: 'Write the grant; without it, show who would get the role' }),
          handler: wrap(async (argv, app) => {
            const groupName = argv.group;
            const roleName = argv.role;
            const data = await addGroupRole(app.sdk, { group: groupName, role: roleName, yes: argv.yes });
            if (data.dry_run) {
              data.rerun = buildRerunCommand(argv, { rerun: data.rerun });
              Object.defineProperty(data, '_formatted', { value: formatGroupRolePreview(data), enumerable: false });
              return app.ok(data, { summary: groupRolePreviewSummary(data) });
            }
            if (!data.verified) {
              process.exitCode = 1;
              return app.ok({ group: data.group, role: data.role, record: data.record, verified: false }, {
                summary: `Grant of ${roleName} to ${groupName} unconfirmed: no sys_group_has_role row on read-back`,
              });
            }
            app.ok(data.record, {
              summary: `Added role ${roleName} to ${groupName}`,
              breadcrumbs: [
                { action: 'list', cmd: `jsn grouproles list --query "group.name=${groupName}"`, description: 'List group roles' },
                { action: 'remove', cmd: `jsn grouproles remove --group ${quoteShellArg(groupName)} --role ${quoteShellArg(roleName)}`, description: 'Remove this role' },
              ],
            });
          }),
        })
        .command({
          command: 'remove',
          describe: 'Remove a role from a group',
          builder: (y) => y
            .option('group', { alias: 'g', type: 'string', demandOption: true, describe: 'Group name or sys_id (required)' })
            .option('role', { alias: 'r', type: 'string', demandOption: true, describe: 'Role name or sys_id (required)' })
            .option('force', { type: 'boolean', describe: 'Skip the confirmation prompt (removal)' }),
          handler: wrap(async (argv, app) => {
            const groupName = argv.group;
            const roleName = argv.role;
            assertSafeExactMatch(groupName);
            assertSafeExactMatch(roleName);
            // Confirm before any lookup: a refused confirmation must not
            // touch the instance at all.
            await confirmDelete(app, argv, `Remove role ${roleName} from group ${groupName}`, {
              rerun: ['grouproles', 'remove', '--group', groupName, '--role', roleName],
            });

            // Resolve group sys_id
            const isGroupSysID = groupName.length === 32 && /^[0-9a-fA-F]+$/.test(groupName);
            const groupParams = new URLSearchParams();
            groupParams.set('sysparm_query', isGroupSysID ? `sys_id=${groupName}` : `name=${groupName}`);
            groupParams.set('sysparm_limit', '1');
            groupParams.set('sysparm_fields', 'sys_id');
            const groupRecords = await app.sdk.list('sys_user_group', groupParams);
            if (groupRecords.length === 0) {
              throw new Error(`Group not found: ${groupName}`);
            }
            const groupSysID = getStringField(groupRecords[0], 'sys_id');

            // Resolve role sys_id
            const isRoleSysID = roleName.length === 32 && /^[0-9a-fA-F]+$/.test(roleName);
            const roleParams = new URLSearchParams();
            roleParams.set('sysparm_query', isRoleSysID ? `sys_id=${roleName}` : `name=${roleName}`);
            roleParams.set('sysparm_limit', '1');
            roleParams.set('sysparm_fields', 'sys_id');
            const roleRecords = await app.sdk.list('sys_user_role', roleParams);
            if (roleRecords.length === 0) {
              throw new Error(`Role not found: ${roleName}`);
            }
            const roleSysID = getStringField(roleRecords[0], 'sys_id');

            // Find the role assignment record
            const findParams = new URLSearchParams();
            findParams.set('sysparm_query', `group=${groupSysID}^role=${roleSysID}`);
            findParams.set('sysparm_limit', '1');
            findParams.set('sysparm_fields', 'sys_id');
            const assignmentRecords = await app.sdk.list('sys_group_has_role', findParams);
            if (assignmentRecords.length === 0) {
              throw new Error(`Role ${roleName} is not assigned to group ${groupName}`);
            }
            const assignmentSysID = getStringField(assignmentRecords[0], 'sys_id');

            // Delete the role assignment
            await app.sdk.delete('sys_group_has_role', assignmentSysID);
            app.ok({ group: groupName, role: roleName }, {
              summary: `Removed role ${roleName} from ${groupName}`,
              breadcrumbs: [
                { action: 'list', cmd: `jsn grouproles list --query "group.name=${groupName}"`, description: 'List group roles' },
                { action: 'add', cmd: `jsn grouproles add --group ${quoteShellArg(groupName)} --role ${quoteShellArg(roleName)}`, description: 'Add role back to group' },
              ],
            });
          }),
        });
    },
    handler: () => {
      console.log('Manage group roles in sys_group_has_role.');
      console.log('');
      console.log('Available subcommands:');
      console.log('  list                  List group roles');
      console.log('  add                   Add a role to a group (previews without --yes)');
      console.log('  remove                Remove a role from a group');
      console.log('');
      console.log('Run "jsn grouproles <command> --help" for details.');
    },
  };
}
