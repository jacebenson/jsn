import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OutputWriter } from '../src/output.js';

function capture(data, options = {}, opts = {}) {
  let stdout = '', stderr = '';
  const output = new OutputWriter({ format: 'csv',
    writer: { isTTY: true, write: text => { stdout += text; } },
    errorWriter: { write: text => { stderr += text; } }, ...options });
  output.ok(data, { summary: 'Do not put this in CSV', ...opts });
  return { stdout, stderr };
}

test('partial CSV keeps stdout pure and reports page count, total and requested next offset once', () => {
  assert.deepEqual(capture({ records: [{ number: 'INC1' }, { number: 'INC2' }],
    pagination: { hasMore: true, total: 71, offset: 10, limit: 5 } }), {
    stdout: 'number\nINC1\nINC2\n',
    stderr: 'CSV pagination: returned 2 of 71 records; more available; next offset 15.\n',
  });
});

for (const total of [undefined, null]) {
  test(`partial CSV with ${total} total states uncertainty`, () => {
    assert.deepEqual(capture({ records: [{ value: 0 }], pagination: { hasMore: true, total, offset: 0, limit: 2 } }), {
      stdout: 'value\n0\n', stderr: 'CSV pagination: returned 1 records; total unknown; more available; next offset 2.\n',
    });
  });
}
test('zero total is not unknown; empty partial pages still carry the notice', () => {
  assert.deepEqual(capture({ records: [], pagination: { hasMore: true, total: 0, offset: 0, limit: 2 } }), {
    stdout: '', stderr: 'CSV pagination: returned 0 of 0 records; more available; next offset 2.\n',
  });
});
test('missing offset context is not invented', () => {
  assert.equal(capture({ records: [], pagination: { hasMore: true, total: null } }).stderr,
    'CSV pagination: returned 0 records; total unknown; more available.\n');
});
test('complete, empty, bare arrays and absent or nonboolean hasMore stay silent', () => {
  for (const records of [[], [{ value: 1 }]]) {
    for (const hasMore of [false, undefined, null, 'true']) {
      assert.equal(capture({ records, pagination: { hasMore, total: 0, limit: 2, offset: 0 } }).stderr, '');
    }
    assert.equal(capture(records).stderr, '');
  }
});
test('other formats and selection retain their output without CSV diagnostics', () => {
  const data = { records: [{ value: 1 }], pagination: { hasMore: true, total: 2, offset: 0, limit: 1 } };
  for (const format of ['json', 'quiet', 'markdown', 'styled', 'auto']) {
    assert.equal(capture(data, { format }).stderr, '');
  }
  assert.deepEqual(capture(data, { jqFilter: 'data.records[0].value' }), { stdout: '1\n', stderr: '' });
});
test('CSV quoting, reference values, nulls and multiline cells remain byte-compatible', () => {
  assert.equal(capture({ records: [{ 'a,b': 'He said "yes"', multiline: 'one\ntwo\rthree',
    reference: { display_value: 'Doe, Jane', value: 'id' }, raw: { value: 0 }, empty: null }],
  pagination: { hasMore: false } }).stdout,
  '"a,b",multiline,reference,raw,empty\n"He said ""yes""","one\ntwo\rthree","Doe, Jane",0,\n');
});

test('real CLI emits one stderr notice for counted records and uncounted tickets, never for complete or no-count records', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-csv-pagination-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const preload = path.join(directory, 'fixture.mjs');
  fs.writeFileSync(preload, `
    import { AuthManager } from ${JSON.stringify(new URL('../src/auth.js', import.meta.url).href)};
    AuthManager.prototype.createProfileProvider = () => ({ getCredentials: async () => ({ auth_method: 'gck', access_token: 'fixture' }) });
    globalThis.fetch = async req => {
      const url = new URL(req.url);
      if (req.method !== 'GET' || url.origin !== 'https://fixture.example.test') throw new Error('Unexpected request');
      if (url.pathname === '/api/now/stats/incident') return Response.json({ result: { stats: { count: '7' } } });
      if (url.pathname !== '/api/now/table/incident') throw new Error('Unexpected path ' + url.pathname);
      const offset = Number(url.searchParams.get('sysparm_offset') || 0);
      const limit = Number(url.searchParams.get('sysparm_limit'));
      if (limit !== 2) throw new Error('Unexpected limit');
      return Response.json({ result: offset >= 7 ? [] : [{ number: 'INC1', short_description: 'A, "quoted" issue' }] });
    };
  `);
  const env = { ...process.env, HOME: directory, XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory,
    SERVICENOW_INSTANCE_URL: '', SERVICENOW_FORMAT: '', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1',
    JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' };
  function run(command, flags = []) {
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href,
      fileURLToPath(new URL('../bin/jsn.js', import.meta.url)), ...command, '--instance', 'https://fixture.example.test',
      '--limit', '2', '--columns', 'number,short_description', '--csv', ...flags],
    { env, cwd: directory, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return { stdout: result.stdout, stderr: result.stderr };
  }
  const records = ['records', 'list', '--table', 'incident'];
  assert.deepEqual(run(records, ['--offset', '3']), {
    stdout: 'number,short_description\nINC1,"A, ""quoted"" issue"\n',
    stderr: 'CSV pagination: returned 1 of 7 records; more available; next offset 5.\n',
  });
  // Ticket pagination uses page fullness; return two rows to trigger its unknown-total notice.
  const source = fs.readFileSync(preload, 'utf8');
  fs.writeFileSync(preload, source.replace("[{ number: 'INC1', short_description: 'A, \"quoted\" issue' }]",
    "[{ number: 'INC1' }, { number: 'INC2' }]"));
  const ticket = run(['incidents', 'list']);
  assert.match(ticket.stderr, /^CSV pagination: returned 2 records; total unknown; more available; next offset 2\.\n$/);
  assert.deepEqual(run(records, ['--offset', '7']), { stdout: '', stderr: '' });
  assert.equal(run(records, ['--no-count']).stderr, '');
  assert.equal(run(records, ['--no-csv', '--quiet']).stderr, '');
});
