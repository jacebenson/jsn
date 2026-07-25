import { resolveItemOptionType, getStringField, interactiveList } from '../helpers.js';

export function catalogCmd(wrap) {
  return {
    command: 'catalogitems [subcommand]',
    aliases: ['ci'],
    describe: 'Manage Service Catalog items and variables',
    builder: (yargs) => {
      return yargs
        .command({
          command: 'create',
          aliases: ['new'],
          describe: 'Create a catalog item with variables',
          builder: (y) => y
            .option('name', { alias: 'n', type: 'string', demandOption: true, describe: 'Catalog item name' })
            .option('short-description', { alias: 'd', type: 'string', describe: 'Short description' })
            .option('description', { type: 'string', describe: 'Full description' })
            .option('category', { alias: 'c', type: 'string', describe: 'Category name' })
            .option('variable', { alias: 'v', type: 'array', describe: 'Variable: \"name:type:label\"' })
            .option('variables', { type: 'string', describe: 'JSON for submit_produce' })
            .option('update-set', { type: 'string', describe: 'Update set' }),
          handler: wrap(async (argv, app) => {
            if (argv.variables) {
              let varsObj;
              try { varsObj = JSON.parse(argv.variables); } catch {
                throw new Error('--variables must be valid JSON');
              }
              let itemSysID = argv.name;
              if (!itemSysID.match(/^[a-f0-9]{32}$/i)) {
                const p = new URLSearchParams();
                p.set('sysparm_query', `name=${itemSysID}`); p.set('sysparm_limit', '1'); p.set('sysparm_fields', 'sys_id');
                const items = await app.sdk.list('sc_cat_item', p);
                if (items.length === 0) throw new Error(`Not found: ${itemSysID}`);
                itemSysID = items[0].sys_id?.value || items[0].sys_id;
              }
              const endpoint = `${app.sdk.baseURL}/api/sn_sc/servicecatalog/items/${itemSysID}/submit_produce`;
              const result = await app.sdk.request(endpoint, { method: 'POST', body: JSON.stringify({ variables: varsObj }) });
              const reqID = result?.result?.sys_id || result?.result?.number || '';
              app.ok({ requested_item: reqID, item_id: itemSysID, variables: varsObj },
                { summary: `Request: ${result?.result?.number || reqID}` });
              return;
            }

            const name = argv.name;
            let categoryID = '';
            if (argv.category) {
              const cp = new URLSearchParams();
              cp.set('sysparm_query', `title=${argv.category}`); cp.set('sysparm_limit', '1'); cp.set('sysparm_fields', 'sys_id');
              const cats = await app.sdk.list('sc_category', cp);
              if (cats.length > 0) categoryID = cats[0].sys_id?.value || cats[0].sys_id;
              else { const nc = await app.sdk.create('sc_category', { title: argv.category }); categoryID = nc.sys_id?.value || nc.sys_id; }
            }

            const item = await app.sdk.create('sc_cat_item', {
              name, short_description: argv['short-description'] || '', description: argv.description || '',
              category: categoryID || undefined, active: true, type: 'item', stage: 'requested',
            });
            const itemID = item.sys_id?.value || item.sys_id;

            const varDefs = [];
            if (argv.variable) {
              for (const v of argv.variable) {
                const parts = String(v).split(':');
                if (parts.length >= 2) {
                  const typeName = parts.length >= 2 ? parts[parts.length - 2] : '';
                  const label = parts.length >= 3 ? parts[parts.length - 1] : parts[0];
                  const sysName = parts[0].replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
                  varDefs.push({ name: sysName, question_text: label, type: resolveItemOptionType(typeName),
                    order: varDefs.length * 100 + 100, cat_item: itemID, mandatory: true, active: true });
                }
              }
              for (const vd of varDefs) {
                try { await app.sdk.create('item_option_new', vd); } catch { /* non-fatal */ }
              }
            }
            app.ok({ sys_id: itemID, name, category: argv.category || null, variables_created: varDefs.length },
              { summary: `Created: ${name} (${varDefs.length} variable(s))` });
          }),
        })
        .command({
          command: 'list',
          aliases: ['ls'],
          describe: 'List catalog items',
          builder: (y) => y
            .option('limit', { alias: 'l', type: 'number', default: 20 })
            .option('category', { type: 'string' }),
          handler: wrap(async (argv, app) => {
            const query = argv.category ? `category.titleLIKE${argv.category}` : '';
            const picked = await interactiveList({
              app, table: 'sc_cat_item', singular: 'catalog item', columns: ['name', 'short_description', 'category', 'active', 'sys_class_name'], limit: argv.limit, query, labelField: 'name',
              formatLabel: r => {
                const n = getStringField(r, 'name') || '';
                const c = getStringField(r, 'category') || '';
                const cls = getStringField(r, 'sys_class_name') || '';
                const tag = cls === 'sc_cat_item_producer' ? ' [Producer]' : cls && cls !== 'sc_cat_item' ? ` [${cls}]` : '';
                return c ? `${n}${tag} [${c}]` : n + tag;
              },
            });
            if (picked === undefined) return;
            if (picked) {
              await showCatalogItem(app, getStringField(picked, 'sys_id') || '');
              return;
            }
            // Fallback
            const p = new URLSearchParams();
            p.set('sysparm_query', query ? `${query}^ORDERBYname` : 'ORDERBYname');
            p.set('sysparm_limit', String(argv.limit)); p.set('sysparm_display_value', 'all');
            p.set('sysparm_fields', 'sys_id,name,short_description,category,active');
            const items = await app.sdk.list('sc_cat_item', p);
            if (!Array.isArray(items)) {
              console.log('No items found or API error');
              return;
            }
            app.ok({ table: 'sc_cat_item', count: items.length, columns: ['name', 'short_description', 'category', 'active'],
              records: items.map(r => ({ sys_id: getStringField(r, 'sys_id'), name: getStringField(r, 'name'),
                short_description: getStringField(r, 'short_description'), category: getStringField(r, 'category'),
                active: getStringField(r, 'active') })),
              context: { instance_url: app.getEffectiveInstance() },
            }, { summary: `${items.length} catalog item(s)` });
          }),
        })
        .command({
          command: 'show <id>',
          aliases: ['get'],
          describe: 'Show a catalog item with variables',
          handler: wrap(async (argv, app) => {
            let itemID = argv.id;
            if (!itemID.match(/^[a-f0-9]{32}$/i)) {
              const p = new URLSearchParams();
              p.set('sysparm_query', `name=${itemID}`); p.set('sysparm_limit', '1'); p.set('sysparm_fields', 'sys_id');
              const items = await app.sdk.list('sc_cat_item', p);
              if (items.length === 0) throw new Error(`Not found: ${itemID}`);
              itemID = items[0].sys_id?.value || items[0].sys_id;
            }
            await showCatalogItem(app, itemID);
          }),
        });
    },
    handler: () => {
      console.log('Service Catalog management.');
      console.log('');
      console.log('Commands:');
      console.log('  create       Create a catalog item with variables');
      console.log('  list         Browse and inspect catalog items');
      console.log('  show <id>    Show item details and variables');
      console.log('');
      console.log('Examples:');
      console.log('  jsn catalogitems create "Coffee Maker" --category "Kitchen" \\');
      console.log('    --variable "color:select:Color" --variable "size:string:Size"');
      console.log('  jsn catalogitems list');
      console.log('  jsn catalogitems show Coffee\\ Maker');
    },
  };
}

async function showCatalogItem(app, sysID) {
  const item = await app.sdk.get('sc_cat_item', sysID);
  // Fetch execution plan / workflow info
  const varParams = new URLSearchParams();
  varParams.set('sysparm_query', `cat_item=${sysID}^active=true`);
  varParams.set('sysparm_limit', '100'); varParams.set('sysparm_display_value', 'all');
  varParams.set('sysparm_fields', 'sys_id,name,question_text,type,order,mandatory,variable_set');
  const variables = await app.sdk.list('item_option_new', varParams);

  const standaloneVars = [];
  const setVars = new Map();
  for (const v of variables) {
    const vs = getStringField(v, 'variable_set');
    const entry = {
      sys_id: getStringField(v, 'sys_id'), name: getStringField(v, 'name'),
      question_text: getStringField(v, 'question_text'), type: getStringField(v, 'type'),
      order: getStringField(v, 'order'), mandatory: getStringField(v, 'mandatory'),
    };
    if (vs) {
      if (!setVars.has(vs)) setVars.set(vs, { name: vs, label: vs, variables: [] });
      setVars.get(vs).variables.push(entry);
    } else { standaloneVars.push(entry); }
  }

  const totalVars = standaloneVars.length + Array.from(setVars.values()).reduce((a, s) => a + s.variables.length, 0);
  const lines = [];
  lines.push(`${getStringField(item, 'name')}`);
  if (getStringField(item, 'short_description')) lines.push(`  ${getStringField(item, 'short_description')}`);
  lines.push(`  Category: ${getStringField(item, 'category') || '(none)'}`);
  lines.push(`  Active: ${getStringField(item, 'active') || 'false'}`);
  const cls = getStringField(item, 'sys_class_name') || '';
  if (cls && cls !== 'sc_cat_item') {
    const label = cls === 'sc_cat_item_producer' ? 'Record Producer' : cls === 'sc_cat_item_guide' ? 'Order Guide' : cls;
    lines.push(`  Class: ${label}`);
  }
  if (app.getEffectiveInstance() && sysID) {
    lines.push(`  URL: ${app.getEffectiveInstance()}/sc_cat_item.do?sys_id=${sysID}`);
  }

  // Flow / Workflow / Execution plan (priority: flow > workflow > plan)
  const flow = getStringField(item, 'flow_designer_flow');
  const workflow = getStringField(item, 'workflow');
  const plan = getStringField(item, 'delivery_plan') || getStringField(item, 'execution_plan');
  if (flow) lines.push(`  Flow: ${flow}`);
  else if (workflow) lines.push(`  Workflow: ${workflow}`);
  else if (plan) lines.push(`  Execution Plan: ${plan}`);

  lines.push(`  Variables (${totalVars}):`);
  for (const v of standaloneVars) {
    const flags = String(v.mandatory) === 'true' ? ' [required]' : '';
    lines.push(`    ${v.question_text || v.name}  ${v.type || ''}${flags}`);
  }
  for (const [_, sd] of setVars) {
    lines.push(`    [${sd.label || sd.name}]`);
    for (const v of sd.variables) {
      const flags = String(v.mandatory) === 'true' ? ' [required]' : '';
      lines.push(`      ${v.question_text || v.name}  ${v.type || ''}${flags}`);
    }
  }
  console.log(lines.join('\n'));
}
