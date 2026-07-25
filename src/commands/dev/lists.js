import { getStringField, interactiveList } from '../../helpers.js';

export function listsCmd(wrap) {
  return {
    command: 'lists [subcommand]',
    aliases: ['list-layout', 'l'],
    describe: 'List views for a table',
    builder: (yargs) => {
      return yargs
        .command({
          command: 'list [table]',
          aliases: ['ls'],
          describe: 'List views for a table (or pick from all tables)',
          builder: (y) => y
            .positional('table', { type: 'string', describe: 'Table name (e.g. incident)' })
            .option('limit', { alias: 'l', type: 'number', default: 50 }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            let table = argv.table;
            let viewSysID = null;

            // If no table, pick one interactively
            if (!table) {
              const tpicked = await interactiveList({
                app, table: 'sys_ui_list', singular: 'table',
                columns: ['name'],
                limit: argv.limit,
                labelField: 'name',
                groupBy: 'name',
              });
              if (!tpicked) return;
              table = getStringField(tpicked, 'name');
            }

            // Show list views for table
            const picked = await interactiveList({
              app, table: 'sys_ui_list', singular: 'list',
              columns: ['name', 'view'],
              limit: argv.limit,
              query: table ? `name=${table}` : '',
              labelField: 'view',
              formatLabel: (r) => `${getStringField(r, 'view')}`,
            });

            if (picked) {
              const sysID = getStringField(picked, 'sys_id') || '';
              viewSysID = getStringField(picked, 'view') || '';
              await showList(app, table, viewSysID, sysID);
              return;
            }

            // Fallback non-TTY
            const p = new URLSearchParams();
            p.set('sysparm_limit', String(argv.limit));
            p.set('sysparm_display_value', 'all');
            p.set('sysparm_fields', 'name,view');
            p.set('sysparm_query', table ? `name=${table}^ORDERBYview` : 'ORDERBYview');
            const records = await app.sdk.list('sys_ui_list', p);
            app.ok({
              table: 'sys_ui_list',
              count: records.length,
              columns: ['name', 'view'],
              records: records.map(r => ({ name: getStringField(r, 'name'), view: getStringField(r, 'view') })),
              context: { instance_url: app.getEffectiveInstance() },
            }, { summary: `${records.length} list view(s)${table ? ` for ${table}` : ''}` });
          }),
        })
        .command({
          command: 'show <table>',
          aliases: ['get'],
          describe: 'Show list layout',
          builder: (y) => y
            .option('view', { type: 'string', default: 'Default view' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const table = argv.table;

            // Resolve view sys_id
            let viewSysID = '';
            const vp = new URLSearchParams();
            vp.set('sysparm_limit', '1'); vp.set('sysparm_fields', 'sys_id');
            vp.set('sysparm_query', `name=${argv.view}^name=${table}`);
            const vr = await app.sdk.list('sys_ui_view', vp);
            viewSysID = vr.length > 0 ? getStringField(vr[0], 'sys_id') : '';

            // Find list layout
            const lp = new URLSearchParams();
            lp.set('sysparm_limit', '1'); lp.set('sysparm_display_value', 'all');
            lp.set('sysparm_fields', 'sys_id,name,view');
            lp.set('sysparm_query', `name=${table}^view=${viewSysID || argv.view}`);
            const layouts = await app.sdk.list('sys_ui_list', lp);
            if (layouts.length === 0) throw new Error(`No list layout for ${table} view "${argv.view}"`);
            await showList(app, table, getStringField(layouts[0], 'view') || argv.view, getStringField(layouts[0], 'sys_id'));
          }),
        });
    },
    handler: () => {
      console.log('Manage list layouts.');
      console.log('');
      console.log('Commands:');
      console.log('  list [table]      List views (pick table if omitted)');
      console.log('  show <table>      Show list layout columns');
    },
  };
}

async function showList(app, table, viewName, layoutSysID) {
  const ep = new URLSearchParams();
  ep.set('sysparm_limit', '100'); ep.set('sysparm_display_value', 'all');
  ep.set('sysparm_fields', 'element,position,type');
  ep.set('sysparm_query', `list_id=${layoutSysID}^ORDERBYposition`);
  const elements = await app.sdk.list('sys_ui_list_element', ep);

  elements.sort((a, b) => {
    const pa = parseInt(getStringField(a, 'position') || '0', 10) || 0;
    const pb = parseInt(getStringField(b, 'position') || '0', 10) || 0;
    return pa - pb;
  });

  app.ok({
    table,
    view: viewName,
    columns: elements.map(e => ({
      element: getStringField(e, 'element'),
      position: parseInt(getStringField(e, 'position') || '0', 10) || 0,
      type: getStringField(e, 'type') || undefined,
    })),
    _context: { instance_url: app.getEffectiveInstance(), table: 'sys_ui_list' },
  }, { summary: `${table} (${viewName}) — ${elements.length} columns` });
}
