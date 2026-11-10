import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSnapshot } from '../src/commands/docs/snapshot.js';

const binary = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
const preload = new URL('./support/docs-release-fetch.js', import.meta.url).href;
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-docs-release-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const scenario = path.join(home, 'scenario.json'), requests = path.join(home, 'requests.txt');
  fs.writeFileSync(scenario, '{}'); fs.writeFileSync(requests, '');
  const configDir = path.join(home, 'config', 'servicenow');
  fs.mkdirSync(configDir, { recursive: true });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'), JSN_DATA_HOME: home,
    JSN_DOCS_URL: 'https://fixture.test/', DOCS_TEST_SCENARIO: scenario, DOCS_TEST_REQUESTS: requests,
    JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1', JSN_NO_DOCS_CHECK: '1' };
  return { home, env, scenario: value => fs.writeFileSync(scenario, JSON.stringify(value)),
    config: value => fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(value)),
    requests: () => fs.readFileSync(requests, 'utf8').trim().split('\n').filter(Boolean).map(value => new URL(value)),
    run: (args, json = true) => spawnSync(process.execPath, ['--import', preload, binary, 'docs', ...args, ...(json ? ['--json'] : [])], { env, cwd: home, encoding: 'utf8', timeout: 15000 }) };
}
function success(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout).data;
}
function snapshot(f) {
  const docsDir = path.join(f.home, 'markdown'), outputDir = path.join(f.home, 'artifacts');
  fs.mkdirSync(docsDir);
  fs.writeFileSync(path.join(docsDir, 'record.md'), '---\ntitle: Record\n---\nRecord documentation reference.');
  const manifest = buildSnapshot({ docsDir, outputDir, revision: 'abcdef012345', artifactBaseURL: 'https://fixture.test/artifacts/', embed: false });
  return { manifest, artifact: path.join(outputDir, path.basename(manifest.url)) };
}
test('CLI release flag beats config, config beats default, and search/read/status send release with JSON', t => {
  const f = fixture(t);
  assert.equal(success(f.run(['record'])).release, 'australia');
  assert.equal(f.requests().at(-1).searchParams.get('release'), 'australia');
  f.config({ docs: { release: 'zurich' } });
  assert.equal(success(f.run(['record'])).release, 'zurich');
  for (const [args, endpoint] of [[['record'], '/api/docs/search'], [['--path', 'record.md'], '/api/docs/document'], [['show', '1'], '/api/docs/1'], [['status'], '/api/docs/status']]) {
    const result = success(f.run([...args, '--release', 'brazil']));
    assert.equal(result.release, 'brazil');
    assert.equal(f.requests().at(-1).pathname, endpoint);
    assert.equal(f.requests().at(-1).searchParams.get('release'), 'brazil');
  }
  for (const args of [['record'], ['--path', 'record.md'], ['status']]) {
    const result = f.run([...args, '--release', 'brazil', '--styled'], false);
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /in brazil/);
  }
});
test('CLI validates shape before network and preserves server 400 message and hint', t => {
  const f = fixture(t);
  for (const release of ['Brazil', '../escape', '', 'a'.repeat(41)]) {
    const result = f.run(['record', '--release', release]);
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.stdout).code, 'usage_error');
  }
  assert.equal(f.requests().length, 0);
  f.scenario({ status: 400, error: 'Unknown release. Valid releases: australia, brazil.', hint: 'Choose brazil.' });
  const result = f.run(['record', '--release', 'unknown']);
  assert.notEqual(result.status, 0);
  const error = JSON.parse(result.stdout);
  assert.equal(error.code, 'usage_error');
  assert.equal(error.error, 'Unknown release. Valid releases: australia, brazil.');
  assert.equal(error.hint, 'Choose brazil.');
});
test('CLI refuses a mismatched response family on search/read/status but accepts older responses', t => {
  const f = fixture(t); f.scenario({ responseRelease: 'zurich' });
  for (const args of [['record'], ['--path', 'record.md'], ['status']]) {
    const result = f.run([...args, '--release', 'brazil']);
    assert.notEqual(result.status, 0); assert.equal(JSON.parse(result.stdout).code, 'api_error');
  }
});
test('CLI snapshot install isolates families, keeps legacy default, and releases works offline', t => {
  const f = fixture(t), artifact = snapshot(f);
  f.scenario({ ...artifact, manifest: { ...artifact.manifest, release: 'brazil' } });
  const brazil = success(f.run(['install', '--source', 'snapshot', '--release', 'brazil']));
  assert.equal(brazil.dbPath, path.join(f.home, 'docs/releases/brazil/docs.db'));
  assert.equal(f.requests()[0].pathname, '/docs-index/releases/brazil/manifest.json');
  assert.equal(fs.existsSync(path.join(f.home, 'docs/docs.db')), false);
  f.scenario({ ...artifact, legacy: true });
  const australia = success(f.run(['install', '--source', 'snapshot']));
  assert.equal(australia.dbPath, path.join(f.home, 'docs/docs.db'));
  assert.ok(f.requests().some(url => url.pathname === '/docs-index/releases/australia/manifest.json'));
  assert.ok(f.requests().some(url => url.pathname === '/docs-index/manifest.json'));
  f.scenario({ offline: true });
  const count = f.requests().length;
  const releases = success(f.run(['releases'])).releases;
  assert.deepEqual(releases.map(row => row.release), ['australia', 'brazil']);
  assert.deepEqual(releases.map(row => row.default), [true, false]);
  assert.ok(releases.every(row => row.documents === 1 && row.revision === artifact.manifest.revision));
  assert.equal(f.requests().length, count);
});
test('CLI refuses mismatched and unlabelled family snapshots without replacing the existing index or falling back', t => {
  const f = fixture(t), artifact = snapshot(f);
  f.scenario({ ...artifact, manifest: { ...artifact.manifest, release: 'brazil' } });
  const installed = success(f.run(['install', '--source', 'snapshot', '--release', 'brazil']));
  const before = fs.readFileSync(installed.dbPath);
  for (const manifest of [{ ...artifact.manifest, release: 'zurich' }, artifact.manifest]) {
    f.scenario({ ...artifact, manifest });
    const result = f.run(['install', '--source', 'snapshot', '--release', 'brazil']);
    assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, /release.*brazil/);
    assert.deepEqual(fs.readFileSync(installed.dbPath), before);
  }
  f.scenario({ ...artifact, manifest: { ...artifact.manifest, release: 'brazil' } });
  const result = f.run(['install', '--source', 'snapshot', '--release', 'australia']);
  assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, /does not match requested release australia/);
  assert.ok(f.requests().every(url => url.pathname !== '/docs-index/manifest.json'));
  f.scenario({ ...artifact, legacy: true });
  assert.notEqual(f.run(['install', '--source', 'snapshot', '--release', 'yokohama']).status, 0);
  assert.ok(f.requests().every(url => url.pathname !== '/docs-index/manifest.json'));
});
test('CLI --serve reports and serves the selected family index', async t => {
  const f = fixture(t), artifact = snapshot(f);
  f.scenario({ ...artifact, manifest: { ...artifact.manifest, release: 'brazil' } });
  success(f.run(['install', '--source', 'snapshot', '--release', 'brazil']));
  const child = spawn(process.execPath, [binary, 'docs', '--serve', '--release', 'brazil', '--port', '0', '--json'], { env: f.env, cwd: f.home });
  t.after(() => { child.kill('SIGTERM'); });
  let output = '';
  const data = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start: ' + output)), 10000);
    child.stdout.on('data', chunk => { output += chunk; try { const value = JSON.parse(output); clearTimeout(timer); resolve(value.data); } catch { /* wait for full JSON */ } });
    child.once('error', reject);
  });
  assert.equal(data.release, 'brazil');
  const response = await fetch(new URL('api/docs/search?q=Record&release=brazil', data.url));
  const result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.release, 'brazil'); assert.equal(result.count, 1);
  const wrong = await fetch(new URL('api/docs/status?release=australia', data.url));
  assert.equal(wrong.status, 400);
  await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
});
test('CLI sync clones and updates the requested family branch with no ingestion', t => {
  const f = fixture(t);
  // Redirect only this fixture subprocess's GitHub source to a local git repository.
  const source = path.join(f.home, 'upstream');
  fs.mkdirSync(path.join(source, 'markdown'), { recursive: true });
  fs.writeFileSync(path.join(source, 'markdown/record.md'), 'Brazil docs');
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { stdio: 'pipe' });
  git('init', '-b', 'brazil'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
  execFileSync('git', ['config', '--file', path.join(f.home, '.gitconfig'), `url.${source}.insteadOf`, 'https://github.com/ServiceNow/ServiceNowDocs']);
  for (let i = 0; i < 2; i++) {
    if (i) {
      fs.writeFileSync(path.join(source, 'markdown/record.md'), 'Brazil documentation updated');
      git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'updated fixture');
    }
    const result = success(f.run(['sync', '--release', 'brazil', '--no-embed', '--no-ingest']));
    assert.equal(result.release, 'brazil'); assert.equal(result.ingested, false);
    assert.equal(result.dbPath, path.join(f.home, 'docs/releases/brazil/docs.db'));
    assert.equal(execFileSync('git', ['-C', result.repoDir, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), 'brazil');
    assert.equal(fs.readFileSync(path.join(result.markdownDir, 'record.md'), 'utf8'), i ? 'Brazil documentation updated' : 'Brazil docs');
  }
  const indexed = success(f.run(['sync', '--release', 'brazil', '--no-embed']));
  assert.equal(indexed.ingested, true);
  const releases = success(f.run(['releases'])).releases;
  assert.equal(releases[0].release, 'brazil');
  assert.equal(releases[0].documents, 1);
  assert.equal(releases[0].revision, git('rev-parse', 'HEAD').toString().trim());
});
