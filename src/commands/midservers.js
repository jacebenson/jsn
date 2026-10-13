import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { input, password as passwordPrompt, select } from '@inquirer/prompts';
import { confirmDelete, formatRecordForDisplay, getStringField, interactiveList, canPrompt, assertSafeExactMatch } from '../helpers.js';
import { FormatAuto } from '../output.js';
import { declareCapabilities } from '../capabilities.js';
import { resolveRecord, unwrapSysId } from '../resolve-record.js';
import { detectDocker, defaultRun, installDockerMidServer, midInstallDirectory, normalizeMidName, validateMidCredentials } from '../midserver-install.js';
import { detectDirectPlatform, installDirectMidServer, readDirectInstallation, removeDirectInstallation, runDirectInstallation } from '../midserver-direct.js';

const AGENT_TABLE = 'ecc_agent';
const QUEUE_TABLE = 'ecc_queue';
const LIST_FIELDS = ['sys_id', 'name', 'status', 'host_name', 'ip_address', 'version', 'validated', 'last_heartbeat', 'sys_updated_on'];
const DEFAULT_TIMEOUT = 120000;
const DEFAULT_INTERVAL = 2000;

declareCapabilities('midservers', { mutationSubcommands: ['add', 'remove', 'execute', 'start', 'stop'] });

function agentName(record) {
  const name = getStringField(record, 'name');
  return `mid.server.${name}`;
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

async function showMidDiagnostics(app, argv, kind) {
  app.requireInstance();
  let mid;
  if (argv.identifier) {
    mid = await resolveMidServer(app.sdk, argv.identifier);
  } else {
    if (!canPrompt() || app.output.getFormat() !== FormatAuto) {
      throw new Error('An identifier is required outside an interactive terminal');
    }
    mid = await interactiveList({
      app, table: AGENT_TABLE, singular: 'MID Server', columns: LIST_FIELDS,
      limit: 50, labelField: 'name', message: `Select a MID Server for ${kind}`,
      formatLabel: record => `${getStringField(record, 'name')} [${getStringField(record, 'status')}]`,
    });
    if (!mid) return;
  }
  const name = getStringField(mid, 'name');
  const sysId = unwrapSysId(mid);
  assertSafeExactMatch(name);
  assertSafeExactMatch(sysId);
  const issues = kind === 'issues';
  const table = issues ? 'ecc_agent_issue' : 'mid_server_event';
  const columns = issues
    ? ['sys_id', 'state', 'source', 'message', 'last_detected']
    : ['sys_id', 'event', 'source', 'message', 'sys_created_on'];
  const query = issues
    ? `mid_server=${sysId}${argv.all ? '' : '^state!=resolved'}^ORDERBYDESClast_detected`
    : `agent=${name}^ORDERBYDESCsys_created_on`;
  const limit = argv.limit ?? 50;
  const offset = argv.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0) {
    throw new Error('Use --limit between 1 and 1000 and a nonnegative --offset');
  }
  const records = await app.sdk.list(table, new URLSearchParams({
    sysparm_query: query, sysparm_fields: columns.join(','), sysparm_display_value: 'all',
    sysparm_limit: String(limit), sysparm_offset: String(offset),
  }));
  const instanceURL = app.getEffectiveInstance();
  const url = new URL(`/${table}_list.do`, instanceURL);
  url.searchParams.set('sysparm_query', query);
  const rows = records.map(record => ({
    ...record,
    url: new URL(`/${table}.do?sys_id=${encodeURIComponent(unwrapSysId(record))}`, instanceURL).href,
  }));
  const label = issues ? (argv.all ? 'issues' : 'unresolved issues') : 'lifecycle events';
  const summary = rows.length
    ? `Showing ${rows.length} ${label} for MID Server '${name}' (offset ${offset})`
    : `No ${label} returned for MID Server '${name}' (offset ${offset})`;
  const lines = [summary, ''];
  for (const record of rows) {
    lines.push(`${getStringField(record, issues ? 'last_detected' : 'sys_created_on')}  ${getStringField(record, issues ? 'state' : 'event')}`);
    const source = getStringField(record, 'source');
    const message = getStringField(record, 'message');
    if (source) lines.push(`  ${source}`);
    if (message) lines.push(`  ${message}`);
    lines.push(`  ${record.url}`, '');
  }
  lines.push(`View in ServiceNow: ${url.href}`);
  app.ok({
    mid_server: name, sys_id: sysId, table, count: rows.length, records: rows,
    pagination: { limit, offset }, url: url.href, context: { instance_url: instanceURL },
    _formatted: `${lines.join('\n')}\n`,
  }, { summary });
}

function midDiagnosticsCommand(kind, wrap) {
  return {
    command: `${kind} [identifier]`,
    describe: kind === 'issues' ? 'Show MID Server issues (unresolved by default)' : 'Show MID Server lifecycle history',
    builder: b => {
      b.option('limit', { alias: 'l', type: 'number', default: 50, describe: 'Max records (1-1000)' })
        .option('offset', { type: 'number', default: 0, describe: 'Result offset' });
      if (kind === 'issues') b.option('all', { type: 'boolean', default: false, describe: 'Include resolved issues' });
      return b;
    },
    handler: wrap(async (argv, app) => showMidDiagnostics(app, argv, kind)),
  };
}

// Progress for long, otherwise-silent direct-install phases. Human terminals
// only, and on stderr, so the stdout envelope and --json output stay clean.
export function directProgress(app) {
  const human = app.output?.getFormat() === FormatAuto && (canPrompt() || process.stderr.isTTY === true);
  if (!human) return () => {};
  const mib = bytes => (Number(bytes || 0) / (1024 * 1024)).toFixed(0);
  return event => {
    if (event.phase === 'download-start') {
      process.stderr.write(`Downloading the official MID ZIP from ServiceNow (about 532 MiB).\n  ${event.archiveURL}\n`);
    } else if (event.phase === 'download') {
      const percent = event.total ? ` (${Math.floor((event.received / event.total) * 100)}%)` : '';
      process.stderr.write(`\r  ${mib(event.received)} MiB${percent} downloaded...`);
      if (event.done) process.stderr.write('\n');
    } else if (event.phase === 'extract-start') {
      process.stderr.write(`Extracting ${event.entries} files into ${event.installDir}...\n`);
    } else if (event.phase === 'extract-done') {
      process.stderr.write('Extraction complete. Configuring the MID Server...\n');
    }
  };
}

// A registration wait is minutes of silence otherwise; report elapsed progress.
export function registrationProgress(app, timeoutMs) {
  const human = app.output?.getFormat() === FormatAuto && (canPrompt() || process.stderr.isTTY === true);
  if (!human) return undefined;
  const seconds = Math.round(timeoutMs / 1000);
  let lastReport = 0;
  return elapsedMs => {
    if (elapsedMs - lastReport < 15000) return;
    lastReport = elapsedMs;
    process.stderr.write(`Waiting for ServiceNow to register the MID Server... ${Math.round(elapsedMs / 1000)}s of ${seconds}s\n`);
  };
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

export function assertMidServerReady(record) {
  assertMidServerUp(record);
  const name = getStringField(record, 'name') || getStringField(record, 'sys_id') || 'MID Server';
  const validated = queueValue(record.validated).toLowerCase();
  if (validated !== 'true') {
    const error = new Error(`MID Server '${name}' is not validated yet (validation: ${validated || 'unknown'}). Use the manual Validate action in ServiceNow before executing a command.`);
    error.code = 'midserver_not_validated';
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

export async function waitForMidServerUp(app, name, timeoutMs, intervalMs, onWait) {
  const started = Date.now();
  const fullName = name;
  while (Date.now() - started <= timeoutMs) {
    onWait?.(Date.now() - started);
    const params = new URLSearchParams({
      sysparm_query: `name=${fullName}`,
      sysparm_limit: '1',
      sysparm_display_value: 'all',
      sysparm_fields: 'sys_id,name,status,validated,host_name,version,last_heartbeat',
    });
    const records = await app.sdk.list(AGENT_TABLE, params);
    if (records[0] && getStringField(records[0], 'status').toLowerCase() === 'up') return records[0];
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`MID Server '${fullName}' did not report Up within ${timeoutMs}ms`);
}

function removeLocalMidServer(instanceURL, name, directory) {
  const direct = readDirectInstallation(instanceURL, name, directory);
  if (direct) { removeDirectInstallation(direct); return true; }
  const installDir = directory || midInstallDirectory(instanceURL, name);
  const composePath = path.join(installDir, 'docker-compose.yaml');
  const envPath = path.join(installDir, '.env');
  if (!fs.existsSync(composePath)) {
    if (fs.existsSync(path.join(installDir, 'agent'))) throw new Error('Native MID directory exists without trustworthy ownership metadata; refusing removal');
    return false;
  }
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
  const installDir = argv.directory || midInstallDirectory(app.getEffectiveInstance(), identifier);
  const direct = readDirectInstallation(app.getEffectiveInstance(), identifier, argv.directory);
  if (direct) {
    if (!Number.isInteger(argv.tail) || argv.tail < 1 || argv.tail > 10000) throw new Error('Use --tail between 1 and 10000');
    if (argv.follow) throw new Error('Direct log follow is not supported; read logs again or use the native host log viewer');
    const logfile = path.join(installDir, 'agent', 'logs', 'agent0.log');
    if (!fs.existsSync(logfile)) throw new Error('No MID agent log yet; the installation may only be prepared');
    const stat = fs.lstatSync(logfile);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Untrusted MID log path');
    const fd = fs.openSync(logfile, 'r');
    let text;
    try {
      const length = Math.min(stat.size, 1024 * 1024);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, stat.size - length);
      text = buffer.toString('utf8').split('\n').slice(-argv.tail).join('\n');
    } finally { fs.closeSync(fd); }
    app.ok({ installation: 'direct', logfile, text, _formatted: `${text}\n` }, { summary: 'Local MID agent log (last 1 MiB maximum)' });
    return;
  }
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
      .command(midDiagnosticsCommand('issues', wrap))
      .command(midDiagnosticsCommand('events', wrap))
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
        describe: 'Show local native or Docker Compose MID logs',
        builder: (b) => b
          .option('tail', { type: 'number', default: 100, describe: 'Number of log lines' })
          .option('follow', { type: 'boolean', default: false, describe: 'Follow the logs (Compose only)' })
          .option('directory', { type: 'string', describe: 'Local installation directory override' }),
        handler: wrap(async (argv, app) => {
          showMidServerLogs(app, argv.identifier, argv);
        }),
      })
      .command({
        command: '<identifier> logs',
        describe: 'Show local native or Docker Compose MID logs',
        builder: (b) => b
          .option('tail', { type: 'number', default: 100, describe: 'Number of log lines' })
          .option('follow', { type: 'boolean', default: false, describe: 'Follow the logs (Compose only)' })
          .option('directory', { type: 'string', describe: 'Local installation directory override' }),
        handler: wrap(async (argv, app) => {
          showMidServerLogs(app, argv.identifier, argv);
        }),
      })
      .command({
        command: 'start <identifier>',
        describe: 'Start an owned direct MID (Windows: foreground console, no service)',
        builder: b => b.option('directory', { type: 'string', describe: 'Installation directory override' }),
        handler: wrap(async (argv, app) => {
          const metadata = readDirectInstallation(app.getEffectiveInstance(), argv.identifier, argv.directory);
          if (!metadata) throw new Error('No owned direct MID installation found');
          if (metadata.state !== 'prepared') throw new Error('MID is already started or has an uncertain runtime state; stop it first');
          const result = runDirectInstallation(metadata, 'start');
          app.ok(result, { summary: result.platform === 'windows' ? 'Windows MID console exited; no service was registered' : 'MID start command completed; registration and manual validation must be checked in ServiceNow' });
        }),
      })
      .command({
        command: 'stop <identifier>',
        describe: 'Stop an owned Linux direct MID; Windows console uses Ctrl+C',
        builder: b => b.option('directory', { type: 'string', describe: 'Installation directory override' }),
        handler: wrap(async (argv, app) => {
          const metadata = readDirectInstallation(app.getEffectiveInstance(), argv.identifier, argv.directory);
          if (!metadata) throw new Error('No owned direct MID installation found');
          app.ok(runDirectInstallation(metadata, 'stop'), { summary: 'Owned native MID stop command completed' });
        }),
      })
      .command({
        command: 'add',
        describe: 'Install and verify a MID Server',
        builder: (b) => b
          .option('name', { type: 'string', describe: 'MID Server name (prompted when omitted)' })
          .option('username', { type: 'string', describe: 'MID Server username (password is always prompted)' })
          .option('install-method', { type: 'string', choices: ['docker', 'direct'], describe: 'Installation method (prompted when omitted)' })
          .option('directory', { type: 'string', describe: 'Installation directory (must not exist for direct ZIP)' })
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
                { name: 'Direct ZIP install (native user-owned runtime)', value: 'direct' },
              ]
              : dockerStatus.installed && dockerStatus.compose
                ? [
                  { name: 'Run with sudo', value: 'sudo' },
                  { name: 'Prepare files now, run Docker later', value: 'prepare' },
                  { name: 'Direct ZIP install (native user-owned runtime)', value: 'direct' },
                ]
              : [
                { name: 'Prepare files now, run Docker later', value: 'prepare' },
                { name: 'Direct ZIP install (native user-owned runtime)', value: 'direct' },
              ],
          });
          if (installMethod === 'direct') {
            const native = detectDirectPlatform();
            const decision = await select({
              message: native === 'linux' ? 'No system service or elevation will be used. Choose runtime:' : 'Windows console runtime only; native service registration is not supported. Choose:',
              choices: [
                ...(native === 'linux' ? [{ name: 'Start user-owned background MID', value: 'start' }] : []),
                { name: 'Prepare private files only (do not start)', value: 'prepare' },
                { name: 'Cancel without downloading', value: 'cancel' },
              ],
            });
            if (decision === 'cancel') return;
            const shortName = normalizeMidName(name);
            const existing = await app.sdk.list(AGENT_TABLE, new URLSearchParams({ sysparm_query: `name=${shortName}`, sysparm_fields: 'sys_id,name', sysparm_limit: '1' }));
            if (existing.length) throw new Error(`MID '${shortName}' already exists in ServiceNow; choose a new name. Existing runtime and record were not changed.`);
            const installation = await installDirectMidServer({
              instanceURL: app.getEffectiveInstance(), ...credentials, name, directory: argv.directory,
              runNow: decision === 'start', onProgress: directProgress(app),
            });
            if (installation.state === 'prepared') {
              app.ok(installation, { summary: `Prepared native MID '${installation.name}' in ${installation.installDir}; not started or registered. Start with jsn midservers start ${installation.name}${argv.directory ? ' --directory ' + JSON.stringify(installation.installDir) : ''}. Windows start runs in the foreground console; no service is installed.` });
              return;
            }
            let record;
            const directWait = Math.max(1, argv['wait-timeout']);
            const directInterval = Math.max(500, argv['wait-interval']);
            const onWait = registrationProgress(app, directWait);
            const started = Date.now();
            try {
              record = await waitForMidServerUp(app, installation.name, directWait, directInterval, onWait);
              onWait?.(directWait);
            }
            catch {
              onWait?.(Math.max(directWait, Date.now() - started));
              app.ok({ ...installation, registration: 'pending', validated: false }, { summary: `Native MID start command completed; registration is pending. Runtime retained for diagnostics at ${installation.installDir}; no forced teardown.` });
              return;
            }
            const validated = queueValue(record.validated).toLowerCase() === 'true';
            const url = new URL(`/ecc_agent.do?sys_id=${encodeURIComponent(unwrapSysId(record))}`, app.getEffectiveInstance()).href;
            app.ok({ ...installation, registration: 'up', validated, record, url }, { summary: validated ? `MID '${installation.name}' is Up and manually validated` : `MID '${installation.name}' is Up but pending manual validation. Use Validate in ServiceNow: ${url}` });
            return;
          }

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
        builder: (b) => b.option('force', { type: 'boolean', default: false, describe: 'Skip confirmation' })
          .option('directory', { type: 'string', describe: 'Local installation directory override' }),
        handler: wrap(async (argv, app) => {
          let record;
          if (argv.identifier) {
            try {
              record = await resolveMidServer(app.sdk, argv.identifier);
            } catch (error) {
              if (error.code !== 'not_found') throw error;
              const localDir = argv.directory || midInstallDirectory(app.getEffectiveInstance(), argv.identifier);
              if (!readDirectInstallation(app.getEffectiveInstance(), argv.identifier, argv.directory) && !fs.existsSync(path.join(localDir, 'docker-compose.yaml'))) throw error;
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
          const direct = readDirectInstallation(app.getEffectiveInstance(), name, argv.directory);
          const localRemoved = removeLocalMidServer(app.getEffectiveInstance(), name, argv.directory);
          if (record) await app.sdk.delete(AGENT_TABLE, sysId);
          app.ok({ name, sys_id: sysId, deleted: Boolean(record), local_compose_removed: localRemoved && !direct, local_installation_removed: localRemoved, local_installation_type: direct ? 'direct' : 'docker' }, { summary: `Removed MID Server '${name}'${localRemoved ? ' and its owned local runtime' : ''}` });
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
          assertMidServerReady(record);
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
          const responseSysId = unwrapSysId(response);
          const responseURL = responseSysId
            ? new URL(`/ecc_queue.do?sys_id=${encodeURIComponent(responseSysId)}`, app.getEffectiveInstance()).href
            : '';
          const summary = `Executed command on MID Server '${getStringField(record, 'name')}'`;
          const lines = [summary, '', result.stdout || '(no stdout)'];
          if (result.stderr) lines.push('', 'stderr:', result.stderr);
          if (responseURL) lines.push('', `ECC input: ${responseURL}`);
          app.ok({
            mid_server: getStringField(record, 'name'),
            command,
            output: { sys_id: outputSysId, ...output },
            response: { ...response, ...result, url: responseURL },
            _formatted: `${lines.join('\n')}\n`,
          }, { summary });
        }),
      }),
    handler: () => {
      console.log('Manage ServiceNow MID Servers and execute commands through them.');
      console.log('');
      console.log('Available subcommands:');
      console.log('  list                         List MID Servers');
      console.log('  issues [name_or_sys_id]       Show unresolved issues (--all includes resolved)');
      console.log('  events [name_or_sys_id]       Show lifecycle history');
      console.log('  show <name_or_sys_id>        Show a MID Server');
      console.log('  add --name <name>             Install a MID Server (Docker or direct ZIP)');
      console.log('  remove <name_or_sys_id>       Remove a MID Server record');
      console.log('  execute <name_or_sys_id>      Execute a shell command');
      console.log('');
      console.log('Run "jsn midservers <command> --help" for details.');
    },
  };
}

export { waitForCommandResult };
