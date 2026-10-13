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
  assert.equal(fs.statSync(archive).mode & 0o777, 0o600);
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
