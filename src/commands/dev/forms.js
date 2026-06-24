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

            const records = await app.sdk.list('sys_ui_section', params);

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
              summary: `${views.length} views for ${table}`,
              breadcrumbs: [
                { action: 'show', cmd: `jsn dev forms show ${table} --view "Default view"`, description: 'Show Default view layout' },
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

            // Fetch sections
            const params = new URLSearchParams();
            params.set('sysparm_limit', '100');
            params.set('sysparm_fields', 'sys_id,name,view,caption,header,order,active,sys_created_on,sys_updated_on');
            params.set('sysparm_display_value', 'all');

            const parts = [];
            if (table) parts.push(`name=${table}`);
            if (viewSysID) parts.push(`view=${viewSysID}`);
            const sysparmQuery = parts.length > 0 ? `${parts.join('^')}^ORDERBYorder` : 'ORDERBYorder';
            params.set('sysparm_query', sysparmQuery);

            const records = await app.sdk.list('sys_ui_section', params);
            if (records.length === 0) {
              throw new Error(`no form sections found for ${table} with view "${viewName}"`);
            }

            // Parse sections
            const sections = records.map(record => ({
              sys_id: getStringField(record, 'sys_id'),
              name: getDisplayValue(record, 'name'),
              view: getDisplayValue(record, 'view'),
              caption: getDisplayValue(record, 'caption'),
              header: getDisplayValue(record, 'header'),
              order: getIntValue(record, 'order'),
              active: getBoolValue(record, 'active'),
              createdOn: getDisplayValue(record, 'sys_created_on'),
              updatedOn: getDisplayValue(record, 'sys_updated_on'),
            }));

            // Fetch elements for each section
            const sectionElements = new Map();
            for (const section of sections) {
              const elemParams = new URLSearchParams();
              elemParams.set('sysparm_limit', '100');
              elemParams.set('sysparm_fields', 'sys_id,sys_ui_section,element,label,type,position,row,col,mandatory,read_only,visible');
              elemParams.set('sysparm_display_value', 'all');
              elemParams.set('sysparm_query', `sys_ui_section=${section.sys_id}^ORDERBYposition`);

              try {
                const elemRecords = await app.sdk.list('sys_ui_element', elemParams);
                const elements = elemRecords.map(record => ({
                  sys_id: getStringField(record, 'sys_id'),
                  section: getStringField(record, 'sys_ui_section'),
                  name: getDisplayValue(record, 'element'),
                  label: getDisplayValue(record, 'label'),
                  elementType: getDisplayValue(record, 'type'),
                  position: getIntValue(record, 'position'),
                  row: getIntValue(record, 'row'),
                  column: getIntValue(record, 'col'),
                  mandatory: getBoolValue(record, 'mandatory'),
                  readOnly: getBoolValue(record, 'read_only'),
                  visible: getBoolValue(record, 'visible'),
                }));
                sectionElements.set(section.sys_id, elements);
              } catch {
                sectionElements.set(section.sys_id, []);
              }
            }

            // Build formatted output
            const lines = [];
            lines.push('');
            lines.push(chalk.bold(chalk.hex('#e8a217')(`${table} (${viewName})`)));
            lines.push('');

            for (let i = 0; i < sections.length; i++) {
              const section = sections[i];
              const elements = sectionElements.get(section.sys_id) || [];

              let sectionTitle = section.caption;
              if (!sectionTitle && section.header && section.header !== 'false') {
                sectionTitle = section.header;
              }
              if (!sectionTitle) {
                sectionTitle = `Section ${i + 1}`;
              }

              lines.push(chalk.bold(chalk.hex('#666666')(`─ ${sectionTitle} ─`)));

              if (elements.length === 0) {
                lines.push(chalk.hex('#888888')('  (no fields)'));
                lines.push('');
                continue;
              }

              elements.sort((a, b) => a.position - b.position);

              for (const elem of elements) {
                if (elem.elementType && elem.elementType !== 'field') {
                  continue;
                }

                let displayName = elem.name;
                if (!displayName) displayName = elem.label;
                if (!displayName) displayName = elem.elementType;

                const indicators = [];
                if (elem.mandatory) indicators.push('*');
                if (elem.readOnly) indicators.push('(RO)');
                const indicatorStr = indicators.length > 0 ? ` ${indicators.join(' ')}` : '';

                lines.push(`  ${chalk.hex('#cccccc')(displayName)}${indicatorStr ? chalk.hex('#888888')(indicatorStr) : ''}`);
              }

              lines.push('');
            }

            lines.push('─────');
            lines.push('');
            lines.push(chalk.bold(chalk.hex('#e8a217')('Hints:')));
            lines.push(`  ${`jsn dev forms list ${table}`.padEnd(50)}  ${chalk.hex('#888888')('List all views')}`);
            lines.push(`  ${`jsn dev columns --table ${table}`.padEnd(50)}  ${chalk.hex('#888888')('View table columns')}`);
            lines.push('');

            const formatted = lines.join('\n');

            // Build structured data for JSON/quiet mode
            const sectionsData = sections.map(section => {
              const elements = (sectionElements.get(section.sys_id) || [])
                .filter(elem => !elem.elementType || elem.elementType === 'field')
                .sort((a, b) => a.position - b.position)
                .map(elem => ({
                  sys_id: elem.sys_id,
                  name: elem.name,
                  label: elem.label,
                  type: elem.elementType,
                  position: elem.position,
                  mandatory: elem.mandatory,
                  read_only: elem.readOnly,
                }));

              let sectionTitle = section.caption;
              if (!sectionTitle && section.header && section.header !== 'false') {
                sectionTitle = section.header;
              }
              if (!sectionTitle) {
                sectionTitle = 'Section';
              }

              return {
                sys_id: section.sys_id,
                caption: sectionTitle,
                order: section.order,
                elements,
              };
            });

            app.ok({
              table,
              view: viewName,
              sections: sectionsData,
              _formatted: formatted,
              _context: {
                instance_url: app.getEffectiveInstance(),
                table: 'sys_ui_section',
              },
            }, {
              summary: `Form: ${table} (${viewName}) - ${sections.length} sections`,
              breadcrumbs: [
                { action: 'list', cmd: `jsn dev forms list ${table}`, description: 'List all views' },
                { action: 'columns', cmd: `jsn dev columns --table ${table}`, description: 'View table columns' },
              ],
            });
          }),
        });
    },
    handler: () => {},
  };
}
