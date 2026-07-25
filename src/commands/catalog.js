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
            .option('category', { alias: 'c', type: 'string' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
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
            app.ok(item, { summary: `Created: ${argv.name}` });
          }),
        })
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
              await showItem(app, getStringField(picked, 'sys_id') || '');
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

  // Fetch variables
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

  const lines = [];
  lines.push(getStringField(item, 'name'));
  if (getStringField(item, 'short_description')) lines.push(`  ${getStringField(item, 'short_description')}`);
  lines.push(`  Category: ${getStringField(item, 'category') || '(none)'}`);
  lines.push(`  Active: ${getStringField(item, 'active') || 'false'}`);
  lines.push(`  URL: ${app.getEffectiveInstance()}/sc_cat_item.do?sys_id=${sysID}`);

  // Flow / Workflow / Execution Plan
  const flowName = getStringField(item, 'flow_designer_flow');
  const flowID = item.flow_designer_flow?.value || '';
  const wfName = getStringField(item, 'workflow');
  const wfID = item.workflow?.value || '';
  const planName = getStringField(item, 'delivery_plan') || getStringField(item, 'execution_plan');
  if (flowName) {
    lines.push(`  Flow: ${flowName}`);
    if (flowID) lines.push(`    → jsn flows show ${flowID}`);
  } else if (wfName) {
    lines.push(`  Workflow: ${wfName}`);
    if (wfID) lines.push(`    → jsn workflows show ${wfID}`);
  } else if (planName) {
    const planID = item.delivery_plan?.value || item.execution_plan?.value || '';
    if (planName === planID && planID) {
      try {
        const planRec = await app.sdk.get('delivery_plan', planID);
        const realName = getStringField(planRec, 'name') || getStringField(planRec, 'short_description') || planID;
        lines.push(`  Execution Plan: ${realName}`);
        lines.push(`    → jsn records get --table delivery_plan --sys-id ${planID}`);
      } catch {
        lines.push(`  Execution Plan: ${planName}`);
      }
    } else {
      lines.push(`  Execution Plan: ${planName}`);
    }
  }

  if (totalVars > 0) {
    lines.push(`  Variables (${totalVars}):`);
    for (const v of standalone) {
      const flags = String(v.mandatory) === 'true' ? ' [required]' : '';
      lines.push(`    ${v.question_text || v.name}  ${v.type || ''}${flags}`);
    }
    for (const [_, sd] of setVars) {
      lines.push(`    [${sd.name}]`);
      for (const v of sd.variables) {
        const flags = String(v.mandatory) === 'true' ? ' [required]' : '';
        lines.push(`      ${v.question_text || v.name}  ${v.type || ''}${flags}`);
      }
    }
  }

  console.log(lines.join('\n'));
}
