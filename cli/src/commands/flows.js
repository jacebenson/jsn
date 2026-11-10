import fs from 'node:fs';
import { formatRecordForDisplay, formatCommandList, getStringField, interactiveList } from '../helpers.js';
import { discoverFlowContextFields, normalizeFlowContext, summarizeFlowContexts, formatFlowContextSummary, aggregateFlowContextMappings, mergeFlowContextStats, buildFlowContextQuery } from '../flow-context.js';
import { declareCapabilities } from '../capabilities.js';
import { inspectFlow } from '../flow-inspection.js';
import { publishFlows, publishFlowLifecycle, publishDoctor, flowStatus } from '../flow-publish.js';
import { resolveRecord, unwrapSysId } from '../resolve-record.js';
import { createFlowFromManifest, updateFlowFromManifest, readCurrentUpdateSet, readCatalogItemVariables } from '../flow-create.js';
import { alignUpdateSetCapture } from '../context.js';
import { EXCLUDED_TRIGGER_TYPES, SUPPORTED_TRIGGER_TYPES, readTriggerCatalog, readTriggerInputDefinitions } from '../flow-triggers.js';
import { testFlow } from '../flow-test.js';
import { releaseOwnFlowSafeEdit } from '../flow-safe-edit.js';
import { AppError, CodeAPI, CodeForbidden, errUsage } from '../errors.js';
import { cancelled, pickDesignerRecord, guidedFlowCreate, guidedFlowEdit, guidedFlowTestRecord, hasDefinitionData, confirmDesignerMutation } from '../flow-designer-interactive.js';

const pickFlow = (argv, app, query = '') => pickDesignerRecord(argv, app, argv.action ? 'sys_hub_action_type_definition' : 'sys_hub_flow', argv.action ? 'action' : 'flow', query);

// Rows the provider cascades when the sys_hub_flow record is deleted. Counted
// before and after so the command reports what went with the flow.
const FLOW_OWNED_TABLES = [
  { table: 'sys_hub_flow_version', label: 'version', query: id => `flow=${id}` },
  { table: 'sys_hub_action_instance_v2', label: 'action instance', query: id => `flow=${id}` },
  { table: 'sys_hub_flow_logic_instance_v2', label: 'logic block', query: id => `flow=${id}` },
  { table: 'sys_hub_flow_stage', label: 'stage', query: id => `flow=${id}` },
  // Flow variables hang off `model`, not `flow`.
  { table: 'sys_hub_flow_variable', label: 'flow variable', query: id => `model=${id}` },
];

function describeOwned(counts) {
  const parts = Object.entries(counts)
    .filter(([, count]) => count)
    .map(([table, count]) => `${count} ${FLOW_OWNED_TABLES.find(entry => entry.table === table)?.label ?? table}${count === 1 ? '' : 's'}`);
  return parts.length ? parts.join(', ') : 'nothing';
}

const FLOW_COMMANDS = [
  { name: 'schemas', description: 'Read live trigger catalog and input schemas' },
  { name: 'catalog-variables [identifier]', description: 'List a catalog item\'s variables for a service_catalog trigger' },
  { name: 'list', description: 'List flows' },
  { name: 'executions', description: 'Show flow executions from sys_flow_context' },
  { name: 'show [identifier]', description: 'Show a flow: structure, inputs, steps and conditions' },
  { name: 'status [identifier]', description: 'Check whether a flow is actually able to run' },
  { name: 'publish [identifier]', description: 'Publish (activate) a flow, or a custom action with --action' },
  { name: 'test [identifier]', description: 'Execute a record-triggered flow against one record' },
  { name: 'create', description: 'Create a draft flow: guided in a terminal, JSON manifest in scripts' },
  { name: 'update [identifier]', description: 'Update a draft, or a published flow whose definition reports write access (alias: edit)' },
  { name: 'doctor', description: 'Check whether this instance can publish flows at all' },
  { name: 'unlock [identifier]', description: 'Release this user\'s stale safe-edit session (orphaned lease) after a failed update' },
  { name: 'delete [identifier]', description: 'Delete a flow and the versions, actions, logic and stages it owns' },
];

function flowInspectionAdapter(app) {
  return {
    inspectFlow: app.sdk.inspectFlow.bind(app.sdk),
    inspectCustomAction: app.sdk.inspectCustomAction.bind(app.sdk),
  };
}

// The picker is driven by the instance's own trigger definitions, but this CLI
// can only create the families it has verified. State both plainly so a created
// flow never surprises the operator with a trigger that was not really set.
function triggerGuidance(trigger) {
  return {
    supported_families: [...SUPPORTED_TRIGGER_TYPES].sort(),
    excluded_families: [...EXCLUDED_TRIGGER_TYPES.entries()].map(([type, reason]) => ({ type, reason })).sort((a, b) => a.type.localeCompare(b.type)),
    created_trigger: trigger ? { id: trigger.id, type: trigger.type, name: trigger.name, triggerDefinitionId: trigger.triggerDefinitionId } : null,
    note: 'The trigger picker lists only families this CLI can create and verify. Families the picker omits are reported in excluded_families.',
  };
}

declareCapabilities('flows', { mutationSubcommands: ['create', 'update', 'edit', 'delete', 'publish', 'test', 'unlock'] });

function renderChecks(checks) {
  return checks.map((c) => {
    const mark = c.skipped ? '➖' : (c.ok ? '✅' : '❌');
    return `  ${mark} ${c.name}: ${c.detail}`;
  }).join('\n');
}

export function flowsCmd(wrap) {
  const originalWrap = wrap;
  wrap = handler => originalWrap((argv, app) => cancelled(() => handler(argv, app)));
  return {
    command: 'flows [subcommand]',
    aliases: ['flow'],
    describe: 'Manage Flow Designer flows',
    builder: (yargs) => {
      return yargs
        .command({
          command: 'schemas',
          describe: 'Read live trigger catalog and input schemas',
          handler: wrap(async (_argv, app) => {
            app.requireInstance();
            const catalog = await readTriggerCatalog(app.sdk);
            for (const category of catalog.categories) {
              for (const trigger of category.triggers) {
                if (trigger.supported) trigger.inputs = await readTriggerInputDefinitions(app.sdk, trigger.sysId);
              }
            }
            for (const trigger of catalog.ungrouped) {
              if (trigger.supported) trigger.inputs = await readTriggerInputDefinitions(app.sdk, trigger.sysId);
            }
            const data = { ...catalog, structural_contract: 'Manifest keys and persistence shape are code-owned; trigger definitions and input metadata are instance-derived.' };
            data._formatted = [...catalog.categories.flatMap(c => c.triggers.map(t => `${c.name}: ${t.name} [${t.type}] ${t.supported ? 'supported' : 'not supported'}; inputs: ${(t.inputs || []).map(i => i.name + ':' + i.type).join(', ')}`)), ...catalog.ungrouped.map(t => `${t.name} [${t.type}] ungrouped${t.supported ? '; supported' : '; not supported'}; inputs: ${(t.inputs || []).map(i => i.name + ':' + i.type).join(', ')}`)].join('\n');
            app.ok(data, { summary: 'Live Flow trigger schemas' });
          }),
        })
        .command({
          command: 'catalog-variables [identifier]',
          describe: 'List a catalog item\'s variables for a service_catalog trigger input',
          builder: (y) => y
            .option('catalog-item', { type: 'string', describe: 'sc_cat_item sys_id used as the trigger\'s template_catalog_item' })
            .option('scope', { type: 'string', describe: 'Transaction scope sys_id (default: the flow\'s own scope)' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const catalogItem = argv.catalogItem ?? argv['catalog-item'];
            if (!String(catalogItem || '').trim()) throw errUsage('--catalog-item <sc_cat_item sys_id> is required; it is the trigger\'s template_catalog_item');
            const identifier = await pickFlow(argv, app);
            if (identifier === undefined) return;
            const record = await resolveRecord(app.sdk, { table: 'sys_hub_flow', identifier, matchField: 'name', resource: 'Flow' });
            const flowId = unwrapSysId(record);
            // resolveRecord reads display values; sending `Global` as a
            // transaction scope is not a scope id. Prefer the raw value.
            const rawScope = record?.sys_scope && typeof record.sys_scope === 'object' ? record.sys_scope.value : record?.sys_scope;
            const scope = argv.scope || rawScope || 'global';
            const result = await readCatalogItemVariables(app.sdk, app.getEffectiveInstance(), flowId, catalogItem, { scope });
            app.ok(result, {
              summary: `${result.count} catalog variable(s) on ${catalogItem}; trigger catalog_variables input: ${result.catalog_variables_input || '(none)'}`,
            });
          }),
        })
        .command({
          command: 'list',
          aliases: ['ls'],
          describe: 'List flows',
          builder: (y) => y
            .option('query', { type: 'string', describe: 'Encoded query (e.g. "nameLIKEincident" or "active=true")' })
            .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns (e.g. "number,short_description")' })
            .option('limit', { alias: 'l', type: 'number', default: 50, describe: 'Max records' })
            .option('depth', {
              type: 'number',
              default: 2,
              describe: 'Expand nested subflows to this depth (1 = subflow names only, 2 = one level, 3+ = deeper)',
            }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const columns = argv.columns ? argv.columns.split(',') : ['name', 'active', 'description', 'sys_created_by', 'sys_updated_on'];
            const query = argv.query || '';

            // Interactive picker
            const picked = await interactiveList({
              app, table: 'sys_hub_flow', singular: 'flow', columns, limit: argv.limit, query, labelField: 'name',
              formatLabel: r => `${getStringField(r, 'active') === 'true' ? '🟢' : '🔴'} ${getStringField(r, 'name')}`,
              promptFn: app.promptFn,
            });
            if (picked === undefined) return; // user cancelled
            if (picked) {
              const inspection = await inspectFlow({
                adapter: flowInspectionAdapter(app),
                identifier: getStringField(picked, 'sys_id'),
                instanceURL: app.getEffectiveInstance(),
                depth: argv.depth,
              });
              return app.ok(inspection, {
                summary: `Flow: ${inspection.flow.name}`,
                breadcrumbs: [{ action: 'list', cmd: 'jsn flows list', description: 'Back to all flows' }],
              });
            }

            // Text/table fallback
            const params = new URLSearchParams();
            params.set('sysparm_limit', String(argv.limit));
            params.set('sysparm_display_value', 'all');
            params.set('sysparm_fields', ['sys_id', ...columns].join(','));
            const q = argv.query ? argv.query + '^ORDERBYDESCsys_updated_on' : 'ORDERBYDESCsys_updated_on';
            params.set('sysparm_query', q);
            const records = await app.sdk.list('sys_hub_flow', params);
            app.ok({
              table: 'sys_hub_flow',
              count: records.length,
              columns,
              records: records.map(r => formatRecordForDisplay(r, columns)),
              context: { instance_url: app.getEffectiveInstance() },
            }, { summary: `${records.length} flow(s)` });
          }),
        })
        .command({
          command: 'executions',
          aliases: ['runs', 'contexts'],
          describe: 'Show Flow Designer executions from sys_flow_context',
          builder: (y) => y
            .option('query', { type: 'string', describe: 'Encoded query (e.g. "state=WAITING" or "source_record=<sys_id>")' })
            .option('record', { type: 'string', describe: 'Only executions for this source record sys_id' })
            .option('since', { type: 'string', describe: 'Only contexts created on or after this timestamp' })
            .option('until', { type: 'string', describe: 'Only contexts created on or before this timestamp' })
            .option('limit', { alias: 'l', type: 'number', default: 50, describe: 'Max executions' })
            .option('summary', { type: 'boolean', default: false, describe: 'Return local counts and duration metrics by flow' })
            .option('active', { type: 'boolean', default: false, describe: 'Only waiting, running, and queued executions' })
            .option('all', { type: 'boolean', default: false, describe: 'Compatibility flag; all states are now shown by default' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const fields = await discoverFlowContextFields(app.sdk);
            const query = buildFlowContextQuery({
              record: argv.record,
              since: argv.since,
              until: argv.until,
              query: argv.query || (argv.active ? 'stateINWAITING,RUNNING,QUEUED' : ''),
            });
            const params = new URLSearchParams();
            params.set('sysparm_query', query);
            params.set('sysparm_limit', String(argv.limit));
            params.set('sysparm_fields', [...fields].join(','));
            params.set('sysparm_display_value', 'all');
            const records = await app.sdk.list('sys_flow_context', params);
            const executions = records.map(record => normalizeFlowContext(record));
            const sampledSummary = summarizeFlowContexts(executions);
            let executionSummary = sampledSummary;
            if (argv.summary) {
              const [totalCount, stats] = await Promise.all([
                app.sdk.aggregateCount('sys_flow_context', query).catch(() => null),
                app.sdk.aggregate('sys_flow_context', { query, groupBy: ['name', 'state'], count: true }).catch(() => null),
              ]);
              executionSummary = mergeFlowContextStats(stats?.groups || stats?.stats || [], sampledSummary, totalCount);
            }
            const data = {
              table: 'sys_flow_context',
              count: argv.summary ? executionSummary.total_count ?? executions.length : executions.length,
              sample_count: executions.length,
              query,
              fields: [...fields],
              field_mapping: aggregateFlowContextMappings(executions),
              missing_fields: [...new Set(executions.flatMap(execution => execution.missing_fields))],
              summary: executionSummary,
              executions: argv.summary ? undefined : executions,
              _formatted: argv.summary ? formatFlowContextSummary(executionSummary) : undefined,
              context: { instance_url: app.getEffectiveInstance(), timezone: 'UTC' },
            };
            app.ok(data, { summary: argv.summary
              ? `${executionSummary.total_count ?? executions.length} matching flow execution(s), ${executions.length} sampled`
              : `${executions.length} flow execution(s)` });
          }),
        })
        .command({
          command: 'show [identifier]',
          aliases: ['get'],
          describe: 'Show flow details by name or sys_id',
          builder: (y) => y
            .option('depth', {
              type: 'number',
              default: 2,
              describe: 'Expand nested subflows to this depth (1 = subflow names only, 2 = one level, 3+ = deeper)',
            })
            .option('raw-payload', {
              type: 'boolean',
              default: false,
              describe: 'Include the raw ProcessFlow document (large; it duplicates the extracted steps)',
            }),
          handler: wrap(async (argv, app) => {
            const identifier = await pickFlow(argv, app);
            if (identifier === undefined) return;
            const inspection = await inspectFlow({
              adapter: flowInspectionAdapter(app),
              identifier,
              instanceURL: app.getEffectiveInstance(),
              depth: argv.depth,
              includePayload: argv.rawPayload === true,
            });
            app.ok(inspection, {
              summary: `Flow: ${inspection.flow.name}`,
              breadcrumbs: [
                { action: 'list', cmd: 'jsn flows list', description: 'Back to all flows' },
              ],
            });
          }),
        })
        .command({
          command: 'publish [identifier]',
          aliases: ['activate'],
          describe: 'Publish (activate) a flow so it can actually run',
          builder: (y) => y
            .option('action', { type: 'boolean', default: false, describe: 'Treat the identifier as a custom action rather than a flow' })
            .option('force', { type: 'boolean', default: false, describe: 'Confirm publication and activation' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const identifier = await pickFlow(argv, app);
            if (identifier === undefined) return;
            const sysID = unwrapSysId(await resolveRecord(app.sdk, {
                table: argv.action ? 'sys_hub_action_type_definition' : 'sys_hub_flow',
                identifier,
                matchField: 'name',
                resource: argv.action ? 'Custom action' : 'Flow',
              }));

            await confirmDesignerMutation(argv, app, `Publish and activate ${argv.action ? 'action' : 'flow'} ${sysID}?`);
            if (!argv.action) {
              const lifecycle = await publishFlowLifecycle(app.sdk, app.getEffectiveInstance(), sysID);
              return app.ok(lifecycle, {
                summary: `Published ${sysID}; active=${lifecycle.active}; version=${lifecycle.version?.sys_id ?? lifecycle.version?.id ?? 'read back'}`,
                breadcrumbs: [{ action: 'status', cmd: `jsn flows status ${sysID}`, description: 'Verify the flow will run' }],
              });
            }
            const result = await publishFlows(app.sdk, [], [sysID]);

            const { summary, results, via } = result;
            const lines = results.map(r => `  ${r.status === 'success' ? '✅' : '❌'} ${r.flow_name ?? r.sys_id}: ${r.message ?? r.status}${r.errorMessage ? ` — ${r.errorMessage}` : ''}`);

            return app.ok({ summary, results, via }, {
              summary: `Published ${summary.succeeded}/${summary.total} (via ${via})\n${lines.join('\n')}`,
              breadcrumbs: [{ action: 'status', cmd: `jsn flows status ${sysID}`, description: 'Verify the flow will run' }],
            });
          }),
        })
        .command({
          command: 'status [identifier]',
          describe: 'Check whether a flow is actually able to run',
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const identifier = await pickFlow(argv, app);
            if (identifier === undefined) return;
            const sysID = unwrapSysId(await resolveRecord(app.sdk, {
              table: 'sys_hub_flow', identifier, matchField: 'name', resource: 'Flow',
            }));
            const status = await flowStatus(app.sdk, sysID);

            return app.ok(status, {
              summary: `${status.ok ? '✅' : '❌'} ${status.flow.name} (${status.flow.type})\n${renderChecks(status.checks)}`,
              breadcrumbs: status.ok ? [] : [{ action: 'publish', cmd: `jsn flows publish ${sysID}`, description: 'Publish this flow' }],
            });
          }),
        })
        .command({
          command: 'test [identifier]',
          describe: 'Execute a record-triggered flow against one record (may cause side effects)',
          builder: (y) => y
            .option('record', { type: 'string', describe: 'Trigger record sys_id to test against' })
            .option('force', { type: 'boolean', default: false, describe: 'Skip confirmation' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const identifier = await pickFlow(argv, app);
            if (identifier === undefined) return;
            argv = { ...argv, identifier };
            const record = await guidedFlowTestRecord(argv, app);
            if (record === undefined) return;
            await confirmDesignerMutation(argv, app, `Execute flow test for ${identifier} against record ${record}; actions may cause side effects`);
            const result = await testFlow(app.sdk, app.getEffectiveInstance(), identifier, record);
            return app.ok(result, {
              summary: result.status === 'completed'
                ? `Flow test completed (${result.success ? 'success' : 'failed'})`
                : 'Flow test accepted for execution',
            });
          }),
        })
        .command({
          command: 'doctor',
          describe: 'Check whether this instance can publish flows at all',
          handler: wrap(async (_argv, app) => {
            app.requireInstance();
            const report = await publishDoctor(app.sdk);
            const hint = report.ok
              ? ''
              : '\n\nFlow publishing is unavailable. Deploys may report success while leaving flows inert.';
            return app.ok(report, {
              summary: `${report.ok ? '✅' : '❌'} Flow publishing\n${renderChecks(report.checks)}${hint}`,
            });
          }),
        })
        .command({
          command: 'create',
          describe: 'Create a draft flow from a JSON manifest or guided prompts',
          builder: (y) => y
            .option('data', { type: 'string', describe: 'Flow manifest as inline JSON' })
            .option('data-file', { type: 'string', describe: 'Read the flow manifest from a JSON file' })
            .option('scope', { type: 'string', describe: 'Transaction scope sys_id or global for the guided picker' })
            .epilogue('Manifest structure is code-owned. Use `jsn flows schemas` for trigger and input schemas, and\n'
              + '`jsn actions action-type-schema --id <actionTypeId> --scope <scopeId>` for provider action inputs.'),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const dataFile = argv.dataFile ?? argv['data-file'];
            let manifest;
            if (!hasDefinitionData(argv)) manifest = await guidedFlowCreate(argv, app);
            else try {
              const raw = dataFile ? fs.readFileSync(dataFile, 'utf8') : argv.data;
              manifest = JSON.parse(raw.charCodeAt?.(0) === 0xFEFF ? raw.slice(1) : raw);
            } catch (error) {
              throw new Error(`Invalid flow manifest JSON: ${error.message}`, { cause: error });
            }
            const result = await createFlowFromManifest(app.sdk, app.getEffectiveInstance(), manifest, {
              readUpdateSet: () => readCurrentUpdateSet(app.sdk),
              ensureCapture: intended => alignUpdateSetCapture(app.sdk, intended),
            });
            app.ok({ ...result, trigger_guidance: triggerGuidance(result.trigger) }, {
              summary: `Created draft flow "${result.flow.name}" (${result.flow.id}) with trigger ${result.trigger?.type ?? 'unknown'} (${result.trigger?.id ?? 'no trigger id'}) without activation`,
              breadcrumbs: [{ action: 'show', cmd: `jsn flows show ${result.flow.id}`, description: 'Inspect the draft flow' }],
            });
          }),
        })
        .command({
          command: 'update [identifier]',
          aliases: ['edit'],
          describe: 'Update a draft, or a published flow that reports write access',
          builder: (y) => y
            .option('data', { type: 'string', describe: 'Update manifest as inline JSON' })
            .option('data-file', { type: 'string', describe: 'Read the update manifest from a JSON file' })
            .option('preview', { type: 'boolean', default: false, describe: 'Validate and show exact before/after input values without saving or versioning' })
            .option('force', { type: 'boolean', default: false, describe: 'Skip confirmation' })
            .epilogue('Editable: record_create_or_update trigger table/condition, existing action inputs, and stage\n'
              + 'placement (add a stage, or move flow steps onto one with componentIndexes). A service_catalog\n'
              + 'trigger is created with its template_catalog_item and catalog_variables inputs. A published flow\n'
              + 'is edited as its working definition; the published snapshot and runtime pointers must stay\n'
              + 'unchanged, and the command fails loudly if they do not. A flow without write access is refused\n'
              + 'before any lock or content write, naming the permission. Flow Logic, flow variables, subflows and\n'
              + 'error handling still need Flow Designer. Never publishes or executes; omitted values are preserved.\n'
              + 'Live schemas: `jsn flows schemas` and `jsn actions action-type-schema --id <actionTypeId>\n'
              + '--scope <scopeId>`.'),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const dataFile = argv.dataFile ?? argv['data-file'];
            // No lifecycle filter: published flows are editable when their own
            // definition reports write access, and a non-writable target is
            // refused with a permission message rather than a lifecycle label.
            const identifier = await pickFlow(argv, app);
            if (identifier === undefined) return;
            argv = { ...argv, identifier };
            let manifest;
            if (!hasDefinitionData(argv)) manifest = await guidedFlowEdit(argv, app);
            else try {
              const raw = dataFile ? fs.readFileSync(dataFile, 'utf8') : argv.data;
              manifest = JSON.parse(raw.charCodeAt?.(0) === 0xFEFF ? raw.slice(1) : raw);
            } catch (error) {
              throw new Error(`Invalid flow update manifest JSON: ${error.message}`, { cause: error });
            }
            if (!argv.preview) await confirmDesignerMutation(argv, app, `Update flow ${identifier}; unspecified components and inputs are preserved. A published flow is edited as its working definition: the published snapshot must stay unchanged.`);
            const result = await updateFlowFromManifest(app.sdk, app.getEffectiveInstance(), argv.identifier, manifest, {
              preview: argv.preview,
              readUpdateSet: () => readCurrentUpdateSet(app.sdk),
              ensureCapture: intended => alignUpdateSetCapture(app.sdk, intended),
            });
            const diff = result.changes.map(change => `${change.component}${change.order ? ` ${change.order}` : ''}.${change.input}: ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`).join('\n');
            const state = `${result.flow.status}${result.flow.active ? ', active' : ''}`;
            const preservation = result.lifecycle?.published && !result.preview
              ? `; published snapshot ${result.runtime_preservation?.before?.published_definition?.snapshot_id ?? ''} unchanged`
              : '';
            return app.ok({ ...result, _formatted: diff }, {
              summary: `${result.preview ? 'Preview for' : 'Updated'} flow "${result.flow.name}" (${result.flow.id}) in state ${state}${preservation} without activation`,
              breadcrumbs: [{ action: 'show', cmd: `jsn flows show ${result.flow.id}`, description: 'Inspect the updated flow' }],
            });
          }),
        })
        .command({
          command: 'unlock [identifier]',
          describe: 'Release this user\'s stale safe-edit lease after a failed update',
          builder: (y) => y
            .option('force', { type: 'boolean', default: false, describe: 'Skip confirmation' })
            .epilogue('Recovery for an orphaned lease left by a failed update: the provider only releases the calling\n'
              + 'user\'s own session, the before/after canUserEdit and currentEditor values are printed, and an\n'
              + 'unconfirmed release fails instead of reporting success. Does not edit content, publish, or touch\n'
              + 'another user\'s session.'),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const identifier = await pickFlow(argv, app);
            if (identifier === undefined) return;
            const sysID = unwrapSysId(await resolveRecord(app.sdk, {
              table: 'sys_hub_flow', identifier, matchField: 'name', resource: 'Flow',
            }));
            await confirmDesignerMutation(argv, app, `Release your Flow Designer safe-edit session on flow ${identifier}? If this flow is open in Flow Designer, that editor's next save will fail.`);
            const result = await releaseOwnFlowSafeEdit(app.sdk, app.getEffectiveInstance(), sysID);
            const state = status => `canUserEdit=${status.canUserEdit}, currentEditor=${JSON.stringify(status.currentEditor ?? null)}`;
            return app.ok({ ...result, flow: { id: sysID, name: identifier } }, {
              summary: result.released
                ? `Released this user's safe edit session on flow ${identifier} (${sysID}): ${state(result.before)} -> ${state(result.after)}`
                : `No safe edit session to release on flow ${identifier} (${sysID}): ${state(result.before)}`,
              breadcrumbs: result.released
                ? [{ action: 'update', cmd: `jsn flows update ${sysID}`, description: 'Retry the edit' }]
                : [{ action: 'show', cmd: `jsn flows show ${sysID}`, description: 'Inspect the flow' }],
            });
          }),
        })
        .command({
          command: 'delete [identifier]',
          describe: 'Delete a flow and everything that belongs to it',
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const identifier = await pickFlow(argv, app);
            if (identifier === undefined) return;
            const sysID = unwrapSysId(await resolveRecord(app.sdk, {
              table: 'sys_hub_flow', identifier, matchField: 'name', resource: 'Flow',
            }));
            const [flow] = await app.sdk.list('sys_hub_flow', new URLSearchParams({
              sysparm_query: `sys_id=${sysID}`,
              sysparm_display_value: 'all',
              sysparm_fields: 'sys_id,name,status,active,sys_scope',
              sysparm_limit: '1',
            }));
            if (!flow) throw errUsage(`Flow ${identifier} (${sysID}) was not found`);
            const name = getStringField(flow, 'name');
            const active = getStringField(flow, 'active') === 'true';
            const counted = async () => {
              const counts = {};
              for (const { table, query } of FLOW_OWNED_TABLES) {
                counts[table] = await app.sdk.aggregateCount(table, query(sysID)).catch(() => null);
              }
              return counts;
            };
            const before = await counted();
            const scopeName = getStringField(flow, 'sys_scope');
            await confirmDesignerMutation(argv, app, `Delete flow "${name}" (${sysID})${active ? ', which is ACTIVE' : ''} and ${describeOwned(before)}? This cannot be undone.`);
            try {
              await app.sdk.delete('sys_hub_flow', sysID);
            } catch (error) {
              // The provider only deletes flows in the session's application scope.
              if (/\b403\b|forbidden/i.test(error.message || '')) {
                throw new AppError(CodeForbidden, `Flow "${name}" is in application scope ${scopeName ? `"${scopeName}"` : 'another scope'}; the provider refused the delete with HTTP 403. Switch to that scope first (jsn scopes), then retry. No delete was applied.`);
              }
              throw error;
            }
            const [stillThere] = await app.sdk.list('sys_hub_flow', new URLSearchParams({
              sysparm_query: `sys_id=${sysID}`, sysparm_fields: 'sys_id', sysparm_limit: '1',
            }));
            if (stillThere) throw new AppError(CodeAPI, `Flow ${sysID} is still present after the delete request; nothing is reported as removed`);
            const remaining = await counted();
            const orphans = Object.entries(remaining).filter(([, count]) => count);
            const removedText = describeOwned(before);
            return app.ok({ flow: { id: sysID, name, active }, removed: before, remaining }, {
              summary: `Deleted flow "${name}" (${sysID})${removedText === 'nothing' ? '' : ` with ${removedText}`}${orphans.length ? `; ${orphans.map(([table, count]) => `${count} ${table} row(s) remain`).join(', ')}` : ''}`,
              breadcrumbs: [{ action: 'list', cmd: 'jsn flows list', description: 'List the remaining flows' }],
            });
          }),
        })
        .epilogue('Run "jsn flows <command> --help" for details. In a terminal you can omit the target and pick\n'
          + 'one; scripts use explicit identifiers and manifests.');
    },
    handler: wrap(async (_argv, app) => {
      const summary = 'Manage Flow Designer flows from the sys_hub_flow table. Flow structure comes from the ProcessFlow API, so V1, V2 and subflow definitions all render in full.';
      app.ok({
        commands: FLOW_COMMANDS.map(command => command.name),
        _formatted: formatCommandList({
          title: summary,
          commands: FLOW_COMMANDS,
          footer: 'Run "jsn flows <command> --help" for details. In a terminal you can omit the target and pick one; scripts use explicit identifiers and manifests.',
        }),
      }, { summary });
    }),
  };
}
