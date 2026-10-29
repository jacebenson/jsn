// Isolate module mocks from the recovery and ordinary docs tests.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as helpers from '../src/helpers.js';
import * as prompts from '../src/prompts.js';

const events = [], questions = [];
mock.module('../src/helpers.js', { namedExports: { ...helpers, canUsePicker: app => !!app.interactive } });
mock.module('../src/prompts.js', { namedExports: { ...prompts,
  select: async config => {
    events.push('source choice');
    assert.deepEqual(config.choices.map(choice => choice.value), ['skip', 'snapshot', 'github']);
    return 'snapshot';
  },
  confirm: async config => { events.push('approval'); questions.push(config); return false; },
} });
const { ensureDocumentation } = await import('../src/commands/docs/install.js');
const { DEFAULT_MANIFEST_URL } = await import('../src/commands/docs/snapshot.js');
const { getDocsDbPath } = await import('../src/commands/docs/db.js');

test('declining an interactive first-search snapshot fetches only the manifest and leaves no index', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-docs-decline-'));
  const previous = { JSN_DATA_HOME: process.env.JSN_DATA_HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };
  process.env.JSN_DATA_HOME = directory;
  process.env.XDG_CACHE_HOME = path.join(directory, 'cache');
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const artifactURL = 'https://fixture.invalid/must-not-download.sqlite.gz';
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(String(url));
    assert.equal(String(url), DEFAULT_MANIFEST_URL, 'declining approval must never request artifact bytes');
    events.push('manifest estimate');
    return new Response(JSON.stringify({ format: 1, schema: 1, cliCompatibility: 'docs-schema-1',
      revision: 'a'.repeat(40), sha256: '0'.repeat(64), compressedBytes: 10 * 1048576,
      databaseBytes: 20 * 1048576, documents: 10, url: artifactURL }));
  });
  await assert.rejects(ensureDocumentation({ interactive: true }, {}), error => {
    assert.equal(error.code, 'usage_error');
    assert.match(error.message, /installation skipped/i);
    assert.match(error.hint, /docs install --source snapshot\|github/);
    return true;
  });
  assert.deepEqual(events, ['source choice', 'manifest estimate', 'approval']);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].default, false);
  assert.match(questions[0].message, /10\.0 MiB/);
  assert.match(questions[0].message, /estimated/);
  assert.deepEqual(requests, [DEFAULT_MANIFEST_URL]);
  assert.equal(fs.existsSync(getDocsDbPath()), false);
  assert.equal(fs.existsSync(`${getDocsDbPath()}.snapshot.json`), false);
});
