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
async function mapBounded(items, action) {
  const results = new Array(items.length), failures = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      try { results[index] = await action(items[index], index); }
      catch (error) { failures[index] = { error }; }
    }
  }
  // Catch per-input errors inside workers: Promise.all cannot return early
  // while another real CLI child is still using the fixture being cleaned up.
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));
  const failure = failures.find(Boolean);
  if (failure) throw failure.error;
  return results;
}
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
test('bounded retired-flag pool caps work, collects in order and drains before deterministic failure propagation', async () => {
  const items = Array.from({ length: 9 }, (_, index) => index);
  let active = 0, peak = 0;
  const completed = [];
  const results = await mapBounded(items, async index => {
    active++; peak = Math.max(peak, active);
    await Promise.resolve();
    completed.push(index); active--;
    return index * 2;
  });
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.deepEqual(completed.slice().sort((a, b) => a - b), items);
  assert.deepEqual(results, items.map(index => index * 2));

  const gates = Array.from({ length: 6 }, () => Promise.withResolvers());
  const failures = [new Error('first input failure'), new Error('later input failure')];
  const started = [], finished = [];
  let settled = false;
  const pending = mapBounded(gates, async (gate, index) => {
    started.push(index);
    await gate.promise;
    finished.push(index);
    if (index === 0) throw failures[0];
    if (index === 2) throw failures[1];
  }).then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
  try {
    assert.deepEqual(started, [0, 1, 2, 3]);
    gates[2].resolve(); // Later input fails first in time.
    await new Promise(setImmediate);
    assert.equal(settled, false, 'started children must drain before failure escapes');
    gates[0].resolve();
    await new Promise(setImmediate);
    assert.equal(settled, false, 'other active children are still pending');
  } finally {
    for (const gate of gates) gate.resolve();
  }
  const outcome = await pending;
  assert.equal(outcome.error, failures[0], 'report the first input failure, not completion order');
  assert.deepEqual(started.slice().sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(finished.slice().sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
});

test('removed browser flags fail before contacting the documentation service', async t => {
  const f = fixture(t);
  let requests = 0;
  const server = http.createServer((_req, res) => { requests++; res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  f.env.JSN_DOCS_URL = `http://127.0.0.1:${server.address().port}`;
  const help = await f.cli('docs', '--help');
  assert.doesNotMatch(help.stdout, /--serve|--host|--port/);
  const retiredOptions = [['--serve'], ['--serve=false'], ['--no-serve'], ['--no-serve=false'],
    ['--host', '127.0.0.1'], ['--host=127.0.0.1'], ['--no-host'], ['--port', '0'], ['--port=0'], ['--no-port']];
  const commands = [[], ['security'], ['search', 'security'], ['show', 'security.md'], ['status'], ['releases'], ['sync'], ['install', '--source', 'skip']];
  const cases = commands.flatMap(command => retiredOptions.map(option => [...command, ...option]));
  assert.equal(cases.length, 80);
  const completed = await mapBounded(cases, async args => {
    await assert.rejects(f.cli('docs', ...args, '--json'), error => {
      assert.notEqual(error.code, 0);
      assert.match(error.stdout + error.stderr, /Unknown argument|Unknown option/i);
      return true;
    });
    return args;
  });
  assert.deepEqual(completed, cases, 'all 80 CLI rejections must execute and be collected');
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
