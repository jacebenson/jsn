import fs from 'node:fs';
import path from 'node:path';
import { input, password as passwordPrompt, select } from '@inquirer/prompts';
import { confirmDelete, formatRecordForDisplay, getStringField, interactiveList, canPrompt } from '../helpers.js';
import { FormatAuto } from '../output.js';
import { declareCapabilities } from '../capabilities.js';
import { resolveRecord, unwrapSysId } from '../resolve-record.js';
import { detectDocker, defaultRun, installDockerMidServer, midInstallDirectory, validateMidCredentials } from '../midserver-install.js';

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

async function promptMidCredentials(app, argv) {
  if (!canPrompt()) throw new Error('MID Server installation is interactive. Run it from a terminal.');
  let username = argv.username || '';
  while (true) {
    username = username || (await input({
      message: 'MID Server username:',
      validate: value => value.trim() ? true : 'Username is required',
    })).trim();
    const password = await passwordPrompt({
      message: 'MID Server password:',
      mask: '*',
      validate: value => value ? true : 'Password is required',
    });
    try {
      const validation = await validateMidCredentials(app.getEffectiveInstance(), username, password);
      return { username, password, releaseName: validation.releaseName };
    } catch (error) {
      const answer = await input({ message: `${error.message}. Press Enter to retry or Q to quit:` });
      if (answer.trim().toLowerCase() === 'q') {
        const quit = new Error('MID Server installation cancelled');
        quit.code = 'cancelled';
        throw quit;
      }
      username = argv.username || '';
    }
  }
}

async function waitForMidServerUp(app, name, timeoutMs, intervalMs) {
  const started = Date.now();
  const fullName = `mid.server.${name.replace(/^mid\.server\./, '')}`;
  while (Date.now() - started <= timeoutMs) {
    const params = new URLSearchParams({
      sysparm_query: `name=${fullName}`,
      sysparm_limit: '1',
      sysparm_display_value: 'all',
      sysparm_fields: 'sys_id,name,status,host_name,version,last_heartbeat',
    });
    const records = await app.sdk.list(AGENT_TABLE, params);
    if (records[0] && getStringField(records[0], 'status').toLowerCase() === 'up') return records[0];
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`MID Server '${fullName}' did not report Up within ${timeoutMs}ms`);
}

function removeLocalMidServer(instanceURL, name) {
  const installDir = midInstallDirectory(instanceURL, name);
  const composePath = path.join(installDir, 'docker-compose.yaml');
  const envPath = path.join(installDir, '.env');
  if (!fs.existsSync(composePath)) return false;
  const composeArgs = ['compose', ...(fs.existsSync(envPath) ? ['--env-file', envPath] : []), '-f', composePath, 'down'];
  try {
    defaultRun('docker', composeArgs, { cwd: installDir });
  } catch {
    defaultRun('sudo', ['systemctl', 'start', 'docker']);
    defaultRun('sudo', ['docker', ...composeArgs], { cwd: installDir });
  }
  try {
    fs.rmSync(installDir, { recursive: true, force: true });
  } catch {
    defaultRun('sudo', ['rm', '-rf', '--', installDir]);
  }
  return true;
}

function showMidServerLogs(app, identifier, argv) {
  const installDir = midInstallDirectory(app.getEffectiveInstance(), identifier);
  const composePath = path.join(installDir, 'docker-compose.yaml');
  const envPath = path.join(installDir, '.env');
  if (!fs.existsSync(composePath)) throw new Error(`No local Compose installation found for MID Server '${identifier}'`);
  const args = ['compose', ...(fs.existsSync(envPath) ? ['--env-file', envPath] : []), '-f', composePath, 'logs', '--tail', String(argv.tail)];
  if (argv.follow) args.push('--follow');
  try {
    defaultRun('docker', args, { cwd: installDir });
  } catch {
    defaultRun('sudo', ['systemctl', 'start', 'docker']);
    defaultRun('sudo', ['docker', ...args], { cwd: installDir });
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
        command: 'logs <identifier>',
        describe: 'Show local Docker Compose logs for a MID Server',
        builder: (b) => b
          .option('tail', { type: 'number', default: 100, describe: 'Number of log lines' })
          .option('follow', { type: 'boolean', default: false, describe: 'Follow the logs' }),
        handler: wrap(async (argv, app) => {
          showMidServerLogs(app, argv.identifier, argv);
        }),
      })
      .command({
        command: '<identifier> logs',
        describe: 'Show local Docker Compose logs for a MID Server',
        builder: (b) => b
          .option('tail', { type: 'number', default: 100, describe: 'Number of log lines' })
          .option('follow', { type: 'boolean', default: false, describe: 'Follow the logs' }),
        handler: wrap(async (argv, app) => {
          showMidServerLogs(app, argv.identifier, argv);
        }),
      })
      .command({
        command: 'add',
        describe: 'Install and verify a MID Server',
        builder: (b) => b
          .option('name', { type: 'string', describe: 'MID Server name (prompted when omitted)' })
          .option('username', { type: 'string', describe: 'MID Server username (password is always prompted)' })
          .option('install-method', { type: 'string', choices: ['docker', 'direct'], describe: 'Installation method (prompted when omitted)' })
          .option('directory', { type: 'string', describe: 'Docker installation directory' })
          .option('wait-timeout', { type: 'number', default: 300000, describe: 'How long to wait for the MID Server to report Up' })
          .option('wait-interval', { type: 'number', default: 3000, describe: 'MID Server status polling interval in milliseconds' }),
        handler: wrap(async (argv, app) => {
          app.requireInstance();
          const credentials = await promptMidCredentials(app, argv);
          const name = argv.name || (await input({
            message: 'MID Server name:',
            validate: value => value.trim() ? true : 'MID Server name is required',
          })).trim();
          const dockerStatus = detectDocker();
          const dockerAvailable = dockerStatus.available;
          const installMethod = argv['install-method'] || await select({
            message: dockerAvailable
              ? 'Docker and Docker Compose are ready. How should the MID Server be installed?'
              : dockerStatus.installed && dockerStatus.compose
                ? 'Docker is installed, but this user cannot access the Docker daemon. How should the MID Server be installed?'
                : 'Docker was not detected. How should the MID Server be installed?',
            choices: dockerAvailable
              ? [
                { name: 'Docker (recommended)', value: 'docker' },
                { name: 'Direct install (not available yet)', value: 'direct' },
              ]
              : dockerStatus.installed && dockerStatus.compose
                ? [
                  { name: 'Run with sudo', value: 'sudo' },
                  { name: 'Prepare files now, run Docker later', value: 'prepare' },
                  { name: 'Direct install (not available yet)', value: 'direct' },
                ]
              : [
                { name: 'Prepare files now, run Docker later', value: 'prepare' },
                { name: 'Direct install (not available yet)', value: 'direct' },
              ],
          });
          if (installMethod === 'direct') throw new Error('Direct MID Server installation is not implemented yet. Choose Docker.');

          const installation = await installDockerMidServer({
            instanceURL: app.getEffectiveInstance(),
            username: credentials.username,
            password: credentials.password,
            name,
            releaseName: credentials.releaseName,
            directory: argv.directory,
            runNow: false,
          });
          if (installMethod === 'sudo') {
            defaultRun('sudo', ['systemctl', 'start', 'docker']);
            defaultRun('sudo', ['docker', 'compose', '--env-file', path.join(installation.installDir, '.env'), '-f', installation.composePath, 'up', '-d'], { cwd: installation.installDir });
            installation.prepared = false;
          }
          if (installation.prepared) {
            app.ok(installation, { summary: `Prepared MID Server files in ${installation.installDir}. Run: ${installation.runCommand}` });
            return;
          }
          console.log('MID Server container started. ServiceNow may take a few minutes to register it and report Up.');
          let record;
          try {
            record = await waitForMidServerUp(app, installation.name, Math.max(1, argv['wait-timeout']), Math.max(500, argv['wait-interval']));
          } catch (error) {
            try { installation.rollback(); } catch { /* preserve the verification error */ }
            throw error;
          }
          app.ok({
            installation: 'docker',
            directory: installation.installDir,
            release: installation.releaseName,
            record,
          }, { summary: `Installed MID Server '${installation.name}' and verified it is Up` });
        }),
      })
      .command({
        command: 'remove [identifier]',
        aliases: ['delete'],
        describe: 'Remove a MID Server record (interactive when no identifier is given)',
        builder: (b) => b.option('force', { type: 'boolean', default: false, describe: 'Skip confirmation' }),
        handler: wrap(async (argv, app) => {
          let record;
          if (argv.identifier) {
            try {
              record = await resolveMidServer(app.sdk, argv.identifier);
            } catch (error) {
              if (error.code !== 'not_found') throw error;
              const localDir = midInstallDirectory(app.getEffectiveInstance(), argv.identifier);
              if (!fs.existsSync(path.join(localDir, 'docker-compose.yaml'))) throw error;
              record = null;
            }
          } else {
            if (!canPrompt() || app.output.getFormat() !== FormatAuto) {
              throw new Error('An identifier is required outside an interactive terminal');
            }
            record = await interactiveList({
              app,
              table: AGENT_TABLE,
              singular: 'MID Server',
              columns: LIST_FIELDS,
              limit: 50,
              labelField: 'name',
              message: 'Select a MID Server to remove',
              formatLabel: (candidate) => {
                const name = getStringField(candidate, 'name') || getStringField(candidate, 'sys_id');
                const status = getStringField(candidate, 'status');
                return status ? `${name} [${status}]` : name;
              },
            });
            if (!record) return;
          }
          const sysId = record ? unwrapSysId(record) : null;
          const name = getStringField(record, 'name') || argv.identifier || sysId;
          await confirmDelete(app, argv, `Remove MID Server '${name}'`);
          const localRemoved = removeLocalMidServer(app.getEffectiveInstance(), name);
          if (record) await app.sdk.delete(AGENT_TABLE, sysId);
          app.ok({ name, sys_id: sysId, deleted: Boolean(record), local_compose_removed: localRemoved }, { summary: `Removed MID Server '${name}'${localRemoved ? ' and its local Compose stack' : ''}` });
        }),
      })
      .command({
        command: 'execute [identifier]',
        describe: 'Execute a shell command through a MID Server',
        builder: (b) => b
          .option('command', { alias: 'c', type: 'string', describe: 'Command line to execute on the MID Server host' })
          .option('timeout', { type: 'number', default: DEFAULT_TIMEOUT, describe: 'Response timeout in milliseconds' })
          .option('interval', { type: 'number', default: DEFAULT_INTERVAL, describe: 'Polling interval in milliseconds' }),
        handler: wrap(async (argv, app) => {
          let record;
          if (argv.identifier) {
            record = await resolveMidServer(app.sdk, argv.identifier);
          } else {
            if (!canPrompt() || app.output.getFormat() !== FormatAuto) {
              throw new Error('An identifier and --command are required outside an interactive terminal');
            }
            record = await interactiveList({
              app,
              table: AGENT_TABLE,
              singular: 'MID Server',
              columns: LIST_FIELDS,
              limit: 50,
              labelField: 'name',
              message: 'Select a MID Server to execute on',
              formatLabel: (candidate) => {
                const name = getStringField(candidate, 'name') || getStringField(candidate, 'sys_id');
                const status = getStringField(candidate, 'status');
                return status ? `${name} [${status}]` : name;
              },
            });
            if (!record) return;
          }
          const command = argv.command || await input({
            message: 'Command to execute:',
            validate: value => value.trim() ? true : 'Command is required',
          });
          assertMidServerUp(record);
          const agent = agentName(record);
          const output = await app.sdk.create(QUEUE_TABLE, {
            agent,
            topic: 'Command',
            queue: 'output',
            name: command,
            payload: buildCommandPayload(command),
          });
          const outputSysId = unwrapSysId(output);
          if (!outputSysId) throw new Error('ServiceNow did not return the ECC Queue sys_id for the command');
          const response = await waitForCommandResult(app.sdk, outputSysId, Math.max(1, argv.timeout), Math.max(250, argv.interval));
          const responseError = getStringField(response, 'error');
          if (responseError) throw new Error(`MID Server command failed: ${responseError}`);
          const result = parseCommandResult(queueValue(response.payload));
          app.ok({
            mid_server: getStringField(record, 'name'),
            command,
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
