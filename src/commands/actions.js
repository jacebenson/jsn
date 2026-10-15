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
  { name: 'action-type-schema', description: 'Read provider metadata for an exact action type ID and scope' },
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
        command: 'create', describe: 'Create a Process Flow action. Use `jsn actions step-types --scope <sys_id>` for live provider schemas. The required definition structure is code-owned; step-specific fields are provider-defined.',
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
            mandatory: input.mandatory ?? input.required ?? input.parameter?.mandatory ?? input.parameter?.required ?? false,
            default: input.defaultValue ?? input.default ?? input.parameter?.defaultValue ?? '',
            description: input.description || input.label || input.parameter?.label || '',
          }));
          app.ok({ action: { id, name: definition.name, scope }, inputs, examples: [], examples_status: 'unverified',
            examples_note: 'Live examples are not shown yet because this instance’s action-instance to snapshot relationship has not been verified.' },
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
        command: 'step-types', describe: 'Read full live step schemas for a target scope',
        builder: yy => yy.option('scope', { type: 'string', describe: 'Exact transaction scope sys_id, or global' }),
        handler: run(async (argv, app) => {
          const scope = await designerScope(argv, app);
          app.ok(await app.sdk.getProcessFlowStepTypes(scope), { summary: 'Process Flow step schemas' });
        }),
      })
      .command({
        command: 'action-type-schema', describe: 'Read live provider input/output metadata for an exact action type ID and scope',
        builder: yy => yy.option('id', { type: 'string', demandOption: true, describe: 'Exact 32-character action type sys_id' }).option('scope', { type: 'string', demandOption: true, describe: 'Exact transaction scope sys_id, or global' }),
        handler: run(async (argv, app) => {
          if (!/^[a-f\d]{32}$/i.test(argv.id)) throw errUsage('--id must be an exact 32-character action type sys_id');
          if (!/^(?:[a-fA-F0-9]{32}|global)$/.test(argv.scope)) throw errUsage('--scope must be an exact scope sys_id or global');
          app.requireInstance();
          const url = `${app.sdk.baseURL}/api/now/processflow/action/action_types/${encodeURIComponent(argv.id)}?${new URLSearchParams({ sysparm_transaction_scope: argv.scope })}`;
          const response = await app.sdk.request(url, { method: 'GET' });
          const result = response?.result;
          if (response?.error || result?.error || (result?.errorCode !== undefined && result.errorCode !== 0 && result.errorCode !== '0')) {
            throw new Error(result?.errorMessage || response?.error?.message || 'Provider rejected the action type schema request');
          }
          if (!result || typeof result !== 'object') throw new Error('Provider returned no action type metadata');
          app.ok(result, { summary: `Provider action type schema ${argv.id}` });
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
