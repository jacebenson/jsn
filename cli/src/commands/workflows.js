import { declareCapabilities } from '../capabilities.js';
import { errUsage } from '../errors.js';
import {
  inspectWorkflow,
  listWorkflows,
  formatWorkflowList,
  formatWorkflowOutline,
} from '../workflow-inspection.js';

// Legacy Workflow Editor inspection is read-only by construction: every
// request in workflow-inspection.js is a Table API GET. Declaring no mutation
// subcommands keeps the mutation guard and read-only profiles aligned with
// what the command can actually do.
declareCapabilities('workflows', { mutationSubcommands: [] });

// A curated human view belongs to the command; keeping it non-enumerable
// leaves the JSON envelope free of presentation text.
function defineFormatted(data, formatted) {
  Object.defineProperty(data, '_formatted', { value: formatted, enumerable: false, configurable: true });
}

export function workflowsCmd(wrap) {
  return {
    command: 'workflows [subcommand]',
    aliases: ['workflow'],
    describe: 'Inspect legacy Workflow Editor workflows (read-only)',
    builder: (yargs) => yargs
      .command({
        command: 'list',
        aliases: ['ls'],
        describe: 'List legacy workflows with published and checked-out versions',
        builder: (y) => y
          .option('name', { type: 'string', describe: 'Workflow name contains this text' })
          .option('table', { type: 'string', describe: 'Exact target table name (e.g. incident)' })
          .option('query', { type: 'string', describe: 'Additional encoded query (e.g. "nameLIKEapproval")' })
          .option('limit', { alias: 'l', type: 'number', default: 20, describe: 'Page size (1–100)' })
          .option('offset', { type: 'number', default: 0, describe: 'Starting result offset' }),
        handler: wrap(async (argv, app) => {
          app.requireInstance();
          const data = await listWorkflows(app.sdk, {
            name: argv.name || '',
            table: argv.table || '',
            query: argv.query || '',
            limit: argv.limit,
            offset: argv.offset,
          });
          const next = data.pagination.has_more
            ? `jsn workflows list --limit ${data.pagination.limit} --offset ${data.pagination.offset + data.pagination.limit}`
            : '';
          const breadcrumbs = data.records.slice(0, 5).map(record => ({
            action: 'show',
            cmd: `jsn workflows show ${record.sys_id}`,
            description: `Inspect ${record.name}`,
          }));
          if (next) breadcrumbs.push({ action: 'next', cmd: next, description: 'Next page of legacy workflows' });
          defineFormatted(data, formatWorkflowList(data));
          app.ok(data, {
            summary: `${data.count} legacy workflow(s)${data.pagination.has_more ? ', more available' : ''}`,
            breadcrumbs,
          });
        }),
      })
      .command({
        command: 'show <identifier>',
        aliases: ['get'],
        describe: 'Inspect one legacy workflow: versions, activities, transitions, conditions and configuration',
        builder: (y) => y
          .positional('identifier', { type: 'string', describe: 'Workflow name, workflow sys_id, or version sys_id' })
          .option('version', { type: 'string', describe: 'Specific wf_workflow_version sys_id (default: published, else newest)' })
          .option('config', { type: 'boolean', describe: 'Show activity configuration and scripts under each step (JSON reads unchanged)' })
          .option('limit', { alias: 'l', type: 'number', default: 200, describe: 'Maximum activities to read (1–1000)' }),
        handler: wrap(async (argv, app) => {
          app.requireInstance();
          if (typeof argv.identifier !== 'string' || !argv.identifier.trim()) {
            throw errUsage('Provide a legacy workflow name or sys_id.');
          }
          const data = await inspectWorkflow(app.sdk, {
            identifier: argv.identifier,
            versionId: argv.version || '',
            includeConfiguration: argv.config !== false,
            limit: argv.limit,
          });
          // Preserve existing structured reads; only the human detail is opt-in.
          defineFormatted(data, formatWorkflowOutline(data, { includeConfiguration: argv.config === true }));
          const versionLabel = data.version
            ? `${data.version.name} (${data.selection.reason})`
            : 'no readable version';
          app.ok(data, {
            summary: `Legacy workflow: ${data.workflow.name} — ${versionLabel}, ${data.activities.length} activity(ies)${data.coverage.complete ? '' : ', partial coverage'}`,
            breadcrumbs: [
              { action: 'list', cmd: 'jsn workflows list', description: 'Back to legacy workflows' },
              ...(data.version ? [{ action: 'json', cmd: `jsn workflows show ${JSON.stringify(data.workflow.name)} --json`, description: 'Structured definition with IDs' }] : []),
            ],
          });
        }),
      }),
  };
}
