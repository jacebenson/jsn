import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync, spawn } from 'node:child_process';

// Census and termination deliberately share the same exact executable allowlist.
// A successful launcher exit is not proof that its wrapper/Java children exited.
export function ownedDirectProcesses(metadata, processes) {
  const windows = metadata.platform === 'windows';
  const paths = windows ? path.win32 : path.posix;
  const normalize = value => windows ? paths.normalize(value).toLowerCase() : paths.normalize(value);
  const root = normalize(metadata.installDir);
  const binaries = (windows
    ? ['agent/bin/wrapper-windows-x86-64.exe', 'agent/bin/wrapper.exe', 'agent/jre/bin/java.exe']
    : ['agent/bin/wrapper-linux-x86-64', 'agent/bin/wrapper', 'agent/jre/bin/java'])
    .map(value => normalize(paths.join(root, value)));
  if (!Array.isArray(processes)) throw new Error('Unknown MID process census; files retained');
  const owned = [];
  for (const candidate of processes) {
    if (!candidate || typeof candidate !== 'object') throw new Error('Unknown MID process evidence; files retained');
    if (!candidate.executable) {
      if (!candidate.name) throw new Error('Unknown MID process executable; files retained');
      if (/^(?:java(?:\.exe)?|wrapper(?:[-.].*)?)$/i.test(candidate.name || '')) throw new Error('MID process executable is inaccessible; files retained');
      continue;
    }
    if (!paths.isAbsolute(candidate.executable)) throw new Error('Invalid process executable; files retained');
    const executable = normalize(candidate.executable);
    if (!binaries.includes(executable)) {
      if (executable.startsWith(root + paths.sep)) throw new Error('Unknown executable inside MID installation; files retained');
      continue;
    }
    if (!Number.isSafeInteger(candidate.pid) || candidate.pid <= 0 || !candidate.identity) throw new Error('Unknown MID process identity; files retained');
    owned.push({ ...candidate, executable });
  }
  return owned;
}

function windowsCall(script, payload, run = execFileSync) {
  const source = `$ErrorActionPreference='Stop'; try {\n$p=([Console]::In.ReadToEnd() | ConvertFrom-Json)\n${script}\n} catch { [Console]::Error.WriteLine('MID process inspection or stop failed; files retained'); exit 1 }`;
  let result;
  try {
    result = run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
      input: JSON.stringify(payload), encoding: 'utf8', timeout: 45000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(String(result).replace(/^\uFEFF/, '').trim());
  } catch { throw new Error('MID process inspection or stop failed; files retained'); }
}

const WINDOWS_IDENTITY = `function Identity($date) {
  # CIM exposes microseconds, while Process.StartTime may have 100ns precision.
  return $date.ToUniversalTime().ToString('yyyyMMddHHmmssffffff',[Globalization.CultureInfo]::InvariantCulture)
}`;
const WINDOWS_RECORD = `${WINDOWS_IDENTITY}
function Record($v) {
  $identity=$null; if ($v.CreationDate) { $identity=Identity $v.CreationDate }
  return @{pid=[int]$v.ProcessId; executable=$v.ExecutablePath; name=$v.Name; identity=$identity}
}`;

export function directProcessTransport(metadata, run = execFileSync) {
  if (metadata.platform === 'windows') return {
    list: () => windowsCall(`${WINDOWS_RECORD}\n$items=@(Get-CimInstance Win32_Process | ForEach-Object { Record $_ }); ConvertTo-Json -InputObject $items -Compress`, {}, run),
    get: pid => windowsCall(`${WINDOWS_RECORD}\n$v=Get-CimInstance Win32_Process -Filter ('ProcessId=' + [uint32]$p.pid); if ($v) { Record $v | ConvertTo-Json -Compress } else { 'null' }`, { pid }, run),
    terminate: candidate => windowsCall(`${WINDOWS_IDENTITY}
$current=Get-CimInstance Win32_Process -Filter ('ProcessId=' + [uint32]$p.pid)
if (!$current) { 'true'; exit 0 }
if (!$current.ExecutablePath -or [IO.Path]::GetFullPath($current.ExecutablePath) -ne $p.executable -or !$current.CreationDate -or (Identity $current.CreationDate) -ne $p.identity) { throw 'Process identity changed' }
$target=Get-Process -Id $p.pid -ErrorAction Stop
try {
  # Pin a process handle before checking identity again. Kill acts on this handle,
  # not a PID which could have been recycled since the CIM query.
  $null=$target.Handle
  if (!$target.Path -or [IO.Path]::GetFullPath($target.Path) -ne $p.executable -or (Identity $target.StartTime) -ne $p.identity) { throw 'Process handle identity changed' }
  $target.Kill()
  if (!$target.WaitForExit(30000)) { throw 'Owned process did not exit' }
} finally { $target.Dispose() }
 'true'`, candidate, run),
  };
  if (metadata.platform !== 'linux' || process.platform !== 'linux') throw new Error('Unsupported MID process inspection platform');
  return {
    list: () => {
      const items = [];
      for (const entry of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        const directory = `/proc/${entry}`;
        try {
          if (fs.statSync(directory).uid !== process.getuid()) continue;
          const stat = fs.readFileSync(`${directory}/stat`, 'utf8');
          const end = stat.lastIndexOf(')');
          const name = stat.slice(stat.indexOf('(') + 1, end);
          const fields = stat.slice(end + 2).split(' ');
          // Zombies have exited and cannot execute or hold the installation open.
          if (fields[0] === 'Z') continue;
          let executable;
          try { executable = fs.readlinkSync(`${directory}/exe`); }
          catch (error) {
            if (error.code === 'ENOENT') continue;
            if (error.code !== 'EACCES' && error.code !== 'EPERM') throw error;
            // Non-dumpable same-user daemons (systemd/gpg-agent) are normal.
            // Keep their names so an inaccessible Java/wrapper fails closed.
          }
          const after = fs.readFileSync(`${directory}/stat`, 'utf8');
          if (after.slice(after.lastIndexOf(')') + 2).split(' ')[19] !== fields[19]) throw new Error('Process identity changed during census');
          items.push({ pid: Number(entry), executable, name, identity: fields[19] });
        } catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'ESRCH') {
            // Process errors may contain local runtime arguments; do not expose them.
            // eslint-disable-next-line preserve-caught-error
            throw new Error('MID process census failed; files retained');
          }
        }
      }
      return items;
    },
  };
}

export function stopOwnedDirectProcesses(metadata, transport) {
  const candidates = ownedDirectProcesses(metadata, transport.list());
  for (const candidate of candidates) {
    const current = transport.get(candidate.pid);
    if (!current) continue;
    const verified = ownedDirectProcesses(metadata, [current])[0];
    if (!verified || verified.pid !== candidate.pid || verified.executable !== candidate.executable || verified.identity !== candidate.identity) throw new Error('Owned process identity changed; refusing to kill reused PID; files retained');
    if (transport.terminate(verified) !== true) throw new Error('Owned MID process stop was not verified; files retained');
  }
  if (ownedDirectProcesses(metadata, transport.list()).length) throw new Error('Owned MID runtime remains; files retained');
}

// Unlike execFileSync, an async foreground child lets JS receive SIGINT/SIGTERM
// and reconcile its descendants before the CLI exits. No service is registered.
export function runDirectConsole(cwd, { spawnImpl = spawn, signals = process, onInterrupt } = {}) {
  return new Promise((resolve, reject) => {
    let interrupted;
    const child = spawnImpl('cmd.exe', ['/d', '/s', '/c', 'bin\\mid.bat console'], { cwd, stdio: 'inherit' });
    // Windows console Ctrl+C is already delivered to the console process group.
    // Do not child.kill(): Windows implements that as PID-based termination.
    const interrupt = signal => {
      interrupted = signal;
      try { onInterrupt?.(); }
      catch { cleanup(); reject(new Error('Windows MID console stop was not verified; files retained')); }
    };
    const onInt = () => interrupt('SIGINT');
    const onTerm = () => interrupt('SIGTERM');
    signals.on('SIGINT', onInt); signals.on('SIGTERM', onTerm);
    const cleanup = () => { signals.removeListener('SIGINT', onInt); signals.removeListener('SIGTERM', onTerm); };
    child.once('error', () => { cleanup(); reject(new Error('Windows MID console could not start')); });
    child.once('exit', (code, signal) => {
      cleanup();
      if (interrupted || signal === 'SIGINT' || signal === 'SIGTERM') resolve({ interrupted: interrupted || signal });
      else if (code === 0) resolve({});
      else reject(new Error('Windows MID console failed'));
    });
  });
}
