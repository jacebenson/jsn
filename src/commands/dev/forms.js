import { getStringField, interactiveList } from '../../helpers.js';

function getDisplayValue(record, key) {
  if (!record || typeof record !== 'object') return '';
  const val = record[key];
  if (val == null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object') {
    if (val.display_value != null && val.display_value !== '') return String(val.display_value);
    if (val.value != null) return String(val.value);
  }
  return String(val);
}

function getIntValue(record, key) {
  if (!record || typeof record !== 'object') return 0;
  const val = record[key];
  if (val == null) return 0;
  if (typeof val === 'number') return Math.floor(val);
  if (typeof val === 'string') { const n = parseInt(val, 10); return isNaN(n) ? 0 : n; }
  if (typeof val === 'object' && val.value != null) { const n = parseInt(val.value, 10); return isNaN(n) ? 0 : n; }
  return 0;
}

function getBoolValue(record, key) {
  if (!record || typeof record !== 'object') return false;
  const val = record[key];
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') return val === 'true';
  if (typeof val === 'object' && val.value != null) return String(val.value) === 'true';
  return false;
}

async function showForm(app, table, viewName) {
  // 1) Look up the view
  const viewParams = new URLSearchParams();
  viewParams.set('sysparm_limit', '1');
  viewParams.set('sysparm_fields', 'sys_id,name,title');
  viewParams.set('sysparm_query', `name=${viewName}`);
  viewParams.set('sysparm_display_value', 'all');
  let viewSysID = '';
  try {
    const vr = await app.sdk.list('sys_ui_view', viewParams);
    if (vr.length > 0) viewSysID = getStringField(vr[0], 'sys_id');
  } catch { /* ignore */ }
  if (!viewSysID) {
    viewParams.set('sysparm_query', `title=${viewName}`);
    try {
      const vr = await app.sdk.list('sys_ui_view', viewParams);
      if (vr.length > 0) viewSysID = getStringField(vr[0], 'sys_id');
    } catch { /* ignore */ }
  }

  // 2) Get sections for this table + view
  const secParams = new URLSearchParams();
  secParams.set('sysparm_limit', '200');
  secParams.set('sysparm_fields', 'sys_id,name,view,caption,header,order,position,label');
  secParams.set('sysparm_display_value', 'all');
  secParams.set('sysparm_query', `name=${table}^view=${viewName}^ORDERBYorder`);
  const sections = await app.sdk.list('sys_ui_section', secParams);

  // 3) Get elements for each section
  const sectionsOut = [];
  for (const sec of sections) {
    const secSysID = getStringField(sec, 'sys_id');
    const elemParams = new URLSearchParams();
    elemParams.set('sysparm_limit', '500');
    elemParams.set('sysparm_fields', 'sys_id,element,type,label,mandatory,visible,read_only,order,default_value,help_tag,choice_table,reference');
    elemParams.set('sysparm_display_value', 'all');
    elemParams.set('sysparm_query', `sys_ui_section=${secSysID}^ORDERBYorder`);
    let elements = [];
    try {
      elements = await app.sdk.list('sys_ui_element', elemParams);
    } catch { /* ignore */ }

    sectionsOut.push({
      name: getDisplayValue(sec, 'name'),
      caption: getDisplayValue(sec, 'caption'),
      label: getDisplayValue(sec, 'label'),
      order: getIntValue(sec, 'order'),
      header: getBoolValue(sec, 'header'),
      position: getIntValue(sec, 'position'),
      elements: elements.map(e => ({
        type: getDisplayValue(e, 'type'),
        label: getDisplayValue(e, 'label'),
        element: getDisplayValue(e, 'element'),
        mandatory: getBoolValue(e, 'mandatory'),
        visible: getBoolValue(e, 'visible'),
        read_only: getBoolValue(e, 'read_only'),
        order: getIntValue(e, 'order'),
        default_value: getDisplayValue(e, 'default_value'),
        help_tag: getDisplayValue(e, 'help_tag'),
        choice_table: getDisplayValue(e, 'choice_table'),
        reference: getDisplayValue(e, 'reference'),
      })),
    });
  }

  const totalElements = sectionsOut.reduce((sum, s) => sum + s.elements.length, 0);
  app.ok({
    table, view: viewName, view_sys_id: viewSysID,
    section_count: sectionsOut.length,
    element_count: totalElements,
    sections: sectionsOut,
    context: { instance_url: app.getEffectiveInstance() },
  }, {
    summary: `${sectionsOut.length} section(s), ${totalElements} element(s) in ${table} → ${viewName}`,
  });
}

export function formsCmd(wrap) {
  return {
    command: 'forms [subcommand]',
    aliases: ['form', 'f'],
    describe: 'Manage UI Forms',
    builder: (yargs) => {
      return yargs
        .command({
          command: 'list [table]',
          aliases: ['ls'],
          describe: 'List form views',
          builder: (y) => y
            .positional('table', { describe: 'Table name (e.g. incident, change_request)', type: 'string' })
            .option('limit', { alias: 'l', type: 'number', default: 50, describe: 'Max records' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const table = argv.table || '';
            const query = table ? `name=${table}` : '';

            const picked = await interactiveList({
              app, table: 'sys_ui_section', singular: 'form view', columns: ['name', 'view', 'caption', 'order'], limit: argv.limit, query, labelField: 'view',
              formatLabel: r => {
                const t = getStringField(r, 'name') || '';
                const v = getStringField(r, 'view') || '';
                const cap = getStringField(r, 'caption') || '';
                return cap ? `${t} — ${v} (${cap})` : `${t} — ${v}`;
              },
            });
            if (picked === undefined) return;
            if (picked) {
              const t = getStringField(picked, 'name') || '';
              const v = getStringField(picked, 'view') || 'Default view';
              // Show full form layout using the show logic
              await showForm(app, t, v);
              return;
            }

            // Fallback
            const params = new URLSearchParams();
            params.set('sysparm_limit', String(argv.limit));
            params.set('sysparm_fields', 'name,view,caption,order,sys_id');
            params.set('sysparm_display_value', 'all');
            params.set('sysparm_query', (query || '') + '^ORDERBYname,view');
            const records = await app.sdk.list('sys_ui_section', params);

            const desc = table ? `for ${table}` : 'across all tables';
            app.ok({
              table: table || 'sys_ui_section',
              count: records.length,
              columns: ['name', 'view', 'caption', 'order'],
              records,
              context: { instance_url: app.getEffectiveInstance() },
            }, {
              summary: `${records.length} form section(s) ${desc}`,
              ...(table ? { breadcrumbs: [{ action: 'show', cmd: `jsn forms show ${table} --view "Default view"`, description: 'Show Default view layout' }] } : {}),
            });
          }),
        })
        .command({
          command: 'show <table>',
          aliases: ['get'],
          describe: 'Show form layout',
          builder: (y) => y
            .option('view', { type: 'string', default: 'Default view', describe: 'View name' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            await showForm(app, argv.table, argv.view);
          }),
        });
    },
    handler: () => {
      console.log('Manage UI form layouts.');
      console.log('');
      console.log('Available subcommands:');
      console.log('  list [table]         List form views (shows table — view name)');
      console.log('  show <table>          Show form layout for a table');
      console.log('');
      console.log('Run "jsn forms <command> --help" for details.');
    },
  };
}
