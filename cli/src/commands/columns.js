import { deferredFamilyDefinition } from '../command-families.js';
import { fieldBehaviorHelp } from '../field-behavior.js';
import { CodeUsage, errNotFoundHint, errUsage } from '../errors.js';
import { loadHierarchy } from '../table-behavior.js';
import { buildDevCmd } from './_generic.js';

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

export const columnsCmd = (wrap) => {
  return buildDevCmd('columns', 'sys_dictionary', [],
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
      } });
};
