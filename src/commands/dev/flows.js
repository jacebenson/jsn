import { formatRecordForDisplay, getStringField, interactiveList } from '../../helpers.js';
import { discoverFlowContextFields, normalizeFlowContext, summarizeFlowContexts, formatFlowContextSummary, aggregateFlowContextMappings, mergeFlowContextStats, buildFlowContextQuery } from '../../flow-context.js';
import { declareCapabilities } from '../../capabilities.js';
import { inspectFlow } from '../../flow-inspection.js';

function flowInspectionAdapter(app) {
  return {
    inspectFlow: app.sdk.inspectFlow.bind(app.sdk),
    inspectCustomAction: app.sdk.inspectCustomAction.bind(app.sdk),
  };
}

declareCapabilities('flows', { mutationSubcommands: ['create', 'update', 'delete'], devAlias: true });

export function flowsCmd(wrap) {
  return {
    command: 'flows [subcommand]',
    aliases: ['flow'],
    describe: 'Manage Flow Designer flows',
    builder: (yargs) => {
      return yargs
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
          command: 'show <identifier>',
          aliases: ['get'],
          describe: 'Show flow details by name or sys_id',
          builder: (y) => y
            .option('depth', {
              type: 'number',
              default: 2,
              describe: 'Expand nested subflows to this depth (1 = subflow names only, 2 = one level, 3+ = deeper)',
            }),
          handler: wrap(async (argv, app) => {
            const inspection = await inspectFlow({
              adapter: flowInspectionAdapter(app),
              identifier: argv.identifier,
              instanceURL: app.getEffectiveInstance(),
              depth: argv.depth,
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
          command: 'create',
          describe: 'Create a new flow (not yet implemented)',
          builder: (y) => y
            .option('data', { type: 'string', describe: 'JSON data for the flow' }),
          handler: wrap(async (_argv, _app) => {
            throw new Error('Flow creation requires the Flow Designer GraphQL API - not yet implemented.\n'
              + 'Use the ServiceNow web UI to create flows, then use "jsn flows list" to view them.');
          }),
        })
        .command({
          command: 'update <identifier>',
          describe: 'Update a flow (not yet implemented)',
          builder: (y) => y
            .option('data', { type: 'string', describe: 'JSON data to update' }),
          handler: wrap(async (_argv, _app) => {
            throw new Error('Flow updates require the Flow Designer GraphQL API - not yet implemented.\n'
              + 'Use the ServiceNow web UI to update flows, then use "jsn flows list" to view them.');
          }),
        })
        .command({
          command: 'delete <identifier>',
          describe: 'Delete a flow (not yet implemented)',
          handler: wrap(async (_argv, _app) => {
            throw new Error('Flow deletion requires the Flow Designer GraphQL API - not yet implemented.\n'
              + 'Use the ServiceNow web UI to delete flows.');
          }),
        });
    },
    handler: () => {
      console.log('Manage Flow Designer flows from the sys_hub_flow table.');
      console.log('');
      console.log('Available subcommands:');
      console.log('  list                  List flows');
      console.log('  executions            Show flow executions from sys_flow_context');
      console.log('  show <identifier>     Show flow details by name or sys_id');
      console.log('  create                Create a new flow (not yet implemented)');
      console.log('  update <identifier>   Update a flow (not yet implemented)');
      console.log('  delete <identifier>   Delete a flow (not yet implemented)');
      console.log('');
      console.log('Run "jsn flows <command> --help" for details.');
      console.log('');
      console.log('Note: Flow structure comes from the ProcessFlow API (the Flow');
      console.log('Designer UI source), so V1, V2, and subflow definitions all');
      console.log('render with full action inputs and conditions.');
    },
  };
}
