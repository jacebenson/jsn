import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { prepareWindowsRemoteMidServer, installWindowsRemoteMidServer, removeWindowsRemoteMidServer, startWindowsRemoteMidServer, stopWindowsRemoteMidServer, logsWindowsRemoteMidServer, inspectWindowsRemoteMidServer } from '../src/midserver-windows-remote.js';

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-win-mid-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const directory = path.join(parent, 'deployment'); const calls = [];
  let fail = false;
  const run = (command, args, options) => {
    const bootstrap = Buffer.from(args.at(-1).split(' ').at(-1), 'base64').toString('utf16le');
    const split = options.input.indexOf('\n');
    const script = Buffer.from(options.input.slice(0, split), 'base64').toString('utf8');
    const payload = JSON.parse(options.input.slice(split + 1));
    calls.push({ command, args, options, bootstrap, script, payload });
    if (fail) throw new Error('private password must not leak');
    let result;
    if (script.includes('platform=\'windows-x64\'')) result = { remoteDirectory: `C:\\ProgramData\\jsn-mid\\${payload.owner}`, elevated: true, platform: 'windows-x64' };
    else if (script.includes('serviceRegistered=$true')) result = { serviceRegistered: true, runtimeAccount: 'NT AUTHORITY\\LocalService', archiveSha256: 'a'.repeat(64), startMode: 'Auto' };
    else if (script.includes('removed=$true')) result = { removed: true };
    else if (script.includes('logs=$text')) result = { logs: 'sanitized fixture log' };
    else result = { status: 'Running', runtimeAccount: 'NT AUTHORITY\\LocalService', startMode: 'Auto' };
    return `JSN_RESULT:${JSON.stringify(result)}\r\n`;
  };
  const prepare = () => prepareWindowsRemoteMidServer({ target: 'family-pc', instanceURL: 'https://example.service-now.com', name: 'native-test', directory, run });
  return { directory, calls, run, prepare, setFail: () => { fail = true; } };
}
const posix = { skip: process.platform === 'win32' };

test('Windows SSH preflight uses encoded static script, admin check and no remote writes', posix, t => {
  const f = fixture(t); const m = f.prepare(); const call = f.calls[0];
  assert.deepEqual(call.args.slice(0, -1), ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'RemoteCommand=none', '-o', 'RequestTTY=no', '--', 'family-pc']);
  assert.match(call.args.at(-1), /^powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+$/);
  assert.ok(call.args.at(-1).length < 2000);
  assert.match(call.bootstrap, /ReadLine\(\)/);
  assert.match(call.bootstrap, /ScriptBlock/);
  assert.match(call.script, /ReadToEnd\(\)/);
  assert.ok(!call.script.includes('InputEncoding='));
  assert.match(call.script, /WindowsBuiltInRole\]::Administrator/);
  assert.ok(!call.script.includes('New-Item'));
  assert.equal(m.runtimeAccount, 'NT AUTHORITY\\LocalService');
  assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(f.directory, '.jsn-mid-windows-remote.json')).mode & 0o777, 0o600);
  assert.throws(f.prepare, /already exists/);
});

test('preflight failure leaves no local directory and never returns nested credentials', posix, t => {
  const f = fixture(t); f.setFail();
  assert.throws(f.prepare, error => /operation failed/.test(error.message) && !error.message.includes('password'));
  assert.equal(fs.existsSync(f.directory), false);
});

test('service lifecycle verifies marker, binary path and least privilege account before operations', posix, t => {
  const f = fixture(t); f.prepare();
  assert.equal(startWindowsRemoteMidServer({ directory: f.directory, run: f.run }).state, 'running');
  assert.equal(stopWindowsRemoteMidServer({ directory: f.directory, run: f.run }).state, 'stopped');
  const inspected = inspectWindowsRemoteMidServer({ directory: f.directory, run: f.run });
  assert.equal(inspected.status, 'Running');
  assert.equal(inspected.startMode, 'Auto');
  const call = f.calls[1];
  assert.match(call.script, /Assert-Owned; \$s=Owned-Service/);
  assert.match(call.script, /Service binary ownership mismatch/);
  assert.match(call.script, /Unexpected runtime service account/);
  assert.match(call.script, /WaitForStatus\('Running'/);
  f.setFail();
  assert.throws(() => stopWindowsRemoteMidServer({ directory: f.directory, run: f.run }), /operation failed/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, '.jsn-mid-windows-remote.json'), 'utf8')).state, 'uncertain');
});

test('Windows log tails are bounded and do not return service environment', posix, t => {
  const f = fixture(t); f.prepare();
  assert.equal(logsWindowsRemoteMidServer({ directory: f.directory, tail: 10, run: f.run }), 'sanitized fixture log');
  assert.equal(f.calls.at(-1).payload.tail, 10);
  const filter = f.calls.at(-1).script.match(/Name -match '([^']+)'/)[1];
  const pattern = new RegExp(filter);
  assert.equal(pattern.test('agent0.log.0'), true);
  assert.equal(pattern.test('agent0.log'), true);
  assert.equal(pattern.test('agent0.log.0.lck'), false);
  assert.equal(pattern.test('wrapper.log'), false);
  assert.equal(pattern.test('agent0XlogX0'), false);
  assert.throws(() => logsWindowsRemoteMidServer({ directory: f.directory, tail: 10001, run: f.run }), /tail/);
});

test('Windows controller and unsafe aliases are rejected before transport', t => {
  const f = fixture(t);
  assert.throws(() => prepareWindowsRemoteMidServer({ platform: 'win32', target: 'family-pc', instanceURL: 'https://example.service-now.com', name: 'mid', directory: f.directory, run: f.run }), /POSIX controller/);
  assert.throws(() => prepareWindowsRemoteMidServer({ platform: 'linux', target: 'family-pc;evil', instanceURL: 'https://example.service-now.com', name: 'mid', directory: f.directory, run: f.run }), /SSH alias/);
  assert.equal(f.calls.length, 0);
});


test('Windows install uses official URL, stdin secrets, restricted runtime ACL and vendor contract checks', posix, t => {
  const f = fixture(t); f.prepare();
  const result = installWindowsRemoteMidServer({ directory: f.directory, releaseName: 'australia-02-11-2026__patch7-09-17-2026_10-06-2026_0905', username: 'mid-user', password: 'private<&password', run: f.run });
  assert.equal(result.state, 'installed');
  assert.equal(result.startMode, 'Auto');
  const call = f.calls.at(-1);
  assert.ok(call.payload.archiveURL.startsWith('https://install.service-now.com/'));
  assert.ok(call.payload.archiveURL.endsWith('.windows.x86-64.zip'));
  assert.equal(call.payload.password, 'private<&password');
  assert.ok(call.options.input.length > 10000);
  assert.ok(call.args.at(-1).length < 2000);
  assert.ok(!call.bootstrap.includes('private'));
  assert.ok(!call.script.includes('private<&password'));
  assert.ok(!JSON.stringify(call.args).includes('private'));
  assert.ok(!fs.readFileSync(path.join(f.directory, '.jsn-mid-windows-remote.json'), 'utf8').includes('private'));
  assert.match(call.script, /S-1-5-19/);
  assert.match(call.script, /LocalService/);
  assert.match(call.script, /wrapper.ntservice.starttype=AUTO_START/);
  assert.ok(call.script.includes('wrapper.ntservice.permissions.1.account=NT AUTHORITY\\LocalService'));
  assert.ok(call.script.includes('wrapper.ntservice.permissions.1.allow=START, STOP'));
  assert.ok(call.script.includes('wrapper.ntservice.permissions.1.service=$($p.serviceName)'));
  assert.ok(call.script.includes("if ($s.StartMode -ne 'Auto')"));
  const overridePattern = call.script.match(/\$text=\[regex\]::Replace\(\$text,'([^']+)'/)[1];
  const replaced = 'wrapper.ntservice.starttype=DEMAND_START\nwrapper.ntservice.starttype.extra=keep\n# wrapper.ntservice.starttype=keep'.replace(new RegExp(overridePattern.replace('(?m)', ''), 'gm'), '');
  assert.ok(!replaced.includes('DEMAND_START'));
  assert.ok(replaced.includes('starttype.extra=keep'));
  assert.ok(replaced.includes('# wrapper.ntservice.starttype=keep'));
  assert.match(call.script, /SetAccessRuleProtection\(\$true,\$false\)/);
  assert.match(call.script, /secure','true'/);
  assert.match(call.script, /mid.windows_host.file_permissions.allow_list/);
  assert.match(call.script, /GetAttribute\('value'\).Split/);
  assert.match(call.script, /entries \+ 'S-1-5-19'/);
  assert.ok(call.script.includes('foreach ($key in @($values.Keys))'));
  assert.ok(!call.script.includes('foreach ($key in $values.Keys)'));
  assert.ok(!call.script.includes('file_permissions.enforce=false'));
  assert.match(call.script, /Unsupported vendor service contract/);
  assert.match(call.script, /bin\\mid.bat install/);
  assert.match(call.script, /Archive links forbidden/);
  assert.match(call.script, /Unsupported vendor permission enforcement contract/);
  assert.ok(call.script.indexOf('bin\\mid.bat install') < call.script.indexOf('enforcePerms -folder $agent'));
  assert.match(call.script, /-additionWhiteListedGroups \$values\['mid.windows_host.file_permissions.allow_list'\]/);
  assert.match(call.script, /FileSystemRights\]::FullControl/);
  const domainSave = call.script.indexOf('$previousUserDomain=$env:USERDOMAIN');
  const domainSet = call.script.indexOf('$env:USERDOMAIN=($s.StartName -split');
  const enforce = call.script.indexOf('enforcePerms -folder $agent');
  const domainRestore = call.script.indexOf('finally { $env:USERDOMAIN=$previousUserDomain }');
  assert.ok(domainSave < domainSet && domainSet < enforce && enforce < domainRestore);
  assert.ok(call.script.includes('unmodified vendor module compute the hash'));
  assert.ok(!call.script.includes('5b311f9827e6a221'));
  assert.ok(!call.script.includes('Set-Content -LiteralPath $WHITELIST_HASH_FILE'));
  assert.match(call.script, /fileperm.aclsave/);
  assert.match(call.script, /fileperm.grphash/);
  assert.ok(!call.script.includes('Start-Service'));
  assert.throws(() => installWindowsRemoteMidServer({ directory: f.directory, releaseName: 'bad', username: 'u', password: 'p', run: f.run }), /fresh prepared/);
});

test('cached ZIP requires inspected hash before writes; removal stops before vendor unregister and cleanup', posix, t => {
  const f = fixture(t); f.prepare(); const count = f.calls.length;
  const credentials = { directory: f.directory, releaseName: 'test-10-06-2026', username: 'u', password: 'p', run: f.run };
  assert.throws(() => installWindowsRemoteMidServer({ ...credentials, archivePath: 'C:\\cache.zip' }), /SHA256/);
  assert.equal(f.calls.length, count);
  installWindowsRemoteMidServer({ ...credentials, archivePath: 'C:\\cache.zip', archiveSha256: 'a'.repeat(64), startMode: 'Auto' });
  assert.equal(removeWindowsRemoteMidServer({ directory: f.directory, run: f.run }).state, 'removed');
  const script = f.calls.at(-1).script;
  assert.ok(script.indexOf('Stop-Service') < script.indexOf('bin\\mid.bat remove'));
  assert.ok(script.indexOf('Service still registered') < script.indexOf('Remove-Item -LiteralPath $p.remoteDirectory'));
  assert.match(script, /ReparsePoint/);
  assert.match(script, /catch \[UnauthorizedAccessException\]/);
  assert.ok(script.indexOf('Service still registered') < script.indexOf('& takeown.exe'));
  assert.ok(script.indexOf('remainingLinks.Count') < script.indexOf('& takeown.exe'));
  assert.ok(script.indexOf('Service still registered') < script.indexOf('$candidates=@'));
  assert.ok(script.indexOf('if ($links.Count)') < script.indexOf('$candidates=@'));
  assert.ok(script.indexOf('$process.WaitForExit(30000)') < script.indexOf('function Remove-OwnedFiles'));
  assert.ok(script.includes('$current.CreationDate -ne $candidate.CreationDate'));
  assert.ok(script.includes('[IO.Path]::GetFullPath($process.Path) -ne [IO.Path]::GetFullPath($current.ExecutablePath)'));
  assert.ok(script.includes('agent\\bin\\wrapper-windows-x86-64.exe'));
  assert.ok(script.includes('agent\\jre\\bin\\java.exe'));
  assert.ok(!script.includes('Stop-Process -Name'));
  assert.ok(!script.includes('taskkill'));
  assert.ok(script.includes('& takeown.exe /F $p.remoteDirectory /R /D Y'));
  assert.ok(script.includes('& icacls.exe $p.remoteDirectory /grant $grant /T /C'));
  assert.ok(script.includes("$_.Name -ne '.jsn-owner.json'"));
  assert.ok(script.includes("if ($LASTEXITCODE -ne 0) { throw 'Scoped ownership recovery failed"));
  assert.ok(script.includes("if ($LASTEXITCODE -ne 0) { throw 'Scoped controller ACL recovery failed"));
  assert.ok(fs.existsSync(path.join(f.directory, '.jsn-mid-windows-remote.json')));
});

test('Windows install and removal failures retain uncertain state without credential-bearing errors', posix, t => {
  const f = fixture(t); f.prepare(); f.setFail();
  assert.throws(() => installWindowsRemoteMidServer({ directory: f.directory, releaseName: 'test-10-06-2026', username: 'u', password: 'private', run: f.run }), error => !error.message.includes('password'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, '.jsn-mid-windows-remote.json'), 'utf8')).state, 'uncertain');
  assert.throws(() => removeWindowsRemoteMidServer({ directory: f.directory, run: f.run }), /operation failed/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, '.jsn-mid-windows-remote.json'), 'utf8')).state, 'uncertain');
});


test('phase diagnostics expose only known static stages and discard exception contents', posix, t => {
  const f = fixture(t); f.prepare();
  const run = () => {
    const failure = new Error('password secret in exception');
    failure.stderr = Buffer.from('private credential details\nJSN_PHASE_FAILED:vendor-contract\nprivate exception detail');
    throw failure;
  };
  assert.throws(() => installWindowsRemoteMidServer({ directory: f.directory, releaseName: 'test-10-06-2026', username: 'u', password: 'p', run }), error => error.phase === 'vendor-contract' && error.message.includes('during vendor-contract') && !error.message.includes('secret') && !error.message.includes('private'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, '.jsn-mid-windows-remote.json'), 'utf8')).failedPhase, 'vendor-contract');
  const unknown = () => { const error = new Error('secret'); error.stderr = 'JSN_PHASE_FAILED:credential-secret'; throw error; };
  assert.throws(() => inspectWindowsRemoteMidServer({ directory: f.directory, run: unknown }), error => !error.phase && !error.message.includes('secret'));
});


test('Windows install refuses success when service automatic startup was not verified', posix, t => {
  const f = fixture(t); f.prepare();
  const run = (command, args, options) => {
    const output = f.run(command, args, options);
    return output.replace('"startMode":"Auto"', '"startMode":"Manual"');
  };
  assert.throws(() => installWindowsRemoteMidServer({ directory: f.directory, releaseName: 'test-10-06-2026', username: 'u', password: 'p', run }), /automatic startup was not verified/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, '.jsn-mid-windows-remote.json'), 'utf8')).state, 'uncertain');
});


test('scoped teardown ACL recovery failure preserves local ownership metadata and static diagnosis', posix, t => {
  const f = fixture(t); f.prepare();
  const run = () => { const error = new Error('private raw exception'); error.stderr = 'JSN_PHASE_FAILED:recover-file-acl'; throw error; };
  assert.throws(() => removeWindowsRemoteMidServer({ directory: f.directory, run }), error => error.phase === 'recover-file-acl' && !error.message.includes('private'));
  const m = JSON.parse(fs.readFileSync(path.join(f.directory, '.jsn-mid-windows-remote.json'), 'utf8'));
  assert.equal(m.state, 'uncertain'); assert.equal(m.failedPhase, 'recover-file-acl');
});
