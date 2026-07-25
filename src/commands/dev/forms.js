import chalk from 'chalk';
import { getStringField, interactiveList } from '../../helpers.js';

// ─── Local helpers ───

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

// ─── Commands ───

export function formsCmd(wrap) {
  return {
    command: 'forms [subcommand]',
    aliases: ['form', 'f'],
    describe: 'Manage UI Forms',
    builder: (yargs) => {
      return yargs
        .command({
          command: 'list <table>',
          aliases: ['ls'],
          describe: 'List form views for a table',
          builder: (y) => y
            .positional('table', { describe: 'Table name (e.g. incident, change_request)', type: 'string' })
            .option('limit', { alias: 'l', type: 'number', default: 50, describe: 'Max records' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const table = argv.table;
            const query = `name=${table}`;

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
              // Show the picked form's full layout
              const viewSysID = getStringField(picked, 'sys_id') || '';
              return app.ok(picked, {
                summary: `Form view: ${getStringField(picked, 'view')} (${table})`,
                breadcrumbs: [
                  { action: 'show', cmd: `jsn forms show ${table} --view "${getStringField(picked, 'view')}"`, description: 'Show full layout' },
                  { action: 'list', cmd: `jsn forms list ${table}`, description: `Back to ${table} forms` },
                ],
              });
            }

            // Fall back to text table
            const params = new URLSearchParams();
            params.set('sysparm_limit', String(argv.limit));
            params.set('sysparm_fields', 'view,caption,order,sys_id');
            params.set('sysparm_display_value', 'all');
            params.set('sysparm_query', query + '^ORDERBYview');
            const records = await app.sdk.list('sys_ui_section', params);

            const viewMap = new Map();
            for (const r of records) {
              const v = getDisplayValue(r, 'view');
              if (v && !viewMap.has(v)) viewMap.set(v, r);
            }
            const views = Array.from(viewMap.values()).sort((a, b) => (getDisplayValue(a, 'view') || '').localeCompare(getDisplayValue(b, 'view') || ''));

            app.ok({
              table,
              count: views.length,
              columns: ['view', 'caption', 'order'],
              records: views.map(v => ({
                view: getDisplayValue(v, 'view'),
                caption: getDisplayValue(v, 'caption'),
                order: getIntValue(v, 'order'),
              })),
              context: { instance_url: app.getEffectiveInstance() },
            }, {
              summary: `${views.length} form view(s) for ${table}`,
              breadcrumbs: [
                { action: 'show', cmd: `jsn forms show ${table} --view "Default view"`, description: 'Show Default view layout' },
              ],
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

            // Look up view sys_id
            let viewSysID = '';
            const viewParams = new URLSearchParams();
            viewParams.set('sysparm_limit', '1');
            viewParams.set('sysparm_fields', 'sys_id');
            viewParams.set('sysparm_query', `name=${viewName}`);
            try {
              const viewRecords = await app.sdk.list('sys_ui_view', viewParams);
              if (viewRecords.length > 0) {
                viewSysID = getStringField(viewRecords[0], 'sys_id');
              }
            } catch { /* ignore */ }

            if (!viewSysID) {
              viewParams.set('sysparm_query', `title=${viewName}`);
              try {
                const viewRecords = await app.sdk.list('sys_ui_view', viewParams);
                if (viewRecords.length > 0) {
                  viewSysID = getStringField(viewRecords[0], 'sys_id');
                }
              } catch { /* ignore */ }
            }

            // Fetch form sections
            const params = new URLSearchParams();
            params.set('sysparm_limit', '200');
            params.set('sysparm_fields', 'caption,caption_script,default_value,hint,instructions,label,mandatory,name,order,read_only,type,visible,choice_table,field,help_tag,list_layout,sys_id,ui_type,sys_scope,sys_created_on,sys_updated_on,sys_created_by,sys_updated_by');
            params.set('sysparm_display_value', 'all');
            params.set('sysparm_query', `name=${table}^view=${viewName}^ORDERBYorder`);

            const sections = await app.sdk.list('sys_ui_section', params);

            // Fetch form sections for the specific view
            if (viewSysID) {
              const sectionParams = new URLSearchParams();
              sectionParams.set('sysparm_limit', '200');
              sectionParams.set('sysparm_fields', 'caption,label,mandatory,name,read_only,type,visible,field,order,position,header,split');
              sectionParams.set('sysparm_display_value', 'all');
              sectionParams.set('sysparm_query', `form_section.view=${viewSysID}^ORDERBYorder`);

              const formRecords = await app.sdk.list('sys_ui_form_section', sectionParams);
              const formSections = formRecords.map(r => ({
                name: getStringField(r, 'name'),
                caption: getStringField(r, 'caption'),
                label: getStringField(r, 'label'),
                mandatory: getBoolValue(r, 'mandatory'),
                read_only: getBoolValue(r, 'read_only'),
                visible: getBoolValue(r, 'visible'),
                type: getStringField(r, 'type'),
                order: getIntValue(r, 'order'),
                split: getBoolValue(r, 'split') || getIntValue(r, 'split') > 0,
                header: getBoolValue(r, 'header') || getIntValue(r, 'header') > 0,
                position: getIntValue(r, 'position'),
              }));

              app.ok({
                table, view: viewName,
                count: formSections.length,
                fields: formSections,
                context: { instance_url: app.getEffectiveInstance() },
              }, { summary: `${formSections.length} form field(s) in ${table} → ${viewName}` });
              return;
            }

            // Fallback: show flat sections
            const sectionList = sections.map(r => ({
              label: getDisplayValue(r, 'label'),
              type: getDisplayValue(r, 'type'),
              mandatory: getBoolValue(r, 'mandatory'),
              read_only: getBoolValue(r, 'read_only'),
              visible: getBoolValue(r, 'visible'),
              order: getIntValue(r, 'order'),
            }));

            app.ok({
              table, view: viewName,
              count: sectionList.length,
              fields: sectionList,
              context: { instance_url: app.getEffectiveInstance() },
            }, { summary: `${sectionList.length} section(s) in ${table} → ${viewName}` });
          }),
        });
    },
    handler: () => {
      console.log('Manage UI form layouts.');
      console.log('');
      console.log('Available subcommands:');
      console.log('  list <table>         List form views for a table');
      console.log('  show <table>          Show form layout for a table');
      console.log('');
      console.log('Run "jsn forms <command> --help" for details.');
    },
  };
}
