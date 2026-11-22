import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OutputWriter } from '../src/output.js';
import { buildCLI, resolveRequestedFormat } from '../src/cli.js';

test('TSV is registered globally alongside CSV and preserves existing shortcut precedence', () => {
  const options = buildCLI().commandRegistry().options;
  assert.equal(options.find(option => option.name === 'tsv').type, 'boolean');
  assert.ok(options.find(option => option.name === 'format').choices.includes('tsv'));
  assert.equal(resolveRequestedFormat({ quiet: true, csv: true }), 'csv');
  assert.equal(resolveRequestedFormat({ quiet: true, tsv: true }), 'tsv');
});

// Decode after splitting: escaped separators must not become record boundaries.
function parse(text) {
  return text.slice(0, -1).split('\n').map(line => line.split('\t').map(cell =>
    cell.replace(/\\([\\tnr])/g, (_, ch) => ({ '\\': '\\', t: '\t', n: '\n', r: '\r' })[ch])));
}
function capture(data, options = {}) {
  let stdout = '', stderr = '';
  new OutputWriter({ format: 'tsv', writer: { write: s => { stdout += s; } },
    errorWriter: { write: s => { stderr += s; } }, ...options }).ok(data, { summary: 'Not a row' });
  return { stdout, stderr };
}
test('TSV parser round trip: headers, tabs, line breaks, literal escapes, unicode, nested values and refs', () => {
  const key = 'head\t\n\r\\';
  const value = '雪\tline\nCR\r\\n\\t\\';
  const row = { [key]: value, ref: { display_value: 'Jane\tDoe', value: 'id' }, raw: { value: 0 },
    nested: { items: ['a\nb', null] }, empty: null, missing: undefined, blank: '', bool: false };
  for (const isTTY of [false, true]) {
    let text = '';
    const result = capture({ records: [row] }, { writer: { isTTY, write: s => { text += s; } } });
    assert.equal(result.stderr, '');
    assert.equal(text.split('\n').length, 3);
    assert.deepEqual(parse(text), [Object.keys(row), [value, 'Jane\tDoe', '0', JSON.stringify(row.nested), '', '', '', 'false']]);
  }
});
test('TSV empty results, pagination uncertainty and extraction precedence', () => {
  for (const data of [[], { records: [] }]) assert.deepEqual(capture(data), { stdout: '', stderr: '' });
  const data = { records: [{ n: 1 }], pagination: { hasMore: true, total: null, offset: 3, limit: 5 } };
  assert.deepEqual(capture(data), { stdout: 'n\n1\n', stderr: 'TSV pagination: returned 1 records; total unknown; more available; next offset 8.\n' });
  assert.deepEqual(capture(data, { jqFilter: 'data.records.0.n' }), { stdout: '1\n', stderr: '' });
  for (const hasMore of [undefined, false, null]) {
    assert.equal(capture({ records: [], pagination: { hasMore } }).stderr, '');
  }
});
test('real CLI TSV flags render records, preserve scalar projection, advertise format and skip interactive output', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-tsv-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const preload = path.join(directory, 'fixture.mjs');
  fs.writeFileSync(preload, `
    Object.defineProperty(process.stdout, 'isTTY', { value: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: true });
    import { AuthManager } from ${JSON.stringify(new URL('../src/auth.js', import.meta.url).href)};
    AuthManager.prototype.createProfileProvider = () => ({ getCredentials: async () => ({ auth_method: 'gck', access_token: 'fixture' }) });
    globalThis.fetch = async req => {
      const url = new URL(req.url);
      if (req.method !== 'GET' || url.origin !== 'https://fixture.example.test') throw new Error('Unexpected request');
      if (url.pathname === '/api/now/stats/incident') return Response.json({ result: { stats: { count: '7' } } });
      if (url.pathname !== '/api/now/table/incident') throw new Error('Unexpected path');
      return Response.json({ result: [{ number: 'INC1', short_description: '雪\\tline\\nnext\\rslash\\\\', assigned_to: { display_value: 'Jane', value: 'id' } }] });
    };
  `);
  const env = { ...process.env, HOME: directory, XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory,
    SERVICENOW_INSTANCE_URL: '', SERVICENOW_FORMAT: '', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '0', TERM: 'xterm', CI: '0', NONINTERACTIVE: '0',
    GITHUB_ACTIONS: 'false', CLAUDE_CODE: '0', COPILOT_AGENT: '0', VSCODE_AGENT: '0', CURSOR_AGENT: '0', CODEX_AGENT: '0', GITHUB_COPILOT_AGENT: '0',
    JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' };
  function run(args) {
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href,
      fileURLToPath(new URL('../bin/jsn.js', import.meta.url)), ...args], { env, cwd: directory, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return { stdout: result.stdout, stderr: result.stderr };
  }
  const args = ['records', 'list', '--table', 'incident', '--instance', 'https://fixture.example.test',
    '--limit', '2', '--columns', 'number,short_description,assigned_to'];
  const result = run([...args, '--tsv']);
  assert.deepEqual(result, run([...args, '--format=tsv']));
  assert.deepEqual(parse(result.stdout), [['number', 'short_description', 'assigned_to'], ['INC1', '雪\tline\nnext\rslash\\', 'Jane']]);
  assert.match(result.stderr, /^TSV pagination: returned 1 of 7 records; more available; next offset 2\.\n$/);
  assert.equal(run([...args, '--tsv', '--get', 'data.records.0.number']).stdout, '"INC1"\n');
  for (const help of [run(['--help']).stdout, run(['--all-commands', '--help']).stdout]) {
    assert.match(help, /--tsv/);
    assert.match(help, /--csv/);
  }
  const root = run(['--help']).stdout;
  assert.match(root.replace(/ \\\n\s*/g, ' '), /--columns sys_id,number,state --limit 5 --csv/);
  assert.ok(root.indexOf('\nOUTPUT\n') < root.indexOf('\nNEXT\n'));
  const registry = JSON.parse(run(['--json']).stdout);
  assert.ok(registry.data.commands.length > 0);
  assert.equal(run([...args, '--tsv', '--no-count']).stderr, '');
  const json = JSON.parse(run([...args, '--json']).stdout);
  assert.ok(json.data.pagination);
  assert.equal(run([...args, '--quiet']).stderr, '');
});
