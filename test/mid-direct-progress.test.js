import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installDirectMidServer, downloadMidZip } from '../src/midserver-direct.js';
import { directProgress, registrationProgress } from '../src/commands/midservers.js';
import { writeZip, inertAgent } from './helpers/mid-zip-fixture.js';

const options = { instanceURL: 'https://example.service-now.com', username: 'isolated-user', password: 'test-only', name: 'oct12', releaseName: 'australia-06-12-2026', runNow: false };

function disposable(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-mid-progress-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeFetch(chunks, contentLength) {
  return async () => ({
    ok: true, status: 200,
    headers: { get: name => (name.toLowerCase() === 'content-length' && contentLength !== undefined ? String(contentLength) : null) },
    body: { async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; } },
  });
}

test('bounded downloader reports byte progress and a final done event', async t => {
  const directory = disposable(t), archive = path.join(directory, '.download.zip');
  const events = [];
  const chunk = Buffer.alloc(3 * 1024 * 1024, 1);
  await downloadMidZip('https://example.invalid/mid.zip', archive, fakeFetch([chunk, chunk], 6 * 1024 * 1024), event => events.push(event));
  assert.deepEqual(events[0], { phase: 'download', received: 0, total: 6 * 1024 * 1024 });
  assert.equal(events.at(-1).done, true);
  assert.equal(events.at(-1).received, 6 * 1024 * 1024);
  assert.equal(fs.statSync(archive).size, 6 * 1024 * 1024);
  if (process.platform !== 'win32') assert.equal(fs.statSync(archive).mode & 0o777, 0o600);
  // Progress is reported at intervals, not once per chunk.
  assert.ok(events.length >= 2 && events.length <= 5, `unexpected event count ${events.length}`);
});

test('installer announces download and extraction phases before the silent runtime start', async t => {
  const directory = path.join(disposable(t), 'oct12');
  const phases = [];
  const downloadPhases = [];
  await installDirectMidServer({
    ...options, directory, onProgress: event => phases.push(event.phase),
    download: async (url, filename, _fetch, onProgress) => { downloadPhases.push(typeof onProgress); return writeZip(filename, inertAgent); },
  });
  assert.deepEqual(phases, ['download-start', 'extract-start', 'extract-done']);
  assert.deepEqual(downloadPhases, ['function']);

  // A download failure after the first phase still cleans up and reports honestly.
  const failed = path.join(disposable(t), 'failed');
  const failedPhases = [];
  await assert.rejects(installDirectMidServer({
    ...options, directory: failed, onProgress: event => failedPhases.push(event.phase),
    download: async () => { throw new Error('network down'); },
  }), /owned files cleaned up/);
  assert.deepEqual(failedPhases, ['download-start']);
  assert.equal(fs.existsSync(failed), false);
});

test('progress stays silent for structured output and non-terminal stderr', () => {
  const writes = [];
  const original = process.stderr.write;
  process.stderr.write = chunk => { writes.push(String(chunk)); return true; };
  try {
    for (const format of ['json', 'quiet', 'markdown', 'csv']) {
      assert.doesNotThrow(() => directProgress({ output: { getFormat: () => format } })({ phase: 'download-start', archiveURL: 'https://example.invalid', installDir: '/tmp/x' }));
      assert.equal(registrationProgress({ output: { getFormat: () => format } }, 300000), undefined);
    }
    assert.equal(writes.length, 0, `structured output must not print progress: ${writes.join('')}`);
  } finally { process.stderr.write = original; }
});

test('direct log discovery finds the rotated vendor log and refuses links', async t => {
  const { resolveDirectLogFile } = await import('../src/midserver-direct.js');
  const directory = disposable(t);
  const logs = path.join(directory, 'agent', 'logs');
  assert.equal(resolveDirectLogFile(directory), null, 'missing logs directory yields null');
  fs.mkdirSync(logs, { recursive: true });
  // An interrupted install with an empty logs dir must not be reported as having a log.
  assert.equal(resolveDirectLogFile(directory), null);
  fs.writeFileSync(path.join(logs, 'wrapper.log'), 'wrapper\n');
  fs.writeFileSync(path.join(logs, 'agent0.log.0.lck'), '');
  assert.equal(path.basename(resolveDirectLogFile(directory)), 'wrapper.log', 'a lock file is not a log');
  fs.writeFileSync(path.join(logs, 'agent0.log.0'), 'rotated\n');
  fs.utimesSync(path.join(logs, 'agent0.log.0'), new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  assert.equal(path.basename(resolveDirectLogFile(directory)), 'agent0.log.0', 'rotated agent log wins over wrapper.log');
  fs.writeFileSync(path.join(logs, 'agent0.log'), 'current\n');
  assert.equal(path.basename(resolveDirectLogFile(directory)), 'agent0.log', 'the most recently written agent log wins');
  fs.utimesSync(path.join(logs, 'agent0.log'), new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  fs.utimesSync(path.join(logs, 'agent0.log.0'), new Date(), new Date());
  assert.equal(path.basename(resolveDirectLogFile(directory)), 'agent0.log.0', 'a newer rotated file takes over after rotation');
  // A symlinked log must never be followed or returned.
  fs.rmSync(path.join(logs, 'agent0.log'));
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(logs, 'wrapper.log'), path.join(logs, 'agent0.log'));
    assert.equal(path.basename(resolveDirectLogFile(directory)), 'agent0.log.0', 'a symlink is never selected');
  }
});

test('follow streams appended lines and survives log rotation', async t => {
  const { followDirectLog, resolveDirectLogFile } = await import('../src/midserver-direct.js');
  const directory = disposable(t);
  const logs = path.join(directory, 'agent', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const active = path.join(logs, 'agent0.log.0');
  fs.writeFileSync(active, 'first\n');
  const chunks = [];
  let step = 0;
  const sleep = async () => {
    step += 1;
    if (step === 1) fs.appendFileSync(active, 'second\n');
    if (step === 2) {
      // Rotate: the retired file goes quiet and a new file becomes the newest agent log.
      fs.writeFileSync(active, 'rotated-away\n');
      fs.utimesSync(active, new Date(Date.now() - 120000), new Date(Date.now() - 120000));
      fs.writeFileSync(path.join(logs, 'agent0.log.1'), '');
    }
    if (step === 3) fs.appendFileSync(path.join(logs, 'agent0.log.1'), 'after rotation\n');
  };
  await followDirectLog(directory, { writer: chunk => chunks.push(chunk), intervalMs: 1, iterations: 3, sleep });
  const output = chunks.join('');
  assert.match(output, /second/);
  assert.match(output, /after rotation/);
  assert.ok(!output.includes('rotated-away'), 'lines written to the retired file are not replayed');
  assert.equal(fs.existsSync(resolveDirectLogFile(directory)), true);

  // A missing log is a clear error, not a hang.
  await assert.rejects(followDirectLog(path.join(directory, 'absent'), { iterations: 1 }), /No MID agent log yet/);
});

test('registration progress reports elapsed time at a bounded cadence', () => {
  const writes = [];
  const originalWrite = process.stderr.write;
  const originalTTY = process.stderr.isTTY;
  process.stderr.write = chunk => { writes.push(String(chunk)); return true; };
  try {
    assert.equal(registrationProgress({ output: { getFormat: () => 'json' } }, 300000), undefined, 'non-human output yields no reporter');
    assert.equal(registrationProgress({ output: { getFormat: () => 'auto' } }, 300000), undefined, 'non-TTY stderr yields no reporter');

    process.stderr.isTTY = true;
    const report = registrationProgress({ output: { getFormat: () => 'auto' } }, 300000);
    assert.equal(typeof report, 'function');
    report(1000); report(5000);
    assert.equal(writes.length, 0, 'sub-window polls must not print');
    report(20000);
    assert.equal(writes.length, 1, 'the first full window prints one line');
    assert.match(writes[0], /20s of 300s/);
    report(25000);
    assert.equal(writes.length, 1, 'a second sub-window poll stays quiet');
  } finally {
    process.stderr.write = originalWrite;
    if (originalTTY === undefined) delete process.stderr.isTTY; else process.stderr.isTTY = originalTTY;
  }
});
