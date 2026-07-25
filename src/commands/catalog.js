import { getStringField, interactiveList } from '../helpers.js';

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
            .option('variables', { type: 'string', describe: 'JSON for submit_produce: {\"key\":\"value\"}' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();

            // submit_produce path
            if (argv.variables) {
              let varsObj;
              try { varsObj = JSON.parse(argv.variables); } catch { throw new Error('--variables must be valid JSON'); }
              let itemSysID = argv.name;
              if (!/^[a-f0-9]{32}$/i.test(itemSysID)) {
                const sp = new URLSearchParams();
                sp.set('sysparm_query', `name=${itemSysID}`);
                sp.set('sysparm_limit', '1');
                sp.set('sysparm_fields', 'sys_id');
                const items = await app.sdk.list('sc_cat_item', sp);
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
                    const typeMap = { string: '6', multilinetext: '2', select: '3', date: '4', datetime: '5', reference: '8', checkbox: '12', email: '11' };
                    await app.sdk.create('item_option_new', {
                      name: sysName, question_text: label, type: typeMap[typeName] || '6',
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
  const item = await app.sdk.get('sc_cat_item', sysID);

  const vp = new URLSearchParams();
  vp.set('sysparm_query', `cat_item=${sysID}^active=true`);
  vp.set('sysparm_limit', '100');
  vp.set('sysparm_display_value', 'all');
  vp.set('sysparm_fields', 'sys_id,name,question_text,type,order,mandatory,variable_set');
  const variables = await app.sdk.list('item_option_new', vp);

  const standalone = [];
  const setVars = new Map();
  for (const v of variables) {
    const vs = getStringField(v, 'variable_set');
    const entry = {
      name: getStringField(v, 'name'),
      question_text: getStringField(v, 'question_text'),
      type: getStringField(v, 'type'),
      mandatory: getStringField(v, 'mandatory'),
    };
    if (vs) {
      if (!setVars.has(vs)) setVars.set(vs, { name: vs, variables: [] });
      setVars.get(vs).variables.push(entry);
    } else {
      standalone.push(entry);
    }
  }
  const totalVars = standalone.length + Array.from(setVars.values()).reduce((a, s) => a + s.variables.length, 0);

  // Resolve flow name
  let flowName = '', flowCmd = '';
  const flowVal = item.flow_designer_flow;
  if (flowVal?.value) {
    const fn = getStringField(item, 'flow_designer_flow');
    if (fn === flowVal.value) {
      try { const fr = await app.sdk.get('sys_hub_flow', flowVal.value); flowName = getStringField(fr, 'name') || ''; } catch { flowName = fn; }
    } else { flowName = fn; }
    flowCmd = `jsn flows show ${flowVal.value}`;
  }
  const wfName = getStringField(item, 'workflow') || '';
  const wfID = item.workflow?.value || '';
  const planName = getStringField(item, 'delivery_plan') || getStringField(item, 'execution_plan') || '';
  const planID = item.delivery_plan?.value || item.execution_plan?.value || '';

  app.ok({
    name: getStringField(item, 'name'),
    short_description: getStringField(item, 'short_description'),
    category: getStringField(item, 'category'),
    active: getStringField(item, 'active'),
    url: `${app.getEffectiveInstance()}/sc_cat_item.do?sys_id=${sysID}`,
    flow: flowName || undefined,
    flow_cmd: flowCmd || undefined,
    workflow: wfName || undefined,
    workflow_cmd: (wfName && wfID) ? `jsn workflows show ${wfID}` : undefined,
    execution_plan: planName || undefined,
    variables: totalVars > 0 ? {
      count: totalVars,
      standalone: standalone.map(v => ({ label: v.question_text || v.name, type: v.type, mandatory: String(v.mandatory) === 'true' })),
      sets: Array.from(setVars.values()).map(s => ({ name: s.name, variables: s.variables.map(v => ({ label: v.question_text || v.name, type: v.type, mandatory: String(v.mandatory) === 'true' })) })),
    } : undefined,
  }, {
    summary: `${getStringField(item, 'name')} — ${totalVars} variable(s)`,
  });
}
