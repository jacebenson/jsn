import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareLinuxRemoteMidServer, installLinuxRemoteMidServer, inspectLinuxRemoteMidServer,
  startLinuxRemoteMidServer, stopLinuxRemoteMidServer, logsLinuxRemoteMidServer, removeLinuxRemoteMidServer } from '../src/midserver-linux-remote.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-linux-remote-'));
  fs.chmodSync(root, 0o700); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'local');
  return { root, directory };
}
function fake(t) {
  const f = fixture(t); const calls = [];
  const run = (command, args, options) => {
    const p = JSON.parse(options.input); calls.push({ command, args, options, p });
    let response = { status: 'stopped', pids: [] };
    if (p.action === 'prepare') response = { remoteDirectory: `/home/test/.jsn-mid/${p.owner}`, platform: 'linux-x64', requiresElevation: false, elevated: false, freeBytes: 4 * 1024 ** 3 };
    if (p.action === 'install') response = { installed: true, archiveSha256: 'a'.repeat(64) };
    if (p.action === 'start') response = { status: 'running', pids: [42] };
    if (p.action === 'remove') response = { removed: true };
    if (p.action === 'logs') response = { logs: 'bounded log' };
    return `SSH banner\nJSN_RESULT:${JSON.stringify(response)}\n`;
  };
  prepareLinuxRemoteMidServer({ target: 'fixture-host', instanceURL: 'https://fixture.service-now.com', name: 'native1', directory: f.directory, run });
  return { ...f, run, calls };
}

test('native Linux API reports privileges and sends credentials only through SSH stdin', t => {
  const f = fake(t);
  const m = installLinuxRemoteMidServer({ directory: f.directory, releaseName: 'glide-australia-01-01-2026', username: 'private-user', password: 'secret-value', run: f.run });
  assert.equal(m.state, 'installed');
  assert.equal(m.requiresElevation, false);
  assert.equal(m.archiveSha256, 'a'.repeat(64));
  const call = f.calls.at(-1);
  assert.equal(call.command, 'ssh');
  assert.ok(call.p.archiveURL.endsWith('.linux.x86-64.zip'));
  assert.ok(call.options.input.includes('secret-value'));
  assert.ok(!call.args.join(' ').includes('secret-value'));
  assert.ok(!fs.readFileSync(path.join(f.directory, '.jsn-mid-linux-remote.json'), 'utf8').includes('secret-value'));
  assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
  assert.equal(startLinuxRemoteMidServer({ directory: f.directory, run: f.run }).status, 'running');
  assert.equal(stopLinuxRemoteMidServer({ directory: f.directory, run: f.run }).status, 'stopped');
  assert.equal(inspectLinuxRemoteMidServer({ directory: f.directory, run: f.run }).status, 'stopped');
  assert.equal(logsLinuxRemoteMidServer({ directory: f.directory, run: f.run }), 'bounded log');
  assert.equal(removeLinuxRemoteMidServer({ directory: f.directory, run: f.run }).state, 'removed');
});

test('native Linux fails closed on public metadata, ambiguous responses and credential-bearing SSH errors', t => {
  const f = fake(t);
  fs.chmodSync(path.join(f.directory, '.jsn-mid-linux-remote.json'), 0o644);
  assert.throws(() => inspectLinuxRemoteMidServer({ directory: f.directory, run: f.run }), /private/);
  fs.chmodSync(path.join(f.directory, '.jsn-mid-linux-remote.json'), 0o600);
  assert.throws(() => inspectLinuxRemoteMidServer({ directory: f.directory, run: () => 'invalid' }), /verified result/);
  assert.throws(() => installLinuxRemoteMidServer({ directory: f.directory, releaseName: 'glide-australia-01-01-2026', username: 'user', password: 'private-secret', run: () => { throw new Error('private-secret'); } }), error => !error.message.includes('private-secret'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, '.jsn-mid-linux-remote.json'))).state, 'uncertain');
  assert.throws(() => logsLinuxRemoteMidServer({ directory: f.directory, tail: 10001 }), /1–10000/);
});

test('static native runner executes read-only Linux preflight without creating remote paths', { skip: process.platform !== 'linux' || process.getuid?.() === 0 }, t => {
  const f = fixture(t); const home = path.join(f.root, 'home'); fs.mkdirSync(home, { mode: 0o700 });
  const run = (_command, args, options) => {
    const encoded = args.at(-1).match(/b64decode\("([A-Za-z0-9+/=]+)"\)/)[1];
    return execFileSync('python3', ['-c', Buffer.from(encoded, 'base64').toString()], { input: options.input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HOME: home } });
  };
  const m = prepareLinuxRemoteMidServer({ target: 'fixture-host', instanceURL: 'https://fixture.service-now.com', name: 'native1', directory: f.directory, run });
  assert.equal(m.elevated, false); assert.equal(m.platform, 'linux-x64');
  assert.ok(!fs.existsSync(path.join(home, '.jsn-mid')));
  const remoteDir = m.remoteDirectory; fs.mkdirSync(remoteDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(remoteDir, '.jsn-owner.json'), JSON.stringify({ owner: 'someone-else' }), { mode: 0o600 });
  assert.throws(() => inspectLinuxRemoteMidServer({ directory: f.directory, run }), /operation failed/);
  assert.ok(fs.existsSync(remoteDir));
});


test('static runner extracts a bounded vendor fixture, protects config, reads logs and removes only owned files', { skip: process.platform !== 'linux' || process.getuid?.() === 0 }, t => {
  const f = fixture(t), home = path.join(f.root, 'home'), archive = path.join(f.root, 'vendor.zip');
  fs.mkdirSync(home, { mode: 0o755 });
  execFileSync('python3', ['-c', `import zipfile,sys
with zipfile.ZipFile(sys.argv[1],'w') as z:
 z.writestr('agent/config.xml','<parameters/>')
 z.writestr('agent/conf/wrapper.conf','wrapper.java.command=jre/bin/java\\n#include ../conf/wrapper-override.conf')
 z.writestr('agent/conf/wrapper-override.conf','')
 z.writestr('agent/bin/mid.sh', 'SERVICE_MANAGEMENT_TOOL=initd\\ncase "$1" in\\nstart) nohup bin/wrapper-linux-x86-64 120 >/dev/null 2>&1 </dev/null & echo $! > fixture.pid ;;\\nstop) kill "$(cat fixture.pid)" ;;\\nesac\\n')
 z.write('/bin/sleep','agent/bin/wrapper-linux-x86-64')
 z.writestr('agent/jre/bin/java','fixture java')
 z.writestr('agent/logs/agent0.log','first\\nlast\\n')
`, archive]);
  const run = (_command, args, options) => {
    const source = Buffer.from(args.at(-1).match(/b64decode\("([A-Za-z0-9+/=]+)"\)/)[1], 'base64').toString();
    const prelude = `import urllib.request,types\nurllib.request.build_opener=lambda *a:types.SimpleNamespace(open=lambda *a,**k:open(${JSON.stringify(archive)},'rb'))\n`;
    return execFileSync('python3', ['-c', prelude + source], { input: options.input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HOME: home } });
  };
  const m = prepareLinuxRemoteMidServer({ target: 'fixture-host', instanceURL: 'https://fixture.service-now.com', name: 'native1', directory: f.directory, run });
  installLinuxRemoteMidServer({ directory: f.directory, releaseName: 'glide-australia-01-01-2026', username: 'u', password: 'p&<', run });
  const config = path.join(m.remoteDirectory, 'agent/config.xml');
  assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(config, 'utf8'), /p&amp;&lt;/);
  assert.equal(inspectLinuxRemoteMidServer({ directory: f.directory, run }).status, 'stopped');
  assert.equal(startLinuxRemoteMidServer({ directory: f.directory, run }).status, 'running');
  assert.throws(() => removeLinuxRemoteMidServer({ directory: f.directory, run }), /operation failed/);
  assert.equal(stopLinuxRemoteMidServer({ directory: f.directory, run }).status, 'stopped');
  assert.equal(logsLinuxRemoteMidServer({ directory: f.directory, tail: 1, run }), 'last');
  assert.equal(removeLinuxRemoteMidServer({ directory: f.directory, run }).removed, true);
  assert.ok(!fs.existsSync(m.remoteDirectory));
  assert.ok(fs.existsSync(archive));
});

test('native extraction rejects traversal and symlink ZIP entries before writing payload files', { skip: process.platform !== 'linux' || process.getuid?.() === 0 }, t => {
  for (const kind of ['traversal', 'symlink']) {
    const f = fixture(t), home = path.join(f.root, 'home'), archive = path.join(f.root, 'unsafe.zip');
    fs.mkdirSync(home, { mode: 0o700 });
    execFileSync('python3', ['-c', `import zipfile,sys,stat
with zipfile.ZipFile(sys.argv[1],'w') as z:
 e=zipfile.ZipInfo('agent/../../escape' if sys.argv[2]=='traversal' else 'agent/link')
 e.create_system=3
 e.external_attr=(stat.S_IFLNK|0o777)<<16 if sys.argv[2]=='symlink' else (stat.S_IFREG|0o600)<<16
 z.writestr(e,'outside')
`, archive, kind]);
    const run = (_command, args, options) => {
      const source = Buffer.from(args.at(-1).match(/b64decode\("([A-Za-z0-9+/=]+)"\)/)[1], 'base64').toString();
      return execFileSync('python3', ['-c', `import urllib.request,types\nurllib.request.build_opener=lambda *a:types.SimpleNamespace(open=lambda *a,**k:open(${JSON.stringify(archive)},'rb'))\n` + source], { input: options.input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HOME: home } });
    };
    const m = prepareLinuxRemoteMidServer({ target: 'fixture-host', instanceURL: 'https://fixture.service-now.com', name: 'native1', directory: f.directory, run });
    assert.throws(() => installLinuxRemoteMidServer({ directory: f.directory, releaseName: 'glide-australia-01-01-2026', username: 'u', password: 'secret', run }), /operation failed/);
    assert.ok(!fs.existsSync(path.join(home, 'escape')));
    assert.ok(!fs.existsSync(path.join(m.remoteDirectory, 'agent')));
    assert.equal(removeLinuxRemoteMidServer({ directory: f.directory, run }).removed, true);
  }
});
