// `tables audit`: audit status for one table and, with --field, one column.
// The switches are separate verbs (`audit enable`, `audit deletes`, ...) so a
// read subcommand stays a read and the mutation guard sees a real path.

import process from 'node:process';
import { readTableAudit, formatTableAudit, planAuditChange, applyAuditChange, auditChangeHolds, describeAuditChange, auditSwitchValue } from '../table-audit.js';
import { FormatAuto, FormatStyled } from '../output.js';
import { collectCapabilities, declareCapabilities } from '../capabilities.js';
import { assertMutationRecordScope } from '../intended-context.js';
import { AUDIT_VERBS } from '../audit-verbs.js';
import { quoteShellArg } from '../helpers.js';
import { errUsage } from '../errors.js';

async function changeAudit(app, argv, data, change) {
  const plan = planAuditChange(data, change);
  const human = [FormatAuto, FormatStyled].includes(app.output.getFormat());
  const status = `jsn tables audit ${data.table}${plan.target.element ? ` --field ${plan.target.element}` : ''}`;
  const rerun = ['jsn', 'tables', 'audit', change.verb, data.table, ...(change.positional ? [change.value] : []), '--yes'].map(quoteShellArg).join(' ');
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

// The switch verbs sit under `audit`, so the read stays `tables audit <table>`
// and a change is `tables audit enable <table>`. They are declared in
// capabilities as two-token mutation paths, which the guard already supports.
const SWITCHES = [
  { verb: AUDIT_VERBS[0], name: 'on', value: true,
    describe: "Turn table auditing on (the table collection row's Audit tick)",
    phrases: ['turn on auditing', 'enable table auditing'],
    task: 'Preview turning table auditing on; --yes writes it' },
  { verb: AUDIT_VERBS[1], name: 'off', value: true,
    describe: 'Turn table auditing off',
    phrases: ['turn off auditing', 'disable table auditing'],
    task: 'Preview turning table auditing off; --yes writes it' },
  { verb: AUDIT_VERBS[2], name: 'exclude', field: true,
    describe: 'Stop auditing a field: add no_audit (whitelist mode: remove audit=true)',
    phrases: ['stop auditing a field', 'exclude field from audit'],
    task: 'Preview excluding a field from auditing; --yes writes it' },
  { verb: AUDIT_VERBS[3], name: 'include', field: true,
    describe: 'Audit a field again: remove no_audit (whitelist mode: add audit=true)',
    phrases: ['audit a field again', 'include field in audit'],
    task: 'Preview auditing a field again; --yes writes it' },
  { verb: AUDIT_VERBS[4], name: 'deletes', state: true,
    describe: 'Remove (on) or add (off) no_audit_delete, which stops deletes reaching sys_audit_delete',
    phrases: ['stop auditing deletes', 'stop recording deletes'],
    task: 'Preview adding no_audit_delete; --yes writes it' },
];

const READ_EPILOGUE = [
  'This reads only: sys_db_object, sys_dictionary, sys_schema_attribute, sys_schema_attribute_m2m and sys_properties, with GET requests.',
  'Changing audit settings is a separate verb: tables audit enable|disable <table>, audit exclude|include <table> <field>, and audit deletes <table> on|off. Each previews unless --yes, writes the table\'s or field\'s own sys_dictionary row, then adds or removes the matching sys_schema_attribute_m2m row unless the platform already has, and re-reads the status. A field defined on a parent table is refused, since changing it there changes every table that extends it. They are refused on read-only profiles and need the capture context any customization write needs.',
  'Reads are never audited: the platform audits create, update and delete only.',
  "Table auditing is the Audit tick on the table's own collection row; it does not inherit from parent tables.",
  'Attributes are read from the dictionary attributes string and from sys_schema_attribute_m2m rows; verdicts follow the string, and any disagreement is listed.',
  'Deleted records go to sys_audit_delete whether or not the table is audited, unless no_audit_delete, glide.db.audit.ignore.delete or the sys_ table rule excludes them.',
].join('\n');

function switchCommand(sw, wrap) {
  const positionals = [sw.field ? '<field>' : '', sw.state ? '<state>' : ''].filter(Boolean).join(' ');
  return {
    command: `${sw.verb} <table>${positionals ? ` ${positionals}` : ''}`,
    describe: sw.describe,
    discoveryTasks: [{ phrases: sw.phrases, args: [], description: sw.task }],
    builder: (y) => {
      let builder = y.strict()
        .positional('table', { type: 'string', describe: 'Table name (e.g. incident)' })
        .option('yes', { type: 'boolean', default: false, describe: 'Write the change; without it, preview only' });
      if (sw.field) builder = builder.positional('field', { type: 'string', describe: 'Column whose audit setting changes' });
      if (sw.state) builder = builder.positional('state', { type: 'string', choices: ['on', 'off'], describe: 'on removes no_audit_delete; off adds it' });
      return builder;
    },
    handler: wrap(async (argv, app) => {
      app.requireInstance();
      // Validate before any request: a bad field or state writes and reads nothing.
      const value = sw.field ? auditSwitchValue(argv.field)
        : sw.state ? argv.state : true;
      if (sw.state && !['on', 'off'].includes(value)) throw errUsage(`state must be on or off; got ${JSON.stringify(value)}. No change was made.`);
      const change = { verb: sw.verb, name: sw.name, value, positional: Boolean(sw.field || sw.state) };
      const data = await readTableAudit(app.sdk, argv.table, {});
      return changeAudit(app, argv, data, change);
    }),
  };
}

export function withTableAudit(command, wrap) {
  // `audit` reads and its verbs change; the guard blocks those paths by name.
  const caps = collectCapabilities().get('tables') || {};
  declareCapabilities('tables', {
    ...caps,
    mutationSubcommands: [...new Set([...(caps.mutationSubcommands || []), ...SWITCHES.map(sw => `audit ${sw.verb}`)])],
  });
  const originalBuilder = command.builder;
  command.builder = (yargs) => {
    let chain = originalBuilder(yargs).command({
      command: 'audit <table>',
      // `audit <table>` reads; the verbs below are its mutation subcommands.
      defaultPositionals: true,
      usageText: 'Usage: jsn tables audit <table> [options]',
      describe: 'Audit status: table on or off, whitelist mode, excluded and encrypted fields, inserts, deletes, and why one field is or is not audited',
      discoveryTasks: [{
        phrases: ['is this table audited', 'table auditing', 'field not audited', 'no_audit', 'audit history missing', 'are deletes audited'],
        args: ['--json'],
        description: 'Show whether the table and its fields are audited, and why',
      }],
      builder: (y) => {
        let builder = y.strict()
          .positional('table', { type: 'string', describe: 'Table name (e.g. incident)' })
          .option('field', { type: 'string', describe: 'Column to give a verdict for, with its reason' })
          .epilogue(READ_EPILOGUE);
        for (const sw of SWITCHES) builder = builder.command(switchCommand(sw, wrap));
        return builder;
      },
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
    return chain;
  };
  if (Array.isArray(command.discovery?.benefits)) {
    command.discovery.benefits.push('Table audit status: jsn tables audit <table> [--field <name>]; change it with jsn tables audit enable|disable <table>, audit exclude|include <table> <field>, or audit deletes <table> on|off (preview unless --yes)');
  }
  return command;
}
