import { deferredFamilyDefinition } from '../command-families.js';
import { fieldBehaviorHelp } from '../field-behavior.js';
import { CodeUsage, errNotFoundHint, errUsage } from '../errors.js';
import { loadHierarchy } from '../table-behavior.js';
import { buildDevCmd } from './_generic.js';
import { columnWhy, formatColumnWhy } from '../column-why.js';
import { FormatAuto, FormatStyled } from '../output.js';

export const CHOICE_LIMIT = 100;
const COLUMN = /^([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)$/;
const raw = (value) => String((value && typeof value === 'object' ? value.value : value) ?? '');
const read = (sdk, table, query, fields, limit) => sdk.listStrict(table, new URLSearchParams({
  sysparm_query: query, sysparm_fields: fields, sysparm_limit: String(limit), sysparm_display_value: 'false' }));

// incident.priority names the column incident inherits from task's dictionary row.
async function resolveColumn(argv, app) {
  const match = COLUMN.exec(argv.identifier);
  if (!match) return argv.identifier;
  const [, table, element] = match.map((part) => part.toLowerCase());
  const hierarchy = await loadHierarchy(app.sdk, table).then((nodes) => nodes.map((node) => node.name), (err) => {
    throw err.code === CodeUsage ? errNotFoundHint('column', argv.identifier, err.message) : err; });
  const rows = await read(app.sdk, 'sys_dictionary', `nameIN${hierarchy.join(',')}^element=${element}`, 'sys_id,name,element', hierarchy.length + 1);
  const row = hierarchy.map((name) => rows.find((r) => raw(r?.name) === name && raw(r?.element).toLowerCase() === element)).find(Boolean);
  if (!row) throw errNotFoundHint('column', argv.identifier, `No accessible sys_dictionary entry for ${element} on ${hierarchy.join(', ')}. List columns with: jsn columns list --query "nameIN${hierarchy.join(',')}"`);
  argv.columnHierarchy = hierarchy;
  return raw(row.sys_id);
}

// The most specific table with an active choice supplies the whole list; parents are not merged (proved on a PDI).
async function addChoices(record, app, argv) {
  const choice = raw(record.choice);
  if (!choice || choice === '0') return;
  const element = raw(record.element);
  const table = argv.columnHierarchy?.[0] || raw(record.name);
  if (raw(record.choice_table)) {
    record._choices = { table, element, choice_table: raw(record.choice_table), choice_field: raw(record.choice_field) };
    return;
  }
  const block = { table, element, source: null, searched: [], limit: CHOICE_LIMIT, truncated: false, choices: [] };
  record._choices = block;
  try {
    const hierarchy = argv.columnHierarchy || (await loadHierarchy(app.sdk, table)).map((node) => node.name);
    for (const name of hierarchy) {
      block.searched.push(name);
      const rows = await read(app.sdk, 'sys_choice', `name=${name}^element=${element}^language=en^ORDERBYdependent_value^ORDERBYsequence`,
        'name,element,value,label,sequence,dependent_value,inactive', CHOICE_LIMIT + 1);
      if (rows.some((r) => raw(r?.name) !== name || raw(r?.element) !== element)) throw new Error(`Malformed sys_choice rows for ${name}.${element}`);
      if (!rows.some((r) => raw(r.inactive) !== 'true')) continue;
      block.source = name;
      block.truncated = rows.length > CHOICE_LIMIT;
      block.choices = rows.slice(0, CHOICE_LIMIT).map((r) => ({ value: raw(r.value), label: raw(r.label), sequence: raw(r.sequence),
        dependent_value: raw(r.dependent_value), inactive: raw(r.inactive) === 'true' }));
      break;
    }
  } catch (err) {
    block.error = err.message;
  }
}

function whyCommand(wrap) {
  return {
    command: 'why <column>',
    describe: 'Explain what makes a field read-only, mandatory or hidden on one record (read-only)',
    builder: (y) => y
      .positional('column', { type: 'string', describe: 'Column as <table>.<field> (e.g. incident.caller_id)' })
      .option('record', { type: 'string', describe: 'Record number or sys_id to test conditions against' })
      .option('table', { type: 'string', describe: 'Table name when not using table.field' })
      .option('field', { type: 'string', describe: 'Dictionary element when not using table.field' })
      .option('user', { type: 'string', describe: 'User whose live access to check when access-analyzer (#636) is available' })
      .epilogue([
        'Read-only. Reads the dictionary (inherited rows included), dictionary overrides, UI policy and data policy field actions and write ACLs.',
        'Policy and ACL conditions are tested by reading the record back with sys_id=<id>^<condition> through the Table API.',
        'Client scripts are candidates only and are never executed. ACL rows are configuration evidence, not proof of any user\'s effective access.',
        'Example: jsn columns why incident.caller_id --record INC0000060 --json',
      ].join('\n')),
    handler: wrap(async (argv, app) => {
      app.requireInstance();
      if (!argv.record) throw errUsage('--record is required: pass a record number or sys_id to test conditions against.');
      const data = await columnWhy(app.sdk, {
        column: argv.column,
        table: argv.table,
        field: argv.field,
        recordIdentifier: argv.record,
        user: argv.user,
      });
      const human = [FormatAuto, FormatStyled].includes(app.output.getFormat());
      return app.ok(human ? { ...data, _formatted: formatColumnWhy(data) } : data, {
        summary: `${data.table}.${data.field} on ${data.record.label}: ${data.summary.counts.ui_policies} UI policy, ${data.summary.counts.data_policies} data policy, ${data.summary.counts.write_acls} write ACL, ${data.summary.counts.client_script_candidates} client-script candidate(s)`,
        breadcrumbs: [
          { action: 'behavior', cmd: `jsn tables behavior ${data.table}`, description: 'Inventory the full table configuration' },
          { action: 'columns', cmd: `jsn columns list --table ${data.table}`, description: 'List dictionary entries for the table' },
        ],
      });
    }),
  };
}

export const columnsCmd = (wrap) => {
  const base = buildDevCmd('columns', 'sys_dictionary', [],
    ['element', 'column_label', 'internal_type', 'mandatory', 'max_length', 'active'],
    wrap, { definition: deferredFamilyDefinition('columns'), singular: 'column', scopeValidation: true, help: fieldBehaviorHelp,
      resolveIdentifier: resolveColumn, identifierRequired: true, onShow: addChoices,
      showDescribe: 'Show a column by <table>.<column> or sys_id, with a choice field\'s choices',
      // `--table` is a first-class list filter, not a patched handler: the
      // previous post-build monkey patch never registered the option, so
      // `jsn columns list --table incident` silently listed every table's
      // dictionary rows.
      listOptions: (y) => y.option('table', { type: 'string', describe: 'Only direct sys_dictionary entries of this table (inherited columns live on its parent)' }),
      listFilter: (argv) => {
        if (!argv.table) return '';
        const table = String(argv.table).trim();
        if (!/^[a-zA-Z0-9_]+$/.test(table)) throw errUsage('--table takes a table name, for example incident or sys_import_set.');
        return `name=${table}`;
      },
      extraSubcommands: [{ name: 'why <table>.<field>', description: 'Explain what makes a field read-only, mandatory or hidden on one record (read-only)' }] });
  const originalBuilder = base.builder;
  base.builder = (yargs) => originalBuilder(yargs).command(whyCommand(wrap));
  return base;
};
