import chalk from 'chalk';
import { getStringField } from '../../helpers.js';

// ─── Helpers ───

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
  if (typeof val === 'string') {
    const n = parseInt(val, 10);
    return isNaN(n) ? 0 : n;
  }
  if (typeof val === 'object' && val.value != null) {
    const n = parseInt(val.value, 10);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

// ─── Commands ───

export function listsCmd(wrap) {
  return {
    command: 'lists [subcommand]',
    aliases: ['list-layout', 'l'],
    describe: 'Manage UI List layouts',
    builder: (yargs) => {
      return yargs
        .command({
          command: 'list <table>',
          aliases: ['ls'],
          describe: 'List list views for a table',
          builder: (y) => y
            .positional('table', {
              describe: 'Table name (e.g. incident, change_request)',
              type: 'string',
            })
            .option('limit', { alias: 'l', type: 'number', default: 50, describe: 'Max records' }),
          handler: wrap(async (argv, app) => {
            const table = argv.table;
            const limit = argv.limit || 50;

            const params = new URLSearchParams();
            params.set('sysparm_limit', String(limit));
            params.set('sysparm_fields', 'view');
            params.set('sysparm_group_by', 'view');
            params.set('sysparm_display_value', 'all');
            const sysparmQuery = table ? `name=${table}^ORDERBYview` : 'ORDERBYview';
            params.set('sysparm_query', sysparmQuery);

            const records = await app.sdk.list('sys_ui_list', params);

            const viewMap = new Map();
            for (const record of records) {
              const view = getDisplayValue(record, 'view');
              if (view && !viewMap.has(view)) {
                viewMap.set(view, true);
              }
            }

            const views = Array.from(viewMap.keys()).sort();
            const defaultViews = views.filter(v => v === 'Default view');
            const workspaceViews = views.filter(v => v.toLowerCase().includes('workspace'));
            const otherViews = views.filter(v => !defaultViews.includes(v) && !workspaceViews.includes(v));

            const recordsOut = views.map(v => ({ view: v, table }));

            app.ok({
              table,
              count: views.length,
              default: defaultViews,
              workspaces: workspaceViews,
              other: otherViews,
              records: recordsOut,
              instance_url: app.getEffectiveInstance(),
            }, {
              summary: `${views.length} list views for ${table}`,
              breadcrumbs: [
                { action: 'show', cmd: `jsn dev lists show ${table} --view "Default view"`, description: 'Show Default view columns' },
              ],
            });
          }),
        })
        .command({
          command: 'show <table>',
          aliases: ['get'],
          describe: 'Show list layout',
          builder: (y) => y
            .option('view', { type: 'string', default: 'Default view', describe: 'View name' }),
          handler: wrap(async (argv, app) => {
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
            } catch {
              // ignore
            }

            if (!viewSysID) {
              viewParams.set('sysparm_query', `title=${viewName}`);
              try {
                const viewRecords = await app.sdk.list('sys_ui_view', viewParams);
                if (viewRecords.length > 0) {
                  viewSysID = getStringField(viewRecords[0], 'sys_id');
                }
              } catch {
                // ignore
              }
            }

            if (!viewSysID) {
              viewSysID = viewName;
            }

            // Fetch list layouts
            const params = new URLSearchParams();
            params.set('sysparm_limit', '10');
            params.set('sysparm_fields', 'sys_id,name,view,parent,active,sys_created_on,sys_updated_on');
            params.set('sysparm_display_value', 'all');

            const parts = [];
            if (table) parts.push(`name=${table}`);
            if (viewSysID) parts.push(`view=${viewSysID}`);
            const sysparmQuery = parts.length > 0 ? `${parts.join('^')}^ORDERBYsys_created_on` : 'ORDERBYsys_created_on';
            params.set('sysparm_query', sysparmQuery);

            const records = await app.sdk.list('sys_ui_list', params);
            if (records.length === 0) {
              throw new Error(`no list layout found for ${table} with view "${viewName}"`);
            }

            const mainLayout = records[0];
            const layoutSysID = getStringField(mainLayout, 'sys_id');

            // Fetch elements (columns) for the list
            const elemParams = new URLSearchParams();
            elemParams.set('sysparm_limit', '100');
            elemParams.set('sysparm_fields', 'sys_id,list_id,element,position,type');
            elemParams.set('sysparm_display_value', 'all');
            elemParams.set('sysparm_query', `list_id=${layoutSysID}^ORDERBYposition`);

            const elemRecords = await app.sdk.list('sys_ui_list_element', elemParams);

            const elements = elemRecords.map(record => ({
              sys_id: getStringField(record, 'sys_id'),
              listID: getStringField(record, 'list_id'),
              element: getDisplayValue(record, 'element'),
              position: getIntValue(record, 'position'),
              type: getDisplayValue(record, 'type'),
            }));

            elements.sort((a, b) => a.position - b.position);

            // Build formatted output
            const lines = [];
            lines.push('');
            lines.push(chalk.bold(chalk.hex('#e8a217')(`${table} (${viewName})`)));
            lines.push('');

            lines.push(chalk.bold(chalk.hex('#666666')('─ List Columns ─')));
            if (elements.length === 0) {
              lines.push(chalk.hex('#888888')('  (no columns defined)'));
            } else {
              for (let i = 0; i < elements.length; i++) {
                const elem = elements[i];
                lines.push(`  ${chalk.hex('#666666')(`${String(i + 1).padStart(2)}.`)}  ${chalk.hex('#cccccc')(elem.element)}`);
              }
            }
            lines.push('');

            lines.push('─────');
            lines.push('');
            lines.push(chalk.bold(chalk.hex('#e8a217')('Hints:')));
            lines.push(`  ${`jsn dev lists list ${table}`.padEnd(50)}  ${chalk.hex('#888888')('List all views')}`);
            lines.push(`  ${`jsn dev forms show ${table} --view "${viewName}"`.padEnd(50)}  ${chalk.hex('#888888')('Show form layout')}`);
            lines.push('');

            const formatted = lines.join('\n');

            // Build structured data for JSON/quiet mode
            const columnsData = elements.map(elem => {
              const col = {
                element: elem.element,
                position: elem.position,
              };
              if (elem.type) {
                col.type = elem.type;
              }
              return col;
            });

            app.ok({
              table,
              view: viewName,
              columns: columnsData,
              _formatted: formatted,
              _context: {
                instance_url: app.getEffectiveInstance(),
                table: 'sys_ui_list',
              },
            }, {
              summary: `List: ${table} (${viewName}) - ${elements.length} columns`,
              breadcrumbs: [
                { action: 'list', cmd: `jsn dev lists list ${table}`, description: 'List all views' },
                { action: 'form', cmd: `jsn dev forms show ${table} --view "${viewName}"`, description: 'Show form layout' },
              ],
            });
          }),
        });
    },
    handler: () => {},
  };
}
