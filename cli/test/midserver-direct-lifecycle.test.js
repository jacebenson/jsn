import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { reconcileDirectInstallation, removeDirectInstallation, runDirectInstallation } from '../src/midserver-direct.js';
import { directProcessTransport, ownedDirectProcesses, stopOwnedDirectProcesses, runDirectConsole } from '../src/midserver-direct-processes.js';

function installation(t, platform = 'windows', state = 'console-running') {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-direct-lifecycle-'));
  t.after(() => fs.rmSync(installDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(installDir, 'agent'));
  const metadata = { owner: 'jsn-mid-direct-v1', name: 'fixture', instanceURL: 'https://example.service-now.com', installDir, platform, runtime: platform === 'windows' ? 'console' : 'user-background', serviceRegistered: false, state };
  fs.writeFileSync(path.join(installDir, '.jsn-mid-direct.json'), JSON.stringify(metadata), { mode: 0o600 });
  fs.writeFileSync(path.join(installDir, 'keep'), 'retained');
  return metadata;
}
const contents = m => fs.readFileSync(path.join(m.installDir, '.jsn-mid-direct.json'), 'utf8');
const owned = (m, pid = 47) => ({ pid, identity: '123456789012345678', name: 'java.exe', executable: path.join(m.installDir, 'agent/jre/bin/java.exe') });
function fixture(initial) {
  let processes = initial;
  const killed = [];
  return {
    list: () => processes,
    get: pid => processes.find(p => p.pid === pid),
    terminate: candidate => { killed.push(candidate); processes = processes.filter(p => p.pid !== candidate.pid); return true; },
    set: value => { processes = value; },
    killed,
  };
}

test('stale Windows console-running metadata reconciles read-only and permits restart/stop/removal', t => {
  const m = installation(t), transport = fixture([]), before = contents(m);
  assert.equal(reconcileDirectInstallation(m, transport).state, 'prepared');
  assert.equal(contents(m), before);
  runDirectInstallation(m, 'start', () => {}, { transport });
  assert.equal(m.state, 'prepared');
  runDirectInstallation(m, 'stop', undefined, { transport });
  removeDirectInstallation(m, undefined, { transport });
  assert.equal(fs.existsSync(m.installDir), false);
});

test('live owned runtime overrides prepared metadata; rejected duplicate start has zero writes', t => {
  const m = installation(t, 'windows', 'prepared'), transport = fixture([owned(m)]), before = contents(m);
  assert.equal(reconcileDirectInstallation(m, transport).state, 'console-running');
  assert.throws(() => runDirectInstallation(m, 'start', () => assert.fail('must not launch'), { transport }), /already started/);
  assert.equal(contents(m), before);
  assert.deepEqual(transport.killed, []);
  removeDirectInstallation(m, undefined, { transport });
  assert.equal(transport.killed.length, 1);
  assert.equal(fs.existsSync(m.installDir), false);
});

test('stop and restart terminate only exact install-root executables, never similar names or prefix roots', t => {
  const m = installation(t);
  const external = [
    { ...owned(m, 48), executable: path.join(m.installDir + '-other', 'agent/jre/bin/java.exe') },
    { ...owned(m, 49), executable: 'C:\\Other\\agent\\bin\\wrapper.exe' },
  ];
  const transport = fixture([owned(m), ...external]);
  runDirectInstallation(m, 'stop', undefined, { transport });
  assert.equal(m.state, 'prepared');
  assert.deepEqual(transport.killed.map(p => p.pid), [47]);
  assert.deepEqual(transport.list(), external);
  runDirectInstallation(m, 'start', () => {}, { transport });
  assert.equal(m.state, 'prepared');
});

test('Windows exact ownership is case-insensitive, but not a suffix or path-prefix match', () => {
  const m = { platform: 'windows', installDir: 'C:\\MID' };
  const p = { pid: 42, identity: 'birth', executable: 'c:\\mid\\AGENT\\BIN\\WRAPPER.EXE' };
  assert.equal(ownedDirectProcesses(m, [p]).length, 1);
  assert.equal(ownedDirectProcesses(m, [{ ...p, executable: 'C:\\MID2\\agent\\bin\\wrapper.exe' }]).length, 0);
  assert.throws(() => ownedDirectProcesses(m, [{ ...p, executable: 'C:\\MID\\agent\\bin\\other.exe' }]), /Unknown executable/);
});

for (const replacement of [
  p => ({ ...p, identity: 'new-birth' }),
  p => ({ ...p, executable: 'C:\\Other\\java.exe' }),
  p => ({ ...p, executable: null }),
  p => ({ ...p, pid: p.pid + 1 }),
]) test('PID identity changes fail closed without a kill, metadata write or deletion', t => {
  const m = installation(t), p = owned(m), before = contents(m);
  const transport = fixture([p]);
  transport.get = () => replacement(p);
  assert.throws(() => removeDirectInstallation(m, undefined, { transport }), /identity|inaccessible/);
  assert.equal(contents(m), before);
  assert.deepEqual(transport.killed, []);
  assert.equal(fs.readFileSync(path.join(m.installDir, 'keep'), 'utf8'), 'retained');
});

for (const kind of ['denied-census', 'denied-stop', 'still-running', 'unknown-path', 'missing-identity']) test(`${kind}: no deletion or metadata writes on rejection`, t => {
  const m = installation(t), p = owned(m), before = contents(m);
  const transport = fixture([p]);
  if (kind === 'denied-census') transport.list = () => { throw new Error('access denied'); };
  if (kind === 'denied-stop') transport.terminate = () => { throw new Error('access denied'); };
  if (kind === 'still-running') transport.terminate = () => true;
  if (kind === 'unknown-path') transport.set([{ ...p, executable: null }]);
  if (kind === 'missing-identity') transport.set([{ ...p, identity: null }]);
  assert.throws(() => removeDirectInstallation(m, undefined, { transport }));
  assert.equal(contents(m), before);
  assert.equal(fs.existsSync(path.join(m.installDir, 'keep')), true);
});

test('a process that exits before identity recheck needs no kill; respawn during stop preserves files', t => {
  const m = installation(t), p = owned(m);
  let calls = 0;
  const transport = { list: () => ++calls === 1 ? [p] : [], get: () => null, terminate: () => assert.fail('already exited') };
  stopOwnedDirectProcesses(m, transport);
  const restarted = fixture([p]);
  restarted.terminate = () => { restarted.set([owned(m, 90)]); return true; };
  assert.throws(() => removeDirectInstallation(m, undefined, { transport: restarted }), /runtime remains/);
  assert.equal(fs.existsSync(m.installDir), true);
});

test('SIGINT/SIGTERM console interruption resolves prepared only after verified exit', async t => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const m = installation(t), transport = fixture([]);
    const result = await runDirectInstallation(m, 'start', undefined, {
      transport, consoleRun: async () => ({ interrupted: signal }),
    });
    assert.equal(result.interrupted, signal);
    assert.equal(JSON.parse(contents(m)).state, 'prepared');
  }
});

test('console exit with a live child or failed census persists uncertain and retains files', async t => {
  for (const unreadable of [false, true]) {
    const m = installation(t), transport = fixture([]);
    await assert.rejects(runDirectInstallation(m, 'start', undefined, {
      transport, consoleRun: async () => {
        if (unreadable) transport.list = () => { throw new Error('denied'); };
        else transport.set([owned(m)]);
        return { interrupted: 'SIGINT' };
      },
    }), /runtime state is uncertain/);
    assert.equal(JSON.parse(contents(m)).state, 'uncertain');
    assert.equal(fs.existsSync(m.installDir), true);
  }
});

for (const change of ['identity', 'executable', 'denied', 'unverified', 'survivor', 'unknown']) {
  test(`Windows failed stop (${change}) never deletes files`, t => {
    const m = installation(t), transport = fixture([owned(m)]), before = contents(m);
    if (change === 'identity') transport.get = () => ({ ...owned(m), identity: 'reused' });
    if (change === 'executable') transport.get = () => ({ ...owned(m), executable: 'C:\\unrelated\\java.exe' });
    if (change === 'denied') transport.terminate = () => { throw new Error('access denied'); };
    if (change === 'unverified') transport.terminate = () => false;
    if (change === 'survivor') transport.terminate = () => true;
    if (change === 'unknown') transport.list = () => [{ name: 'java.exe', pid: 47 }];
    assert.throws(() => removeDirectInstallation(m, undefined, { transport }));
    assert.equal(contents(m), before);
    assert.equal(fs.readFileSync(path.join(m.installDir, 'keep'), 'utf8'), 'retained');
    if (['identity', 'executable', 'unknown'].includes(change)) assert.deepEqual(transport.killed, []);
  });
}

test('census denial rejects start/stop/remove with zero writes', t => {
  const m = installation(t), before = contents(m);
  const transport = { list: () => { throw new Error('access denied'); } };
  for (const action of ['start', 'stop']) assert.throws(() => runDirectInstallation(m, action, () => assert.fail(), { transport }), /access denied/);
  assert.throws(() => removeDirectInstallation(m, undefined, { transport }), /access denied/);
  assert.equal(contents(m), before);
  assert.equal(fs.existsSync(m.installDir), true);
});

test('Linux removal runs native stop then verifies children exited before deleting', { skip: process.platform !== 'linux' }, t => {
  const m = installation(t, 'linux', 'uncertain');
  const candidate = { ...owned(m), name: 'java', executable: path.join(m.installDir, 'agent/jre/bin/java') };
  const transport = fixture([candidate]), calls = [];
  const run = (command, args) => { calls.push([command, args]); transport.set([]); };
  removeDirectInstallation(m, run, { transport });
  assert.deepEqual(calls, [['sh', ['bin/mid.sh', 'stop']]]);
  assert.equal(fs.existsSync(m.installDir), false);
  assert.deepEqual(transport.killed, []);
});

test('Linux failed native stop or surviving child prevents deletion', { skip: process.platform !== 'linux' }, t => {
  for (const fails of [false, true]) {
    const m = installation(t, 'linux', 'started');
    const transport = fixture([{ ...owned(m), name: 'java', executable: path.join(m.installDir, 'agent/jre/bin/java') }]);
    assert.throws(() => removeDirectInstallation(m, () => { if (fails) throw new Error('failed'); }, { transport }));
    assert.equal(fs.existsSync(m.installDir), true);
  }
});

test('foreground signal listeners invoke owned-stop hook, wait for child exit, and are removed', async () => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const signals = new EventEmitter(), child = new EventEmitter();
    let stops = 0, settled = false;
    const result = runDirectConsole('fixture', { signals, spawnImpl: () => child, onInterrupt: () => { stops++; } });
    result.then(() => { settled = true; });
    signals.emit(signal);
    await Promise.resolve();
    assert.equal(stops, 1);
    assert.equal(settled, false);
    child.emit('exit', 1, null);
    assert.deepEqual(await result, { interrupted: signal });
    assert.equal(signals.listenerCount('SIGINT'), 0);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
  }
});

test('Windows transport pins handle and rechecks creation/executable identity; payloads use stdin', () => {
  const calls = [];
  const transport = directProcessTransport({ platform: 'windows' }, (command, args, opts) => {
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    calls.push({ command, script, opts });
    return calls.length === 1 ? '[]' : calls.length === 2 ? 'null' : 'true';
  });
  assert.deepEqual(transport.list(), []);
  assert.equal(transport.get(42), null);
  assert.equal(transport.terminate({ pid: 42, executable: 'C:\\MID\\agent\\bin\\wrapper.exe', identity: 'birth' }), true);
  assert.ok(calls.every(c => c.command === 'powershell.exe' && c.opts.timeout === 45000));
  // Architectural safety invariant: no PID-only termination, even after JS preflight.
  assert.match(calls[2].script, /Identity \$current.CreationDate/);
  assert.match(calls[2].script, /\$null=\$target.Handle[\s\S]*\$target.Path[\s\S]*\$target.StartTime[\s\S]*\$target.Kill\(\)/);
  assert.match(calls[2].script, /WaitForExit\(30000\)/);
  assert.doesNotMatch(calls[2].script, /Stop-Process|taskkill/);
});

test('unknown census and transport failures fail closed', () => {
  const m = { platform: 'windows', installDir: 'C:\\MID' };
  assert.throws(() => ownedDirectProcesses(m, null), /Unknown MID process census/);
  assert.throws(() => directProcessTransport(m, () => 'not-json').list(), /inspection or stop failed/);
  assert.throws(() => directProcessTransport(m, () => { throw new Error('secret'); }).list(), /^Error: MID process inspection or stop failed; files retained$/);
  assert.throws(() => stopOwnedDirectProcesses(m, { list: () => [{ pid: 1, executable: 'C:\\MID\\agent\\bin\\wrapper.exe' }] }), /Unknown MID process identity/);
});


test('linked runtime paths are rejected before census, metadata writes or deletion', { skip: process.platform === 'win32' }, t => {
  const m = installation(t), before = contents(m);
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-direct-unowned-'));
  t.after(() => fs.rmSync(external, { recursive: true, force: true }));
  fs.symlinkSync(external, path.join(m.installDir, 'agent/bin'));
  const transport = { list: () => assert.fail('must reject before census') };
  for (const action of ['start', 'stop']) assert.throws(() => runDirectInstallation(m, action, undefined, { transport }), /linked MID runtime/);
  assert.throws(() => removeDirectInstallation(m, undefined, { transport }), /linked MID runtime/);
  assert.equal(contents(m), before);
  assert.equal(fs.existsSync(m.installDir), true);
});

test('registered service ownership is never adopted by a direct lifecycle operation', t => {
  const m = installation(t), before = contents(m);
  m.serviceRegistered = true;
  assert.throws(() => removeDirectInstallation(m, undefined, { transport: fixture([]) }), /registered service/);
  assert.equal(contents(m), before);
});

test('foreground launch/stop failures reject without leaked signal handlers or PID kills', async () => {
  for (const failure of ['launch', 'stop']) {
    const signals = new EventEmitter(), child = new EventEmitter();
    const result = runDirectConsole('fixture', {
      signals, spawnImpl: () => child,
      onInterrupt: () => { throw new Error('denied'); },
    });
    if (failure === 'launch') child.emit('error', new Error('private arguments'));
    else signals.emit('SIGTERM');
    await assert.rejects(result, /Windows MID console/);
    assert.equal(signals.listenerCount('SIGINT'), 0);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
  }
});
