// Catalog item management commands
// NOTE: This is an AI-friendly high-level command that wraps sc_cat_item + item_option_new

import { resolveItemOptionType, getStringField } from '../helpers.js';

export function catalogCmd(wrap) {
  return {
    command: 'catalog <subcommand>',
    aliases: ['cat'],
    describe: 'Manage Service Catalog items and variables',
    builder: (yargs) => {
      return yargs
        // ── create-item: Create a new catalog item definition ──
        .command({
          command: 'create-item',
          describe: 'Create a catalog item (sc_cat_item) with variables',
          builder: (y) => y
            .option('name', { alias: 'n', type: 'string', demandOption: true, describe: 'Catalog item name' })
            .option('short-description', { alias: 'd', type: 'string', describe: 'Short description' })
            .option('description', { type: 'string', describe: 'Full description' })
            .option('category', { alias: 'c', type: 'string', describe: 'Category name (created if missing)' })
            .option('variable', { alias: 'v', type: 'array', describe: 'Variable definition in format "name:type:label" or "name:type" (e.g. "reason:multilinetext:Reason" or "start_date:date")' })
            .option('variables', { type: 'string', describe: 'JSON object of variable values for submit_produce API (e.g. \'{"quantity":"100","reason":"Need more"}\')' })
            .option('update-set', { type: 'string', describe: 'Update set sys_id or name to capture changes' }),
          handler: wrap(async (argv, app) => {
            // If --variables is provided, use submit_produce API (request against existing item)
            if (argv.variables) {
              let varsObj;
              try {
                varsObj = JSON.parse(argv.variables);
              } catch {
                throw new Error('--variables must be a valid JSON object, e.g. {"reason":"Need this"}');
              }
              // Resolve the catalog item sys_id from name if needed
              let itemSysID = argv.name;
              if (!itemSysID.match(/^[a-f0-9]{32}$/i)) {
                const params = new URLSearchParams();
                params.set('sysparm_query', `name=${itemSysID}`);
                params.set('sysparm_limit', '1');
                params.set('sysparm_fields', 'sys_id');
                const items = await app.sdk.list('sc_cat_item', params);
                if (items.length === 0) throw new Error(`Catalog item not found: ${itemSysID}`);
                const item = items[0];
                itemSysID = item.sys_id?.value || item.sys_id;
              }
              // Submit via submit_produce API
              const endpoint = `${app.sdk.baseURL}/api/sn_sc/servicecatalog/items/${itemSysID}/submit_produce`;
              const body = { variables: varsObj };
              const result = await app.sdk.request(endpoint, {
                method: 'POST',
                body: JSON.stringify(body),
              });
              const reqID = result?.result?.sys_id || result?.result?.number || '';
              app.ok({
                requested_item: reqID,
                item_id: itemSysID,
                variables: varsObj,
              }, {
                summary: `Request created: ${result?.result?.number || reqID}`,
                breadcrumbs: [
                  { action: 'view', cmd: `jsn requests show ${reqID}`, description: 'View the request' },
                ],
              });
              return;
            }

            // Original create-item flow: create a new catalog item definition
            const name = argv.name;
            const shortDesc = argv['short-description'] || '';
            const description = argv.description || shortDesc;
            let categoryID = '';

            // Resolve or create category
            if (argv.category) {
              const catParams = new URLSearchParams();
              catParams.set('sysparm_query', `title=${argv.category}`);
              catParams.set('sysparm_limit', '1');
              catParams.set('sysparm_fields', 'sys_id,title');
              const cats = await app.sdk.list('sc_category', catParams);
              if (cats.length > 0) {
                categoryID = cats[0].sys_id?.value || cats[0].sys_id;
              } else {
                const newCat = await app.sdk.create('sc_category', {
                  title: argv.category,
                  description: `Category for ${argv.category}`,
                });
                categoryID = newCat.sys_id?.value || newCat.sys_id;
              }
            }

            // Create the catalog item
            const item = await app.sdk.create('sc_cat_item', {
              name,
              short_description: shortDesc,
              description,
              category: categoryID || undefined,
              active: true,
              type: 'item',
              stage: 'requested',
            });
            const itemID = item.sys_id?.value || item.sys_id;

            // Parse and create variables
            const varDefs = [];
            if (argv.variable) {
              for (const v of argv.variable) {
                const parts = String(v).split(':');
                if (parts.length >= 2) {
                  const typeName = parts.length >= 2 ? parts[parts.length - 2] : '';
                  const label = parts.length >= 3 ? parts[parts.length - 1] : parts[0];
                  const typeID = resolveItemOptionType(typeName);
                  const sysName = parts[0].replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
                  varDefs.push({
                    name: sysName,
                    question_text: label,
                    type: typeID,
                    order: varDefs.length * 100 + 100,
                    cat_item: itemID,
                    mandatory: true,
                    active: true,
                  });
                }
              }

              for (const vd of varDefs) {
                try {
                  await app.sdk.create('item_option_new', vd);
                } catch {
                  // variable creation failure is non-fatal
                }
              }
            }

            app.ok({
              sys_id: itemID,
              name,
              category: argv.category || null,
              variables_created: varDefs.length,
              update_set: argv['update-set'] || null,
              instance_url: app.getEffectiveInstance(),
            }, {
              summary: `Created catalog item: ${name} (${varDefs.length} variable(s))`,
              breadcrumbs: [
                { action: 'view', cmd: `jsn records get --table sc_cat_item --sys-id ${itemID}`, description: 'View the catalog item' },
                { action: 'edit', cmd: `jsn catalog update-item ${itemID} --name "${name}"`, description: 'Edit the catalog item' },
              ],
            });
          }),
        })
        // ── items: List and show catalog items ──
        .command({
          command: 'items <subcommand>',
          aliases: ['item'],
          describe: 'Browse catalog items and inspect variables',
          builder: (y) => y
            .command({
              command: 'list',
              aliases: ['ls'],
              describe: 'List catalog items',
              builder: (y) => y
                .option('limit', { alias: 'l', type: 'number', default: 20, describe: 'Max records' })
                .option('category', { type: 'string', describe: 'Filter by category' }),
              handler: wrap(async (argv, app) => {
                let query = 'ORDERBYname';
                if (argv.category) query = `category.titleLIKE${argv.category}^${query}`;
                const params = new URLSearchParams();
                params.set('sysparm_query', query);
                params.set('sysparm_limit', String(argv.limit));
                params.set('sysparm_display_value', 'all');
                params.set('sysparm_fields', 'sys_id,name,short_description,category,active');
                const items = await app.sdk.list('sc_cat_item', params);
                app.ok({
                  table: 'sc_cat_item',
                  count: items.length,
                  columns: ['name', 'short_description', 'category', 'active'],
                  records: items.map(r => ({
                    sys_id: getStringField(r, 'sys_id'),
                    name: getStringField(r, 'name'),
                    short_description: getStringField(r, 'short_description'),
                    category: getStringField(r, 'category'),
                    active: getStringField(r, 'active'),
                  })),
                  context: { instance_url: app.getEffectiveInstance() },
                }, { summary: `${items.length} catalog item(s)` });
              }),
            })
            .command({
              command: 'show <id>',
              describe: 'Show a catalog item with variables and variable sets',
              handler: wrap(async (argv, app) => {
                let itemID = argv.id;
                // Resolve name to sys_id
                if (!itemID.match(/^[a-f0-9]{32}$/i)) {
                  const params = new URLSearchParams();
                  params.set('sysparm_query', `name=${itemID}`);
                  params.set('sysparm_limit', '1');
                  params.set('sysparm_fields', 'sys_id,name');
                  const items = await app.sdk.list('sc_cat_item', params);
                  if (items.length === 0) throw new Error(`Catalog item not found: ${itemID}`);
                  itemID = items[0].sys_id?.value || items[0].sys_id;
                }

                // Get the catalog item
                const item = await app.sdk.get('sc_cat_item', itemID);

                // Get variables (item_option_new) for this catalog item
                const varParams = new URLSearchParams();
                varParams.set('sysparm_query', `cat_item=${itemID}^active=true`);
                varParams.set('sysparm_limit', '100');
                varParams.set('sysparm_display_value', 'all');
                varParams.set('sysparm_fields', 'sys_id,name,question_text,type,order,mandatory,variable_set');
                const variables = await app.sdk.list('item_option_new', varParams);

                // Separate standalone vs variable-set variables
                const standaloneVars = [];
                const setVars = new Map(); // set_sys_id -> { name, label, variables: [] }
                for (const v of variables) {
                  const vs = v.variable_set?.value || v.variable_set;
                  const entry = {
                    sys_id: v.sys_id?.value || v.sys_id,
                    name: v.name?.value || v.name || '',
                    question_text: v.question_text?.display_value || v.question_text || '',
                    type: v.type?.display_value || v.type,
                    order: v.order?.display_value || v.order,
                    mandatory: v.mandatory?.display_value || v.mandatory,
                  };
                  if (vs) {
                    if (!setVars.has(vs)) {
                      setVars.set(vs, { name: vs, label: vs, variables: [] });
                    }
                    setVars.get(vs).variables.push(entry);
                  } else {
                    standaloneVars.push(entry);
                  }
                }

                // Try to resolve variable set names
                for (const [sysID, setData] of setVars) {
                  try {
                    const vsRecord = await app.sdk.get('sc_cat_item_option_set', sysID);
                    setData.name = vsRecord.name?.value || vsRecord.name || sysID;
                    setData.label = vsRecord.label?.value || vsRecord.label || setData.name;
                    setData.order = vsRecord.order?.display_value || vsRecord.order;
                  } catch {
                    // Can't resolve, keep sys_id as name
                  }
                }

                app.ok({
                  sys_id: itemID,
                  name: item.name?.display_value || item.name,
                  short_description: item.short_description?.display_value || item.short_description || '',
                  description: item.description?.display_value || item.description || '',
                  category: item.category?.display_value || '',
                  active: item.active?.display_value || item.active,
                  variables: {
                    standalone: standaloneVars,
                    variable_sets: Array.from(setVars.values()),
                  },
                  instance_url: app.getEffectiveInstance(),
                }, {
                  summary: `${item.name?.display_value || item.name} — ${standaloneVars.length + Array.from(setVars.values()).reduce((a, s) => a + s.variables.length, 0)} variable(s)`,
                });
              }),
            })
            .demandCommand(1, 'Specify a subcommand: list or show'),
              handler: () => {},
            });
    },
    handler: (argv) => {
      if (!argv._[1]) {
        console.log('Manage Service Catalog items.\n');
        console.log('Commands:');
        console.log('  create-item    Create a catalog item, or submit a request via submit_produce');
        console.log('  items list     List catalog items');
        console.log('  items show     Show catalog item details with variables');
        console.log('\nExamples:');
        console.log('  jsn catalog create-item "Request PTO" \\');
        console.log('    --category "Time Off" \\');
        console.log('    --short-description "Submit a PTO request" \\');
        console.log('    --variable "start_date:date:Start Date" \\');
        console.log('    --variable "type:select:Type" \\');
        console.log('    --variable "reason:multilinetext:Reason/Notes"');
        console.log('');
        console.log('  # Submit a request via submit_produce:');
        console.log('  jsn catalog create-item "Minecraft Coins" \\');
        console.log('    --variables \'{"quantity":"100","reason":"Server upgrade"}\'');
        console.log('\nVariable types: string, multilinetext, select, date, datetime, reference, checkbox, email');
        console.log('\nRun "jsn catalog <command> --help" for details.');
      }
    },
  };
}
