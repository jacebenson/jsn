import { getStringField, interactiveList, resolveItemOptionType } from '../helpers.js';
import { resolveSysId } from '../resolve-record.js';
import { declareCapabilities } from '../capabilities.js';
import { enrichCatalogItem, buildCatalogFormatted } from './catalog/enrich.js';

declareCapabilities('catalogitems', { mutationSubcommands: ['create'] });

export function catalogCmd(wrap) {
  return {
    command: 'catalogitems [subcommand]',
    aliases: ['ci'],
    describe: 'Manage Service Catalog items',
    builder: (yargs) => {
      return yargs
        .command({
          command: 'create',
          aliases: ['new'],
          describe: 'Create a catalog item',
          builder: (y) => y
            .option('name', { alias: 'n', type: 'string', demandOption: true })
            .option('short-description', { alias: 'd', type: 'string' })
            .option('category', { alias: 'c', type: 'string' })
            .option('variable', { alias: 'v', type: 'array', describe: 'Variable: "name:type:label"' })
            .option('variables', { type: 'string', describe: 'JSON for submit_produce: {"key":"value"}' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();

            // submit_produce path
            if (argv.variables) {
              let varsObj;
              try { varsObj = JSON.parse(argv.variables); } catch { throw new Error('--variables must be valid JSON'); }
              const itemSysID = await resolveSysId(app.sdk, { table: 'sc_cat_item', identifier: argv.name, matchField: 'name', resource: 'Catalog item' });
              const endpoint = `${app.sdk.baseURL}/api/sn_sc/servicecatalog/items/${itemSysID}/submit_produce`;
              const result = await app.sdk.request(endpoint, { method: 'POST', body: JSON.stringify({ variables: varsObj }) });
              const reqID = result?.result?.sys_id || result?.result?.number || '';
              app.ok({ requested_item: reqID, item_id: itemSysID, variables: varsObj },
                { summary: `Request: ${result?.result?.number || reqID}` });
              return;
            }

            let categoryID = '';
            if (argv.category) {
              const cp = new URLSearchParams();
              cp.set('sysparm_query', `title=${argv.category}`);
              cp.set('sysparm_limit', '1');
              cp.set('sysparm_fields', 'sys_id');
              const cats = await app.sdk.list('sc_category', cp);
              if (cats.length > 0) categoryID = cats[0].sys_id?.value || cats[0].sys_id;
              else { const nc = await app.sdk.create('sc_category', { title: argv.category }); categoryID = nc.sys_id?.value || nc.sys_id; }
            }
            const item = await app.sdk.create('sc_cat_item', {
              name: argv.name,
              short_description: argv['short-description'] || '',
              category: categoryID || undefined,
              active: true,
              type: 'item',
            });
            const itemID = item.sys_id?.value || item.sys_id;

            // Create variables if --variable flag(s) provided
            let varCount = 0;
            if (argv.variable) {
              for (const v of argv.variable) {
                const parts = String(v).split(':');
                if (parts.length >= 2) {
                  const typeName = parts.length >= 2 ? parts[parts.length - 1] : '';
                  const label = parts.length >= 3 ? parts[parts.length - 1] : parts[0];
                  const sysName = parts[0].replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
                  try {
                    await app.sdk.create('item_option_new', {
                      name: sysName, question_text: label, type: resolveItemOptionType(typeName),
                      order: (varCount + 1) * 100, cat_item: itemID, mandatory: true, active: true,
                    });
                    varCount++;
                  } catch { /* non-fatal */ }
                }
              }
            }

            app.ok({ sys_id: itemID, name: argv.name, variables_created: varCount },
              { summary: `Created: ${argv.name}${varCount ? ` (${varCount} variable(s))` : ''}` });
          }),
        })
        .command({
          command: 'list',
          aliases: ['ls'],
          describe: 'List catalog items',
          builder: (y) => y
            .option('limit', { alias: 'l', type: 'number', default: 50 })
            .option('category', { type: 'string' })
            .option('query', { type: 'string', describe: 'Encoded query (e.g. active=true)' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const query = argv.query || (argv.category ? `category.titleLIKE${argv.category}` : '');

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
              await showItem(app, getStringField(picked, 'sys_id') || '');
              return;
            }

            // Fallback — non-TTY / --json / --styled
            const p = new URLSearchParams();
            p.set('sysparm_query', query ? `${query}^ORDERBYname` : 'ORDERBYname');
            p.set('sysparm_limit', String(argv.limit));
            p.set('sysparm_display_value', 'all');
            p.set('sysparm_fields', 'name,short_description,category,active');
            const records = await app.sdk.list('sc_cat_item', p);
            // Map reference fields to strings for styled/table renderer
            const safe = records.map(r => ({
              name: getStringField(r, 'name'),
              short_description: getStringField(r, 'short_description'),
              category: getStringField(r, 'category'),
              active: getStringField(r, 'active'),
            }));
            app.ok({
              table: 'sc_cat_item',
              count: safe.length,
              columns: ['name', 'short_description', 'category', 'active'],
              records: safe,
              context: { instance_url: app.getEffectiveInstance() },
            }, { summary: `${safe.length} catalog item(s)` });
          }),
        })
        .command({
          command: 'show <id>',
          aliases: ['get'],
          describe: 'Show a catalog item',
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const id = await resolveSysId(app.sdk, { table: 'sc_cat_item', identifier: argv.id, matchField: 'name', resource: 'Catalog item' });
            await showItem(app, id);
          }),
        });
    },
    handler: () => {
      console.log('Service Catalog management.');
      console.log('');
      console.log('Commands:');
      console.log('  create     Create a catalog item');
      console.log('  list       Browse catalog items');
      console.log('  show <id>  Show catalog item');
    },
  };
}

async function showItem(app, sysID) {
  const { data, standalone, setVars, totalVars } = await enrichCatalogItem({
    sdk: app.sdk,
    instanceUrl: app.getEffectiveInstance(),
    sysID,
  });

  // Styled-mode rendering (non-enumerable so JSON output stays clean)
  Object.defineProperty(data, '_formatted', {
    value: buildCatalogFormatted(data, standalone, setVars, totalVars),
    enumerable: false,
    configurable: true,
  });

  app.ok(data, {
    summary: `${data.name} — ${totalVars} variable(s)`,
    breadcrumbs: [
      { action: 'list', cmd: 'jsn catalogitems list', description: 'Back to all catalog items' },
    ],
  });
}
