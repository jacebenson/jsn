import { formatRecordForDisplay, getStringField, resolveFieldsParam } from '../helpers.js';

export function groupMembersCmd(wrap) {
  return {
    command: 'groupmembers [subcommand]',
    aliases: ['groupmember', 'gmember', 'gm'],
    describe: 'Manage group memberships',
    builder: (yargs) => {
      return yargs
        .command({
          command: 'list',
          aliases: ['ls'],
          describe: 'List group members',
          builder: (y) => y
            .option('query', { type: 'string', describe: 'Encoded query (e.g. "nameLIKEincident" or "active=true")' })
            .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns (e.g. "number,short_description")' })
            .option('limit', { alias: 'l', type: 'number', default: 20, describe: 'Max records' }),
          handler: wrap(async (argv, app) => {
            const columns = argv.columns ? argv.columns.split(',') : ['user.name', 'group.name'];
            const params = new URLSearchParams();
            params.set('sysparm_limit', String(argv.limit));
            params.set('sysparm_display_value', 'all');
            const fields = resolveFieldsParam(columns);
            if (fields) params.set('sysparm_fields', fields);
            if (argv.query) params.set('sysparm_query', argv.query);
            const records = await app.sdk.list('sys_user_grmember', params);
            app.ok({
              table: 'sys_user_grmember',
              count: records.length,
              columns,
              records: fields ? records.map(r => formatRecordForDisplay(r, columns)) : records,
              context: { instance_url: app.getEffectiveInstance() },
            }, { summary: `${records.length} group member(s)` });
          }),
        })
        .command({
          command: 'add',
          describe: 'Add a user to a group',
          builder: (y) => y
            .option('group', { alias: 'g', type: 'string', demandOption: true, describe: 'Group name or sys_id (required)' })
            .option('user', { alias: 'u', type: 'string', demandOption: true, describe: 'Username or sys_id (required)' }),
          handler: wrap(async (argv, app) => {
            const groupName = argv.group;
            const userName = argv.user;

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

            // Resolve user sys_id
            const isUserSysID = userName.length === 32 && /^[0-9a-fA-F]+$/.test(userName);
            const userParams = new URLSearchParams();
            userParams.set('sysparm_query', isUserSysID ? `sys_id=${userName}` : `user_name=${userName}`);
            userParams.set('sysparm_limit', '1');
            userParams.set('sysparm_fields', 'sys_id');
            const userRecords = await app.sdk.list('sys_user', userParams);
            if (userRecords.length === 0) {
              throw new Error(`User not found: ${userName}`);
            }
            const userSysID = getStringField(userRecords[0], 'sys_id');

            // Check if membership already exists
            const checkParams = new URLSearchParams();
            checkParams.set('sysparm_query', `group=${groupSysID}^user=${userSysID}`);
            checkParams.set('sysparm_limit', '1');
            checkParams.set('sysparm_fields', 'sys_id');
            const existing = await app.sdk.list('sys_user_grmember', checkParams);
            if (existing.length > 0) {
              throw new Error(`User ${userName} is already a member of group ${groupName}`);
            }

            // Create the membership
            const record = await app.sdk.create('sys_user_grmember', {
              group: groupSysID,
              user: userSysID,
            });
            app.ok(record, {
              summary: `Added ${userName} to ${groupName}`,
              breadcrumbs: [
                { action: 'list', cmd: `jsn groupmembers list --query "group.name=${groupName}"`, description: 'List group members' },
                { action: 'remove', cmd: `jsn groupmembers remove --group "${groupName}" --user "${userName}"`, description: 'Remove this member' },
              ],
            });
          }),
        })
        .command({
          command: 'remove',
          describe: 'Remove a user from a group',
          builder: (y) => y
            .option('group', { alias: 'g', type: 'string', demandOption: true, describe: 'Group name or sys_id (required)' })
            .option('user', { alias: 'u', type: 'string', demandOption: true, describe: 'Username or sys_id (required)' }),
          handler: wrap(async (argv, app) => {
            const groupName = argv.group;
            const userName = argv.user;

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

            // Resolve user sys_id
            const isUserSysID = userName.length === 32 && /^[0-9a-fA-F]+$/.test(userName);
            const userParams = new URLSearchParams();
            userParams.set('sysparm_query', isUserSysID ? `sys_id=${userName}` : `user_name=${userName}`);
            userParams.set('sysparm_limit', '1');
            userParams.set('sysparm_fields', 'sys_id');
            const userRecords = await app.sdk.list('sys_user', userParams);
            if (userRecords.length === 0) {
              throw new Error(`User not found: ${userName}`);
            }
            const userSysID = getStringField(userRecords[0], 'sys_id');

            // Find the membership record
            const findParams = new URLSearchParams();
            findParams.set('sysparm_query', `group=${groupSysID}^user=${userSysID}`);
            findParams.set('sysparm_limit', '1');
            findParams.set('sysparm_fields', 'sys_id');
            const membershipRecords = await app.sdk.list('sys_user_grmember', findParams);
            if (membershipRecords.length === 0) {
              throw new Error(`User ${userName} is not a member of group ${groupName}`);
            }
            const membershipSysID = getStringField(membershipRecords[0], 'sys_id');

            // Delete the membership
            await app.sdk.delete('sys_user_grmember', membershipSysID);
            app.ok({ user: userName, group: groupName }, {
              summary: `Removed ${userName} from ${groupName}`,
              breadcrumbs: [
                { action: 'list', cmd: `jsn groupmembers list --query "group.name=${groupName}"`, description: 'List group members' },
                { action: 'add', cmd: `jsn groupmembers add --group "${groupName}" --user "${userName}"`, description: 'Add user back to group' },
              ],
            });
          }),
        });
    },
    handler: () => {},
  };
}
