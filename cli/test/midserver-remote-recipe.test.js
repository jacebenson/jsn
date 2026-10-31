import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recipeTar, downloadRemoteMidRecipe } from '../src/midserver-remote-recipe.js';
import { writeZip } from './helpers/mid-zip-fixture.js';
const release = 'australia-02-11-2026__patch7-09-17-2026_10-06-2026_0905';
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-recipe-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }

test('official recipe ZIP becomes a tar context with verified file content and executable mode', async t => {
  const root = fixture(t), zip = path.join(root, 'fixture.zip');
  writeZip(zip, [{ name: 'recipe/Dockerfile', text: 'FROM scratch\n' }, { name: 'recipe/start.sh', text: '#!/bin/sh\n', mode: 0o100755 }]);
  let request;
  const tar = await downloadRemoteMidRecipe(release, { fetchImpl: async (url, opts) => { request = { url, opts }; return new Response(fs.readFileSync(zip)); } });
  assert.match(request.url, /mid-linux-container-recipe.*linux\.x86-64\.zip$/);
  assert.equal(request.opts.redirect, 'error');
  assert.equal(tar.subarray(0, 100).toString().replace(/\0/g, ''), 'Dockerfile');
  assert.equal(tar.subarray(512, 525).toString(), 'FROM scratch\n');
  assert.equal(tar.subarray(1024, 1124).toString().replace(/\0/g, ''), 'start.sh');
  // Windows controllers are rejected before provisioning; their filesystem
  // does not retain the executable bits supplied by the official ZIP.
  if (process.platform !== 'win32') assert.equal(parseInt(tar.subarray(1124, 1132).toString(), 8), 0o755);
});

test('recipe ZIP still rejects traversal, links and missing or ambiguous Dockerfiles', async t => {
  const root = fixture(t);
  for (const files of [[{name:'../Dockerfile'}], [{name:'Dockerfile',mode:0o120777}], [{name:'README'}], [{name:'a/Dockerfile'},{name:'b/Dockerfile'}]]) {
    const zip = path.join(root, 'fixture.zip'); writeZip(zip, files);
    await assert.rejects(downloadRemoteMidRecipe(release, {fetchImpl:async()=>new Response(fs.readFileSync(zip))}));
  }
});

test('tar preparation refuses links before streaming any context to a host', { skip: process.platform === 'win32' }, t => {
  const root = fixture(t); fs.symlinkSync('/etc/passwd',path.join(root,'link'));
  assert.throws(()=>recipeTar(root),/link/);
});
