import fs from 'node:fs';
import { formatRecordForDisplay, getStringField, interactiveList } from '../../helpers.js';

export function updateSetsCmd(wrap) {
  return {
    command: 'updatesets [subcommand]',
    aliases: ['updateset', 'us'],
    describe: 'Manage update sets',
    builder: (yargs) => {
      return yargs
        .command({
          command: 'list',
          aliases: ['ls'],
          describe: 'List update sets',
          builder: (y) => y
            .option('query', { type: 'string', describe: 'Encoded query (e.g. "nameLIKEincident" or "active=true")' })
            .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns (e.g. "number,short_description")' })
            .option('limit', { alias: 'l', type: 'number', default: 20, describe: 'Max records' }),
          handler: wrap(async (argv, app) => {
            const columns = argv.columns ? argv.columns.split(',') : ['name', 'state', 'application'];
            const query = argv.query || '';

            const picked = await interactiveList({
              app, table: 'sys_update_set', singular: 'update set', columns, limit: argv.limit, query, labelField: 'name',
              formatLabel: r => `${getStringField(r, 'name')} [${getStringField(r, 'state') || '?'}]`,
            });
            if (picked) {
              picked._context = { instance_url: app.getEffectiveInstance(), table: 'sys_update_set' };
              return app.ok(picked, { summary: `Update set: ${getStringField(picked, 'name')}` });
            }

            const params = new URLSearchParams();
            params.set('sysparm_limit', String(argv.limit));
            params.set('sysparm_display_value', 'all');
            params.set('sysparm_fields', ['sys_id', ...columns].join(','));
            const q = argv.query ? argv.query + '^ORDERBYDESCsys_updated_on' : 'ORDERBYDESCsys_updated_on';
            params.set('sysparm_query', q);
            const records = await app.sdk.list('sys_update_set', params);
            app.ok({
              table: 'sys_update_set',
              count: records.length,
              columns,
              records: records.map(r => formatRecordForDisplay(r, columns)),
              context: { instance_url: app.getEffectiveInstance() },
            }, { summary: `${records.length} update set(s)` });
          }),
        })
        .command({
          command: 'show <name>',
          aliases: ['get'],
          describe: 'Show an update set',
          handler: wrap(async (argv, app) => {
            const params = new URLSearchParams();
            params.set('sysparm_query', `name=${argv.name}`);
            params.set('sysparm_limit', '1');
            params.set('sysparm_display_value', 'all');
            const records = await app.sdk.list('sys_update_set', params);
            if (records.length === 0) {
              throw new Error(`Update set not found: ${argv.name}`);
            }
            app.ok(records[0], { summary: `Update set ${argv.name}` });
          }),
        })
        .command({
          command: 'set <name>',
          describe: 'Set the current update set',
          handler: wrap(async (argv, app) => {
            const params = new URLSearchParams();
            params.set('sysparm_query', `name=${argv.name}`);
            params.set('sysparm_limit', '1');
            params.set('sysparm_fields', 'sys_id,name');
            const records = await app.sdk.list('sys_update_set', params);
            if (records.length === 0) {
              throw new Error(`Update set not found: ${argv.name}`);
            }
            const sysID = getStringField(records[0], 'sys_id');
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
            // Find or create preference
            const prefParams = new URLSearchParams();
            prefParams.set('sysparm_query', `user=${userSysID}^name=sys_update_set`);
            prefParams.set('sysparm_limit', '1');
            const prefs = await app.sdk.list('sys_user_preference', prefParams);
            if (prefs.length > 0) {
              await app.sdk.update('sys_user_preference', getStringField(prefs[0], 'sys_id'), { value: sysID });
            } else {
              await app.sdk.create('sys_user_preference', {
                user: userSysID,
                name: 'sys_update_set',
                value: sysID,
                type: 'string',
              });
            }
            app.ok({ update_set: argv.name, sys_id: sysID }, { summary: `Current update set: ${argv.name}` });
          }),
        })
        .command({
          command: 'create',
          describe: 'Create a new update set',
          builder: (y) => y
            .option('name', { alias: 'n', type: 'string', demandOption: true, describe: 'Update set name' })
            .option('description', { type: 'string', describe: 'Description' }),
          handler: wrap(async (argv, app) => {
            const record = await app.sdk.create('sys_update_set', {
              name: argv.name,
              description: argv.description || argv.name,
              state: 'in progress',
            });

            // Auto-set as current update set
            const sysID = record?.sys_id?.value || record?.sys_id;
            try {
              const user = await app.sdk.list('sys_user', new URLSearchParams({
                sysparm_query: 'user_name=javascript:gs.getUserName()',
                sysparm_limit: '1',
                sysparm_fields: 'sys_id',
              }));
              if (user.length > 0) {
                const userSysID = user[0].sys_id?.value || user[0].sys_id;
                // Check for existing preference
                const prefParams = new URLSearchParams();
                prefParams.set('sysparm_query', `user=${userSysID}^name=sys_update_set`);
                prefParams.set('sysparm_limit', '1');
                const prefs = await app.sdk.list('sys_user_preference', prefParams);
                if (prefs.length > 0) {
                  const prefID = prefs[0].sys_id?.value || prefs[0].sys_id;
                  await app.sdk.update('sys_user_preference', prefID, { value: sysID });
                } else {
                  await app.sdk.create('sys_user_preference', {
                    user: userSysID,
                    name: 'sys_update_set',
                    value: sysID,
                    type: 'string',
                  });
                }
              }
            } catch {
              // Non-fatal — auto-set is a convenience, not mandatory
            }

            app.ok(record, {
              summary: `Created update set: ${argv.name}`,
              breadcrumbs: [
                {
                  action: 'set',
                  cmd: `jsn dev updatesets set "${argv.name}"`,
                  description: 'Switch to this update set',
                },
                {
                  action: 'complete',
                  cmd: `jsn dev updatesets complete "${argv.name}"`,
                  description: 'Mark as complete when done',
                },
              ],
            });
          }),
        })
        .command({
          command: 'yolo',
          aliases: ['silence'],
          describe: 'Silence the "Default update set" warning for this profile',
          handler: wrap(async (argv, app) => {
            const name = app.context.profileName;
            if (!name) {
              throw new Error('No active profile to mark as yolo. Run jsn setup first.');
            }
            app.config.profiles[name].yolo = true;
            const { saveConfig } = await import('../../config.js');
            saveConfig(app.config);
            app.ok({ profile: name, yolo: true }, { summary: 'Default update set warning silenced for this profile' });
          }),
        })
        .command({
          command: 'export <name>',
          describe: 'Export an update set to XML',
          builder: (y) => y
            .positional('name', {
              describe: 'Update set name',
              type: 'string',
            })
            .option('output', {
              alias: 'o',
              type: 'string',
              describe: 'Output file path (default: stdout)',
            }),
          handler: wrap(async (argv, app) => {
            const params = new URLSearchParams();
            params.set('sysparm_query', `name=${argv.name}`);
            params.set('sysparm_limit', '1');
            params.set('sysparm_fields', 'sys_id,name');
            const records = await app.sdk.list('sys_update_set', params);
            if (records.length === 0) {
              throw new Error(`Update set not found: ${argv.name}`);
            }
            const sysID = getStringField(records[0], 'sys_id');
            const instance = app.getEffectiveInstance();
            const url = `${instance}/sys_update_set.do?XML&sysparm_sys_id=${sysID}`;
            const xml = await app.sdk.rawRequest(url, { method: 'GET' });
            if (argv.output) {
              fs.writeFileSync(argv.output, xml, 'utf-8');
              app.ok({ name: argv.name, sys_id: sysID, output: argv.output }, { summary: `Exported update set to ${argv.output}` });
            } else {
              process.stdout.write(xml + '\n');
            }
          }),
        })

    },
    handler: (argv) => {
      if (!argv._[1]) {
        console.log('Manage ServiceNow update sets.\n');
        console.log('Commands:');
        console.log('  list           List update sets');
        console.log('  show <name>    Show an update set');
        console.log('  set  <name>    Set the current update set');
        console.log('  create         Create a new update set (auto-sets as current)');
        console.log('  export <name>  Export an update set to XML');
        console.log('  complete <name>  Mark an update set as complete (coming soon)');
        console.log('  yolo           Silence the "Default update set" warning');
        console.log('\nRun "jsn dev updatesets <command> --help" for details.');
        console.log('\nTip: Create an update set first:');
        console.log('  jsn dev updatesets create --name "My Feature"');
        console.log('  # → Auto-set as current, then record changes are captured.');
      }
    },
  };
}
