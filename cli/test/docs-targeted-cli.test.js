import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { startDocumentationServer } from '../src/commands/docs/server.js';
import { getHostedDoc } from '../src/commands/docs/client.js';

const exec = promisify(execFile);
const body = '# API\n\nOnly available in global scope.\n\n## addQuery(name)\nFirst overload\n\n## addQuery(name, operator, value)\n<table><tr><td>operator</td></tr></table>\n\n### Example\n```js\n# not a heading\n```\n\n## Repeat\none\n\n## Repeat\ntwo\n';
async function fixture(t, old = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-sections-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const document = { id: 1, path: 'api.md', title: 'API', release: 'australia', body };
  let server, url;
  if (old) {
    server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ release: 'australia', revision: 'abc', document })); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}/`;
  } else {
    const db = new Database(path.join(root, 'docs.sqlite3'));
    db.exec("CREATE TABLE meta(key TEXT, value TEXT); INSERT INTO meta VALUES('source_revision','abc'); CREATE TABLE docs(id INTEGER, path TEXT, title TEXT, bundle TEXT, doc_type TEXT, release TEXT, body TEXT)");
    db.prepare('INSERT INTO docs VALUES(1, ?, ?, NULL, NULL, ?, ?)').run(document.path, document.title, document.release, body);
    db.close();
    ({ server, url } = await startDocumentationServer({ storage: root, refresh: false }));
  }
  t.after(() => new Promise(resolve => server.close(resolve)));
  const cli = async (...args) => exec(process.execPath, ['bin/jsn.js', 'docs', ...args], { env: { ...process.env, JSN_DOCS_URL: url, JSN_CONFIG_HOME: root, JSN_DATA_HOME: root, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1' } });
  return { url, cli };
}
for (const old of [false, true]) test(`real CLI document reader and ${old ? 'old-service fallback' : 'shared HTTP'} selection`, async t => {
  const { url, cli } = await fixture(t, old);
  const full = JSON.parse((await cli('--path', 'api.md', '--json')).stdout).data;
  assert.equal(full.body, body);
  assert.equal(Object.hasOwn(full, '_formatted'), false);
  const short = JSON.parse((await cli('--path', 'api.md', '--lines', '1', '--json')).stdout).data;
  assert.deepEqual(short, full);
  const outline = JSON.parse((await cli('--path', 'api.md', '--outline', '--json')).stdout).data;
  assert.equal(Object.hasOwn(outline, 'body'), false);
  assert.equal(outline.outline.length, 6);
  const id = outline.outline[2].id;
  const selected = JSON.parse((await cli('--path', 'api.md', '--section', id, '--json')).stdout).data;
  assert.equal(selected.retrieval.execution, old ? 'client-fallback' : 'service');
  assert.equal(selected.retrieval.full_document_transferred, old);
  assert.match(selected.body, /Only available in global scope/);
  assert.match(selected.body, /<table>/);
  assert.match(selected.body, /# not a heading/);
  assert.doesNotMatch(selected.body, /First overload|## Repeat/);
  assert.equal(selected.revision, 'abc');
  assert.equal(selected.release, 'australia');
  assert.ok(selected.body.length < full.body.length);
  const human = (await cli('--path', 'api.md', '--section', id, '--lines', '1', '--styled')).stdout;
  assert.match(human, /Complete selected subtree/);
  assert.match(human, /<table>/);
  assert.match(human, /Semantic answer completeness: unknown/);
  assert.equal(JSON.parse((await cli('--path', 'api.md', '--section', id, '--get', 'data.body')).stdout), selected.body);
  for (const section of ['missing', 'Repeat', '', id.replace(/:3$/, ':900')]) {
    await assert.rejects(cli('--path', 'api.md', '--section', section, '--json'), error => {
      assert.notEqual(error.code, 0);
      assert.match(error.stdout + error.stderr, /matching|Ambiguous|nonempty/);
      return true;
    });
  }
  await assert.rejects(getHostedDoc('api.md', { serviceUrl: url, revision: 'stale', section: id }), /changed|mismatch/);
  await assert.rejects(getHostedDoc('api.md', { serviceUrl: url, release: 'zurich', section: id }), /release/);
  await assert.rejects(cli('--outline', '--json'), error => /--path/.test(error.stdout + error.stderr));
  await assert.rejects(cli('--path', 'api.md', '--outline', '--section', id, '--json'), error => /either/.test(error.stdout + error.stderr));
});
