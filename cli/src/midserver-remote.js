import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

const FILE = '.jsn-mid-remote.json';
const PREFIX = 'io.jsn.mid';
const SSH_OPTIONS = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'RemoteCommand=none', '-o', 'RequestTTY=no', '--'];

export function validateRemoteTarget(target) {
  if (typeof target !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/.test(target)) throw new Error('Use a configured SSH alias containing only letters, numbers, dots, underscores or dashes');
  return target;
}

function defaultRun(command, args, options) {
  const { mergeStderr, ...settings } = options;
  const execution = { ...settings, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 };
  if (!mergeStderr) return execFileSync(command, args, execution);
  const result = spawnSync(command, args, execution);
  if (result.error || result.status !== 0) throw new Error('Remote log snapshot failed');
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function sshArgs(target, args) {
  validateRemoteTarget(target);
  // OpenSSH joins the command for the remote shell. Every argument is constrained,
  // including format expressions; secrets and manifests travel only on stdin.
  if (args.some(arg => typeof arg !== 'string' || !/^[A-Za-z0-9_./:{}=,@+-]+$/.test(arg))) throw new Error('Unsafe remote Docker argument');
  return [...SSH_OPTIONS, target, `docker ${args.join(' ')}`];
}

function docker(target, args, { run = defaultRun, input, timeout = 30000, signal, mergeStderr = false } = {}) {
  const commandArgs = sshArgs(target, args);
  try { return String(run('ssh', commandArgs, { input, timeout, signal, mergeStderr }) || '').trim(); }
  catch { throw new Error(`Remote Docker ${args[0]} failed; inspect the selected target and retained local metadata`); }
}

function probe(target, options) {
  const platform = docker(target, ['info', '--format', '{{.OSType}}/{{.Architecture}}'], options);
  if (!/^linux\/(amd64|x86_64)$/.test(platform)) throw new Error('Remote MID containers require a Linux amd64 Docker engine');
  docker(target, ['compose', 'version'], options);
  const engineId = docker(target, ['info', '--format', '{{.ID}}'], options);
  if (!engineId) throw new Error('Remote Docker did not report an engine ID');
  return engineId;
}

function save(directory, metadata) {
  fs.writeFileSync(path.join(directory, FILE), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(path.join(directory, FILE), 0o600);
}

function load(directory) {
  const dir = fs.lstatSync(directory);
  const file = fs.lstatSync(path.join(directory, FILE));
  if (!dir.isDirectory() || dir.isSymbolicLink() || !file.isFile() || file.isSymbolicLink() || (dir.mode & 0o077) || (file.mode & 0o077)) throw new Error('Remote MID metadata directory and file must be private and must not be symlinks');
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, FILE), 'utf8'));
  validateRemoteTarget(metadata.target);
  if (metadata.version !== 1 || !/^[a-f0-9-]{36}$/.test(metadata.owner)) throw new Error('Invalid remote MID ownership metadata');
  for (const key of ['project', 'container', 'volume', 'image', ...(metadata.network ? ['network'] : [])]) if (!/^[a-z0-9][a-z0-9_.:-]+$/.test(metadata[key])) throw new Error('Invalid remote MID resource metadata');
  return metadata;
}

function labels(metadata) {
  return { [`${PREFIX}.owner`]: metadata.owner, [`${PREFIX}.instance`]: metadata.instanceURL, [`${PREFIX}.target`]: metadata.target, [`${PREFIX}.name`]: metadata.name };
}

function checkEngine(metadata, options) {
  if (probe(metadata.target, options) !== metadata.engineId) throw new Error('SSH target now selects a different Docker engine; refusing lifecycle operation');
}

function inspect(metadata, kind, resource, options) {
  let value;
  try { value = JSON.parse(docker(metadata.target, [kind, 'inspect', resource], options))[0]; } catch { throw new Error(`Cannot verify owned remote ${kind}; no destructive action taken`); }
  const actual = value?.Config?.Labels || value?.Labels;
  if (!actual || Object.entries(labels(metadata)).some(([key, expected]) => actual[key] !== expected)) throw new Error(`Remote ${kind} ownership mismatch; refusing operation`);
  return value;
}

export function prepareRemoteMidServer({ target, instanceURL, name, directory, platform = process.platform, ...options }) {
  if (platform === 'win32') throw new Error('Remote MID management requires a POSIX controller to enforce private local metadata permissions; Windows Docker hosts remain supported over SSH');
  validateRemoteTarget(target);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name || '')) throw new Error('Invalid MID Server name');
  const url = new URL(instanceURL);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use an HTTPS instance origin without credentials');
  if (fs.existsSync(directory)) throw new Error('Remote MID local directory already exists; refusing to overwrite or adopt');
  const owner = randomUUID();
  const project = `jsn-mid-${owner}`;
  const metadata = { version: 1, target, instanceURL: url.origin, name, owner, project, container: project, image: `${project}:local`, volume: `${project}-export`, network: `${project}-network`, engineId: probe(target, options), state: 'prepared' };
  fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  save(directory, metadata);
  return metadata;
}

export function buildRemoteMidManifest(metadata, { username, password }) {
  if (!username || !password) throw new Error('MID username and password are required');
  const ownership = labels(metadata);
  const literal = value => String(value).replaceAll('$', () => '$$');
  return { services: { mid: { container_name: metadata.container, image: metadata.image, pull_policy: 'never', restart: 'unless-stopped', labels: ownership, environment: { MID_INSTANCE_URL: `${metadata.instanceURL}/`, MID_INSTANCE_USERNAME: literal(username), MID_INSTANCE_PASSWORD: literal(password), MID_SERVER_NAME: literal(metadata.name) }, volumes: [`${metadata.volume}:/opt/snc_mid_server/agent/export`], networks: ['mid'] } }, volumes: { [metadata.volume]: { name: metadata.volume, labels: ownership } }, networks: { mid: { name: metadata.network, labels: ownership } } };
}

function resources(metadata, options) {
  const checks = [ ['container', ['container', 'ls', '-a', '--filter', `name=${metadata.container}`, '--format', '{{.Names}}'], metadata.container], ['volume', ['volume', 'ls', '--filter', `name=${metadata.volume}`, '--format', '{{.Name}}'], metadata.volume], ['image', ['image', 'ls', '--filter', `reference=${metadata.image}`, '--format', '{{.Repository}}:{{.Tag}}'], metadata.image] ];
  if (metadata.network) checks.push(['network', ['network', 'ls', '--filter', `name=${metadata.network}`, '--format', '{{.Name}}'], metadata.network]);
  return checks.filter(([, args, resource]) => docker(metadata.target, args, options).split(/\r?\n/).includes(resource)).map(([kind]) => kind);
}

function absent(metadata, options) {
  if (resources(metadata, options).length) throw new Error('Remote resources already exist; refusing to overwrite or adopt');
}

export function installRemoteMidServer({ directory, context, username, password, ...options }) {
  const metadata = load(directory);
  if (metadata.state !== 'prepared') throw new Error('Install requires a fresh prepared deployment; retained partial deployments must be inspected and removed explicitly');
  if (!Buffer.isBuffer(context) || context.length === 0) throw new Error('An official recipe tar build context is required');
  const manifest = buildRemoteMidManifest(metadata, { username, password });
  checkEngine(metadata, options);
  absent(metadata, options);
  metadata.state = 'building'; save(directory, metadata);
  try {
    const buildLabels = Object.entries(labels(metadata)).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
    docker(metadata.target, ['build', ...buildLabels, '--tag', metadata.image, '-'], { ...options, input: context, timeout: 1200000 });
    inspect(metadata, 'image', metadata.image, options);
    metadata.state = 'deploying'; save(directory, metadata);
    docker(metadata.target, ['compose', '-p', metadata.project, '-f', '-', 'up', '-d'], { ...options, input: JSON.stringify(manifest), timeout: 300000 });
    inspect(metadata, 'container', metadata.container, options);
    inspect(metadata, 'volume', metadata.volume, options);
    inspect(metadata, 'network', metadata.network, options);
    metadata.state = 'running'; save(directory, metadata);
    return metadata;
  } catch (error) { metadata.state = 'uncertain'; save(directory, metadata); throw error; }
}

export function inspectRemoteMidServer({ directory, ...options }) {
  const metadata = load(directory); checkEngine(metadata, options);
  const container = inspect(metadata, 'container', metadata.container, options);
  return { ...metadata, status: container.State?.Status || 'unknown' };
}

function lifecycle(operation, { directory, ...options }) {
  const metadata = load(directory); checkEngine(metadata, options);
  inspect(metadata, 'container', metadata.container, options);
  try { docker(metadata.target, ['container', operation, metadata.container], options); }
  catch (error) { metadata.state = 'uncertain'; save(directory, metadata); throw error; }
  metadata.state = operation === 'start' ? 'running' : 'stopped'; save(directory, metadata);
  return metadata;
}
export const startRemoteMidServer = options => lifecycle('start', options);
export const stopRemoteMidServer = options => lifecycle('stop', options);

export function logsRemoteMidServer({ directory, tail = 100, ...options }) {
  if (!Number.isInteger(tail) || tail < 1 || tail > 10000) throw new Error('Log tail must be between 1 and 10000');
  const metadata = load(directory); checkEngine(metadata, options);
  inspect(metadata, 'container', metadata.container, options);
  return docker(metadata.target, ['container', 'logs', '--tail', String(tail), metadata.container], { ...options, mergeStderr: true });
}

export async function followRemoteMidServer({ directory, tail = 100, spawnImpl = spawn, stdout = process.stdout, stderr = process.stderr, signalSource = process, ...options }) {
  if (!Number.isInteger(tail) || tail < 1 || tail > 10000) throw new Error('Log tail must be between 1 and 10000');
  const metadata = load(directory); checkEngine(metadata, options);
  inspect(metadata, 'container', metadata.container, options);
  const args = sshArgs(metadata.target, ['container', 'logs', '--follow', '--tail', String(tail), metadata.container]);
  return new Promise((resolve, reject) => {
    let child;
    let cancelled = false;
    let timer;
    let settled = false;
    const cleanup = () => {
      signalSource.removeListener('SIGINT', cancel);
      clearTimeout(timer);
      child?.stdout?.unpipe(stdout);
      child?.stderr?.unpipe(stderr);
      child?.removeListener('error', failed);
      child?.removeListener('close', closed);
    };
    const finish = error => {
      if (settled) return;
      settled = true; cleanup();
      if (error) reject(new Error('Remote Docker log viewer failed; the container was not stopped'));
      else resolve({ cancelled });
    };
    const failed = () => finish(true);
    const closed = code => finish(!cancelled && code !== 0);
    const cancel = () => {
      if (cancelled || settled) return;
      cancelled = true;
      child.kill('SIGINT');
      timer = setTimeout(() => { child.kill('SIGKILL'); finish(false); }, 2000);
      timer.unref?.();
    };
    try {
      child = spawnImpl('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      child.on('error', failed);
      child.on('close', closed);
      child.stdout?.pipe(stdout, { end: false });
      child.stderr?.pipe(stderr, { end: false });
      signalSource.on('SIGINT', cancel);
    } catch { finish(true); }
  });
}

export function removeRemoteMidServer({ directory, ...options }) {
  const metadata = load(directory); checkEngine(metadata, options);
  // A partial install may have only an image or volume. Verify every present
  // resource before deleting any, and preserve metadata for retries/diagnosis.
  const present = resources(metadata, options);
  for (const kind of present) inspect(metadata, kind, metadata[kind], options);
  metadata.state = 'removing'; save(directory, metadata);
  try {
    if (present.includes('container')) {
      docker(metadata.target, ['container', 'stop', metadata.container], options);
      docker(metadata.target, ['container', 'rm', metadata.container], options);
    }
    if (present.includes('volume')) docker(metadata.target, ['volume', 'rm', metadata.volume], options);
    if (present.includes('network')) docker(metadata.target, ['network', 'rm', metadata.network], options);
    if (present.includes('image')) docker(metadata.target, ['image', 'rm', metadata.image], options);
  } catch (error) { metadata.state = 'uncertain'; save(directory, metadata); throw error; }
  metadata.state = 'removed'; save(directory, metadata);
  return metadata;
}
