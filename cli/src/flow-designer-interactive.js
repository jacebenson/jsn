// Terminal orchestration only. Persistence and lifecycle remain in the SDK.
import fs from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import { input, select, confirm, editor } from '@inquirer/prompts';
import { canPrompt, interactiveList, getStringField } from './helpers.js';
import { FormatAuto } from './output.js';
import { errUsage, errConfirmationRequired } from './errors.js';
import { getCurrentUser, getCurrentApplication } from './context.js';
import { validateDefinition, validateScope, ACTION_TABLE } from './processflow-actions.js';
import { validateFlowManifest, validateFlowUpdateManifest, readProcessFlow, readActionDefinition } from './flow-create.js';
import {
  NUMERIC_TRIGGER_TYPES,
  PROMPTABLE_TRIGGER_TYPES,
  conditionInputFor,
  readTableDescriptor,
  readTriggerCatalog,
  readTriggerInputDefinitions,
  selectableTriggers,
  tableInputFor,
  triggerChoiceLabel,
} from './flow-triggers.js';
import { deriveRecordTrigger } from './flow-test.js';
import { getActiveProfile } from './config.js';

const CANCEL = Symbol('cancel');
const clone = value => structuredClone(value);
export const rawField = value => value && typeof value === 'object' && 'value' in value ? value.value : value;
const prompts = app => app.flowDesignerPrompts || { input, select, confirm, editor };
export function hasDefinitionData(argv) {
  return argv.data !== undefined || argv['data-file'] !== undefined || argv.dataFile !== undefined;
}
export function interactiveDesigner(argv, app) {
  return !hasDefinitionData(argv) && argv['output-map'] === undefined && !argv.get && app.output?.getFormat() === FormatAuto && canPrompt();
}
export async function cancelled(operation) {
  try { return await operation(); }
  catch (error) {
    if (error === CANCEL || ['ExitPromptError', 'AbortPromptError'].includes(error.name)) return undefined;
    // Keep direct handler errors throwable; opt into the shared JSON renderer at the CLI boundary.
    if (error.code === 'usage_error') error.jsonEnvelope = true;
    throw error;
  }
}
export async function pickDesignerRecord(argv, app, table, singular, query = '', labelField = 'name') {
  if (argv.identifier !== undefined) {
    if (!String(argv.identifier).trim()) throw errUsage(`${singular} identifier must not be empty`);
    return argv.identifier;
  }
  if (!interactiveDesigner(argv, app)) throw errUsage(`Provide an explicit ${singular} identifier in noninteractive mode`);
  const picked = await interactiveList({ app, table, singular, query, labelField,
    columns: [labelField], promptFn: app.promptFn });
  if (picked === null) throw errUsage(`No readable ${singular} records are available for selection`);
  if (picked === undefined) return undefined;
  const id = rawField(picked.sys_id);
  if (!id) throw errUsage(`Selected ${singular} has no raw sys_id`);
  return id;
}
export async function designerScope(argv, app) {
  if (argv.scope !== undefined) return validateScope(app.sdk, argv.scope);
  if (!interactiveDesigner(argv, app)) throw errUsage('Provide --scope <exact sys_id or global> in noninteractive mode');
  const user = await getCurrentUser(app.sdk);
  const current = user ? await getCurrentApplication(app.sdk, user.sys_id) : null;
  if (current?.appSysId && await prompts(app).confirm({ message: `Use current application scope ${current.appSysId}?`, default: true })) {
    return validateScope(app.sdk, current.appSysId);
  }
  const scope = await pickDesignerRecord(argv, app, 'sys_scope', 'scope');
  if (scope === undefined) throw CANCEL;
  return validateScope(app.sdk, scope);
}
export async function confirmDesignerSave(app, message) {
  if (!await prompts(app).confirm({ message, default: false })) throw CANCEL;
}
// Explicit JSON/data, pipes and disabled prompts never enter a TTY confirmation.
export async function confirmDesignerMutation(argv, app, message) {
  if (argv.force) return;
  if (interactiveDesigner(argv, app)) return confirmDesignerSave(app, message);
  if (getActiveProfile(app.config)?.skip_confirmations === true) return;
  throw errConfirmationRequired(message, ['jsn', ...(argv._ || [])].join(' '));
}
function required(value) { return String(value).trim() ? true : 'A value is required'; }
function scalarDefault(value) { return value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value); }
function schemaObjectValue(field, value) {
  return ['object', 'complex'].includes(field.type) && value && typeof value === 'object'
    && !('schemaless' in value) && field.children?.some(child => Object.hasOwn(value, child.name));
}

// Preserve schema objects. Change only a requested value, never regenerate metadata.
export async function promptSchemaValue(app, field, existing, prefix = '') {
  if (!field?.name || !field.type) throw errUsage('Provider returned an incomplete named, typed input schema');
  const p = prompts(app);
  const message = `${prefix}${field.label || field.name} [${field.type}]`;
  const supplied = existing ?? field.defaultValue ?? field.default;
  const value = schemaObjectValue(field, supplied) ? supplied : rawField(supplied);
  if (field.type === 'script') {
    const method = await p.select({ message: `${message}: script source`, choices: [
      { name: 'Script file', value: 'file' }, { name: 'Open $VISUAL/$EDITOR', value: 'editor' },
    ] });
    const script = method === 'file'
      ? fs.readFileSync(await p.input({ message: 'Script file path', validate: required }), 'utf8')
      : await p.editor({ message, default: scalarDefault(value), waitForUse: true });
    if ((field.mandatory === true || field.required === true) && !script.trim()) throw errUsage(`Script ${field.name} is required; nothing was saved`);
    return script;
  }
  if (typeof value === 'string' && value.startsWith('{{')) {
    return p.input({ message: `${message} (raw pill)`, default: value, validate: required });
  }
  if (field.children?.length && ['object', 'complex'].includes(field.type)) {
    const result = value && typeof value === 'object' && !Array.isArray(value) ? clone(value) : {};
    for (const child of field.children) result[child.name] = await promptSchemaValue(app, child, result[child.name], `${message}.`);
    return result;
  }
  if (['boolean', 'bool'].includes(field.type)) {
    return p.confirm({ message, default: value === true || value === 'true' });
  }
  if (field.type === 'choice' && Array.isArray(field.choices) && field.choices.length) {
    if (field.choices.some(choice => typeof choice !== 'string' && (!choice || !Object.hasOwn(choice, 'value')))) {
      throw errUsage(`Choice input ${field.name} has incomplete provider choices; nothing was saved`);
    }
    return p.select({ message, default: value, choices: field.choices.map(choice => ({
      name: typeof choice === 'string' ? choice : String(choice.label ?? choice.display_value ?? choice.value),
      value: typeof choice === 'string' ? choice : choice.value,
    })) });
  }
  const textual = ['string', 'reference', 'table_name', 'field_name', 'conditions', 'condition', 'html', 'url', 'email', 'choice', 'document_id'];
  const numeric = ['integer', 'number', 'decimal', 'float'];
  if (![...textual, ...numeric].includes(field.type)) {
    throw errUsage(`Guided input ${field.name} has unsupported type ${field.type}; use --data-file to preserve its complete schema and value`);
  }
  const answer = await p.input({ message: `${message} (raw pills accepted)`, default: scalarDefault(value), validate: answer => {
    if ((field.mandatory === true || field.required === true) && answer === '') return 'A value is required';
    if (numeric.includes(field.type) && answer !== '' && !answer.startsWith('{{') && (!Number.isFinite(Number(answer)) || field.type === 'integer' && !Number.isInteger(Number(answer)))) return 'Enter a valid number or raw pill';
    return true;
  } });
  // Pills are opaque provider expressions, not numbers to be coerced.
  return numeric.includes(field.type) && answer !== '' && !answer.startsWith('{{') ? Number(answer) : answer;
}
async function editVariables(app, variables, message, valueKey = 'value') {
  for (const field of variables.filter(field => !field.name.startsWith('__'))) {
    if (await prompts(app).confirm({ message: `${message}: change ${field.name}?`, default: false })) {
      const value = await promptSchemaValue(app, field, field[valueKey], `${message}: `);
      const wrapped = field[valueKey] && typeof field[valueKey] === 'object' && 'value' in field[valueKey] && !schemaObjectValue(field, field[valueKey]);
      field[valueKey] = wrapped ? { ...field[valueKey], value } : value;
      if (valueKey === 'defaultValue') field.mandatory = await prompts(app).confirm({ message: `${field.name}: required?`, default: field.mandatory === true });
    }
  }
}
function schemaTemplates(types) {
  const templates = [];
  const visit = fields => {
    if (fields !== undefined && !Array.isArray(fields)) throw errUsage('Provider variable schema must be an array; no parent was allocated');
    for (const field of fields || []) {
      if (!field || typeof field !== 'object') throw errUsage('Provider variable schema requires objects; no parent was allocated');
      if (field.name && field.type && !field.name.startsWith('__')) templates.push(field);
      visit(field.children);
    }
  };
  for (const type of types) { visit(type.inputs); visit(type.outputs); visit(type.extended_inputs); visit(type.extended_outputs); }
  return templates;
}
function freshVariable(template) {
  const field = clone(template);
  const renew = variable => {
    variable.id = randomBytes(16).toString('hex');
    if (variable.attributes?.uiUniqueId) variable.attributes.uiUniqueId = randomUUID();
    for (const child of variable.children || []) renew(child);
  };
  renew(field);
  return field;
}
async function newVariable(app, templates, message) {
  const candidates = templates.filter(field => ['string', 'integer', 'boolean', 'reference', 'object'].includes(field.type));
  if (!candidates.length) throw errUsage('Step schemas contain no supported variable templates; use --data-file');
  const template = await prompts(app).select({ message: `${message}: select provider schema template`, choices: candidates.map(field => ({ name: `${field.name} [${field.type}]`, value: field })) });
  const field = freshVariable(template);
  field.name = await prompts(app).input({ message: `${message}: variable name`, validate: value => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) || 'Use a JavaScript variable name' });
  field.label = field.name;
  field.mandatory = await prompts(app).confirm({ message: `${field.name}: required?`, default: false });
  delete field.value;
  delete field.display_value;
  return field;
}
export function stepTypeSchemas(response) {
  const types = Array.isArray(response) ? response : response?.step_types ?? response?.stepTypes;
  if (!Array.isArray(types) || !types.length) throw errUsage('Provider returned no supported step_types schema array; no parent was allocated');
  return types;
}
export async function guidedActionCreate(argv, app) {
  if (!interactiveDesigner(argv, app)) throw errUsage('Provide --data-file or --data for a full action definition in noninteractive mode');
  const scope = await designerScope(argv, app);
  const types = stepTypeSchemas(await app.sdk.getProcessFlowStepTypes(scope));
  const definition = { scope, name: await prompts(app).input({ message: 'Action name', validate: required }),
    description: await prompts(app).input({ message: 'Description' }), inputs: [], outputs: [], steps: [] };
  const templates = schemaTemplates(types);
  while (await prompts(app).confirm({ message: 'Add an action input?', default: false })) {
    definition.inputs.push(await newVariable(app, templates, 'Action input'));
  }
  do {
    const schema = await prompts(app).select({ message: 'Select executable step schema', choices: types.map(type => ({ name: type.name || type.step_type_name || type.type || type.step_type, value: type })) });
    if (!(schema.type || schema.step_type) || !(schema.id || schema.step_type_id) || !Array.isArray(schema.inputs) || !Array.isArray(schema.outputs)) {
      throw errUsage('Selected provider step schema is incomplete; no parent was allocated');
    }
    const step = { ...clone(schema), cid: randomUUID(), step_type: schema.step_type || schema.type,
      step_type_id: schema.step_type_id || schema.id, order: definition.steps.length + 1,
      inputs: clone(schema.inputs), outputs: clone(schema.outputs),
      extended_inputs: clone(schema.extended_inputs || []), extended_outputs: clone(schema.extended_outputs || []) };
    delete step.id;
    delete step.step_id;
    delete step.action;
    for (const field of step.inputs) field.value = await promptSchemaValue(app, field, field.value);
    if (step.step_type === 'SCRIPT') {
      for (const field of definition.inputs) step.extended_inputs.push({ ...freshVariable(field), extended: true, value: `{{inputs.${field.name}}}` });
      while (await prompts(app).confirm({ message: 'Declare a script step output?', default: false })) {
        step.extended_outputs.push({ ...await newVariable(app, templates, 'Script output'), extended: true });
      }
    }
    definition.steps.push(step);
  } while (await prompts(app).confirm({ message: 'Add another step?', default: false }));
  const outputs = definition.steps.flatMap(step => [...step.outputs, ...step.extended_outputs]
    .filter(field => !field.name.startsWith('__')).map(field => ({ step, field })));
  while (await prompts(app).confirm({ message: 'Map a step output to an action output?', default: false })) {
    if (!outputs.length) throw errUsage('No provider-declared step outputs available');
    const { step, field } = await prompts(app).select({ message: 'Select output', choices: outputs.map(candidate => ({ name: `Step ${candidate.step.order}: ${candidate.field.name}`, value: candidate })) });
    const output = { ...freshVariable(field), extended: false };
    output.name = await prompts(app).input({ message: 'Action output name', default: field.name, validate: required });
    output.value = `{{step[${step.cid}].${field.name}}}`;
    definition.outputs.push(output);
  }
  validateDefinition(definition, undefined, scope);
  await confirmDesignerSave(app, `Create inactive draft action '${definition.name}' with ${definition.steps.length} step(s)? No publish or execution.`);
  return { scope, definition };
}
export async function guidedActionEdit(argv, app, definition) {
  if (!interactiveDesigner(argv, app)) throw errUsage('Provide --data-file or --data for the full action definition in noninteractive mode');
  validateDefinition(definition, definition.id, definition.scope);
  const edited = clone(definition);
  const fields = await prompts(app).select({ message: 'Edit action', choices: [
    { name: 'Name and description', value: 'metadata' }, { name: 'Action inputs', value: 'inputs' },
    { name: 'Action output mappings', value: 'outputs' }, { name: 'Step inputs, scripts and mappings', value: 'steps' },
  ] });
  if (fields === 'metadata') {
    edited.name = await prompts(app).input({ message: 'Action name', default: edited.name, validate: required });
    if (Object.hasOwn(edited, 'displayName')) edited.displayName = edited.name;
    edited.description = await prompts(app).input({ message: 'Description', default: edited.description || '' });
  } else if (fields === 'steps') {
    const step = await prompts(app).select({ message: 'Select saved step', choices: edited.steps.map(step => ({ name: `${step.order}: ${step.step_type}`, value: step })) });
    await editVariables(app, step.inputs, 'Step input');
    await editVariables(app, step.extended_inputs, 'Step input mapping');
    await editVariables(app, step.extended_outputs, 'Step output');
  } else await editVariables(app, edited[fields], fields, fields === 'inputs' ? 'defaultValue' : 'value');
  validateDefinition(edited, definition.id, definition.scope);
  await confirmDesignerSave(app, `Save action '${edited.name}'? Unspecified schema and lifecycle identities are preserved. No publish or execution.`);
  return edited;
}
export async function guidedActionTestInputs(argv, app, definition) {
  const values = {};
  for (const field of definition.inputs) values[field.name] = await promptSchemaValue(app, field, field.defaultValue, 'Test input: ');
  return values;
}
async function tableName(argv, app) {
  const id = await pickDesignerRecord(argv, app, 'sys_db_object', 'trigger table');
  if (id === undefined) throw CANCEL;
  const table = await app.sdk.get('sys_db_object', id);
  const name = rawField(table?.name);
  if (!name) throw errUsage('Selected trigger table has no raw name');
  return name;
}

// Prompt for one declared trigger input. Choice lists are not exposed by
// sys_hub_trigger_input on this instance, and every supported family declares
// its choice/boolean inputs as optional with a default, so those keep the
// instance default instead of inventing options.
async function promptTriggerInput(app, input) {
  if (!input?.name || !input.type) throw errUsage('Provider returned an incomplete named, typed trigger input');
  if (input.type === 'choice') {
    if (input.mandatory) throw errUsage(`Trigger input ${input.name} is a mandatory choice whose options this instance does not expose; supply it through --data-file`);
    return null;
  }
  if (input.type === 'boolean') return null;
  if (!PROMPTABLE_TRIGGER_TYPES.has(input.type)) {
    throw errUsage(`Trigger input ${input.name} has unsupported type ${input.type}; use --data-file to preserve its complete schema and value`);
  }
  const p = prompts(app);
  const message = `Trigger input: ${input.label || input.name} [${input.type}]`;
  const fallback = input.defaultValue === '' || input.defaultValue === undefined ? '' : String(input.defaultValue);
  if (NUMERIC_TRIGGER_TYPES.has(input.type)) {
    const answer = await p.input({ message, default: scalarDefault(fallback), validate: value => {
      if (value === '' && input.mandatory) return 'A value is required';
      if (value === '') return true;
      return Number.isFinite(Number(value)) ? true : 'Enter a number';
    } });
    return answer === '' ? '' : Number(answer);
  }
  return p.input({ message, default: scalarDefault(fallback), validate: value => (input.mandatory && value === '' ? 'A value is required' : true) });
}

export async function guidedFlowCreate(argv, app) {
  if (!interactiveDesigner(argv, app)) throw errUsage('Provide --data-file or --data for the flow manifest in noninteractive mode');
  const name = await prompts(app).input({ message: 'Flow name', validate: required });
  const description = await prompts(app).input({ message: 'Description' });
  const scope = await designerScope(argv, app);
  const manifest = { name, description, scope, trigger: { type: '' }, actions: [] };

  // Category first, then the triggers that category actually contains, both
  // read from the instance (sys_hub_trigger_category + the definition's own
  // `category` reference). Definitions this CLI cannot create are never offered.
  const catalog = await readTriggerCatalog(app.sdk);
  const pickable = catalog.categories.filter(category => selectableTriggers(category).length);
  if (!pickable.length) {
    throw errUsage('No supported trigger categories are available on this instance; use --data-file to supply the manifest directly');
  }
  const chosenCategory = await prompts(app).select({
    message: 'Select a trigger category',
    choices: pickable.map(category => ({ name: `${category.name} (${selectableTriggers(category).length})`, value: category })),
  });
  const triggers = selectableTriggers(chosenCategory);
  const definition = await prompts(app).select({
    message: `Select a ${chosenCategory.name} trigger`,
    choices: triggers.map(trigger => ({ name: triggerChoiceLabel(trigger), value: trigger })),
  });
  manifest.trigger.type = definition.type;

  const declared = await readTriggerInputDefinitions(app.sdk, definition.sysId);
  const tableInput = tableInputFor(declared);
  if (tableInput) {
    manifest.trigger.table = await tableName(argv, app);
  }
  const conditionInput = conditionInputFor(declared);
  if (conditionInput) {
    manifest.trigger.condition = await prompts(app).input({ message: 'Trigger condition (single supported encoded predicate, or empty)' });
  }
  const optional = declared.filter(input => !tableInput || input.name !== tableInput.name)
    .filter(input => !conditionInput || input.name !== conditionInput.name);
  if (optional.some(input => input.mandatory)) {
    manifest.trigger.inputs = {};
    for (const input of optional.filter(candidate => candidate.mandatory)) {
      const value = await promptTriggerInput(app, input);
      if (value !== null) manifest.trigger.inputs[input.name] = value;
    }
  }
  if (optional.some(input => !input.mandatory && input.type !== 'choice' && input.type !== 'boolean')
    && await prompts(app).confirm({ message: 'Change optional trigger inputs (otherwise the instance defaults are used)?', default: false })) {
    manifest.trigger.inputs = manifest.trigger.inputs || {};
    for (const input of optional.filter(candidate => !candidate.mandatory)) {
      if (input.type === 'choice' || input.type === 'boolean') continue;
      if (!await prompts(app).confirm({ message: `Change ${input.label || input.name} [${input.type}]?`, default: false })) continue;
      const value = await promptTriggerInput(app, input);
      if (value !== null) manifest.trigger.inputs[input.name] = value;
    }
  }
  if (manifest.trigger.inputs && !Object.keys(manifest.trigger.inputs).length) delete manifest.trigger.inputs;

  while (await prompts(app).confirm({ message: 'Add a published action?', default: true })) {
    const id = await pickDesignerRecord(argv, app, ACTION_TABLE, 'published action', 'active=true^published=true');
    if (id === undefined) throw CANCEL;
    const { schema } = await readActionDefinition(app.sdk, app.getEffectiveInstance(), id, manifest.scope, { requireTypes: true });
    const inputs = {};
    for (const field of schema) {
      if (!field.id || !field.name) {
        throw errUsage(`Published action input ${field.name || 'unknown'} lacks the provider identity needed to bind a value; no flow was allocated`);
      }
      inputs[field.name] = await promptSchemaValue(app, field, field.default, 'Action input: ');
    }
    manifest.actions.push({ type: id, inputs });
  }
  validateFlowManifest(manifest);
  await confirmDesignerSave(app, `Create inactive draft flow '${manifest.name}' with trigger ${definition.name} and ${manifest.actions.length} action(s)? No publish or execution.`);
  return manifest;
}
export async function savedFlowDefinition(app, identifier) {
  const { resolveRecord, unwrapSysId } = await import('./resolve-record.js');
  const record = await resolveRecord(app.sdk, { table: 'sys_hub_flow', identifier, matchField: 'name', resource: 'flow' });
  const id = unwrapSysId(record);
  const scope = rawField(record.sys_scope) || rawField(record.scope);
  if (!scope) throw errUsage('Saved flow has no raw transaction scope');
  return { record, definition: await readProcessFlow(app.sdk, app.getEffectiveInstance(), id, scope) };
}
export async function guidedFlowEdit(argv, app) {
  if (!interactiveDesigner(argv, app)) throw errUsage('Provide --data-file or --data for the flow update manifest in noninteractive mode');
  const { record, definition } = await savedFlowDefinition(app, argv.identifier);
  // Published/active targets are judged by the provider, exactly as the scripted
  // path does: an inactive Draft needs no write check, anything else must report
  // security.can_write=true or the save would be rejected after this wizard.
  const active = rawField(record.active) === true || rawField(record.active) === 'true';
  const draft = !active && rawField(record.status) === 'draft';
  if (!draft && definition?.security?.can_write !== true) throw errUsage(`Guided flow edit needs the flow's ProcessFlow definition to report security.can_write=true; ${argv.identifier} does not, so the provider would reject the save. Edit it in Flow Designer as a user who can write this flow.`);
  const manifest = {};
  const choice = await prompts(app).select({ message: 'Edit supported flow fields', choices: [
    { name: 'Record trigger condition', value: 'trigger' }, { name: 'Existing action input values', value: 'actions' },
  ] });
  if (choice === 'trigger') {
    const trigger = deriveRecordTrigger(definition).trigger;
    const condition = (trigger.inputs || []).find(field => field.name === 'condition');
    manifest.trigger = { condition: await prompts(app).input({ message: 'Trigger condition (single supported encoded predicate, or empty)', default: rawField(condition?.value) || '' }) };
  } else {
    const actions = definition.actionInstances || definition.actions || [];
    if (!actions.length) throw errUsage('Saved flow contains no supported action instances');
    const action = await prompts(app).select({ message: 'Select saved action instance', choices: actions.map(action => ({ name: `${action.order}: ${getStringField(action, 'name') || action.actionTypeSysId}`, value: action })) });
    const fields = action.inputs || action.inputValues || [];
    if (!fields.length) throw errUsage('Saved action instance contains no input schema');
    const field = await prompts(app).select({ message: 'Select input to change', choices: fields.map(field => ({ name: `${field.name} [${field.type || field.parameter?.type || 'unknown'}]`, value: field })) });
    const actionType = rawField(action.actionTypeSysId || action.action_type_sys_id || action.actionType?.sys_id || action.actionType?.sysId);
    let inputSchema = { ...field, type: field.type || field.parameter?.type };
    if (!inputSchema.type) {
      const { schema } = await readActionDefinition(app.sdk, app.getEffectiveInstance(), actionType, rawField(record.sys_scope) || rawField(record.scope), { requireTypes: true });
      inputSchema = schema.find(candidate => candidate.name === field.name);
      if (!inputSchema) throw errUsage(`Saved action input ${field.name} is absent from its provider schema`);
    }
    const value = await promptSchemaValue(app, inputSchema, rawField(field.value));
    manifest.actions = [{ order: Number(action.order), type: actionType, inputs: { [field.name]: value } }];
  }
  validateFlowUpdateManifest(manifest);
  return manifest;
}
export async function guidedFlowTestRecord(argv, app) {
  if (argv.record !== undefined) return argv.record;
  if (!interactiveDesigner(argv, app)) throw errUsage('Provide --record <sys_id> in noninteractive mode');
  const { definition } = await savedFlowDefinition(app, argv.identifier);
  const { table } = deriveRecordTrigger(definition);
  const descriptor = await readTableDescriptor(app.sdk, table);
  const { identifier: _identifier, ...pickerArgs } = argv;
  return pickDesignerRecord(pickerArgs, app, table, `test record in ${table}`, '', descriptor.displayField);
}
