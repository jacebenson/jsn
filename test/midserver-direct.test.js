import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMidZipUrl, detectDirectPlatform, installDirectMidServer, readDirectInstallation, removeDirectInstallation, runDirectInstallation, configureMidXml, downloadMidZip } from '../src/midserver-direct.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectMidZip, extractMidZip } from '../src/midserver-zip.js';
import { writeZip, inertAgent } from './helpers/mid-zip-fixture.js';

function disposable(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-mid-direct-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const options = { instanceURL: 'https://example.service-now.com', username: 'isolated-user', password: 'test-only<&"', name: 'mid.server.oct12', releaseName: 'australia-06-12-2026', runNow: false };
const download = async (_url, filename) => writeZip(filename, inertAgent);

test('real isolated Linux launcher prepares private XML, starts, stops and removes only its owned directory', { skip: process.platform !== 'linux' }, async t => {
  const parent = disposable(t), directory = path.join(parent, 'oct12');
  const metadata = await installDirectMidServer({ ...options, directory, download });
  assert.equal(metadata.state, 'prepared');
  assert.equal(metadata.name, 'oct12');
  assert.equal(metadata.serviceRegistered, false);
  const config = fs.readFileSync(path.join(directory, 'agent/config.xml'), 'utf8');
  assert.match(config, /secure="true" name="mid.instance.password" value="test-only&lt;&amp;&quot;"/);
  assert.match(config, /name="name" value="oct12"/);
  assert.match(config, /name="threads.max" value="25"/);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(directory, 'agent/config.xml')).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(metadata), /test-only|isolated-user/);
  assert.deepEqual(readDirectInstallation(options.instanceURL, 'oct12', directory), metadata);
  runDirectInstallation(metadata, 'start');
  assert.equal(metadata.state, 'started');
  runDirectInstallation(metadata, 'stop');
  assert.equal(metadata.state, 'prepared');
  assert.equal(fs.readFileSync(path.join(directory, 'agent/invocations'), 'utf8'), 'start\nstop\n');
  fs.writeFileSync(path.join(parent, 'unrelated'), 'keep');
  removeDirectInstallation(metadata);
  assert.equal(fs.existsSync(directory), false);
  assert.equal(fs.readFileSync(path.join(parent, 'unrelated'), 'utf8'), 'keep');
});

test('collision and unsupported-platform preflight never downloads or changes existing files', async t => {
  const directory = disposable(t);
  fs.writeFileSync(path.join(directory, 'keep'), 'untouched');
  const forbidden = async () => assert.fail('download must not run');
  await assert.rejects(installDirectMidServer({ ...options, directory, download: forbidden }), /Refusing to overwrite/);
  await assert.rejects(installDirectMidServer({ ...options, directory: path.join(directory, 'new'), arch: 'arm64', download: forbidden }), /x86-64/);
  assert.equal(fs.readFileSync(path.join(directory, 'keep'), 'utf8'), 'untouched');
  assert.equal(fs.existsSync(path.join(directory, 'new')), false);
});

test('malicious ZIP paths, links, duplicate Windows aliases and corrupt data are rejected', async t => {
  const directory = disposable(t), archive = path.join(directory, 'bad.zip');
  for (const name of ['agent/../../escape', '/agent/evil', 'agent/C:/evil', 'agent/CON', 'agent/a\\evil', 'agent/foo.']) {
    writeZip(archive, [{ name }]);
    assert.throws(() => inspectMidZip(archive), /Unsafe ZIP path/);
  }
  writeZip(archive, [{ name: 'agent/link', mode: 0o120777, text: '../escape' }]);
  assert.throws(() => inspectMidZip(archive), /links/);
  writeZip(archive, [{ name: 'agent/Test' }, { name: 'agent/test' }]);
  assert.throws(() => inspectMidZip(archive), /Duplicate/);
  writeZip(archive, [{ name: 'agent/data', text: 'original' }]);
  const bytes = fs.readFileSync(archive); bytes[40] ^= 1; fs.writeFileSync(archive, bytes);
  await assert.rejects(extractMidZip(archive, path.join(directory, 'output')), /integrity/);
});

test('ZIP extraction refuses pre-existing symlink escape and metadata cannot claim another MID', { skip: process.platform !== 'linux' }, async t => {
  const parent = disposable(t), archive = path.join(parent, 'safe.zip');
  const destination = path.join(parent, 'destination'), outside = path.join(parent, 'outside');
  fs.mkdirSync(destination); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(destination, 'agent'));
  writeZip(archive, [{ name: 'agent/escaped', text: 'must not write' }]);
  await assert.rejects(extractMidZip(archive, destination), /Unsafe ZIP destination/);
  assert.equal(fs.existsSync(path.join(outside, 'escaped')), false);
  const directory = path.join(parent, 'owned');
  await installDirectMidServer({ ...options, directory, download });
  assert.throws(() => readDirectInstallation('https://another.service-now.com', 'oct12', directory), /ownership/);
  fs.chmodSync(directory, 0o777);
  assert.throws(() => readDirectInstallation(options.instanceURL, 'oct12', directory), /untrusted installation/);
});

test('failed extraction and ACL preparation clean up only newly created installation', async t => {
  const parent = disposable(t);
  for (const protect of [() => { throw new Error('ACL denied'); }, () => {}]) {
    const directory = path.join(parent, 'failed');
    await assert.rejects(installDirectMidServer({ ...options, directory, protect, download: async (_, archive) => writeZip(archive, [{ name: 'agent/../escape' }]) }), /owned files cleaned up/);
    assert.equal(fs.existsSync(directory), false);
  }
});

test('a crash between start and verification reconciles state instead of reporting success', { skip: process.platform !== 'linux' }, async t => {
  const directory = path.join(disposable(t), 'crashed-start');
  const metadata = await installDirectMidServer({ ...options, directory, download });
  metadata.state = 'starting';
  fs.writeFileSync(path.join(directory, '.jsn-mid-direct.json'), JSON.stringify(metadata, null, 2), { mode: 0o600 });
  delete metadata.state;
  assert.throws(() => runDirectInstallation(metadata, 'start'), /uncertain/);
  assert.throws(() => runDirectInstallation(readDirectInstallation(options.instanceURL, 'oct12', directory), 'stop'), /uncertain/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, '.jsn-mid-direct.json'), 'utf8')).state, 'uncertain');
});

test('failed native start retains an uncertain runtime and refuses cleanup when stop fails', { skip: process.platform !== 'linux' }, async t => {
  const directory = path.join(disposable(t), 'failed-start');
  const metadata = await installDirectMidServer({ ...options, directory, download });
  const fail = () => { throw new Error('test-only secret must never escape'); };
  assert.throws(() => runDirectInstallation(metadata, 'start', fail), /MID start failed/);
  assert.equal(metadata.state, 'starting');
  assert.throws(() => removeDirectInstallation(metadata, fail), /MID stop failed/);
  assert.equal(fs.existsSync(directory), true);
});

test('Windows invocation seam selects console, never installstart or LocalSystem (not host proof)', async t => {
  const directory = path.join(disposable(t), 'windows-seam');
  const metadata = await installDirectMidServer({ ...options, directory, platform: 'win32', arch: 'x64', download, protect: () => {} });
  const calls = [];
  runDirectInstallation(metadata, 'start', (command, args, opts) => calls.push({ command, args, cwd: opts.cwd }));
  assert.deepEqual(calls, [{ command: 'cmd.exe', args: ['/d', '/s', '/c', 'bin\\mid.bat console'], cwd: path.join(directory, 'agent') }]);
  assert.equal(metadata.serviceRegistered, false);
  assert.doesNotMatch(JSON.stringify(calls), /test-only|installstart/);
});

test('Windows console errors retain uncertain state and do not leak process error output', async t => {
  const directory = path.join(disposable(t), 'windows-failed');
  const metadata = await installDirectMidServer({ ...options, directory, platform: 'win32', arch: 'x64', download, protect: () => {} });
  assert.throws(() => runDirectInstallation(metadata, 'start', () => { throw new Error('sensitive-process-output'); }), /Windows MID console failed/);
  assert.equal(metadata.state, 'console-running');
  assert.throws(() => removeDirectInstallation(metadata), /owning terminal/);
  assert.equal(fs.existsSync(directory), true);
});

test('XML values preserve template comments and optional fields', () => {
  assert.equal(configureMidXml('<parameters><!-- example --><parameter name="name" value="old"/></parameters>', { name: 'A&B' }), '<parameters><!-- example --><parameter name="name" value="A&amp;B"/></parameters>');
  assert.throws(() => configureMidXml('<parameters></parameters>', { name: '\u0000' }), /Invalid XML/);
});

test('bounded downloader rejects redirects, oversized and incomplete bodies', async t => {
  const parent = disposable(t);
  const response = (length, body) => ({ ok: true, status: 200, headers: new Map([['content-length', String(length)]]), body });
  await assert.rejects(downloadMidZip('https://install.service-now.com/test', path.join(parent, 'large'), async (_url, opts) => { assert.equal(opts.redirect, 'error'); return response(2 ** 31, []); }), /1 GiB/);
  await assert.rejects(downloadMidZip('https://install.service-now.com/test', path.join(parent, 'short'), async () => response(10, [Buffer.from('x')])), /Incomplete/);
});

test('official ZIP URL uses the final runtime build date and native platform', () => {
  const release = 'australia-12-17-2025__patch3-06-18-2026_07-01-2026';
  assert.equal(buildMidZipUrl(release, 'linux'), `https://install.service-now.com/glide/distribution/builds/package/app-signed/mid/2026/07/01/mid.${release}.linux.x86-64.zip`);
  assert.equal(buildMidZipUrl(release, 'win32').endsWith('.windows.x86-64.zip'), true);
  assert.throws(() => buildMidZipUrl('../bad-07-01-2026', 'linux'));
  assert.throws(() => buildMidZipUrl('australia-02-30-2026', 'linux'));
});
test('unsupported hosts fail before installation', () => {
  assert.equal(detectDirectPlatform('linux', 'x64'), 'linux');
  assert.equal(detectDirectPlatform('win32', 'x64'), 'windows');
  assert.throws(() => detectDirectPlatform('darwin', 'x64'), /Linux and Windows/);
  assert.throws(() => detectDirectPlatform('linux', 'arm64'), /x86-64/);
});
