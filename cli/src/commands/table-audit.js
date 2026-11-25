// `tables audit`: audit status for one table and, with --field, one column; a switch changes it.

import process from 'node:process';
import { readTableAudit, formatTableAudit, AUDIT_SWITCHES, auditSwitch, planAuditChange, applyAuditChange, auditChangeHolds, describeAuditChange } from '../table-audit.js';
import { FormatAuto, FormatStyled } from '../output.js';
import { collectCapabilities, declareCapabilities } from '../capabilities.js';
import { assertMutationRecordScope } from '../intended-context.js';
import { quoteShellArg } from '../helpers.js';

async function changeAudit(app, argv, data, change) {
  const plan = planAuditChange(data, change);
  const human = [FormatAuto, FormatStyled].includes(app.output.getFormat());
  const status = `jsn tables audit ${data.table}${plan.target.element ? ` --field ${plan.target.element}` : ''}`;
  const rerun = ['jsn', 'tables', 'audit', data.table, `--${change.name}`, ...(typeof change.value === 'string' ? [change.value] : []), '--yes'].map(quoteShellArg).join(' ');
  const record = `  Record   sys_dictionary ${plan.target.sys_id} (${plan.target.element ? `${plan.target.name}.${plan.target.element}` : plan.target.name})`;
  const steps = plan.set ? [record, `  Write    ${Object.entries(plan.set).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ')}`,
    ...(plan.attribute_id ? [`  Then     ${plan.present ? 'add' : 'remove'} its sys_schema_attribute_m2m ${plan.attribute} row, unless the platform already has`] : [])] : [record];
  const send = (out, summary, extra = [], breadcrumbs = [{ action: 'verify', cmd: status, description: 'Re-read the audit status' }]) =>
    app.ok(human ? { ...out, _formatted: [summary, ...steps, ...extra].join('\n') } : out, { summary, breadcrumbs });
  // no_audit_delete is one of several delete rules; say when another one still decides.
  const deletesNote = status => change.name === 'deletes' && status && status.deletes.recorded !== (change.value === 'on') ? `; deletes are still ${status.deletes.recorded ? 'recorded' : 'not recorded'}: ${status.deletes.reason}` : '';
  if (plan.already) return send({ table: data.table, change, ...plan, written: [] }, `No change: ${plan.already}${deletesNote(data)}`);
  if (!argv.yes) return send({ table: data.table, change, ...plan, dry_run: true, rerun }, `Dry run: would ${describeAuditChange(plan)}`, ['', `Rerun with --yes to write: ${rerun}`], [{ action: 'update', cmd: rerun, description: 'Write this change' }]);
  // Preflight the record's scope before the first write, as records delete-many does.
  await assertMutationRecordScope(app, 'sys_dictionary', plan.target.sys_id);
  const written = [];
  let error;
  try { await applyAuditChange(app.sdk, plan, written); }
  catch (failure) { error = failure.message || String(failure); }
  let after = null;
  let verificationError;
  try { after = await readTableAudit(app.sdk, data.table, { field: argv.field }); }
  catch (failure) { verificationError = failure.message || String(failure); }
  const verified = !error && after !== null && auditChangeHolds(after, plan);
  send({ table: data.table, change, ...plan, written, verified, ...(error ? { error } : {}), ...(verificationError ? { verification_error: verificationError } : {}), status: after },
    verified ? `Done: ${describeAuditChange(plan)}; the re-read status agrees${deletesNote(after)}` : `Change incomplete or unverified: ${written.length} write(s)${error ? `; failed: ${error}` : ''}${verificationError ? `; re-read failed: ${verificationError}` : ''}`,
    after ? ['', formatTableAudit(after)] : []);
  if (!verified) process.exitCode = 1;
}

export function withTableAudit(command, wrap) {
  // The switches make `tables audit` a mutation: read-only profiles and capture context apply.
  declareCapabilities('tables', { ...collectCapabilities().get('tables'), mutationOptions: { audit: AUDIT_SWITCHES } });
  const originalBuilder = command.builder;
  command.builder = (yargs) => originalBuilder(yargs).command({
    command: 'audit <table>',
    describe: 'Audit status: table on or off, whitelist mode, excluded and encrypted fields, inserts, deletes, and why one field is or is not audited; switches change it',
    discoveryTasks: [{
      phrases: ['is this table audited', 'table auditing', 'field not audited', 'no_audit', 'audit history missing', 'are deletes audited'],
      args: ['--json'],
      description: 'Show whether the table and its fields are audited, and why',
    },
    { phrases: ['turn off auditing', 'disable table auditing'], args: ['--off'], description: 'Preview turning table auditing off; --yes writes it' },
    { phrases: ['turn on auditing', 'enable table auditing'], args: ['--on'], description: 'Preview turning table auditing on; --yes writes it' },
    { phrases: ['stop auditing a field', 'exclude field from audit'], args: ['--exclude', '<field>'], description: 'Preview excluding a field from auditing; --yes writes it' },
    { phrases: ['stop auditing deletes', 'stop recording deletes'], args: ['--deletes', 'off'], description: 'Preview adding no_audit_delete; --yes writes it' }],
    builder: (y) => y.strict()
      .positional('table', { type: 'string', describe: 'Table name (e.g. incident)' })
      .option('field', { type: 'string', describe: 'Column to give a verdict for, with its reason' })
      .option('on', { type: 'boolean', describe: 'Turn table auditing on (the collection row\'s Audit tick)' })
      .option('off', { type: 'boolean', describe: 'Turn table auditing off' })
      .option('exclude', { type: 'string', describe: 'Stop auditing a field: add no_audit (whitelist mode: remove audit=true)' })
      .option('include', { type: 'string', describe: 'Audit a field again: remove no_audit (whitelist mode: add audit=true)' })
      .option('deletes', { type: 'string', choices: ['on', 'off'], describe: 'Remove (on) or add (off) no_audit_delete, which stops deletes reaching sys_audit_delete' })
      .option('yes', { type: 'boolean', default: false, describe: 'Write the switch; without it, preview only' })
      .epilogue([
        'Without a switch it only reads: sys_db_object, sys_dictionary, sys_schema_attribute, sys_schema_attribute_m2m and sys_properties, with GET requests.',
        'One switch per run, previewed unless --yes. It writes the table\'s or field\'s own sys_dictionary row, then adds or removes the matching sys_schema_attribute_m2m row unless the platform already has, and re-reads the status. A field defined on a parent table is refused, since changing it there changes every table that extends it. Switches are refused on read-only profiles and need the capture context any customization write needs.',
        'Reads are never audited: the platform audits create, update and delete only.',
        'Table auditing is the Audit tick on the table\'s own collection row; it does not inherit from parent tables.',
        'Attributes are read from the dictionary attributes string and from sys_schema_attribute_m2m rows; verdicts follow the string, and any disagreement is listed.',
        'Deleted records go to sys_audit_delete whether or not the table is audited, unless no_audit_delete, glide.db.audit.ignore.delete or the sys_ table rule excludes them.',
      ].join('\n')),
    handler: wrap(async (argv, app) => {
      app.requireInstance();
      const change = auditSwitch(argv);
      const data = await readTableAudit(app.sdk, argv.table, { field: argv.field });
      if (change) return changeAudit(app, argv, data, change);
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
    command.discovery.benefits.push('Table audit status and switches: jsn tables audit <table> [--field <name>] [--on|--off|--exclude <f>|--include <f>|--deletes on|off] [--yes]');
  }
  return command;
}
