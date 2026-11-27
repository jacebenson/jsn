import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { credentialFixtureArgs } from './helpers/fake-keyring.js';

const exec = promisify(execFile);
const entry = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));

test('public nested denials and project-selected same-origin profile cannot bypass trusted policy', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-preference-policy-'));
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push([req.method, req.url]);
    res.setHeader('Content-Type', 'application/json');
    res.end('{"result":[]}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const globalPath = path.join(root, 'xdg/servicenow/config.json');
  const localPath = path.join(root, '.servicenow/config.json');
  fs.mkdirSync(path.dirname(globalPath), { recursive: true });
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(globalPath, JSON.stringify({ default_profile: 'prod', profiles: {
    prod: { instance_url: origin, preferences: { operations: { create: false, update: false, delete: false } } },
    alternate: { instance_url: origin, preferences: { operations: { create: true, update: true, delete: true } } },
    different: { instance_url: 'https://different.invalid', preferences: { testing: { recommend: false } } },
  } }));
  fs.writeFileSync(localPath, JSON.stringify({ default_profile: 'project', profiles: {
    project: { instance_url: origin, preferences: { operations: { create: true, delete: true } } },
  } }));
  const env = { HOME: root, XDG_CONFIG_HOME: path.join(root, 'xdg'), XDG_CACHE_HOME: path.join(root, 'cache'),
    PATH: path.join(root, 'no-utilities'), TMPDIR: root, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1',
    JSN_NO_PROMPTS: '1', JSN_NO_HEADER: '1', SERVICENOW_OAUTH_TOKEN: 'synthetic-token' };
  async function run(args) {
    try { return { ...await exec(process.execPath, [...credentialFixtureArgs, entry, ...args], { cwd: root, env, timeout: 10000 }), code: 0 }; }
    catch (error) { return { stdout: error.stdout, stderr: error.stderr, code: error.code }; }
  }
  try {
    for (const selector of [[], ['--profile', 'prod'], ['-p', 'prod'], ['--instance', origin]]) {
      const show = await run(['preferences', 'show', ...selector, '--json']);
      assert.equal(show.code, 0, show.stdout + show.stderr);
      assert.equal(JSON.parse(show.stdout).data.profile, 'prod');
      assert.equal(JSON.parse(show.stdout).data.preferences.operations.create, false);
      for (const args of [
        ['records', 'create', '--table', 'incident', '--data', '{}'],
        ['rest', '/api/now/table/incident', '--method', 'POST'],
        ['records', 'delete', 'a'.repeat(32), '--table', 'incident'],
        ['scan', 'checks', 'delete', 'a'.repeat(32)],
        ['scan', 'checks', 'create', '--type', 'script', '--data', '{}'],
        ['scan', 'suites', 'update', 'a'.repeat(32), '--data', '{}'],
      ]) {
        const result = await run([...args, ...selector, '--force', '--yes', '--json']);
        assert.notEqual(result.code, 0);
        assert.equal(JSON.parse(result.stdout).code, 'operation_denied', result.stdout + result.stderr);
        assert.deepEqual(requests, [], 'denied operation must not reach transport');
      }
    }
    const alternate = await run(['preferences', 'show', '-p', 'alternate', '--json']);
    assert.equal(alternate.code, 0, alternate.stderr);
    assert.equal(JSON.parse(alternate.stdout).data.preferences.operations.create, true);
    const allowed = await run(['records', 'list', '--table', 'incident', '-p', 'alternate', '--json']);
    assert.equal(allowed.code, 0, allowed.stdout + allowed.stderr);
    assert.ok(requests.length > 0, 'positive control reaches loopback');
    const different = await run(['preferences', 'show', '--instance', 'https://unrelated.invalid', '--json']);
    assert.equal(different.code, 0, different.stderr);
    assert.equal(JSON.parse(different.stdout).data.profile, null);
    assert.equal(JSON.parse(different.stdout).data.preferences.operations.create, true, 'do not borrow another origin policy');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('preferences guide is published through the existing static registry', () => {
  const site = new URL('../../site/', import.meta.url);
  const guides = JSON.parse(fs.readFileSync(new URL('config/guides.json', site), 'utf8'));
  assert.equal(guides.preferences, 'guides/preferences.md');
  assert.match(fs.readFileSync(new URL('docs/' + guides.preferences, site), 'utf8'), /--scope x_custom/);
});
