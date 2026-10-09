import { buildDevCmd } from './_generic.js';
import { parseDataArg, confirmDelete } from '../helpers.js';
import { resolveRecord, unwrapSysId } from '../resolve-record.js';
import { declareCapabilities } from '../capabilities.js';
import { ACTION_TABLE, actionScope, validateScope } from '../processflow-actions.js';
import { errUsage } from '../errors.js';

const scopeOption = y => y.option('scope', { type: 'string', describe: 'Exact transaction scope sys_id; inferred from existing action when omitted' });
const dataOptions = y => y
  .option('data-file', { type: 'string', describe: 'Full action definition JSON file, not table fields' })
  .option('data', { type: 'string', describe: 'Full action definition as JSON' });
async function actionID(argv, app) {
  return unwrapSysId(await resolveRecord(app.sdk, { table: ACTION_TABLE, identifier: argv.identifier, matchField: 'name', resource: 'action' }));
}

export const actionsCmd = wrap => {
  // Reuse the existing list/show picker and output contract only.
  const base = buildDevCmd('actions', ACTION_TABLE, ['action'], ['name', 'active', 'sys_scope', 'sys_updated_on'], wrap, {
    singular: 'action', readOnly: true,
    showBreadcrumbs: (_record, id) => [
      { action: 'definition', cmd: `jsn actions definition ${id}`, description: 'Read complete executable definition' },
      { action: 'list', cmd: 'jsn actions list', description: 'Back to actions' },
    ],
  });
  declareCapabilities('actions', { mutationSubcommands: ['create', 'update', 'edit', 'delete', 'test'] });
  // Retain the common wrap and output controller; domain failures get a
  // structured error envelope and nonzero exit, never a success-shaped dispatch.
  const run = handler => wrap(async (argv, app) => {
    try { await handler(argv, app); }
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
        command: 'create', describe: 'Create parent and executable Process Flow action; verify persistence',
        builder: yy => dataOptions(yy).option('scope', { type: 'string', demandOption: true, describe: 'Exact target scope sys_id, or global' }),
        handler: run(async (argv, app) => {
          const definition = parseDataArg(argv);
          const result = await app.sdk.createProcessFlowAction(argv.scope, definition);
          app.ok(result, { summary: `Created and verified action ${result.sys_id}` });
        }),
      })
      .command({
        command: 'definition <identifier>', describe: 'Read full JSON definition including executable step_instances',
        builder: scopeOption,
        handler: run(async (argv, app) => {
          const id = await actionID(argv, app);
          const scope = await actionScope(app.sdk, id, argv.scope);
          app.ok(await app.sdk.getProcessFlowAction(id, scope), { summary: `Read action definition ${id}` });
        }),
      })
      .command({
        command: 'update <identifier>', aliases: ['edit'], describe: 'Save a full definition through Process Flow PUT and verify readback',
        builder: yy => dataOptions(scopeOption(yy)),
        handler: run(async (argv, app) => {
          const definition = parseDataArg(argv);
          const id = await actionID(argv, app);
          const result = await app.sdk.updateProcessFlowAction(id, argv.scope, definition);
          app.ok(result, { summary: `Saved and verified action ${id}` });
        }),
      })
      .command({
        command: 'test <identifier>', describe: 'Execute saved or supplied definition; optionally wait for actual outputs',
        builder: yy => dataOptions(scopeOption(yy))
          .option('force', { type: 'boolean', default: false, describe: 'Confirm execution of action scripts, which may have side effects' })
          .option('output-map', { type: 'string', default: '{}', describe: 'JSON action input names to values; sent as outputMap' })
          .option('run-on-thread', { type: 'boolean', default: true, describe: 'Run test on a worker thread' })
          .option('tracing-enabled', { type: 'boolean', default: false, describe: 'Enable Flow Designer tracing' })
          .option('wait', { type: 'boolean', default: false, describe: 'Wait for COMPLETE context and actual runtime outputs' })
          .option('timeout', { type: 'number', default: 60, describe: 'Maximum wait seconds after dispatch, greater than 0, at most 3600' }),
        handler: run(async (argv, app) => {
          let outputMap;
          try { outputMap = JSON.parse(argv['output-map'] ?? '{}'); }
          catch { throw errUsage('--output-map must be valid JSON'); }
          const definition = argv['data-file'] || argv.data ? parseDataArg(argv) : undefined;
          const id = await actionID(argv, app);
          await confirmDelete(app, argv, `Execute action '${argv.identifier}' scripts, which may have side effects`);
          const result = await app.sdk.testProcessFlowAction(id, argv.scope, definition, outputMap, {
            wait: argv.wait, timeout: argv.timeout, runOnThread: argv['run-on-thread'], tracingEnabled: argv['tracing-enabled'],
          });
          app.ok(result, { summary: result.status === 'complete' ? `Test completed ${result.context}` : `Test dispatched ${result.context}; outputs not yet verified` });
        }),
      })
      .command({
        command: 'step-types', describe: 'Read step schema templates for a target scope',
        builder: yy => yy.option('scope', { type: 'string', demandOption: true, describe: 'Exact transaction scope sys_id, or global' }),
        handler: run(async (argv, app) => {
          await validateScope(app.sdk, argv.scope);
          app.ok(await app.sdk.getProcessFlowStepTypes(argv.scope), { summary: 'Process Flow step schemas' });
        }),
      })
      .command({
        command: 'delete <identifier>', describe: 'Delete action parent explicitly',
        builder: yy => scopeOption(yy).option('force', { type: 'boolean', default: false, describe: 'Skip confirmation' }),
        handler: run(async (argv, app) => {
          const id = await actionID(argv, app);
          await actionScope(app.sdk, id, argv.scope);
          await confirmDelete(app, argv, `Delete action '${argv.identifier}'`);
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
      app.ok({ commands: ['list', 'show', 'definition', 'step-types', 'create', 'update', 'test', 'delete'] }, {
        summary: 'Use jsn actions <command> --help. Create/update require full JSON definitions, not table fields.',
      });
    }),
  };
};
