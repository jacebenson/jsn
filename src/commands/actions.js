import { buildDevCmd } from './_generic.js';
import { formatCommandList, parseDataArg } from '../helpers.js';
import { resolveRecord, unwrapSysId } from '../resolve-record.js';
import { declareCapabilities } from '../capabilities.js';
import { ACTION_TABLE, actionScope } from '../processflow-actions.js';
import { errUsage } from '../errors.js';
import { cancelled, pickDesignerRecord, designerScope, guidedActionCreate, guidedActionEdit, guidedActionTestInputs, interactiveDesigner, hasDefinitionData, confirmDesignerMutation } from '../flow-designer-interactive.js';

const ACTION_COMMANDS = [
  { name: 'list', description: 'List actions' },
  { name: 'show [identifier]', description: 'Show an action by name or sys_id' },
  { name: 'help [identifier]', description: 'Show action input requirements and live usage examples' },
  { name: 'definition [identifier]', description: 'Read the full JSON definition including executable step_instances' },
  { name: 'step-types', description: 'Read step schema templates for a target scope' },
  { name: 'create', description: 'Create an action: guided in a terminal, full JSON definition in scripts' },
  { name: 'update [identifier]', description: 'Save a full definition through Process Flow (alias: edit)' },
  { name: 'test [identifier]', description: 'Execute an action and optionally wait for actual outputs' },
  { name: 'delete [identifier]', description: 'Delete an action parent explicitly' },
];

const scopeOption = y => y.option('scope', { type: 'string', describe: 'Exact transaction scope sys_id; inferred from existing action when omitted' });
const dataOptions = y => y
  .option('data-file', { type: 'string', describe: 'Full action definition JSON file, not table fields' })
  .option('data', { type: 'string', describe: 'Full action definition as JSON' });
async function actionID(argv, app) {
  const identifier = await pickDesignerRecord(argv, app, ACTION_TABLE, 'action');
  if (identifier === undefined) return undefined;
  argv = { ...argv, identifier };
  return unwrapSysId(await resolveRecord(app.sdk, { table: ACTION_TABLE, identifier: argv.identifier, matchField: 'name', resource: 'action' }));
}

const refID = value => typeof value === 'string' ? value : value?.value ?? value?.sys_id ?? value?.sysId ?? value?.id;
const asBoolean = value => value === true || value === 1 || (typeof value === 'string' && value.toLowerCase() === 'true');
const EXAMPLE_TYPES = new Set(['approval_rules', 'conditions', 'schedule_date_time']);
function collectActionExamples(node, snapshotId, allowedInputs, examples, flowName) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const item of node) collectActionExamples(item, snapshotId, allowedInputs, examples, flowName); return; }
  const typeId = refID(node.actionTypeSysId || node.action_type_sys_id || node.actionType || node.action_type);
  if (typeId === snapshotId && Array.isArray(node.inputs)) {
    const values = Object.fromEntries(node.inputs.filter(input => input?.name && allowedInputs.has(input.name) && input.value !== undefined && input.value !== null)
      .map(input => [input.name, refID(input.value) ?? input.value]));
    if (Object.keys(values).length) examples.push({ flow: flowName, inputs: values });
  }
  for (const [key, value] of Object.entries(node)) if (key !== 'inputs') collectActionExamples(value, snapshotId, allowedInputs, examples, flowName);
}
async function findActionExamples(sdk, definition, inputDefinitions) {
  const snapshotId = refID(definition.latest_snapshot);
  if (!/^[a-f0-9]{32}$/i.test(snapshotId || '')) return { examples: [], status: 'unavailable' };
  const allowedInputs = new Set(inputDefinitions.filter(input => EXAMPLE_TYPES.has(input.type)
    && !/(password|secret|token|credential|authorization|cookie|api[_-]?key)/i.test(input.name)).map(input => input.name));
  if (!allowedInputs.size) return { examples: [], status: 'not_applicable' };
  const query = new URLSearchParams({
    sysparm_query: `action_type=${snapshotId}^ORDERBYsys_id`,
    sysparm_fields: 'sys_id,flow,action_type',
    sysparm_limit: '20',
    sysparm_display_value: 'false',
  });
  const rows = await sdk.listStrict('sys_hub_action_instance', query);
  if (!rows.length) return { examples: [], status: 'none' };
  const flowIds = [...new Set(rows.map(row => refID(row.flow)).filter(value => /^[a-f0-9]{32}$/i.test(value || '')))];
  if (!flowIds.length) return { examples: [], status: 'unavailable' };
  const examples = [];
  let unreadable = false;
  for (const flowId of flowIds.slice(0, 10)) {
    try {
      const result = await sdk.inspectFlow(flowId);
      const payloadActions = result?.payload?.actionInstances;
      if (!Array.isArray(payloadActions) || !payloadActions.some(item => item && typeof item === 'object' && !Array.isArray(item))) {
        unreadable = true;
        continue;
      }
      collectActionExamples(result.payload, snapshotId, allowedInputs, examples, result?.flow?.name || flowId);
    } catch { unreadable = true; }
    if (examples.length >= 3) break;
  }
  return { examples: examples.slice(0, 3), status: examples.length ? 'found' : unreadable ? 'unavailable' : 'none' };
}

export const actionsCmd = wrap => {
  // Reuse the existing list/show picker and output contract only.
  const base = buildDevCmd('actions', ACTION_TABLE, ['action'], ['name', 'active', 'sys_scope', 'sys_updated_on'], wrap, {
    singular: 'action', readOnly: true,
    resolveIdentifier: (argv, app) => cancelled(() => pickDesignerRecord(argv, app, ACTION_TABLE, 'action')),
    showBreadcrumbs: (_record, id) => [
      { action: 'definition', cmd: `jsn actions definition ${id}`, description: 'Read complete executable definition' },
      { action: 'list', cmd: 'jsn actions list', description: 'Back to actions' },
    ],
  });
  declareCapabilities('actions', { mutationSubcommands: ['create', 'update', 'edit', 'delete', 'test'] });
  // Retain the common wrap and output controller; domain failures get a
  // structured error envelope and nonzero exit, never a success-shaped dispatch.
  const run = handler => wrap(async (argv, app) => {
    try { await cancelled(() => handler(argv, app)); }
    catch (error) {
      if (!error.code?.startsWith('action_')) throw error;
      if (error.details) error.hint = JSON.stringify(error.details);
      app.err(error);
      process.exitCode = 1;
    }
  });
  return {
    ...base,
    describe: 'Flow Designer actions: create, edit full definitions, and test with outputs',
    builder: y => base.builder(y)
      .command({
        command: 'create', describe: `Create parent and executable Process Flow action; verify persistence. --data/--data-file requires a full definition with inputs, outputs, and steps arrays. Variables have name and type; each step requires cid, step_type, and inputs, outputs, extended_inputs, extended_outputs arrays. Use step_types for valid step_type schema. Example (structure only):\n{"name":"Example action","inputs":[{"name":"record_id","type":"string"}],"outputs":[],"steps":[{"cid":"step-1","step_type":"<stepTypeFromSchema>","inputs":[],"outputs":[],"extended_inputs":[],"extended_outputs":[]}]}`,
        builder: yy => dataOptions(yy).option('scope', { type: 'string', describe: 'Exact target scope sys_id, or global' }),
        handler: run(async (argv, app) => {
          const guided = !hasDefinitionData(argv) ? await guidedActionCreate(argv, app) : undefined;
          const definition = guided?.definition ?? parseDataArg(argv);
          const scope = guided?.scope ?? await designerScope(argv, app);
          const result = await app.sdk.createProcessFlowAction(scope, definition);
          app.ok(result, { summary: `Created and verified action ${result.sys_id}` });
        }),
      })
      .command({
        command: 'help [identifier]', describe: 'Show action input requirements and examples from flows on this instance',
        builder: scopeOption,
        handler: run(async (argv, app) => {
          const id = await actionID(argv, app);
          if (id === undefined) return;
          const scope = await actionScope(app.sdk, id, argv.scope);
          const definition = await app.sdk.getProcessFlowAction(id, scope);
          const inputs = (definition.inputs || []).map(input => ({
            name: input.name,
            type: input.type || input.parameter?.type || input.parameter?.inputType || input.valueType || 'unknown',
            mandatory: asBoolean(input.mandatory ?? input.required ?? input.parameter?.mandatory ?? input.parameter?.required),
            default: input.defaultValue ?? input.default ?? input.parameter?.defaultValue ?? '',
            description: input.description || input.label || input.parameter?.label || '',
          }));
          const exampleResult = await findActionExamples(app.sdk, definition, inputs);
          app.ok({ action: { id, name: definition.name, scope }, inputs, examples: exampleResult.examples,
            examples_status: exampleResult.status },
          { summary: `Input help for action ${definition.name || id}` });
        }),
      })
      .command({
        command: 'definition [identifier]', describe: 'Read full JSON definition including executable step_instances',
        builder: scopeOption,
        handler: run(async (argv, app) => {
          const id = await actionID(argv, app);
          if (id === undefined) return;
          const scope = await actionScope(app.sdk, id, argv.scope);
          app.ok(await app.sdk.getProcessFlowAction(id, scope), { summary: `Read action definition ${id}` });
        }),
      })
      .command({
        command: 'update [identifier]', aliases: ['edit'], describe: 'Save a full definition through Process Flow PUT and verify readback',
        builder: yy => dataOptions(scopeOption(yy)),
        handler: run(async (argv, app) => {
          if (!hasDefinitionData(argv) && !interactiveDesigner(argv, app)) throw errUsage('Provide --data-file or --data for the full action definition in noninteractive mode');
          const id = await actionID(argv, app);
          if (id === undefined) return;
          const definition = hasDefinitionData(argv) ? parseDataArg(argv)
            : await guidedActionEdit(argv, app, await app.sdk.getProcessFlowAction(id, await actionScope(app.sdk, id, argv.scope)));
          const result = await app.sdk.updateProcessFlowAction(id, argv.scope, definition);
          app.ok(result, { summary: `Saved and verified action ${id}` });
        }),
      })
      .command({
        command: 'test [identifier]', describe: 'Execute saved or supplied definition; optionally wait for actual outputs',
        builder: yy => dataOptions(scopeOption(yy))
          .option('force', { type: 'boolean', default: false, describe: 'Confirm execution of action scripts, which may have side effects' })
          .option('output-map', { type: 'string', describe: 'JSON action input names to values; sent as outputMap' })
          .option('run-on-thread', { type: 'boolean', default: true, describe: 'Run test on a worker thread' })
          .option('tracing-enabled', { type: 'boolean', default: false, describe: 'Enable Flow Designer tracing' })
          .option('wait', { type: 'boolean', default: false, describe: 'Wait for COMPLETE context and actual runtime outputs' })
          .option('timeout', { type: 'number', default: 60, describe: 'Maximum wait seconds after dispatch, greater than 0, at most 3600' }),
        handler: run(async (argv, app) => {
          let outputMap;
          try { outputMap = JSON.parse(argv['output-map'] ?? '{}'); }
          catch { throw errUsage('--output-map must be valid JSON'); }
          let definition = hasDefinitionData(argv) ? parseDataArg(argv) : undefined;
          const id = await actionID(argv, app);
          if (id === undefined) return;
          if (argv['output-map'] === undefined && interactiveDesigner(argv, app)) {
            definition = await app.sdk.getProcessFlowAction(id, await actionScope(app.sdk, id, argv.scope));
            outputMap = await guidedActionTestInputs(argv, app, definition);
          }
          await confirmDesignerMutation(argv, app, `Execute action '${id}' scripts, which may have side effects`);
          const result = await app.sdk.testProcessFlowAction(id, argv.scope, definition, outputMap, {
            wait: argv.wait, timeout: argv.timeout, runOnThread: argv['run-on-thread'], tracingEnabled: argv['tracing-enabled'],
          });
          app.ok(result, { summary: result.status === 'complete' ? `Test completed ${result.context}` : `Test dispatched ${result.context}; outputs not yet verified` });
        }),
      })
      .command({
        command: 'step-types', describe: 'Read step schema templates for a target scope',
        builder: yy => yy.option('scope', { type: 'string', describe: 'Exact transaction scope sys_id, or global' }),
        handler: run(async (argv, app) => {
          const scope = await designerScope(argv, app);
          app.ok(await app.sdk.getProcessFlowStepTypes(scope), { summary: 'Process Flow step schemas' });
        }),
      })
      .command({
        command: 'delete [identifier]', describe: 'Delete action parent explicitly',
        builder: yy => scopeOption(yy).option('force', { type: 'boolean', default: false, describe: 'Skip confirmation' }),
        handler: run(async (argv, app) => {
          const id = await actionID(argv, app);
          if (id === undefined) return;
          await actionScope(app.sdk, id, argv.scope);
          await confirmDesignerMutation(argv, app, `Delete action '${id}'`);
          await app.sdk.delete(ACTION_TABLE, id);
          // Verify the exact target is absent. Do not interpret a 403 as deletion.
          const query = new URLSearchParams({ sysparm_query: `sys_id=${id}`, sysparm_limit: '1', sysparm_fields: 'sys_id', sysparm_display_value: 'false' });
          const response = await app.sdk.request(`${app.sdk.baseURL}/api/now/table/${ACTION_TABLE}?${query}`, { method: 'GET' });
          if (!response || response.error || !Array.isArray(response.result) || response.result.length) {
            throw new Error(`Delete is unverified; action ${id} absence was not explicitly confirmed`);
          }
          app.ok({ name: argv.identifier, sys_id: id, deleted: true }, { summary: `Deleted action ${id}` });
        }),
      }),
    handler: wrap(async (_argv, app) => {
      const summary = 'Manage Flow Designer actions from the sys_hub_action_type_definition table. Create and update guide terminal users; automation passes full JSON definitions, not table fields.';
      app.ok({
        commands: ACTION_COMMANDS.map(command => command.name),
        _formatted: formatCommandList({
          title: summary,
          commands: ACTION_COMMANDS,
          footer: 'Run "jsn actions <command> --help" for details. In a terminal you can omit the target and pick one.',
        }),
      }, { summary });
    }),
  };
};
