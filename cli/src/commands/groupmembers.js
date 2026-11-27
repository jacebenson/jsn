import { formatRecordForDisplay, resolveFieldsParam, buildRerunCommand } from '../helpers.js';
import { deferredFamilyDefinition } from '../command-families.js';
import { errUsage } from '../errors.js';
import { addGroupMembers, removeGroupMembers, formatGroupMembers, groupMembersSummary } from '../group-memberships.js';

// add/remove write sys_user_grmember; the mutation guard (instance +
// read-only profile) keys off the family's mutationSubcommands.

const targetOptions = (y) => y.strict()
  .option('group', { alias: 'g', type: 'string', demandOption: true, describe: 'Group name or sys_id (required)' })
  .option('user', { alias: 'u', type: 'string', array: true, demandOption: true, describe: 'User name or sys_id; repeat or comma-separate, up to 100 (required)' })
  .option('yes', { type: 'boolean', default: false, describe: 'Write the change; without it, show what would change' });

function writeHandler(wrap, op, run) {
  return wrap(async (argv, app) => {
    // remove used to delete with --force; refuse it so such a script fails instead of only previewing.
    if (op === 'remove' && argv.force) throw errUsage('remove does not take --force: run it without --yes to preview, then rerun with the --yes --expect-count it prints. Nothing removed.');
    app.requireInstance();
    const data = await run(app.sdk, { group: argv.group, user: argv.user, yes: argv.yes, expectCount: argv.expectCount });
    if (data.rerun) data.rerun = buildRerunCommand(argv, { rerun: data.rerun });
    Object.defineProperty(data, '_formatted', { value: formatGroupMembers(data, op), enumerable: false });
    app.ok(data, { summary: groupMembersSummary(data, op) });
    if (data.verified === false) process.exitCode = 1;
  });
}

export function groupMembersCmd(wrap) {
  return {
    ...deferredFamilyDefinition('groupmembers'),
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
          describe: 'Add users to a group, skipping any already in it; previews without --yes',
          builder: (y) => targetOptions(y).epilogue('Creates one sys_user_grmember row per user, then reads them back and exits nonzero unless every membership is there.'),
          handler: writeHandler(wrap, 'add', addGroupMembers),
        })
        .command({
          command: 'remove',
          describe: 'Remove users from a group; previews without --yes',
          builder: (y) => targetOptions(y)
            .option('expect-count', { type: 'number', describe: 'Required with --yes: the number of membership rows the preview listed' })
            .epilogue('Deletes the listed sys_user_grmember rows only when their count equals --expect-count, then reads them back and exits nonzero if any is still there.'),
          handler: writeHandler(wrap, 'remove', removeGroupMembers),
        });
    },
    handler: () => {
      console.log('Manage group memberships in sys_user_grmember.');
      console.log('');
      console.log('Available subcommands:');
      console.log('  list                  List group members');
      console.log('  add                   Add users to a group (previews without --yes)');
      console.log('  remove                Remove users from a group (previews without --yes)');
      console.log('');
      console.log('Run "jsn groupmembers <command> --help" for details.');
    },
  };
}
