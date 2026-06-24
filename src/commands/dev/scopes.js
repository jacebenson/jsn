import { formatRecordForDisplay, getStringField, interactiveList } from '../../helpers.js';

export function scopesCmd(wrap) {
  return {
    command: 'scopes [subcommand]',
    aliases: ['scope', 'sc'],
    describe: 'Manage application scopes',
    builder: (yargs) => {
      return yargs
        .command({
          command: 'list',
          aliases: ['ls'],
          describe: 'List application scopes',
          builder: (y) => y
            .option('query', { type: 'string', describe: 'Encoded query (e.g. "nameLIKEincident" or "active=true")' })
            .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns (e.g. "number,short_description")' })
            .option('limit', { alias: 'l', type: 'number', default: 20, describe: 'Max records' }),
          handler: wrap(async (argv, app) => {
            const columns = argv.columns ? argv.columns.split(',') : ['name', 'scope', 'short_description', 'active'];
            const query = argv.query || '';

            const picked = await interactiveList({
              app, table: 'sys_scope', singular: 'scope', columns, limit: argv.limit, query, labelField: 'name',
              formatLabel: r => `${getStringField(r, 'name')} [${getStringField(r, 'scope') || '?'}]`,
            });
            if (picked) {
              picked._context = { instance_url: app.getEffectiveInstance(), table: 'sys_scope' };
              return app.ok(picked, { summary: `Scope: ${getStringField(picked, 'name')}` });
            }

            const params = new URLSearchParams();
            params.set('sysparm_limit', String(argv.limit));
            params.set('sysparm_display_value', 'all');
            params.set('sysparm_fields', ['sys_id', ...columns].join(','));
            const q = argv.query ? argv.query + '^ORDERBYDESCsys_updated_on' : 'ORDERBYDESCsys_updated_on';
            params.set('sysparm_query', q);
            const records = await app.sdk.list('sys_scope', params);
            app.ok({
              table: 'sys_scope',
              count: records.length,
              columns,
              records: records.map(r => formatRecordForDisplay(r, columns)),
              context: { instance_url: app.getEffectiveInstance() },
            }, { summary: `${records.length} scope(s)` });
          }),
        })
        .command({
          command: 'show <scope>',
          aliases: ['get'],
          describe: 'Show a scope by scope value or name',
          builder: (y) => y
            .positional('scope', {
              describe: 'Scope value (e.g. x_417611_daves_o_0) or display name',
              type: 'string',
            }),
          handler: wrap(async (argv, app) => {
            let records;
            // Try by scope value first, then by name
            for (const queryField of ['scope', 'name']) {
              const params = new URLSearchParams();
              params.set('sysparm_query', `${queryField}=${argv.scope}`);
              params.set('sysparm_limit', '1');
              params.set('sysparm_display_value', 'all');
              records = await app.sdk.list('sys_scope', params);
              if (records.length > 0) break;
            }
            if (!records || records.length === 0) {
              throw new Error(`Scope not found: ${argv.scope}`);
            }
            app.ok(records[0], { summary: `Scope ${argv.scope}` });
          }),
        })
        .command({
          command: 'set <scope>',
          describe: 'Set the current application scope',
          handler: wrap(async (argv, app) => {
            const params = new URLSearchParams();
            params.set('sysparm_query', `scope=${argv.scope}`);
            params.set('sysparm_limit', '1');
            params.set('sysparm_fields', 'sys_id,scope');
            const records = await app.sdk.list('sys_scope', params);
            if (records.length === 0) {
              throw new Error(`Scope not found: ${argv.scope}`);
            }
            const scopeSysID = getStringField(records[0], 'sys_id');
            // Update user preference
            const user = await app.sdk.list('sys_user', new URLSearchParams({
              sysparm_query: 'user_name=javascript:gs.getUserName()',
              sysparm_limit: '1',
              sysparm_fields: 'sys_id',
            }));
            if (user.length === 0) {
              throw new Error('Could not determine current user');
            }
            const userSysID = getStringField(user[0], 'sys_id');
            const prefParams = new URLSearchParams();
            prefParams.set('sysparm_query', `user=${userSysID}^name=apps.current_app`);
            prefParams.set('sysparm_limit', '1');
            const prefs = await app.sdk.list('sys_user_preference', prefParams);
            if (prefs.length > 0) {
              await app.sdk.update('sys_user_preference', getStringField(prefs[0], 'sys_id'), { value: scopeSysID });
            } else {
              await app.sdk.create('sys_user_preference', {
                user: userSysID,
                name: 'apps.current_app',
                value: scopeSysID,
                type: 'string',
              });
            }
            app.ok({ scope: argv.scope, sys_id: scopeSysID }, { summary: `Current scope: ${argv.scope}` });
          }),
        })
        .command({
          command: 'create',
          describe: 'Create a new application scope',
          builder: (y) => y
            .option('name', { alias: 'n', type: 'string', demandOption: true, describe: 'Application name' })
            .option('scope', { type: 'string', describe: 'Scope value (auto-generated from name if omitted)' }),
          handler: wrap(async (argv, app) => {
            let scope = argv.scope;
            if (!scope) {
              // Auto-generate scope from name: lowercase, replace spaces/special chars
              scope = 'x_' + argv.name.toLowerCase()
                .replace(/[^a-z0-9_]/g, '_')
                .replace(/_+/g, '_')
                .replace(/^_|_$/g, '')
                .substring(0, 38); // x_ + max 35 chars = 37, leave room
            }
            // Check for existing scope
            const existing = await app.sdk.list('sys_scope', new URLSearchParams({
              sysparm_query: `scope=${scope}`,
              sysparm_limit: '1',
            }));
            if (existing.length > 0) {
              throw new Error(`Scope '${scope}' already exists. Use a different name or --scope flag.`);
            }
            const record = await app.sdk.create('sys_scope', {
              name: argv.name,
              scope,
              short_description: argv.name,
            });
            app.ok(record, {
              summary: `Created scope: ${scope}`,
              breadcrumbs: [{
                action: 'show',
                cmd: `jsn dev scopes show ${scope}`,
                description: 'View the new scope',
              }],
            });
          }),
        })

    },
    handler: (argv) => {
      if (!argv._[1]) {
        console.log('Manage ServiceNow application scopes.\n');
        console.log('Commands:');
        console.log('  list           List application scopes');
        console.log('  show <scope>   Show a scope');
        console.log('  set  <scope>   Set the current application scope');
        console.log('  create         Create a new application scope');
        console.log('\nRun "jsn dev scopes <command> --help" for details.');
      }
    },
  };
}
