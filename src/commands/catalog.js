import { getStringField, interactiveList } from '../helpers.js';

export function catalogCmd(wrap) {
  return {
    command: 'catalogitems [subcommand]',
    aliases: ['ci'],
    describe: 'Manage Service Catalog items',
    builder: (yargs) => {
      return yargs
        .command({
          command: 'list',
          aliases: ['ls'],
          describe: 'List catalog items',
          builder: (y) => y
            .option('limit', { alias: 'l', type: 'number', default: 50 })
            .option('category', { type: 'string' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const query = argv.category ? `category.titleLIKE${argv.category}` : '';

            const picked = await interactiveList({
              app,
              table: 'sc_cat_item',
              singular: 'catalog item',
              columns: ['name', 'short_description', 'category', 'active'],
              limit: argv.limit,
              query,
              labelField: 'name',
              formatLabel: (r) => {
                const n = getStringField(r, 'name') || '';
                const c = getStringField(r, 'category') || '';
                return c ? `${n} [${c}]` : n;
              },
            });

            if (picked === undefined) return;
            if (picked) {
              const sysID = getStringField(picked, 'sys_id') || '';
              const item = await app.sdk.get('sc_cat_item', sysID);
              console.log(`${getStringField(item, 'name')}`);
              if (getStringField(item, 'short_description')) {
                console.log(`  ${getStringField(item, 'short_description')}`);
              }
              console.log(`  Category: ${getStringField(item, 'category') || '(none)'}`);
              console.log(`  Active: ${getStringField(item, 'active') || 'false'}`);
              console.log(`  URL: ${app.getEffectiveInstance()}/sc_cat_item.do?sys_id=${sysID}`);
              return;
            }

            // Fallback — non-TTY
            const p = new URLSearchParams();
            p.set('sysparm_query', query ? `${query}^ORDERBYname` : 'ORDERBYname');
            p.set('sysparm_limit', String(argv.limit));
            p.set('sysparm_display_value', 'all');
            p.set('sysparm_fields', 'name,short_description,category,active');
            const records = await app.sdk.list('sc_cat_item', p);
            app.ok({
              table: 'sc_cat_item',
              count: records.length,
              columns: ['name', 'short_description', 'category', 'active'],
              records,
              context: { instance_url: app.getEffectiveInstance() },
            }, { summary: `${records.length} catalog item(s)` });
          }),
        })
        .command({
          command: 'show <id>',
          aliases: ['get'],
          describe: 'Show a catalog item',
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            let id = argv.id;
            if (!/^[a-f0-9]{32}$/i.test(id)) {
              const p = new URLSearchParams();
              p.set('sysparm_query', `name=${id}`);
              p.set('sysparm_limit', '1');
              p.set('sysparm_fields', 'sys_id');
              const results = await app.sdk.list('sc_cat_item', p);
              if (results.length === 0) throw new Error(`Not found: ${id}`);
              id = results[0].sys_id?.value || results[0].sys_id;
            }
            const item = await app.sdk.get('sc_cat_item', id);
            app.ok(item, {
              summary: getStringField(item, 'name'),
              breadcrumbs: [{ action: 'list', cmd: 'catalogitems list', description: 'Back to list' }],
            });
          }),
        });
    },
    handler: () => {
      console.log('Service Catalog management.');
      console.log('');
      console.log('Commands:');
      console.log('  list       Browse catalog items');
      console.log('  show <id>  Show catalog item');
    },
  };
}
