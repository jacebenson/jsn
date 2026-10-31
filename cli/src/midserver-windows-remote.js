import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validateRemoteTarget } from './midserver-remote.js';
import { buildMidZipUrl } from './midserver-direct.js';

const FILE = '.jsn-mid-windows-remote.json';
const SSH = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'RemoteCommand=none', '-o', 'RequestTTY=no', '--'];
const PHASES = new Set(['initialization', 'validate', 'reserve-directory', 'protect-directory', 'download', 'verify-archive', 'inspect-archive', 'extract', 'vendor-contract', 'configure', 'register-service', 'verify-service', 'enforce-permissions', 'remove-files', 'recover-file-acl', 'stop-owned-processes']);
const HEADER = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $phase='initialization';
trap { [Console]::Error.WriteLine(('JSN_PHASE_FAILED:' + $phase)); exit 1 }
$p=([Console]::In.ReadToEnd() | ConvertFrom-Json)
function Result($v) { [Console]::Out.WriteLine(('JSN_RESULT:' + ($v | ConvertTo-Json -Compress -Depth 8))) }
function Assert-Admin { if ($env:OS -ne 'Windows_NT') { throw 'Windows required' }; $i=[Security.Principal.WindowsIdentity]::GetCurrent(); $principal=New-Object Security.Principal.WindowsPrincipal($i); if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Elevated service installation rights required' } }
function Assert-Owned {
  Assert-Admin
  if (!(Test-Path -LiteralPath $p.remoteDirectory -PathType Container)) { throw 'Owned directory missing' }
  $item=Get-Item -LiteralPath $p.remoteDirectory
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point forbidden' }
  $marker=Get-Content -Raw -LiteralPath (Join-Path $p.remoteDirectory '.jsn-owner.json') | ConvertFrom-Json
  if ($marker.owner -ne $p.owner -or $marker.serviceName -ne $p.serviceName -or $marker.instanceURL -ne $p.instanceURL -or $marker.name -ne $p.name) { throw 'Ownership mismatch' }
}
function Owned-Service {
  $s=Get-CimInstance Win32_Service -Filter ('Name="' + $p.serviceName + '"')
  if ($s) {
    $expected=[IO.Path]::GetFullPath((Join-Path $p.remoteDirectory 'agent\\bin\\wrapper-windows-x86-64.exe'))
    $command=[regex]::Match($s.PathName,'^\\s*(?:"([^"\\r\\n]+)"|(.+?\\.exe))(?:\\s|$)',[Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (!$command.Success) { throw 'Service binary ownership mismatch' }
    $binary=$command.Groups[1].Value; if (!$binary) { $binary=$command.Groups[2].Value }
    if ([IO.Path]::GetFullPath($binary) -ne $expected) { throw 'Service binary ownership mismatch' }
    if ($s.StartName -ne 'NT AUTHORITY\\LocalService' -and $s.StartName -ne 'LocalService') { throw 'Unexpected runtime service account' }
  }
  return $s
}
`;

function remote(target, script, payload, { run = execFileSync, timeout = 30000 } = {}) {
  validateRemoteTarget(target);
  const bootstrap = `$ErrorActionPreference='Stop'; try { [Console]::InputEncoding=New-Object Text.UTF8Encoding($false); [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); $source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine())); & ([ScriptBlock]::Create($source)) } catch { [Console]::Error.WriteLine('Remote MID bootstrap failed'); exit 1 }`;
  const encoded = Buffer.from(bootstrap, 'utf16le').toString('base64');
  const input = `${Buffer.from(HEADER + script, 'utf8').toString('base64')}\n${JSON.stringify(payload)}`;
  let output;
  try { output = String(run('ssh', [...SSH, target, `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`], { input, timeout, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })); }
  catch (error) {
    const candidate = String(error.stderr || '').split(/\r?\n/).findLast(line => /^JSN_PHASE_FAILED:[a-z-]+$/.test(line));
    const phase = candidate?.slice('JSN_PHASE_FAILED:'.length);
    const failure = new Error(`Remote Windows MID operation failed${PHASES.has(phase) ? ` during ${phase}` : ''}; inspect retained ownership metadata and service status`);
    if (PHASES.has(phase)) failure.phase = phase;
    throw failure;
  }
  const line = output.split(/\r?\n/).findLast(value => value.startsWith('JSN_RESULT:'));
  if (!line) throw new Error('Remote Windows MID returned no verified result');
  try { return JSON.parse(line.slice('JSN_RESULT:'.length)); } catch { throw new Error('Invalid remote Windows MID result'); }
}

function save(directory, metadata) {
  fs.writeFileSync(path.join(directory, FILE), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(path.join(directory, FILE), 0o600);
}
function load(directory) {
  const dir = fs.lstatSync(directory); const file = fs.lstatSync(path.join(directory, FILE));
  if (!dir.isDirectory() || dir.isSymbolicLink() || !file.isFile() || file.isSymbolicLink() || (dir.mode & 0o077) || (file.mode & 0o077)) throw new Error('Windows MID local metadata must be private');
  const m = JSON.parse(fs.readFileSync(path.join(directory, FILE), 'utf8'));
  validateRemoteTarget(m.target);
  if (m.version !== 1 || !/^[a-f0-9-]{36}$/.test(m.owner) || m.serviceName !== `jsn-mid-${m.owner}` || !/^[A-Z]:\\[A-Za-z0-9 _.-]+(?:\\[A-Za-z0-9 _.-]+)*$/i.test(m.remoteDirectory) || !m.remoteDirectory.endsWith(`\\${m.owner}`)) throw new Error('Invalid Windows MID ownership metadata');
  return m;
}

export function prepareWindowsRemoteMidServer({ target, instanceURL, name, directory, platform = process.platform, ...options }) {
  if (platform === 'win32') throw new Error('A POSIX controller is required for private local metadata');
  validateRemoteTarget(target);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name || '')) throw new Error('Invalid MID name');
  const url = new URL(instanceURL);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use an HTTPS instance origin');
  if (fs.existsSync(directory)) throw new Error('Local deployment directory already exists; no adoption or overwrite');
  const owner = randomUUID(); const serviceName = `jsn-mid-${owner}`;
  const probe = remote(target, `Assert-Admin
if ([Environment]::Is64BitOperatingSystem -ne $true) { throw 'x64 Windows required' }
$base=Join-Path $env:ProgramData 'jsn-mid'
$remoteDirectory=Join-Path $base $p.owner
if (Test-Path -LiteralPath $remoteDirectory) { throw 'Deployment directory exists' }
if (Get-Service -Name $p.serviceName -ErrorAction SilentlyContinue) { throw 'Service already exists' }
Result @{remoteDirectory=$remoteDirectory; elevated=$true; platform='windows-x64'}`, { owner, serviceName }, options);
  if (!probe.elevated || probe.platform !== 'windows-x64' || !probe.remoteDirectory?.endsWith(`\\${owner}`)) throw new Error('Windows preflight failed');
  const metadata = { version: 1, target, owner, serviceName, instanceURL: url.origin, name, remoteDirectory: probe.remoteDirectory, state: 'prepared', runtimeAccount: 'NT AUTHORITY\\LocalService' };
  fs.mkdirSync(directory, { mode: 0o700 }); fs.chmodSync(directory, 0o700); save(directory, metadata);
  return metadata;
}

const INSTALL = String.raw`$phase='validate'; Assert-Admin
if (Get-Service -Name $p.serviceName -ErrorAction SilentlyContinue) { throw 'Service already exists; no adoption' }
if (Test-Path -LiteralPath $p.remoteDirectory) { throw 'Directory already exists; no adoption' }
$phase='reserve-directory'
$parent=Split-Path -Parent $p.remoteDirectory
if (!(Test-Path -LiteralPath $parent)) { $null=New-Item -ItemType Directory -Path $parent }
$ancestor=Get-Item -LiteralPath $parent
while ($ancestor) { if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse ancestor forbidden' }; $ancestor=$ancestor.Parent }
$null=New-Item -ItemType Directory -Path $p.remoteDirectory
$phase='protect-directory'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
foreach ($id in @($sid.Value,'S-1-5-18','S-1-5-32-544') | Select-Object -Unique) {
  $who=New-Object Security.Principal.SecurityIdentifier($id)
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($who,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
}
$localService=New-Object Security.Principal.SecurityIdentifier('S-1-5-19')
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($localService,'Modify','ContainerInherit,ObjectInherit','None','Allow')))
Set-Acl -LiteralPath $p.remoteDirectory -AclObject $acl
$actual=Get-Acl -LiteralPath $p.remoteDirectory
if (!$actual.AreAccessRulesProtected) { throw 'ACL protection failed' }
$allowed=@($sid.Value,'S-1-5-18','S-1-5-32-544','S-1-5-19')
foreach ($r in $actual.Access) { if ($r.AccessControlType -ne 'Allow' -or $r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed) { throw 'Unexpected ACL rule' } }
$marker=@{owner=$p.owner;serviceName=$p.serviceName;instanceURL=$p.instanceURL;name=$p.name}
$marker | ConvertTo-Json -Compress | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $p.remoteDirectory '.jsn-owner.json')
$phase='download'
$archive=Join-Path $p.remoteDirectory '.download.zip'
if ($p.archivePath) { Copy-Item -LiteralPath $p.archivePath -Destination $archive } else { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri $p.archiveURL -OutFile $archive -TimeoutSec 600 }
$phase='verify-archive'
if ((Get-Item -LiteralPath $archive).Length -gt 1GB) { throw 'Archive too large' }
$archiveHash=(Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash
if ($p.archiveSha256 -and $archiveHash -ne $p.archiveSha256) { throw 'Archive hash mismatch' }
$phase='inspect-archive'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead($archive)
try {
  if ($zip.Entries.Count -gt 20000) { throw 'Too many archive entries' }
  $total=0; $seen=@{}
  foreach ($entry in $zip.Entries) {
    $entryName=$entry.FullName
    if ($entryName.Contains('\') -or $entryName.StartsWith('/') -or $entryName.Contains(':')) { throw 'Unsafe archive path' }
    $parts=$entryName.TrimEnd('/').Split('/')
    if ($parts[0] -notin @('agent','META-INF')) { throw 'Unexpected archive root' }
    foreach ($part in $parts) { if (!$part -or $part -eq '.' -or $part -eq '..' -or $part -match '[<>"|?*\x00-\x1f]' -or $part -match '[. ]$' -or $part -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)') { throw 'Unsafe archive entry' } }
    $key=$entryName.TrimEnd('/').ToLowerInvariant(); if ($seen.ContainsKey($key)) { throw 'Duplicate archive entry' }; $seen[$key]=$true
    $mode=($entry.ExternalAttributes -shr 16) -band 0xF000
    if ($mode -ne 0 -and $mode -ne 0x8000 -and $mode -ne 0x4000) { throw 'Archive links forbidden' }
    $total+=$entry.Length; if ($total -gt 2GB) { throw 'Expanded archive too large' }
  }
} finally { $zip.Dispose() }
$phase='extract'
Expand-Archive -LiteralPath $archive -DestinationPath $p.remoteDirectory
Remove-Item -LiteralPath $archive
$phase='vendor-contract'
$agent=Join-Path $p.remoteDirectory 'agent'
foreach ($relative in @('config.xml','conf\wrapper.conf','conf\wrapper-override.conf','bin\mid.bat','bin\wrapper-windows-x86-64.exe','jre\bin\java.exe')) { if (!(Test-Path -LiteralPath (Join-Path $agent $relative) -PathType Leaf)) { throw 'Unsupported vendor ZIP layout' } }
$batch=Get-Content -Raw -LiteralPath (Join-Path $agent 'bin\mid.bat')
$wrapper=Get-Content -Raw -LiteralPath (Join-Path $agent 'conf\wrapper.conf')
if ($batch -notmatch '\[install\]' -or $batch -notmatch '\[remove\]' -or $batch -notmatch '(?m)^\s*%_WRAPPER_EXE% -i ' -or $batch -notmatch '(?m)^\s*%_WRAPPER_EXE% -r ' -or $wrapper -notmatch '(?m)^wrapper.java.command=jre/bin/java' -or $wrapper -notmatch '(?m)^#include ../conf/wrapper-override.conf') { throw 'Unsupported vendor service contract' }
$modules=@(Get-ChildItem -LiteralPath $agent -Filter 'EnforceFilePermissions.psm1' -File -Recurse)
if ($modules.Count -ne 1 -or (Get-Content -Raw -LiteralPath $modules[0].FullName) -notmatch 'function\s+enforcePerms\s*\{') { throw 'Unsupported vendor permission enforcement contract' }
$phase='configure'
$config=Join-Path $agent 'config.xml'
$xml=New-Object Xml.XmlDocument; $xml.XmlResolver=$null; $xml.PreserveWhitespace=$true; $xml.Load($config)
if ($xml.DocumentElement.Name -ne 'parameters') { throw 'Unsupported configuration XML root' }
$values=@{url=($p.instanceURL+'/');'mid.instance.username'=$p.username;'mid.instance.password'=$p.password;name=$p.name;'mid.windows_host.file_permissions.allow_list'='S-1-5-19'}
foreach ($key in @($values.Keys)) {
  $nodes=@($xml.SelectNodes('/parameters/parameter') | Where-Object { $_.GetAttribute('name') -eq $key })
  if ($nodes.Count -gt 1) { throw 'Duplicate configuration parameter' }
  if ($nodes.Count -eq 0) { $node=$xml.CreateElement('parameter'); $node.SetAttribute('name',$key); $null=$xml.DocumentElement.AppendChild($node) } else { $node=$nodes[0] }
  if ($key -eq 'mid.windows_host.file_permissions.allow_list') {
    $entries=@($node.GetAttribute('value').Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $values[$key]=(@($entries + 'S-1-5-19') | Select-Object -Unique) -join ','
  }
  $node.SetAttribute('value',[string]$values[$key])
  if ($key -eq 'mid.instance.password' -and !$node.HasAttribute('secure')) { $node.SetAttribute('secure','true') }
}
$xml.Save($config)
$override=Join-Path $agent 'conf\wrapper-override.conf'
$text=Get-Content -Raw -LiteralPath $override
$text=[regex]::Replace($text,'(?m)^wrapper\.(?:name|displayname|ntservice\.(?:account|account\.prompt|password|password\.prompt|starttype|permissions\.1\.(?:account|allow|service)))=.*\r?$','')
$text+="
wrapper.name=$($p.serviceName)
wrapper.displayname=ServiceNow MID $($p.serviceName)
wrapper.ntservice.account=NT AUTHORITY\LocalService
wrapper.ntservice.password=
wrapper.ntservice.account.prompt=FALSE
wrapper.ntservice.password.prompt=FALSE
wrapper.ntservice.starttype=AUTO_START
wrapper.ntservice.permissions.1.account=NT AUTHORITY\LocalService
wrapper.ntservice.permissions.1.allow=START, STOP
wrapper.ntservice.permissions.1.service=$($p.serviceName)
"
[IO.File]::WriteAllText($override,$text,(New-Object Text.UTF8Encoding($false)))
$phase='register-service'
Push-Location $agent
try { & cmd.exe /d /s /c 'bin\mid.bat install' 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Vendor install failed' } } finally { Pop-Location }
$phase='verify-service'
Assert-Owned; $s=Owned-Service; if (!$s) { throw 'Service registration missing' }
if ($s.StartMode -ne 'Auto') { throw 'Service automatic startup was not configured' }
$phase='enforce-permissions'
Import-Module -Name $modules[0].FullName -Force -ErrorAction Stop
$enforce=Get-Command -Name enforcePerms -CommandType Function -ErrorAction Stop
if ($enforce.Module.Path -ne $modules[0].FullName) { throw 'Wrong enforcement module' }
# The vendor allow-list includes a second service principal when USERDOMAIN
# resolves it. Match the LocalService runtime context so its saved list/hash is
# identical on startup; let the unmodified vendor module compute the hash.
$previousUserDomain=$env:USERDOMAIN
try {
  $env:USERDOMAIN=($s.StartName -split '\\',2)[0]
  enforcePerms -folder $agent -serviceName $p.serviceName -debug $false -additionWhiteListedGroups $values['mid.windows_host.file_permissions.allow_list'] | Out-Null
} finally { $env:USERDOMAIN=$previousUserDomain }
$serviceRules=@((Get-Acl -LiteralPath $agent).Access | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-19' -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl })
if (!$serviceRules.Count) { throw 'Runtime account lacks enforced permissions' }
foreach ($receipt in @('fileperm.aclsave','fileperm.grphash')) { if (!(Test-Path -LiteralPath (Join-Path (Join-Path $agent 'etc') $receipt) -PathType Leaf)) { throw 'Vendor enforcement receipt missing' } }
Result @{status=$s.State;runtimeAccount=$s.StartName;serviceRegistered=$true;archiveSha256=$archiveHash;startMode=$s.StartMode}
`;

export function installWindowsRemoteMidServer({ directory, releaseName, username, password, archivePath, archiveSha256, ...options }) {
  const m = load(directory);
  if (m.state !== 'prepared') throw new Error('Install requires a fresh prepared deployment');
  if (!username || !password || [...String(username) + String(password)].some(char => char.codePointAt(0) < 32 && !['\t', '\n', '\r'].includes(char))) throw new Error('Valid MID credentials are required');
  const archiveURL = buildMidZipUrl(releaseName, 'win32');
  if (archiveSha256 && !/^[a-f0-9]{64}$/i.test(archiveSha256)) throw new Error('Invalid archive SHA256');
  if (archivePath && (!archiveSha256 || !/^[A-Z]:\\[A-Za-z0-9 _.-]+(?:\\[A-Za-z0-9 _.-]+)*$/i.test(archivePath))) throw new Error('Cached remote archive requires an absolute safe path and inspected SHA256');
  m.state = 'installing'; m.releaseName = releaseName; save(directory, m);
  try {
    const result = remote(m.target, INSTALL, { ...m, archiveURL, username, password, archivePath, archiveSha256 }, { ...options, timeout: 1200000 });
    if (!result.serviceRegistered || !['NT AUTHORITY\\LocalService', 'LocalService'].includes(result.runtimeAccount)) throw new Error('Service installation was not verified under LocalService');
    if (result.startMode !== 'Auto') throw new Error('Service automatic startup was not verified');
    if (!/^[a-f0-9]{64}$/i.test(result.archiveSha256 || '')) throw new Error('Archive hash verification result missing');
    m.startMode = result.startMode; m.archiveSha256 = result.archiveSha256.toLowerCase(); m.state = 'installed'; save(directory, m); return m;
  } catch (error) { m.state = 'uncertain'; if (error.phase) m.failedPhase = error.phase; save(directory, m); throw error; }
}

export function removeWindowsRemoteMidServer({ directory, ...options }) {
  const m = load(directory);
  m.state = 'removing'; save(directory, m);
  try {
    remote(m.target, String.raw`Assert-Owned; $s=Owned-Service
if ($s) {
  Stop-Service -Name $p.serviceName -ErrorAction Stop
  (Get-Service -Name $p.serviceName).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(60))
  $null=Owned-Service
  $agent=Join-Path $p.remoteDirectory 'agent'
  Push-Location $agent
  try { & cmd.exe /d /s /c 'bin\mid.bat remove' 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Vendor removal failed' } } finally { Pop-Location }
  $deadline=(Get-Date).AddSeconds(30)
  while (Get-Service -Name $p.serviceName -ErrorAction SilentlyContinue) { if ((Get-Date) -gt $deadline) { throw 'Service still registered' }; Start-Sleep -Milliseconds 500 }
}
Assert-Owned
$links=@(Get-ChildItem -LiteralPath $p.remoteDirectory -Force -Recurse | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
if ($links.Count) { throw 'Refusing recursive cleanup through reparse points' }
$phase='stop-owned-processes'
if (Get-Service -Name $p.serviceName -ErrorAction SilentlyContinue) { throw 'Service still registered; refusing process cleanup' }
$ownedBinaries=@('agent\bin\wrapper-windows-x86-64.exe','agent\bin\wrapper.exe','agent\jre\bin\java.exe') | ForEach-Object { [IO.Path]::GetFullPath((Join-Path $p.remoteDirectory $_)) }
$candidates=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -in $ownedBinaries })
foreach ($candidate in $candidates) {
  $current=Get-CimInstance Win32_Process -Filter ('ProcessId=' + [uint32]$candidate.ProcessId)
  if (!$current) { continue }
  if (!$current.ExecutablePath -or [IO.Path]::GetFullPath($current.ExecutablePath) -notin $ownedBinaries -or $current.ExecutablePath -ne $candidate.ExecutablePath -or $current.CreationDate -ne $candidate.CreationDate) { throw 'Owned process identity changed; refusing to kill reused PID' }
  $process=Get-Process -Id $current.ProcessId -ErrorAction Stop
  try {
    $null=$process.Handle
    if (!$process.Path -or [IO.Path]::GetFullPath($process.Path) -ne [IO.Path]::GetFullPath($current.ExecutablePath)) { throw 'Process executable changed' }
    $process.Kill()
    if (!$process.WaitForExit(30000)) { throw 'Owned process did not exit' }
  } finally { $process.Dispose() }
}
$remaining=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -in $ownedBinaries })
if ($remaining.Count) { throw 'Owned runtime process remains; files retained' }
function Remove-OwnedFiles {
  # Keep the owner receipt until all other children are gone, allowing a failed
  # teardown to be safely retried without adopting an unmarked directory.
  Get-ChildItem -LiteralPath $p.remoteDirectory -Force | Where-Object { $_.Name -ne '.jsn-owner.json' } | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop }
  $receipt=Join-Path $p.remoteDirectory '.jsn-owner.json'
  if (Test-Path -LiteralPath $receipt) { Remove-Item -LiteralPath $receipt -Force -ErrorAction Stop }
  Remove-Item -LiteralPath $p.remoteDirectory -Force -ErrorAction Stop
}
$phase='remove-files'
try { Remove-OwnedFiles } catch [UnauthorizedAccessException] {
  $phase='recover-file-acl'
  # Service absence and the full tree scan were verified above. Do not expand
  # recovery to any parent, sibling, global policy or unowned service.
  if (Get-Service -Name $p.serviceName -ErrorAction SilentlyContinue) { throw 'Service reappeared; refusing ACL recovery' }
  $remainingLinks=@(Get-ChildItem -LiteralPath $p.remoteDirectory -Force -Recurse | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
  if ($remainingLinks.Count) { throw 'Refusing ACL recovery through reparse points' }
  & takeown.exe /F $p.remoteDirectory /R /D Y 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Scoped ownership recovery failed; localized takeown prompts may require manual recovery' }
  $controllerSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $grant='*' + $controllerSid + ':(OI)(CI)F'
  & icacls.exe $p.remoteDirectory /grant $grant /T /C 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Scoped controller ACL recovery failed' }
  $phase='remove-files'
  Remove-OwnedFiles
}
if (Test-Path -LiteralPath $p.remoteDirectory) { throw 'Owned directory remains' }
Result @{removed=$true}`, m, { ...options, timeout: 180000 });
    m.state = 'removed'; save(directory, m); return m;
  } catch (error) { m.state = 'uncertain'; if (error.phase) m.failedPhase = error.phase; save(directory, m); throw error; }
}

export function inspectWindowsRemoteMidServer({ directory, ...options }) {
  const m = load(directory);
  return { ...m, ...remote(m.target, `Assert-Owned; $s=Owned-Service; if (!$s) { throw 'Service missing' }; Result @{status=$s.State; runtimeAccount=$s.StartName; startMode=$s.StartMode}`, m, options) };
}

function lifecycle(operation, { directory, ...options }) {
  const m = load(directory);
  try {
    remote(m.target, `Assert-Owned; $s=Owned-Service; if (!$s) { throw 'Service missing' }; ${operation}-Service -Name $p.serviceName -ErrorAction Stop
(Get-Service -Name $p.serviceName).WaitForStatus('${operation === 'Start' ? 'Running' : 'Stopped'}',[TimeSpan]::FromSeconds(60))
Result @{status='${operation === 'Start' ? 'Running' : 'Stopped'}'}`, m, { ...options, timeout: 90000 });
    m.state = operation === 'Start' ? 'running' : 'stopped'; save(directory, m); return m;
  } catch (error) { m.state = 'uncertain'; if (error.phase) m.failedPhase = error.phase; save(directory, m); throw error; }
}
export const startWindowsRemoteMidServer = options => lifecycle('Start', options);
export const stopWindowsRemoteMidServer = options => lifecycle('Stop', options);

export function logsWindowsRemoteMidServer({ directory, tail = 100, ...options }) {
  if (!Number.isInteger(tail) || tail < 1 || tail > 10000) throw new Error('Log tail must be between 1 and 10000');
  const m = load(directory);
  return remote(m.target, `Assert-Owned; $null=Owned-Service
$logs=@(Get-ChildItem -LiteralPath (Join-Path $p.remoteDirectory 'agent\\logs') -File | Where-Object { $_.Name -match '^agent.*\\.log(?:\\.[0-9]+)?$' } | Sort-Object LastWriteTime -Descending)
$text=''; if ($logs.Count -gt 0) { $text=(Get-Content -LiteralPath $logs[0].FullName -Tail $p.tail) -join [Environment]::NewLine }; Result @{logs=$text}`, { ...m, tail }, options).logs;
}
