import { deferredFamilyDefinition } from '../command-families.js';
import { buildDevCmd } from './_generic.js';
import { getStringField, quoteShellArg } from '../helpers.js';
import { FormatAuto, FormatStyled } from '../output.js';
import { readRestMessageLogs, formatRestMessageLogs } from '../restmessage-logs.js';

export const restmessageCmd = (wrap) => withLogs(buildDevCmd('restmessage', 'sys_rest_message', [],
  ['name', 'endpoint', 'active', 'sys_scope'], wrap, {
    definition: deferredFamilyDefinition('restmessage'),
    singular: 'REST message',
    scopeValidation: true,
    extraSubcommands: [{ name: 'logs', description: 'Recent calls from the outbound HTTP log' }],
    onShow: async (record, app) => {
      const sysID = getStringField(record, 'sys_id') || '';
      if (!sysID) return;

      // Fetch related methods
      const mp = new URLSearchParams();
      mp.set('sysparm_query', `rest_message=${sysID}^ORDERBYorder`);
      mp.set('sysparm_limit', '100');
      mp.set('sysparm_display_value', 'all');
      mp.set('sysparm_fields', 'name,http_method,rest_endpoint,order,sys_id');
      const methods = await app.sdk.list('sys_rest_message_fn', mp);

      if (methods.length > 0) {
        console.log(`  Methods (${methods.length}):`);
        for (const m of methods) {
          const name = getStringField(m, 'name') || getStringField(m, 'http_method') || '';
          const method = getStringField(m, 'http_method') || '';
          const path = getStringField(m, 'rest_endpoint') || '';
          const mid = getStringField(m, 'sys_id') || '';
          console.log(`    ${method} ${path}  (${name})`);
          console.log(`      → jsn records get --table sys_rest_message_fn --sys-id ${mid}`);
        }
      }
    },
  }), wrap);

const LOGS_EPILOGUE = [
  'A log row names the script that made the call, not the REST message, so calls are matched by URL:',
  'it starts with the host of one of the endpoints of the message and its methods, and contains',
  'the directory of one of them (the path up to its last /, before any ${variable}). A call that',
  'setEndpoint() sent to another host or directory is not found, and an endpoint whose host is a',
  'variable is listed as not matched. What a row holds depends on the method\'s HTTP log level:',
  'Basic, the default, records no headers. Calls through a MID server show the server name;',
  'the MID server\'s own record is in ecc_queue.',
  '',
  'Credential headers and query values are always redacted. Request and response bodies are never read.',
].join('\n');

function withLogs(command, wrap) {
  const originalBuilder = command.builder;
  command.builder = (yargs) => originalBuilder(yargs).command({
    command: 'logs <message>',
    aliases: ['log'],
    describe: 'Recent calls a REST message made, from the outbound HTTP log, newest first',
    discoveryTasks: [{
      phrases: ['rest message log', 'outbound http log', 'outbound rest call failed', 'did the integration call go out', 'rest message response status'],
      args: ['--json'],
      description: 'Show the recent outbound calls of one REST message, with status and timing',
    }],
    builder: (y) => y.strict()
      .positional('message', { type: 'string', describe: 'REST message name or sys_id' })
      .option('status', { type: 'string', describe: 'Only this status code (404) or class (4xx)' })
      .option('endpoint', { type: 'string', describe: 'Only calls whose URL contains this text' })
      .option('limit', { type: 'number', default: 20, describe: 'Calls per page, 1 to 200' })
      .option('offset', { type: 'number', default: 0, describe: 'Calls to skip, for the next page' })
      .epilogue(LOGS_EPILOGUE),
    handler: wrap(async (argv, app) => {
      app.requireInstance();
      const data = await readRestMessageLogs(app.sdk, argv.message, { status: argv.status, endpoint: argv.endpoint, limit: argv.limit, offset: argv.offset });
      const { has_more: hasMore, next_offset: next } = data.pagination;
      const page = ['jsn', 'restmessage', 'logs', data.message.sys_id, ...(argv.status === undefined ? [] : ['--status', argv.status]),
        ...(argv.endpoint === undefined ? [] : ['--endpoint', argv.endpoint]), '--limit', String(argv.limit), '--offset', String(next)].map(quoteShellArg).join(' ');
      // Non-enumerable, so piped JSON from the auto format does not repeat the view.
      if ([FormatAuto, FormatStyled].includes(app.output.getFormat())) Object.defineProperty(data, '_formatted', { value: formatRestMessageLogs(data), enumerable: false, configurable: true });
      app.ok(data, {
        summary: data.note || `${data.count} logged call(s) of REST message ${data.message.name}${hasMore ? `; more with --offset ${next}` : ''}`,
        breadcrumbs: [
          ...(hasMore ? [{ action: 'list', cmd: page, description: 'Next page of calls' }] : []),
          ...data.mid_servers.map(mid => ({ action: 'list', cmd: `jsn records list --table ecc_queue --query ${quoteShellArg(`agent=mid.server.${mid}^ORDERBYDESCsys_created_on`)} --limit 20`, description: `ECC queue rows of MID server ${mid}` })),
          { action: 'show', cmd: `jsn restmessage show ${quoteShellArg(data.message.sys_id)}`, description: 'The REST message and its methods' },
        ],
      });
    }),
  });
  if (Array.isArray(command.discovery?.benefits)) command.discovery.benefits.push('Recent outbound calls matched by endpoint URL, with credentials redacted');
  return command;
}
