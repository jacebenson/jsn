// Trigger contract for Flow Designer creation.
//
// Flow Designer does NOT give a newly POSTed ProcessFlow a default trigger, so
// the trigger instance must be INSERTED through the same snFlowDesigner
// GraphQL `flowPatch` that inserts actions. Everything the insert needs is read
// from the instance's own schema tables — no trigger input is hardcoded:
//
//   sys_hub_trigger_definition      one row per trigger ("Created", "Daily", …)
//   sys_hub_trigger_category        the picker's first level
//   sys_hub_trigger_input           the inputs a definition declares. The owning
//                                   definition is carried by `name`, which is
//                                   `var__m_sys_hub_trigger_input_<definitionId>`;
//                                   the `model` reference is EMPTY on this
//                                   instance for most definitions, and a
//                                   `trigger_definition=` query is silently
//                                   ignored, so `name` is the only reliable
//                                   relation.
//   sys_db_object / sys_dictionary  the record trigger's Table label and display
//                                   column (the ProcessFlow
//                                   /trigger/record/table descriptor endpoint
//                                   does not exist: HTTP 400 "Requested URI does
//                                   not represent any resource").
//
// `internal_type` on sys_hub_trigger_input holds the parameter's real type
// ("glide_time", "table_name", "conditions", …) as its raw value; its display
// value is the human label ("Time", "Table Name", …).

export const TRIGGER_DEFINITION_TABLE = 'sys_hub_trigger_definition';
export const TRIGGER_CATEGORY_TABLE = 'sys_hub_trigger_category';
export const TRIGGER_INPUT_TABLE = 'sys_hub_trigger_input';

export const TRIGGER_INPUT_NAME_PREFIX = 'var__m_sys_hub_trigger_input_';

// Families this CLI can actually create, each verified against a live instance
// with a disposable draft flow (see the PR body for the probe sys_ids). The
// picker intersects this set with the instance's own active definitions, so an
// unimplemented family can never be offered.
export const SUPPORTED_TRIGGER_TYPES = new Set([
  'record_create',
  'record_update',
  'record_create_or_update',
  'daily',
  'weekly',
  'monthly',
  'repeat',
  'run_once',
  'email',
  'knowledge_management',
  'service_catalog',
  'sla_task',
  'remote_table_query',
]);

// Definitions that exist on the instance but are deliberately not offered, with
// the reason. Kept explicit so the picker can explain the omission instead of
// silently hiding a family.
export const EXCLUDED_TRIGGER_TYPES = new Map([
  ['analytics', 'the Proactive Analytics trigger definition is inactive on this instance'],
  ['rest', 'the Trigger Rest definition has no resolvable trigger category'],
]);

// Families whose declared inputs name a table. The manifest's `table` shortcut
// maps onto whichever of these the chosen definition declares.
const TABLE_INPUT_NAMES = ['table', 'u_table', 'target_table'];
// Same idea for the encoded-query condition.
const CONDITION_INPUT_NAMES = ['condition', 'email_conditions', 'business_calendar_condition'];

// Trigger input types this CLI can prompt for. Anything else must be supplied
// through --data-file so its complete schema and value are preserved.
export const PROMPTABLE_TRIGGER_TYPES = new Set([
  'string', 'table_name', 'field_name', 'conditions', 'choice', 'reference',
  'glide_time', 'glide_date_time', 'glide_duration', 'glide_list',
  'integer', 'decimal', 'float', 'boolean', 'day_of_week', 'month_of_year',
  'script', 'html', 'url', 'email', 'document_id', 'date', 'datetime',
]);

export const NUMERIC_TRIGGER_TYPES = new Set(['integer', 'decimal', 'float']);

function rawValue(value) {
  if (value && typeof value === 'object') return value.value ?? value.sys_id ?? value.name ?? '';
  return value == null ? '' : value;
}

function displayValue(value) {
  if (value && typeof value === 'object') return value.display_value ?? value.value ?? '';
  return value == null ? '' : value;
}

function text(value) {
  const result = rawValue(value);
  return result == null ? '' : String(result);
}

export function isSysId(value) {
  return typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value);
}

function boolValue(value) {
  return String(rawValue(value)).toLowerCase() === 'true';
}

function numeric(value, fallback = 0) {
  const parsed = Number(rawValue(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * The category tree the picker shows, built from the instance's own
 * sys_hub_trigger_category rows and the category reference each active
 * definition carries.
 *
 * Definitions whose category does not resolve to a readable category record
 * are returned separately in `ungrouped` — they are never selectable, but the
 * caller can report them.
 */
export async function readTriggerCatalog(sdk) {
  const [definitions, categories] = await Promise.all([
    sdk.list(TRIGGER_DEFINITION_TABLE, new URLSearchParams({
      sysparm_query: 'active=true^ORDERBYname',
      sysparm_limit: '200',
      sysparm_display_value: 'all',
      sysparm_fields: 'sys_id,name,type,active,category,description',
    })),
    sdk.list(TRIGGER_CATEGORY_TABLE, new URLSearchParams({
      sysparm_limit: '200',
      sysparm_display_value: 'all',
      sysparm_fields: 'sys_id,name',
    })),
  ]);

  const categoryNames = new Map(categories.map(row => [text(row.sys_id), displayValue(row.name) || text(row.name)]));
  const grouped = new Map();
  const ungrouped = [];

  for (const row of definitions) {
    const categoryId = text(row.category);
    const categoryName = categoryNames.get(categoryId) || '';
    const definition = {
      sysId: text(row.sys_id),
      type: text(row.type),
      name: displayValue(row.name) || text(row.name),
      description: displayValue(row.description) || '',
      supported: SUPPORTED_TRIGGER_TYPES.has(text(row.type)),
      excludedReason: EXCLUDED_TRIGGER_TYPES.get(text(row.type)) || (SUPPORTED_TRIGGER_TYPES.has(text(row.type)) ? '' : 'this CLI has no verified creation contract for this trigger'),
    };
    if (!categoryId || !categoryName) {
      ungrouped.push(definition);
      continue;
    }
    if (!grouped.has(categoryId)) grouped.set(categoryId, { id: categoryId, name: categoryName, triggers: [] });
    grouped.get(categoryId).triggers.push(definition);
  }

  const categoriesOut = [...grouped.values()]
    .map(category => ({ ...category, triggers: category.triggers.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { categories: categoriesOut, ungrouped };
}

/** The pickable definitions for one category, in the shape the picker needs. */
export function selectableTriggers(category) {
  return (category?.triggers || []).filter(trigger => trigger.supported);
}

// Definition descriptions are authored HTML; strip it and keep the first
// sentence so a picker row stays readable.
export function triggerChoiceLabel(trigger) {
  const text = String(trigger?.description || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return trigger?.name || '';
  const sentence = text.split(/\.\s/)[0];
  return `${trigger.name} — ${sentence.length > 90 ? `${sentence.slice(0, 87)}…` : sentence}`;
}

/**
 * The inputs a trigger definition declares, straight from
 * sys_hub_trigger_input. Answers "what must I supply for this family?" from the
 * instance rather than from a hand-written table.
 */
export async function readTriggerInputDefinitions(sdk, definitionId) {
  if (!isSysId(definitionId)) throw new Error(`Trigger definition id must be an exact sys_id, got "${definitionId}"`);
  const rows = await sdk.list(TRIGGER_INPUT_TABLE, new URLSearchParams({
    sysparm_query: `name=${TRIGGER_INPUT_NAME_PREFIX}${definitionId}^ORDERBYorder`,
    sysparm_limit: '200',
    sysparm_display_value: 'all',
    sysparm_fields: 'sys_id,element,label,column_label,internal_type,mandatory,order,max_length,default_value,attributes,choice,reference,use_dependent_field,dependent_on_field,read_only,hint',
  }));
  return rows
    .map(normalizeTriggerInput)
    .filter(input => input.name);
}

function normalizeTriggerInput(row) {
  const parameter = {
    id: text(row.sys_id),
    label: displayValue(row.label) || displayValue(row.column_label) || text(row.element),
    name: text(row.element),
    type: text(row.internal_type),
    hint: displayValue(row.hint) || '',
    order: numeric(row.order),
    extended: false,
    mandatory: boolValue(row.mandatory),
    readonly: boolValue(row.read_only),
    maxsize: numeric(row.max_length),
    children: [],
    reference: text(row.reference) ? displayValue(row.reference) : '',
    reference_display: '',
    ref_qual: '',
    choiceOption: text(row.choice),
    table: '',
    columnName: '',
    defaultValue: rawValue(row.default_value) ?? '',
    use_dependent: boolValue(row.use_dependent_field),
    dependent_on: text(row.dependent_on_field),
    show_ref_finder: false,
    local: false,
    // On INPUT the GraphQL type is String; the read path renders it as an object.
    attributes: text(row.attributes),
  };
  return {
    id: parameter.id,
    name: parameter.name,
    label: parameter.label,
    type: parameter.type,
    mandatory: parameter.mandatory,
    order: parameter.order,
    defaultValue: parameter.defaultValue === '' ? '' : String(parameter.defaultValue),
    reference: parameter.reference,
    parameter,
  };
}

/**
 * The record trigger's table metadata. The documented ProcessFlow descriptor
 * route (/api/now/processflow/trigger/record/table) does not exist on this
 * instance, so the label comes from sys_db_object and the display column from
 * the nearest sys_dictionary `display=true` element walking up the
 * super_class chain (a child table such as `ticket` inherits `number` from
 * `task`).
 */
export async function readTableDescriptor(sdk, table) {
  const name = String(table || '').trim();
  if (!name) throw new Error('Record trigger requires a table name');
  const rows = await sdk.list('sys_db_object', new URLSearchParams({
    sysparm_query: `name=${name}`,
    sysparm_limit: '2',
    sysparm_display_value: 'all',
    sysparm_fields: 'name,label,super_class',
  }));
  if (rows.length !== 1) throw new Error(rows.length === 0 ? `Table not found: ${name}` : `Table name is ambiguous: ${name}`);
  const label = displayValue(rows[0].label) || text(rows[0].label);
  if (!label) throw new Error(`Table ${name} has no label`);
  return { table: name, label, displayField: await readDisplayField(sdk, name, text(rows[0].super_class)) };
}

async function readDisplayField(sdk, table, superId) {
  let current = table;
  let parentId = superId;
  for (let depth = 0; depth < 16 && current; depth += 1) {
    const field = await sdk.list('sys_dictionary', new URLSearchParams({
      sysparm_query: `name=${current}^display=true`,
      sysparm_limit: '5',
      sysparm_display_value: 'all',
      sysparm_fields: 'element',
    }));
    const element = field.map(row => text(row.element)).find(Boolean);
    if (element) return element;
    if (!parentId) return '';
    const parent = await sdk.list('sys_db_object', new URLSearchParams({
      sysparm_query: `sys_id=${parentId}`,
      sysparm_limit: '2',
      sysparm_display_value: 'all',
      sysparm_fields: 'name,super_class',
    }));
    if (parent.length !== 1) return '';
    current = text(parent[0].name);
    parentId = text(parent[0].super_class);
  }
  return '';
}

/** The declared input a manifest shortcut (`table`, `condition`) should drive. */
export function tableInputFor(declared) {
  return declared.find(input => TABLE_INPUT_NAMES.includes(input.name)) || null;
}

export function conditionInputFor(declared) {
  return declared.find(input => CONDITION_INPUT_NAMES.includes(input.name)) || null;
}

function wrapped(value) {
  const scalar = value === '' || value === null || value === undefined ? '' : String(value);
  return { schemaless: false, schemalessValue: '', value: scalar };
}

function declaredDefault(input) {
  return input.defaultValue === '' || input.defaultValue === undefined ? '' : input.defaultValue;
}

/**
 * Turn a definition's declared inputs plus the caller's values into the exact
 * `inputs` array the snFlowDesigner insert expects.
 *
 * Every declared input is written, using the instance's own default when the
 * caller supplies nothing, because Flow Designer stores the full input set
 * (a real record trigger carries run_on_extended / run_flow_in /
 * run_when_setting / … alongside table and condition).
 */
export function buildTriggerInputs(declared, supplied = {}, tableDescriptor = null) {
  const byName = new Map(declared.map(input => [input.name, input]));
  for (const name of Object.keys(supplied)) {
    if (!byName.has(name)) throw new Error(`Trigger input "${name}" is not declared by this trigger definition`);
  }
  for (const input of declared) {
    const value = Object.prototype.hasOwnProperty.call(supplied, input.name) ? supplied[input.name] : declaredDefault(input);
    const resolved = value === '' || value === null || value === undefined ? '' : String(value);
    if (resolved === '' && input.mandatory) throw new Error(`Trigger input "${input.name}" (${input.label || input.type}) is required`);
    const tableValue = tableDescriptor && TABLE_INPUT_NAMES.includes(input.name);
    const renderedValue = tableValue ? tableDescriptor.table : resolved;
    const renderedDisplay = tableValue ? tableDescriptor.label : resolved;
    if (!input.parameter?.id) throw new Error(`Trigger input "${input.name}" is missing its provider identity; refusing to invent one`);
    byName.get(input.name).value = renderedValue;
    byName.get(input.name).displayValue = renderedDisplay;
    byName.get(input.name).displayField = tableValue ? tableDescriptor.displayField || '' : '';
  }
  return declared.map(input => ({
    name: input.name,
    value: wrapped(input.value),
    displayValue: wrapped(input.displayValue),
    displayField: input.displayField || '',
    scriptActive: false,
    label: input.parameter.label,
    internalType: input.parameter.type,
    fromTemplate: false,
    order: input.parameter.order,
    valueSysId: '',
    mandatory: input.parameter.mandatory === true,
    parameter: input.parameter,
  }));
}

/** The triggerInstances.insert payload for the snFlowDesigner flow patch. */
export function buildTriggerInstance({ flowId, definition, triggerType = '', inputs, metadata = '{}' }) {
  if (!flowId) throw new Error('Trigger insert requires the created flow id');
  if (!definition?.sysId || !definition?.type) throw new Error('Trigger insert requires a resolved trigger definition');
  return {
    flowSysId: flowId,
    name: definition.name,
    type: definition.type,
    triggerType: triggerType || '',
    triggerDefinitionId: definition.sysId,
    metadata,
    inputs,
  };
}

// The snFlowDesigner GraphQL input types take `attributes` as a String
// ("key=value,key=value") even though the ProcessFlow read path renders it as an
// object. Sending the object fails validation: "not a valid 'String'".
export function attributesToString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Provider attributes must be a string or a flat object');
  return Object.entries(value).map(([key, item]) => `${key}=${item}`).join(',');
}

// Accepted `parameter` keys on global_snFlowDesigner_FlowDesignParameter.
// GraphQL introspection is disabled on this instance, so this list was
// established empirically by probing each candidate field against the live
// schema (unknown keys answer "contains a field not in
// 'global_snFlowDesigner_FlowDesignParameter'"). Anything the ProcessFlow
// action definition returns that is NOT in this list — notably the synthetic
// `default` this CLI adds, plus `scriptActive`/`value`/`displayValue` — must be
// carried elsewhere or dropped, or the mutation fails validation.
const FLOW_DESIGN_PARAMETER_FIELDS = [
  'id', 'label', 'name', 'type', 'type_label', 'hint', 'order', 'extended',
  'mandatory', 'readonly', 'maxsize', 'children', 'data_structure', 'reference',
  'reference_display', 'ref_qual', 'choiceOption', 'table', 'columnName',
  'defaultValue', 'defaultDisplayValue', 'use_dependent', 'dependent_on',
  'show_ref_finder', 'local', 'attributes', 'sys_class_name', 'choices',
  'defaultChoices', 'uiDisplayType', 'uiDisplayTypeLabel', 'placeholder',
  'comments', 'internal_link', 'dynamic', 'searchField',
];

/** A provider schema entry narrowed to the GraphQL parameter input type. */
export function flowDesignParameter(entry) {
  const out = {};
  for (const key of FLOW_DESIGN_PARAMETER_FIELDS) if (entry?.[key] !== undefined) out[key] = entry[key];
  out.attributes = attributesToString(entry?.attributes);
  return out;
}
