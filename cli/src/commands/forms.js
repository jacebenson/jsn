import { getStringField, interactiveList } from '../helpers.js';

import { createRecordMetadataReader } from '../metadata/records.js';

export function formatFormMetadata(metadata) {
  const lines = [`Form: ${metadata.table} → ${metadata.requested_view}`];
  if (metadata.form?.inherited) lines.push(`  Inherited layout: ${metadata.form.table}`);
  if (!metadata.form) lines.push('  No unambiguous shared form layout is visible.');
  for (const section of metadata.form?.sections || []) {
    lines.push('', `── ${section.caption || '(unnamed)'} ──`);
    for (const element of section.elements) lines.push(`  ${element.label || element.element || '(unnamed)'}${element.type ? ` (${element.type})` : ''}`);
    if (!section.elements.length) lines.push('  (no visible elements)');
  }
  const configured = metadata.related_lists.filter(item => item.configured);
  if (configured.length) {
    lines.push('', 'Configured related lists:');
    for (const list of configured) lines.push(`  ${list.label || list.id} (${list.query_status})`);
  }
  lines.push('', metadata.coverage.scope);
  for (const warning of metadata.coverage.warnings) lines.push(`  ${warning.source}: ${warning.reason}`);
  return lines.join('\n');
}

async function showForm(app, table, view) {
  const metadata = await createRecordMetadataReader(app.sdk).read({ table, view });
  app.ok({ ...metadata, _formatted: formatFormMetadata(metadata) }, { summary: `Form metadata for ${table}` });
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
              app, table: 'sys_ui_form', singular: 'form', columns: ['name', 'view'], limit: argv.limit, query, labelField: 'name',
              formatLabel: r => {
                const t = getStringField(r, 'name') || '';
                const v = getStringField(r, 'view') || '';
                return `${t} — ${v}`;
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
            params.set('sysparm_fields', 'name,view,sys_id');
            params.set('sysparm_display_value', 'all');
            params.set('sysparm_query', (query || '') + '^ORDERBYname');
            const records = await app.sdk.list('sys_ui_form', params);

            const desc = table ? `for ${table}` : 'across all tables';
            app.ok({
              table: table || 'sys_ui_form',
              count: records.length,
              columns: ['name', 'view'],
              records,
              context: { instance_url: app.getEffectiveInstance() },
            }, {
              summary: `${records.length} form(s) ${desc}`,
              ...(table ? { breadcrumbs: [{ action: 'show', cmd: `jsn forms show ${table} --view "Default view"`, description: 'Show Default view layout' }] } : {}),
            });
          }),
        })
        .command({
          command: 'show <table>',
          aliases: ['get'],
          describe: 'Show form layout',
          builder: (y) => y
            .option('view', { type: 'string', default: 'Default view', describe: 'Shared view name, title or sys_id' })
            .epilogue('Discovers shared layouts, inherited forms and related-list metadata. JSON includes coverage limits; custom relationship scripts are never executed. Generic records get presentation is unchanged.'),
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
