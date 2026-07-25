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
          describe: 'List form views for a table',
          builder: (y) => y
            .positional('table', { describe: 'Table name (e.g. incident, change_request)', type: 'string' })
            .option('limit', { alias: 'l', type: 'number', default: 50, describe: 'Max records' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const table = argv.table || '';
            const query = table ? `name=${table}` : '';

            const picked = await interactiveList({
              app, table: 'sys_ui_section', singular: 'form view', columns: ['view', 'caption', 'order'], limit: argv.limit, query, labelField: 'view',
              formatLabel: r => {
                const view = getStringField(r, 'view') || '';
                const caption = getStringField(r, 'caption') || '';
                return caption ? `${view} — ${caption}` : view;
              },
            });
            if (picked === undefined) return;
            if (picked) {
              return app.ok(picked, {
                summary: `Form view: ${getStringField(picked, 'view') || '?'} (${table || getStringField(picked, 'name') || 'sys_ui_section'})`,
                breadcrumbs: [
                  { action: 'show', cmd: `jsn forms show ${table} --view "${getStringField(picked, 'view') || ''}"`, description: 'Show full layout' },
                  { action: 'list', cmd: `jsn forms list ${table || ''}`, description: table ? `Back to ${table} forms` : 'Back to all forms' },
                ],
              });
            }

            // Fallback
            const params = new URLSearchParams();
            params.set('sysparm_limit', String(argv.limit));
            params.set('sysparm_fields', 'view,caption,order,sys_id');
            params.set('sysparm_display_value', 'all');
            params.set('sysparm_query', (query || '') + '^ORDERBYview');
            const records = await app.sdk.list('sys_ui_section', params);

            const desc = table ? `for ${table}` : 'across all tables';
            app.ok({
              table: table || 'sys_ui_section',
              count: records.length,
              columns: ['view', 'caption', 'order'],
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
            const table = argv.table;
            const viewName = argv.view;

            let viewSysID = '';
            const viewParams = new URLSearchParams();
            viewParams.set('sysparm_limit', '1');
            viewParams.set('sysparm_fields', 'sys_id');
            viewParams.set('sysparm_query', `name=${viewName}`);
            try {
              const viewRecords = await app.sdk.list('sys_ui_view', viewParams);
              if (viewRecords.length > 0) viewSysID = getStringField(viewRecords[0], 'sys_id');
            } catch { /* ignore */ }

            if (!viewSysID) {
              viewParams.set('sysparm_query', `title=${viewName}`);
              try {
                const viewRecords = await app.sdk.list('sys_ui_view', viewParams);
                if (viewRecords.length > 0) viewSysID = getStringField(viewRecords[0], 'sys_id');
              } catch { /* ignore */ }
            }

            const params = new URLSearchParams();
            params.set('sysparm_limit', '200');
            params.set('sysparm_fields', 'caption,label,mandatory,name,read_only,type,visible,field,order');
            params.set('sysparm_display_value', 'all');
            params.set('sysparm_query', `name=${table}^view=${viewName}^ORDERBYorder`);
            const sections = await app.sdk.list('sys_ui_section', params);

            if (viewSysID) {
              const sectionParams = new URLSearchParams();
              sectionParams.set('sysparm_limit', '200');
              sectionParams.set('sysparm_fields', 'caption,label,mandatory,name,read_only,type,visible,field,order,position,header,split');
              sectionParams.set('sysparm_display_value', 'all');
              sectionParams.set('sysparm_query', `form_section.view=${viewSysID}^ORDERBYorder`);
              const formRecords = await app.sdk.list('sys_ui_form_section', sectionParams);
              const fields = formRecords.map(r => ({
                name: getStringField(r, 'name'),
                caption: getStringField(r, 'caption'),
                label: getStringField(r, 'label'),
                mandatory: getBoolValue(r, 'mandatory'),
                read_only: getBoolValue(r, 'read_only'),
                visible: getBoolValue(r, 'visible'),
                type: getStringField(r, 'type'),
                order: getIntValue(r, 'order'),
                split: getBoolValue(r, 'split'),
                header: getBoolValue(r, 'header'),
                position: getIntValue(r, 'position'),
              }));
              app.ok({ table, view: viewName, count: fields.length, fields, context: { instance_url: app.getEffectiveInstance() } },
                { summary: `${fields.length} field(s) in ${table} → ${viewName}` });
              return;
            }

            const fields = sections.map(r => ({
              label: getDisplayValue(r, 'label'),
              type: getDisplayValue(r, 'type'),
              mandatory: getBoolValue(r, 'mandatory'),
              read_only: getBoolValue(r, 'read_only'),
              visible: getBoolValue(r, 'visible'),
              order: getIntValue(r, 'order'),
            }));
            app.ok({ table, view: viewName, count: fields.length, fields, context: { instance_url: app.getEffectiveInstance() } },
              { summary: `${fields.length} section(s) in ${table} → ${viewName}` });
          }),
        });
    },
    handler: () => {
      console.log('Manage UI form layouts.');
      console.log('');
      console.log('Available subcommands:');
      console.log('  list [table]         List form views (optional: filter by table)');
      console.log('  show <table>          Show form layout for a table');
      console.log('');
      console.log('Run "jsn forms <command> --help" for details.');
    },
  };
}
