import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { recordsCmd } from '../src/commands/records.js';
import { isMutationCommand } from '../src/mutations.js';
import { inspectUnloadXML } from '../src/record-xml.js';

const id = n => String(n).padStart(32, '0');
const dirs = [];
after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-export-')); dirs.push(dir); return dir; };
const unload = (rows, extra = '') => `<?xml version="1.0" encoding="UTF-8"?>\n<unload unload_date="2026-11-25 06:48:57">\n${rows.map(n =>
  `<incident action="INSERT_OR_UPDATE"><active>true</active><sys_id>${id(n)}</sys_id></incident>\n`
  + `<sys_journal_field action="INSERT_OR_UPDATE"><element_id>${id(n)}</element_id><sys_id>${id(n + 100)}</sys_id></sys_journal_field>\n`).join('')}${extra}</unload>\n`;

function fixture({ count = 2, xml = unload([1, 2]), properties = [] } = {}) {
  const commands = [];
  const builder = { command(c) { commands.push(c); return this; } };
  recordsCmd(fn => fn).builder(builder);
  const handler = commands.find(c => c.command === 'export').handler;
  const calls = { count: 0, exports: [], properties: 0 };
  let data;
  const app = {
    requireInstance() {},
    sdk: {
      baseURL: 'https://example.service-now.com',
      aggregateCount: async () => { calls.count++; return count; },
      list: async (table, params, opts = {}) => {
        if (opts.responseMetadata) opts.responseMetadata.total = 1;
        if (table === 'sys_db_object') return [{ sys_id: 'f'.repeat(32), name: 'incident', super_class: '' }];
        if (table === 'sys_dictionary') return [{ sys_id: 'e'.repeat(32), name: 'incident', element: 'active', internal_type: 'boolean', reference: '' }];
        throw new Error(`unexpected read of ${table}`);
      },
      async listStrict(table, ...rest) {
        if (table === 'sys_properties') { calls.properties++; return properties; }
        return this.list(table, ...rest);
      },
      rawRequest: async (url, opts) => { calls.exports.push(url); calls.timeout = opts.timeout; return xml; },
    },
    ok(value, meta) { data = { value, meta }; },
  };
  return { calls, get data() { return data; },
    run: (args = {}) => handler({ table: 'incident', query: 'active=true', ...args }, app) };
}

test('export validates, counts, then GETs the unload processor and reports what the XML holds', async () => {
  const f = fixture({ count: 5 });
  const dir = tmp();
  const out = path.join(dir, 'p1.xml');
  await f.run({ limit: 2, out });
  assert.deepEqual(f.calls.exports, ['https://example.service-now.com/incident.do?UNL=&sysparm_query=active%3Dtrue&sysparm_record_count=2']);
  // 10,000 dictionary rows took 111 seconds on a PDI, past the 30-second default.
  assert.equal(f.calls.timeout, 10 * 60 * 1000);
  assert.deepEqual(f.data.value, { table: 'incident', query: 'active=true', matched: 5, records: 2,
    tables: { incident: 2, sys_journal_field: 2 }, bytes: Buffer.byteLength(unload([1, 2])), out });
  assert.match(f.data.meta.summary, /Exported 2 of 5 incident record\(s\)/);
  assert.equal(fs.readFileSync(out, 'utf8'), unload([1, 2]));
  // An existing file is never overwritten, and is refused before any request.
  const again = fixture({ count: 5 });
  await assert.rejects(again.run({ limit: 2, out }), /already exists; export never overwrites a file/);
  assert.equal(again.calls.count, 0);
  assert.deepEqual(again.calls.exports, []);
  assert.equal(fs.readFileSync(out, 'utf8'), unload([1, 2]));
});

test('export refuses a query naming a column the table lacks before counting or exporting', async () => {
  const f = fixture();
  await assert.rejects(f.run({ query: 'active=true^zzz_nope=1' }), /Export refused: .*zzz_nope/);
  assert.equal(f.calls.count, 0);
  assert.deepEqual(f.calls.exports, []);
});

test('export refuses bad input without any request', async () => {
  for (const args of [{ query: '' }, { query: '   ' }, { table: 'incident.do?x=' }, { limit: 0 }, { limit: 1.5 }, { limit: Number.NaN }, { table: 'sys_update_xml' }, { table: 'sys_remote_update_set' }]) {
    const f = fixture();
    await assert.rejects(f.run(args), { code: 'usage_error' });
    assert.equal(f.calls.count, 0);
    assert.deepEqual(f.calls.exports, []);
  }
  // An update set's rows exported one table at a time do not load as an update set.
  await assert.rejects(fixture().run({ table: 'sys_update_xml' }), /parts of an update set; export the whole set with jsn updatesets export/);
});

test('export refuses a set over the instance cap, honouring the export limit properties', async () => {
  const cases = [
    [{ count: 10001 }, /10001 incident records match, but the instance exports at most 10000 per file \(the platform default; neither export limit property is set\)/],
    [{ count: 6, properties: [{ name: 'glide.xml.export.limit', value: '5' }] }, /at most 5 per file \(glide.xml.export.limit\)/],
    [{ count: 6, properties: [{ name: 'glide.ui.export.limit', value: '4' }] }, /at most 4 per file \(glide.ui.export.limit\)/],
    [{ count: 6, properties: [{ name: 'glide.xml.export.limit', value: '5' }, { name: 'glide.ui.export.limit', value: '100' }] }, /at most 5 per file \(glide.xml.export.limit\)/],
  ];
  for (const [options, message] of cases) {
    const f = fixture(options);
    await assert.rejects(f.run(), message);
    assert.deepEqual(f.calls.exports, []);
  }
  // --limit at or under the cap is the explicit way to export part of a large set.
  const f = fixture({ count: 20000 });
  await f.run({ limit: 2, json: true });
  assert.equal(f.calls.exports.length, 1);
  assert.equal(f.data.value.records, 2);
});

test('export refuses when nothing matches, without exporting', async () => {
  const f = fixture({ count: 0 });
  await assert.rejects(f.run(), /No incident records match the query; nothing exported/);
  assert.deepEqual(f.calls.exports, []);
});

test('export never reports a short, wide, empty or non-XML response as success, and writes no file', async () => {
  const cases = [
    [unload([1]), /holds 1 incident record\(s\) but 2 matched/],
    [unload([1, 2, 3]), /holds 3 incident record\(s\) but only 2 were expected/],
    ['', /non-XML response \(empty body\)/],
    ['<html><body>Log in</body></html>', /non-XML response/],
    ['<?xml version="1.0"?><xml><incident/></xml>', /unreadable XML: Expected unload XML/],
    ['<?xml version="1.0"?><unload><incident action="INSERT_OR_UPDATE">', /unreadable XML/],
    [unload([1]).replace('</unload>', `<incident action="INSERT_OR_UPDATE"><active>true</active></incident></unload>`), /without a sys_id/],
  ];
  for (const [xml, message] of cases) {
    const f = fixture({ xml });
    const dir = tmp();
    const out = path.join(dir, 'never.xml');
    await assert.rejects(f.run({ out }), message);
    assert.equal(fs.existsSync(out), false);
    assert.equal(f.data, undefined);
  }
  // An instance that ignores --limit is caught too.
  const f = fixture({ count: 5, xml: unload([1, 2]) });
  await assert.rejects(f.run({ limit: 1, json: true }), /holds 2 incident record\(s\) but only 1 were expected/);
  assert.equal(f.data, undefined);
});

test('export counts child-class rows as matches and related rows separately', async () => {
  const xml = '<unload><change_request action="INSERT_OR_UPDATE"><sys_id>' + id(1) + '</sys_id></change_request>'
    + '<sys_attachment action="INSERT_OR_UPDATE"><sys_id>' + id(2) + '</sys_id></sys_attachment>'
    + '<sys_attachment_doc action="INSERT_OR_UPDATE"><sys_id>' + id(3) + '</sys_id></sys_attachment_doc></unload>';
  const f = fixture({ count: 1, xml });
  f.calls.exports.length = 0;
  await f.run({ json: true });
  assert.equal(f.data.value.records, 1);
  assert.deepEqual(f.data.value.tables, { change_request: 1, sys_attachment: 1, sys_attachment_doc: 1 });
});

test('unload XML parsing lists each top-level record and refuses DOCTYPE', () => {
  assert.deepEqual(inspectUnloadXML(unload([1])), [
    { table: 'incident', action: 'INSERT_OR_UPDATE', sys_id: id(1) },
    { table: 'sys_journal_field', action: 'INSERT_OR_UPDATE', sys_id: id(101) },
  ]);
  assert.throws(() => inspectUnloadXML('<!DOCTYPE unload [<!ENTITY x SYSTEM "file:///etc/passwd">]><unload>&x;</unload>'), /DOCTYPE/);
});

test('export is a read, so read-only profiles allow it, and its help names its guards', () => {
  assert.equal(isMutationCommand({ _: ['records', 'export'] }), false);
  const result = spawnSync(process.execPath, ['cli/bin/jsn.js', 'records', 'export', '--help'], {
    cwd: new URL('../../', import.meta.url), encoding: 'utf8',
    env: { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  for (const flag of ['--table', '--query', '--limit', '--out', 'glide.xml.export.limit', 'jsn updatesets export']) assert.ok(result.stdout.includes(flag), flag);
});
