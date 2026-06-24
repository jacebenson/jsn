import { formatRecordForDisplay, getStringField, resolveFieldsParam } from '../helpers.js';

export function groupRolesCmd(wrap) {
  return {
    command: 'grouproles [subcommand]',
    aliases: ['grouprole', 'grole', 'gr'],
    describe: 'Manage group roles',
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
          describe: 'Add a role to a group',
          builder: (y) => y
            .option('group', { alias: 'g', type: 'string', demandOption: true, describe: 'Group name or sys_id (required)' })
            .option('role', { alias: 'r', type: 'string', demandOption: true, describe: 'Role name or sys_id (required)' }),
          handler: wrap(async (argv, app) => {
            const groupName = argv.group;
            const roleName = argv.role;

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

            // Check if role assignment already exists
            const checkParams = new URLSearchParams();
            checkParams.set('sysparm_query', `group=${groupSysID}^role=${roleSysID}`);
            checkParams.set('sysparm_limit', '1');
            checkParams.set('sysparm_fields', 'sys_id');
            const existing = await app.sdk.list('sys_group_has_role', checkParams);
            if (existing.length > 0) {
              throw new Error(`Role ${roleName} is already assigned to group ${groupName}`);
            }

            // Create the role assignment
            const record = await app.sdk.create('sys_group_has_role', {
              group: groupSysID,
              role: roleSysID,
            });
            app.ok(record, {
              summary: `Added role ${roleName} to ${groupName}`,
              breadcrumbs: [
                { action: 'list', cmd: `jsn grouproles list --query "group.name=${groupName}"`, description: 'List group roles' },
                { action: 'remove', cmd: `jsn grouproles remove --group "${groupName}" --role "${roleName}"`, description: 'Remove this role' },
              ],
            });
          }),
        })
        .command({
          command: 'remove',
          describe: 'Remove a role from a group',
          builder: (y) => y
            .option('group', { alias: 'g', type: 'string', demandOption: true, describe: 'Group name or sys_id (required)' })
            .option('role', { alias: 'r', type: 'string', demandOption: true, describe: 'Role name or sys_id (required)' }),
          handler: wrap(async (argv, app) => {
            const groupName = argv.group;
            const roleName = argv.role;

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
                { action: 'add', cmd: `jsn grouproles add --group "${groupName}" --role "${roleName}"`, description: 'Add role back to group' },
              ],
            });
          }),
        });
    },
    handler: () => {},
  };
}
