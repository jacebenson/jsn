import { confirmDelete, formatRecordForDisplay, getStringField, interactiveList, parseDataArg, canPrompt } from '../helpers.js';
import { FormatAuto } from '../output.js';
import { declareCapabilities } from '../capabilities.js';
import { resolveRecord, unwrapSysId } from '../resolve-record.js';

const AGENT_TABLE = 'ecc_agent';
const QUEUE_TABLE = 'ecc_queue';
const LIST_FIELDS = ['sys_id', 'name', 'status', 'host_name', 'ip_address', 'version', 'validated', 'last_heartbeat', 'sys_updated_on'];
const DEFAULT_TIMEOUT = 120000;
const DEFAULT_INTERVAL = 2000;

declareCapabilities('midservers', { mutationSubcommands: ['add', 'remove', 'execute'] });

function agentName(record) {
  const name = getStringField(record, 'name');
  return name.startsWith('mid.server.') ? name : `mid.server.${name}`;
}

function queueValue(value) {
  return value && typeof value === 'object' ? (value.value || value.display_value || '') : String(value || '');
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&apos;');
}

export function buildCommandPayload(command) {
  return `<parameters><parameter name="name" value="${escapeXml(command)}"/></parameters>`;
}

function decodeXml(value) {
  return String(value || '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

export function parseCommandResult(payload) {
  if (!payload) return { stdout: '', stderr: '' };
  const result = payload.match(/<result\b[^>]*>([\s\S]*?)<\/result>/i)?.[1] || payload;
  const stdout = result.match(/<stdout\b[^>]*>([\s\S]*?)<\/stdout>/i)?.[1] || '';
  const stderr = result.match(/<stderr\b[^>]*>([\s\S]*?)<\/stderr>/i)?.[1] || '';
  return { stdout: decodeXml(stdout), stderr: decodeXml(stderr) };
}

async function waitForCommandResult(sdk, outputSysId, timeoutMs, intervalMs) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const params = new URLSearchParams({
      sysparm_query: `response_to=${outputSysId}^queue=input`,
      sysparm_limit: '1',
      sysparm_display_value: 'all',
      sysparm_fields: 'sys_id,state,error,payload,name,topic,queue,agent,created_on,processed',
    });
    const records = await sdk.list(QUEUE_TABLE, params);
    if (records.length > 0) return records[0];
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  const error = new Error(`Timed out waiting for MID Server response to ECC Queue record ${outputSysId}`);
  error.code = 'midserver_timeout';
  throw error;
}

async function resolveMidServer(sdk, identifier) {
  try {
    return await resolveRecord(sdk, {
      table: AGENT_TABLE,
      identifier,
      matchField: 'name',
      resource: 'MID Server',
    });
  } catch (error) {
    if (error.code !== 'not_found' || identifier.startsWith('mid.server.')) throw error;
    return resolveRecord(sdk, {
      table: AGENT_TABLE,
      identifier: `mid.server.${identifier}`,
      matchField: 'name',
      resource: 'MID Server',
    });
  }
}

async function listAgents(app, argv) {
  const columns = argv.columns
    ? [...new Set(argv.columns.split(',').map(column => column.trim()).filter(Boolean))]
    : LIST_FIELDS;
  const query = argv.query || '';

  if (canPrompt() && app.output.getFormat() === FormatAuto && !query) {
    const picked = await interactiveList({
      app,
      table: AGENT_TABLE,
      singular: 'MID Server',
      columns,
      limit: argv.limit,
      labelField: 'name',
      message: 'Select a MID Server',
      formatLabel: (record) => {
        const name = getStringField(record, 'name') || getStringField(record, 'sys_id');
        const status = getStringField(record, 'status');
        return status ? `${name} [${status}]` : name;
      },
    });
    if (picked === undefined || picked === null) return;
    picked._context = { instance_url: app.getEffectiveInstance(), table: AGENT_TABLE };
    app.ok(picked, {
      summary: `MID Server: ${getStringField(picked, 'name') || getStringField(picked, 'sys_id')}`,
      breadcrumbs: [{ action: 'list', cmd: 'jsn midservers list', description: 'Back to all MID Servers' }],
    });
    return;
  }

  const params = new URLSearchParams({
    sysparm_limit: String(argv.limit),
    sysparm_display_value: 'all',
    sysparm_fields: ['sys_id', ...columns.filter(column => column !== 'sys_id')].join(','),
    sysparm_query: query ? `${query}^ORDERBYDESCsys_updated_on` : 'ORDERBYname',
  });
  const records = await app.sdk.list(AGENT_TABLE, params);
  app.ok({
    table: AGENT_TABLE,
    count: records.length,
    columns,
    records: records.map(record => formatRecordForDisplay(record, columns)),
    context: { instance_url: app.getEffectiveInstance() },
  }, { summary: `${records.length} MID Server(s)` });
}

export function assertMidServerUp(record) {
  const name = getStringField(record, 'name') || getStringField(record, 'sys_id') || 'MID Server';
  const status = getStringField(record, 'status');
  if (status.toLowerCase() !== 'up') {
    const error = new Error(`MID Server '${name}' is not Up (status: ${status || 'unknown'}). Start or install it before executing a command.`);
    error.code = 'midserver_not_up';
    throw error;
  }
}

export function midserversCmd(wrap) {
  return {
    command: 'midservers [subcommand]',
    aliases: ['midserver', 'mid'],
    describe: 'Manage ServiceNow MID Servers and run commands through them',
    builder: (y) => y
      .command({
        command: 'list',
        aliases: ['ls'],
        describe: 'List MID Servers',
        builder: (b) => b
          .option('query', { type: 'string', describe: 'Encoded query against ecc_agent' })
          .option('columns', { type: 'string', describe: 'Comma-separated fields' })
          .option('limit', { alias: 'l', type: 'number', default: 50, describe: 'Max records' }),
        handler: wrap(async (argv, app) => {
          await listAgents(app, argv);
        }),
      })
      .command({
        command: 'show <identifier>',
        aliases: ['get'],
        describe: 'Show a MID Server by name or sys_id',
        handler: wrap(async (argv, app) => {
          const record = await resolveMidServer(app.sdk, argv.identifier);
          record._context = { instance_url: app.getEffectiveInstance(), table: AGENT_TABLE };
          app.ok(record, { summary: `MID Server: ${getStringField(record, 'name') || argv.identifier}` });
        }),
      })
      .command({
        command: 'add',
        describe: 'Create a MID Server record',
        builder: (b) => b
          .option('name', { type: 'string', describe: 'MID Server name (without the mid.server. prefix)' })
          .option('host-name', { type: 'string', describe: 'MID Server host name' })
          .option('ip-address', { type: 'string', describe: 'MID Server IP address' })
          .option('data', { type: 'string', describe: 'JSON fields for the ecc_agent record' })
          .option('data-file', { type: 'string', describe: 'Read JSON fields from a file' }),
        handler: wrap(async (argv, app) => {
          let data = argv.data || argv['data-file'] ? parseDataArg(argv) : {};
          if (argv.name) data.name = argv.name;
          if (!data.name) throw new Error('--name or --data with a name is required');
          data.name = String(data.name).startsWith('mid.server.') ? data.name : `mid.server.${data.name}`;
          if (argv['host-name']) data.host_name = argv['host-name'];
          if (argv['ip-address']) data.ip_address = argv['ip-address'];
          const record = await app.sdk.create(AGENT_TABLE, data);
          app.ok(record, { summary: `Created MID Server '${getStringField(record, 'name') || data.name}'` });
        }),
      })
      .command({
        command: 'remove <identifier>',
        aliases: ['delete'],
        describe: 'Remove a MID Server record',
        builder: (b) => b.option('force', { type: 'boolean', default: false, describe: 'Skip confirmation' }),
        handler: wrap(async (argv, app) => {
          const record = await resolveMidServer(app.sdk, argv.identifier);
          const sysId = unwrapSysId(record);
          const name = getStringField(record, 'name') || argv.identifier;
          await confirmDelete(app, argv, `Remove MID Server '${name}'`);
          await app.sdk.delete(AGENT_TABLE, sysId);
          app.ok({ name, sys_id: sysId, deleted: true }, { summary: `Removed MID Server '${name}'` });
        }),
      })
      .command({
        command: 'execute <identifier>',
        describe: 'Execute a shell command through a MID Server',
        builder: (b) => b
          .option('command', { alias: 'c', type: 'string', demandOption: true, describe: 'Command line to execute on the MID Server host' })
          .option('timeout', { type: 'number', default: DEFAULT_TIMEOUT, describe: 'Response timeout in milliseconds' })
          .option('interval', { type: 'number', default: DEFAULT_INTERVAL, describe: 'Polling interval in milliseconds' }),
        handler: wrap(async (argv, app) => {
          const record = await resolveMidServer(app.sdk, argv.identifier);
          assertMidServerUp(record);
          const agent = agentName(record);
          const output = await app.sdk.create(QUEUE_TABLE, {
            agent,
            topic: 'Command',
            queue: 'output',
            name: argv.command,
            payload: buildCommandPayload(argv.command),
          });
          const outputSysId = unwrapSysId(output);
          if (!outputSysId) throw new Error('ServiceNow did not return the ECC Queue sys_id for the command');
          const response = await waitForCommandResult(app.sdk, outputSysId, Math.max(1, argv.timeout), Math.max(250, argv.interval));
          const responseError = getStringField(response, 'error');
          if (responseError) throw new Error(`MID Server command failed: ${responseError}`);
          const result = parseCommandResult(queueValue(response.payload));
          app.ok({
            mid_server: getStringField(record, 'name'),
            command: argv.command,
            output: { sys_id: outputSysId, ...output },
            response: { ...response, ...result },
          }, { summary: `Executed command on MID Server '${getStringField(record, 'name')}'` });
        }),
      }),
    handler: () => {
      console.log('Manage ServiceNow MID Servers and execute commands through them.');
      console.log('');
      console.log('Available subcommands:');
      console.log('  list                         List MID Servers');
      console.log('  show <name_or_sys_id>        Show a MID Server');
      console.log('  add --name <name>             Create a MID Server record');
      console.log('  remove <name_or_sys_id>       Remove a MID Server record');
      console.log('  execute <name_or_sys_id>      Execute a shell command');
      console.log('');
      console.log('Run "jsn midservers <command> --help" for details.');
    },
  };
}

export { waitForCommandResult };
