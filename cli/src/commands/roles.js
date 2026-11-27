import { buildProfileCommand } from '../record-profiles.js';
import { quoteShellArg } from '../helpers.js';
import { listRoleHolders, formatRoleHolders } from '../role-holders.js';

const holdersCommand = wrap => ({
  command: 'holders <role>',
  describe: 'List every user who holds a role by any path, with a distinct user count (read-only)',
  builder: y => y
    .option('effective', { type: 'boolean', default: false, describe: 'Collapse to one line per user with how the role is held (joins sys_user for active)' })
    .option('direct', { type: 'boolean', default: false, describe: 'Only direct grants (excludes group, contained-role and inherited rows)' })
    .option('limit', { alias: 'l', type: 'number', default: 100, describe: 'Max rows (rows mode) or users (--effective); 1-1000' }),
  handler: wrap(async (argv, app) => {
    app.requireInstance();
    const data = await listRoleHolders(app.sdk, argv.role, {
      effective: argv.effective === true, direct: argv.direct === true, limit: argv.limit,
    });
    Object.defineProperty(data, '_formatted', { value: formatRoleHolders(data), enumerable: false });
    const distinct = data.counts.distinct_users === null ? 'unknown' : data.counts.distinct_users;
    const unit = data.mode === 'effective' ? 'user(s)' : 'row(s)';
    const more = data.pagination.has_more ? `, more match (raise --limit or narrow with --direct)` : '';
    app.ok(data, {
      summary: `${distinct} distinct user(s) hold ${data.role.name}${data.filters.direct ? ' directly' : ''}; showing ${data.count} ${unit}${more}`,
      breadcrumbs: [
        data.mode === 'effective'
          ? { action: 'rows', cmd: `jsn roles holders ${quoteShellArg(argv.role)}`, description: 'One row per role grant' }
          : { action: 'effective', cmd: `jsn roles holders ${quoteShellArg(argv.role)} --effective`, description: 'One line per user with how the role is held' },
        { action: 'why', cmd: 'jsn users roles <user> --why', description: 'How one user holds their roles' },
      ],
    });
  }),
});

export const rolesCmd = wrap => {
  const command = buildProfileCommand('roles', wrap, {
    extraSubcommands: [{ name: 'holders', description: 'Users holding a role by any path (read-only)' }],
  });
  const baseBuilder = command.builder;
  command.builder = yargs => baseBuilder(yargs).command(holdersCommand(wrap));
  return command;
};
