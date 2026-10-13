import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { midInstallDirectory, normalizeMidName, defaultRun, validateMidCredentials } from './midserver-install.js';
import { extractMidZip, inspectMidZip } from './midserver-zip.js';

const METADATA = '.jsn-mid-direct.json';
const MAX_ARCHIVE = 1024 * 1024 * 1024;

export function detectDirectPlatform(platform = process.platform, arch = process.arch) {
  if (!['linux', 'win32'].includes(platform)) throw new Error('Direct MID installs require Linux and Windows');
  if (arch !== 'x64') throw new Error('Direct MID ZIP installs require x86-64');
  return platform === 'win32' ? 'windows' : 'linux';
}

export function buildMidZipUrl(releaseName, platform = process.platform) {
  const native = detectDirectPlatform(platform, 'x64');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(releaseName)) throw new Error('Invalid MID release name');
  const match = [...releaseName.matchAll(/(\d{4})-(\d{2})-(\d{2})|(\d{2})-(\d{2})-(\d{4})/g)].at(-1);
  if (!match) throw new Error('MID release name has no build date');
  const year = match[1] || match[6], month = match[2] || match[4], day = match[3] || match[5];
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== `${year}-${month}-${day}`) throw new Error('Invalid MID build date');
  return `https://install.service-now.com/glide/distribution/builds/package/app-signed/mid/${year}/${month}/${day}/mid.${releaseName}.${native}.x86-64.zip`;
}

function powershell(script, directory) {
  return execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(`$ErrorActionPreference='Stop'; try {\n${script}\n} catch { exit 1 }`, 'utf16le').toString('base64')], {
    env: { ...process.env, JSN_MID_DIRECTORY: directory }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// No chmod substitute on Windows: protect the DACL before any credential is written.
function protectDirectory(directory, platform) {
  if (platform === 'linux') { fs.chmodSync(directory, 0o700); return; }
  powershell(`$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $env:JSN_MID_DIRECTORY -AclObject $acl
$actual=Get-Acl -LiteralPath $env:JSN_MID_DIRECTORY
if (!$actual.AreAccessRulesProtected) { throw 'MID directory ACL is not protected' }
foreach($r in $actual.Access) { if($r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $r.AccessControlType -ne 'Allow') { throw 'Unexpected MID directory access rule' } }`, directory);
  assertPrivateWindows(directory);
}

function assertPrivateWindows(directory) {
  powershell(`$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=Get-Acl -LiteralPath $env:JSN_MID_DIRECTORY
if (!$acl.AreAccessRulesProtected -or @($acl.Access).Count -ne 1) { throw 'MID directory ACL must be private' }
$r=@($acl.Access)[0]
if ($r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $r.AccessControlType -ne 'Allow' -or $r.FileSystemRights -ne 'FullControl') { throw 'Unexpected MID directory access rule' }`, directory);
}

function checkParents(directory, platform) {
  let current = path.dirname(directory);
  while (true) {
    if (fs.existsSync(current)) {
      const st = fs.lstatSync(current);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('Installation ancestors must be real directories');
      if (platform === 'linux' && (st.mode & 0o022) && !(st.mode & 0o1000)) throw new Error('Installation ancestor is writable by other users');
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export async function downloadMidZip(url, archive, fetchImpl = fetch, onProgress) {
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(600000) });
  if (!response.ok || !response.body) throw new Error(`MID ZIP download failed (HTTP ${response.status})`);
  const length = Number(response.headers.get('content-length'));
  if (length > MAX_ARCHIVE) throw new Error('MID ZIP exceeds 1 GiB download limit');
  onProgress?.({ phase: 'download', received: 0, total: Number.isFinite(length) ? length : 0 });
  const fd = fs.openSync(archive, 'wx', 0o600);
  let size = 0;
  let reported = 0;
  const step = Math.max(4 * 1024 * 1024, Math.floor((Number.isFinite(length) ? length : MAX_ARCHIVE) / 100));
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_ARCHIVE) throw new Error('MID ZIP exceeds 1 GiB download limit');
      fs.writeSync(fd, chunk);
      if (onProgress && size - reported >= step) {
        reported = size;
        onProgress({ phase: 'download', received: size, total: Number.isFinite(length) ? length : 0 });
      }
    }
    if (length && size !== length) throw new Error('Incomplete MID ZIP download');
    onProgress?.({ phase: 'download', received: size, total: size, done: true });
  } finally { fs.closeSync(fd); }
}

function xmlEscape(value) {
  if ([...String(value)].some(char => char.codePointAt(0) < 32 && !['\t', '\n', '\r'].includes(char))) throw new Error('Invalid XML configuration character');
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll("'", '&apos;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\r', '&#13;').replaceAll('\n', '&#10;').replaceAll('\t', '&#9;');
}

export function configureMidXml(template, values) {
  // Work only on active parameter elements, never examples in template comments.
  const comments = [];
  let xml = template.replace(/<!--[\s\S]*?-->/g, comment => `<!--JSN_COMMENT_${comments.push(comment) - 1}-->`);
  for (const [name, value] of Object.entries(values)) {
    let found = 0;
    xml = xml.replace(/<parameter\b[^>]*\/>/g, tag => {
      if (!tag.match(/\bname\s*=\s*(["'])(.*?)\1/) || tag.match(/\bname\s*=\s*(["'])(.*?)\1/)[2] !== name) return tag;
      found++;
      const attribute = `value="${xmlEscape(value)}"`;
      return /\bvalue\s*=/.test(tag) ? tag.replace(/\bvalue\s*=\s*(["'])[\s\S]*?\1/, attribute) : tag.replace(/\/>$/, ` ${attribute}/>`);
    });
    if (found > 1) throw new Error(`Duplicate MID configuration field ${name}`);
    if (!found) {
      if (!xml.includes('</parameters>')) throw new Error('Unrecognized vendor config.xml template');
      xml = xml.replace('</parameters>', `  <parameter name="${name}" value="${xmlEscape(value)}"/>\n</parameters>`);
    }
  }
  return xml.replace(/<!--JSN_COMMENT_(\d+)-->/g, (_, index) => comments[index]);
}

function nativeToken(origin, name, directory) {
  return `jsn_mid_${createHash('sha256').update(`${origin}/${name}/${directory}`).digest('hex').slice(0, 20)}`;
}

function refuseNativeService(token) {
  for (const filename of [`/etc/systemd/system/${token}.service`, `/run/systemd/system/${token}.service`, `/usr/lib/systemd/system/${token}.service`, `/etc/init/${token}.conf`, `/etc/init.d/${token}`, `/etc/rc.d/init.d/${token}`]) {
    try { fs.lstatSync(filename); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error('A native service already uses this MID identity; refusing to operate on it');
  }
}

function save(metadata) {
  fs.writeFileSync(path.join(metadata.installDir, METADATA), JSON.stringify(metadata, null, 2), { mode: 0o600 });
}

export function readDirectInstallation(instanceURL, name, directory) {
  const installDir = path.resolve(directory || midInstallDirectory(instanceURL, name));
  try { fs.lstatSync(path.join(installDir, METADATA)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  checkParents(installDir, process.platform === 'linux' ? 'linux' : 'windows');
  const root = fs.lstatSync(installDir);
  if (!root.isDirectory() || root.isSymbolicLink() || (process.platform === 'linux' && ((root.mode & 0o077) || root.uid !== process.getuid()))) throw new Error('Refusing an untrusted installation directory');
  if (process.platform === 'win32') assertPrivateWindows(installDir);
  const metaPath = path.join(installDir, METADATA);
  const st = fs.lstatSync(metaPath);
  if (!st.isFile() || st.isSymbolicLink() || (process.platform === 'linux' && ((st.mode & 0o077) || st.uid !== process.getuid()))) throw new Error('Untrusted MID installation metadata');
  const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  if (metadata.owner !== 'jsn-mid-direct-v1' || metadata.installDir !== installDir || metadata.instanceURL !== new URL(instanceURL).origin || metadata.name !== normalizeMidName(name) || metadata.platform !== detectDirectPlatform()) throw new Error('MID installation ownership does not match');
  if (fs.lstatSync(path.join(installDir, 'agent')).isSymbolicLink()) throw new Error('Refusing symlink agent');
  return metadata;
}

function uncertainState(metadata) {
  return `MID '${metadata.name}' runtime state is uncertain after an interrupted lifecycle command. Confirm no vendor MID process from ${metadata.installDir} is running, then rerun; installed files are kept.`;
}

export function runDirectInstallation(metadata, action, run = defaultRun) {
  const cwd = path.join(metadata.installDir, 'agent');
  if (!['start', 'stop'].includes(action)) throw new Error('Unsupported MID runtime action');
  if (metadata.state === 'uncertain') throw new Error(uncertainState(metadata));
  if (metadata.runtime !== 'user-background') {
    // Windows console runtime: never register a service, never guess at a state.
    if (action === 'stop') {
      throw new Error(metadata.state === 'console-running' ? 'Windows console MID: stop with Ctrl+C in its owning terminal before removal' : 'Windows console MID is not running');
    }
    if (metadata.state !== 'prepared') throw new Error('MID is already started; stop it before starting again');
    metadata.state = 'console-running'; save(metadata);
    try { run('cmd.exe', ['/d', '/s', '/c', 'bin\\mid.bat console'], { cwd }); }
    catch { throw new Error('Windows MID console failed or was interrupted; runtime state is uncertain. Stop in its owning terminal; files retained.'); }
    metadata.state = 'prepared'; save(metadata);
    return metadata;
  }
  // Never guess at a state an interrupted Linux command left behind; make it explicit.
  if (['starting', 'stopping', 'console-running'].includes(metadata.state)) {
    metadata.state = 'uncertain'; save(metadata);
    throw new Error(uncertainState(metadata));
  }
  // Call the native user-owned launcher, never install/register a system service.
  if (process.getuid?.() === 0) throw new Error('Run native MID lifecycle commands as a non-root user');
  refuseNativeService(nativeToken(metadata.instanceURL, metadata.name, metadata.installDir));
  if (action === 'start' && metadata.state !== 'prepared') throw new Error('MID is already started; stop it before starting again');
  if (action === 'stop' && metadata.state !== 'started') throw new Error('MID is not running');
  metadata.state = action === 'start' ? 'starting' : 'stopping'; save(metadata);
  try { run('sh', ['bin/mid.sh', action], { cwd, stdio: 'ignore' }); }
  catch { throw new Error(`MID ${action} failed; installation retained at ${metadata.installDir}. Inspect local logs.`); }
  metadata.state = action === 'start' ? 'started' : 'prepared'; save(metadata);
  return metadata;
}

export function removeDirectInstallation(metadata, run = defaultRun) {
  if (metadata.state === 'uncertain') throw new Error(`Refusing to remove '${metadata.name}': runtime state is uncertain. Inspect ${metadata.installDir} and stop any vendor MID process first.`);
  if (metadata.state !== 'prepared') runDirectInstallation(metadata, 'stop', run);
  fs.rmSync(metadata.installDir, { recursive: true });
}

export async function installDirectMidServer({ instanceURL, username, password, name, directory, releaseName: suppliedRelease,
  runNow = false, platform = process.platform, arch = process.arch, fetchImpl = fetch, download = downloadMidZip, onProgress,
  protect = protectDirectory, run = defaultRun }) {
  const native = detectDirectPlatform(platform, arch);
  if (native === 'linux' && process.getuid?.() === 0) throw new Error('Run direct MID installation as a non-root user');
  if (native === 'windows' && runNow) throw new Error('Prepare Windows first, then start its console in an owning terminal; no implicit service registration');
  const shortName = normalizeMidName(name);
  const origin = new URL(instanceURL).origin;
  if (!origin.startsWith('https://')) throw new Error('MID credentials require an HTTPS instance');
  const installDir = path.resolve(directory || midInstallDirectory(origin, shortName));
  checkParents(installDir, native);
  if (native === 'linux') refuseNativeService(nativeToken(origin, shortName, installDir));
  if (fs.existsSync(installDir)) throw new Error(`Refusing to overwrite existing installation: ${installDir}`);
  const releaseName = suppliedRelease || (await validateMidCredentials(origin, username, password, fetchImpl)).releaseName;
  const archiveURL = buildMidZipUrl(releaseName, platform);
  // Validate all credential fields before creating files or downloading.
  for (const value of [origin, username, password, shortName]) xmlEscape(value);
  if (!username || !password) throw new Error('MID credentials are required');
  let ancestor = path.dirname(installDir);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const disk = fs.statfsSync(ancestor);
  if (disk.bavail * disk.bsize < 3 * MAX_ARCHIVE) throw new Error('Direct MID installation requires at least 3 GiB free disk space');
  fs.mkdirSync(path.dirname(installDir), { recursive: true, mode: 0o700 });
  fs.mkdirSync(installDir, { mode: 0o700 }); // atomic collision refusal
  const archive = path.join(installDir, '.download.zip');
  let prepared = false;
  try {
    protect(installDir, native);
    onProgress?.({ phase: 'download-start', archiveURL, platform: native, installDir, name: shortName });
    await download(archiveURL, archive, fetchImpl, onProgress);
    const entries = inspectMidZip(archive);
    onProgress?.({ phase: 'extract-start', entries: entries.length, installDir });
    await extractMidZip(archive, installDir, entries);
    onProgress?.({ phase: 'extract-done', entries: entries.length, installDir });
    const agent = path.join(installDir, 'agent');
    for (const filename of ['config.xml', 'conf/wrapper-override.conf', native === 'linux' ? 'bin/mid.sh' : 'bin/mid.bat']) {
      if (!fs.statSync(path.join(agent, filename)).isFile()) throw new Error(`Vendor ZIP missing ${filename}`);
    }
    const config = path.join(agent, 'config.xml');
    fs.writeFileSync(config, configureMidXml(fs.readFileSync(config, 'utf8'), {
      url: `${origin}/`, 'mid.instance.username': username, 'mid.instance.password': password, name: shortName,
    }), { mode: 0o600 });
    const token = nativeToken(origin, shortName, installDir);
    const override = path.join(agent, 'conf/wrapper-override.conf');
    let text = fs.readFileSync(override, 'utf8').replace(/^wrapper\.(name|displayname)=.*\r?$/gm, '');
    text += `\nwrapper.name=${token}\nwrapper.displayname=ServiceNow MID ${shortName}\n`;
    fs.writeFileSync(override, text, { mode: 0o600 });
    if (native === 'linux') {
      fs.appendFileSync(path.join(agent, 'bin/mid.shconf_override'), `\nAPP_NAME="${token}"\nAPP_LONG_NAME="ServiceNow MID ${shortName}"\nSERVICE_MANAGEMENT_TOOL=initd\n`);
    }
    fs.rmSync(archive);
    const metadata = { owner: 'jsn-mid-direct-v1', instanceURL: origin, name: shortName, releaseName, installDir, archiveURL, platform: native, runtime: native === 'linux' ? 'user-background' : 'console', state: 'prepared', serviceRegistered: false };
    save(metadata);
    prepared = true;
    if (runNow) runDirectInstallation(metadata, 'start', run);
    return metadata;
  } catch (error) {
    if (!prepared) fs.rmSync(installDir, { recursive: true, force: true });
    // Do not expose nested process/fetch errors that could include credential-bearing content.
    if (prepared) throw error;
    // Do not retain raw causes, which can contain credentials.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`Direct MID preparation failed; owned files cleaned up (${error.code || 'preparation error'}). Check ZIP, disk, permissions and vendor layout.`);
  }
}
