import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { prepareRemoteMidServer, installRemoteMidServer, startRemoteMidServer, stopRemoteMidServer, logsRemoteMidServer, removeRemoteMidServer, followRemoteMidServer, validateRemoteTarget } from '../src/midserver-remote.js';

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-remote-test-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const directory = path.join(parent, 'mid');
  const calls = [];
  const present = new Set();
  let metadata;
  let engine = 'engine-one';
  let fail;
  let foreign = false;
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    const remote = args.at(-1);
    if (fail && remote.includes(fail)) throw new Error('secret password must never appear in wrapped errors');
    if (remote === 'docker info --format {{.OSType}}/{{.Architecture}}') return 'linux/x86_64\n';
    if (remote === 'docker info --format {{.ID}}') return engine;
    if (remote === 'docker compose version') return 'Docker Compose version v5.6.1';
    for (const kind of ['container', 'volume', 'image', 'network']) {
      if (remote.startsWith(`docker ${kind} ls `)) return present.has(kind) ? `${metadata[kind]}\n` : '';
      if (remote.startsWith(`docker ${kind} inspect `)) {
        const labels = { 'io.jsn.mid.owner': foreign ? 'another-owner' : metadata.owner, 'io.jsn.mid.instance': metadata.instanceURL, 'io.jsn.mid.target': metadata.target, 'io.jsn.mid.name': metadata.name };
        return JSON.stringify([{ Config: { Labels: labels }, Labels: labels, State: { Status: 'running' } }]);
      }
      if (remote.startsWith(`docker ${kind} rm `)) present.delete(kind);
    }
    if (remote.startsWith('docker build ')) present.add('image');
    if (remote.startsWith('docker compose -p ')) { present.add('container'); present.add('volume'); present.add('network'); }
    if (remote.startsWith('docker container logs ')) return 'bounded log line';
    return '';
  };
  const prepare = () => {
    metadata = prepareRemoteMidServer({ target: 'family-pc', instanceURL: 'https://example.service-now.com', name: 'test-mid', directory, run });
    return metadata;
  };
  const install = () => installRemoteMidServer({ directory, context: Buffer.from('official tar fixture'), username: 'mid-user', password: 'private$literal\nsecret', run });
  return { directory, calls, present, run, prepare, install, setEngine: value => { engine = value; }, setFail: value => { fail = value; }, setForeign: value => { foreign = value; } };
}

test('remote target rejects shell injection and ssh options', () => {
  for (const value of ['-oProxyCommand=evil', 'host;touch', 'host user', 'user@host', 'host\n', 'host$(id)', '']) assert.throws(() => validateRemoteTarget(value));
  assert.equal(validateRemoteTarget('elite-2'), 'elite-2');
});

test('prepare uses noninteractive cross-platform SSH override and private new metadata', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); const metadata = f.prepare();
  assert.deepEqual(f.calls[0].args.slice(0, -1), ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'RemoteCommand=none', '-o', 'RequestTTY=no', '--', 'family-pc']);
  assert.equal(metadata.engineId, 'engine-one');
  assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(f.directory, '.jsn-mid-remote.json')).mode & 0o777, 0o600);
  assert.throws(f.prepare, /already exists/);
});

test('install streams official tar and literal secret manifest only through stdin', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); f.prepare(); const result = f.install();
  assert.equal(result.state, 'running');
  const build = f.calls.find(call => call.args.at(-1).startsWith('docker build '));
  assert.ok(Buffer.isBuffer(build.options.input));
  assert.match(build.args.at(-1), /--label io.jsn.mid.owner=/);
  const deploy = f.calls.find(call => call.args.at(-1).startsWith('docker compose -p '));
  const manifest = JSON.parse(deploy.options.input);
  assert.equal(manifest.services.mid.environment.MID_INSTANCE_PASSWORD, 'private$$literal\nsecret');
  assert.equal(manifest.services.mid.volumes.length, 1);
  assert.deepEqual(manifest.services.mid.networks, ['mid']);
  assert.equal(manifest.networks.mid.name, result.network);
  assert.equal(manifest.networks.mid.labels['io.jsn.mid.owner'], result.owner);
  assert.ok(!manifest.services.mid.volumes[0].startsWith('/'));
  assert.ok(!JSON.stringify(f.calls.map(call => call.args)).includes('private'));
  assert.ok(!fs.readFileSync(path.join(f.directory, '.jsn-mid-remote.json'), 'utf8').includes('private'));
  assert.deepEqual(fs.readdirSync(f.directory), ['.jsn-mid-remote.json']);
});

test('start stop and bounded logs verify ownership; changed engine prevents actions', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); f.prepare(); f.install();
  assert.equal(stopRemoteMidServer({ directory: f.directory, run: f.run }).state, 'stopped');
  assert.equal(startRemoteMidServer({ directory: f.directory, run: f.run }).state, 'running');
  assert.equal(logsRemoteMidServer({ directory: f.directory, tail: 20, run: f.run }), 'bounded log line');
  assert.throws(() => logsRemoteMidServer({ directory: f.directory, tail: 10001, run: f.run }), /tail/);
  f.setEngine('different');
  const count = f.calls.length;
  assert.throws(() => stopRemoteMidServer({ directory: f.directory, run: f.run }), /different Docker engine/);
  assert.ok(!f.calls.slice(count).some(call => call.args.at(-1).startsWith('docker container stop ')));
});

test('foreign labels refuse all removal and stop failure blocks deletion', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); f.prepare(); f.install(); f.setForeign(true);
  assert.throws(() => removeRemoteMidServer({ directory: f.directory, run: f.run }), /ownership mismatch/);
  assert.ok(!f.calls.some(call => /docker (container|volume|image) rm /.test(call.args.at(-1))));
  f.setForeign(false); f.setFail('container stop');
  assert.throws(() => removeRemoteMidServer({ directory: f.directory, run: f.run }), /Remote Docker container failed/);
  assert.ok(!f.calls.some(call => /docker (container|volume|image) rm /.test(call.args.at(-1))));
});

test('partial build failure retains diagnosis metadata and permits only owned partial cleanup', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); f.prepare(); f.setFail('compose -p');
  assert.throws(f.install, error => !error.message.includes('password'));
  const metadata = JSON.parse(fs.readFileSync(path.join(f.directory, '.jsn-mid-remote.json'), 'utf8'));
  assert.equal(metadata.state, 'uncertain');
  assert.throws(f.install, /fresh prepared/);
  f.setFail(undefined);
  assert.equal(removeRemoteMidServer({ directory: f.directory, run: f.run }).state, 'removed');
  assert.equal(f.present.size, 0);
  assert.ok(!f.calls.some(call => call.args.at(-1).startsWith('docker container stop ')));
  assert.ok(fs.existsSync(path.join(f.directory, '.jsn-mid-remote.json')));
});

test('resource collisions and permissive metadata permissions fail before provisioning', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); f.prepare(); f.present.add('volume');
  assert.throws(f.install, /refusing to overwrite or adopt/);
  assert.ok(!f.calls.some(call => call.args.at(-1).startsWith('docker build ')));
  fs.chmodSync(path.join(f.directory, '.jsn-mid-remote.json'), 0o644);
  assert.throws(f.install, /must be private/);
});

test('non-linux engine is rejected without reserving a directory', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  assert.throws(() => prepareRemoteMidServer({ target: 'elite-2', instanceURL: 'https://example.service-now.com', name: 'mid', directory: f.directory, run: () => 'windows/amd64' }), /Linux amd64/);
  assert.ok(!fs.existsSync(f.directory));
});


test('snapshot logs request stderr merging without exposing inspect output', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); f.prepare(); f.install();
  logsRemoteMidServer({ directory: f.directory, run: f.run });
  const call = f.calls.at(-1);
  assert.equal(call.options.mergeStderr, true);
  assert.match(call.args.at(-1), /^docker container logs /);
});

function viewer() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.killedWith = [];
  child.kill = signal => { child.killedWith.push(signal); queueMicrotask(() => child.emit('close', null, signal)); return true; };
  return child;
}

test('follow streams both channels and SIGINT cancels only SSH viewer with clean listeners', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t); f.prepare(); f.install();
  const child = viewer(); const signals = new EventEmitter();
  const stdout = new PassThrough(); const stderr = new PassThrough();
  let out = ''; let err = ''; let invocation;
  stdout.on('data', chunk => { out += chunk; }); stderr.on('data', chunk => { err += chunk; });
  const promise = followRemoteMidServer({ directory: f.directory, tail: 12, run: f.run, signalSource: signals, stdout, stderr, spawnImpl: (command, args, options) => { invocation = { command, args, options }; return child; } });
  child.stdout.write('application stdout'); child.stderr.write('application stderr');
  signals.emit('SIGINT');
  assert.deepEqual(await promise, { cancelled: true });
  assert.equal(out, 'application stdout'); assert.equal(err, 'application stderr');
  assert.deepEqual(child.killedWith, ['SIGINT']);
  assert.equal(invocation.command, 'ssh');
  assert.match(invocation.args.at(-1), /^docker container logs --follow --tail 12 jsn-mid-/);
  assert.ok(invocation.args.includes('RemoteCommand=none'));
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(child.listenerCount('close'), 0);
  assert.equal(child.listenerCount('error'), 0);
  assert.ok(!f.calls.some(call => call.args.at(-1).includes('container stop')));
  assert.equal(stdout.writableEnded, false); assert.equal(stderr.writableEnded, false);
});

test('follow verifies ownership before spawn and sanitizes spawn/error failures', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t); f.prepare(); f.install();
  let spawned = 0;
  f.setForeign(true);
  await assert.rejects(followRemoteMidServer({ directory: f.directory, run: f.run, spawnImpl: () => { spawned++; } }), /ownership mismatch/);
  assert.equal(spawned, 0);
  f.setForeign(false);
  const signals = new EventEmitter(); const child = viewer();
  const promise = followRemoteMidServer({ directory: f.directory, run: f.run, signalSource: signals, spawnImpl: () => child });
  child.emit('error', new Error('private credential text'));
  await assert.rejects(promise, error => !error.message.includes('credential') && /viewer failed/.test(error.message));
  assert.equal(signals.listenerCount('SIGINT'), 0);
  await assert.rejects(followRemoteMidServer({ directory: f.directory, run: f.run, spawnImpl: () => { throw new Error('private credential text'); } }), /viewer failed/);
});

test('Windows controller is rejected before SSH or metadata writes', t => {
  const f = fixture(t);
  assert.throws(() => prepareRemoteMidServer({ platform: 'win32', target: 'family-pc', instanceURL: 'https://example.service-now.com', name: 'mid', directory: f.directory, run: f.run }), /POSIX controller/);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(f.directory), false);
});


test('successful teardown removes only the explicitly owned network as well as container volume and image', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); f.prepare(); f.install();
  const metadata = removeRemoteMidServer({ directory: f.directory, run: f.run });
  assert.equal(f.present.size, 0);
  assert.ok(f.calls.some(call => call.args.at(-1) === `docker network inspect ${metadata.network}`));
  assert.ok(f.calls.some(call => call.args.at(-1) === `docker network rm ${metadata.network}`));
  assert.ok(!f.calls.some(call => call.args.at(-1).includes('prune')));
});
