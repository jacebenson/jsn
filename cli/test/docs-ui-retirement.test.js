import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const binary = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-docs-retired-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const marker = path.join(home, 'injected');
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home,
    JSN_CONFIG_HOME: home, JSN_DATA_HOME: home, JSN_HERMES_BASE_DIR: path.join(home, '.hermes'),
    JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1',
    USER: `missing; printf injected > ${marker}; #` };
  return { home, marker, env, cli: (...args) => exec(process.execPath, [binary, ...args], { env, timeout: 10000 }) };
}
test('removed browser flags fail before contacting the documentation service', async t => {
  const f = fixture(t);
  let requests = 0;
  const server = http.createServer((_req, res) => { requests++; res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  f.env.JSN_DOCS_URL = `http://127.0.0.1:${server.address().port}`;
  const help = await f.cli('docs', '--help');
  assert.doesNotMatch(help.stdout, /--serve|--host|--port/);
  for (const args of [['--serve'], ['--serve=false'], ['--no-serve'], ['--host', '127.0.0.1'], ['--port', '0'], ['search', 'security', '--serve']]) {
    await assert.rejects(f.cli('docs', ...args, '--json'), error => {
      assert.notEqual(error.code, 0);
      assert.match(error.stdout + error.stderr, /Unknown argument|Unknown option/i);
      return true;
    });
  }
  assert.equal(requests, 0);
  assert.equal(fs.existsSync(f.marker), false);
});
test('normal terminal search still uses the configured JSON service', async t => {
  const f = fixture(t), requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ query: 'security', release: 'australia', revision: 'fixture', total: 1, count: 1, offset: 0,
      results: [{ id: 1, path: 'security.md', title: 'Security reference', summary: 'Local fixture result' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  f.env.JSN_DOCS_URL = `http://127.0.0.1:${server.address().port}`;
  const result = await f.cli('docs', 'security', '--json');
  assert.equal(JSON.parse(result.stdout).data.results[0].path, 'security.md');
  const human = await f.cli('docs', 'security', '--styled');
  assert.match(human.stdout, /Security reference/);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(url => new URL(url, f.env.JSN_DOCS_URL).pathname === '/api/docs/search'));
  assert.equal(fs.existsSync(f.marker), false);
});
test('skill import and OS home resolution never interpret inherited USER', async t => {
  const f = fixture(t);
  const skill = new URL('../src/commands/skill.js', import.meta.url).href;
  const code = `import os from 'node:os'; const { realHomeDir } = await import(${JSON.stringify(skill)}); process.stdout.write(JSON.stringify({home: realHomeDir(), expected: os.userInfo().homedir}));`;
  const result = await exec(process.execPath, ['--input-type=module', '-e', code], { env: f.env, timeout: 10000 });
  const data = JSON.parse(result.stdout);
  assert.equal(data.home, data.expected);
  assert.equal(fs.existsSync(f.marker), false);
});
