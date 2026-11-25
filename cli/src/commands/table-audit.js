// `tables audit`: read-only audit status for one table and, with --field, one column.

import { readTableAudit, formatTableAudit } from '../table-audit.js';
import { FormatAuto, FormatStyled } from '../output.js';

export function withTableAudit(command, wrap) {
  const originalBuilder = command.builder;
  command.builder = (yargs) => originalBuilder(yargs).command({
    command: 'audit <table>',
    describe: 'Read-only audit status: table on or off, whitelist mode, excluded and encrypted fields, inserts, deletes, and why one field is or is not audited',
    discoveryTasks: [{
      phrases: ['is this table audited', 'table auditing', 'field not audited', 'no_audit', 'audit history missing', 'are deletes audited'],
      args: ['--json'],
      description: 'Show whether the table and its fields are audited, and why',
    }],
    builder: (y) => y.strict()
      .positional('table', { type: 'string', describe: 'Table name (e.g. incident)' })
      .option('field', { type: 'string', describe: 'Column to give a verdict for, with its reason' })
      .epilogue([
        'Read-only: reads sys_db_object, sys_dictionary, sys_schema_attribute, sys_schema_attribute_m2m and sys_properties with GET requests.',
        'Reads are never audited: the platform audits create, update and delete only.',
        'Table auditing is the Audit tick on the table\'s own collection row; it does not inherit from parent tables.',
        'Attributes are read from the dictionary attributes string and from sys_schema_attribute_m2m rows; verdicts follow the string, and any disagreement is listed.',
        'Deleted records go to sys_audit_delete whether or not the table is audited, unless no_audit_delete, glide.db.audit.ignore.delete or the sys_ table rule excludes them.',
      ].join('\n')),
    handler: wrap(async (argv, app) => {
      app.requireInstance();
      const data = await readTableAudit(app.sdk, argv.table, { field: argv.field });
      const human = [FormatAuto, FormatStyled].includes(app.output.getFormat());
      const summary = data.field
        ? `Field ${data.table}.${data.field.name}: ${data.field.audited ? 'audited' : 'not audited'}`
        : `Table audit: ${data.table} ${data.audited ? 'on' : 'off'}, ${data.excluded_fields.length} excluded field(s), deletes ${data.deletes.recorded ? 'recorded' : 'not recorded'}`;
      app.ok(human ? { ...data, _formatted: formatTableAudit(data) } : data, {
        summary,
        breadcrumbs: [
          { action: 'list', cmd: `jsn tables show ${data.table}`, description: `Show table ${data.table}` },
          { action: 'list', cmd: `jsn records list --table sys_audit_delete --query "tablename=${data.table}" --limit 20`, description: `Recently deleted ${data.table} records` },
        ],
      });
    }),
  });
  if (Array.isArray(command.discovery?.benefits)) {
    command.discovery.benefits.push('Table audit status: jsn tables audit <table> [--field <name>]');
  }
  return command;
}
