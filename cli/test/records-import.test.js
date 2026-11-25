import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { recordsCmd } from '../src/commands/records.js';
import { isMutationCommand } from '../src/mutations.js';

const id = n => String(n).padStart(32, '0');
const row = (table, n, { action = 'INSERT_OR_UPDATE', updated = '2026-11-25 06:00:00', mods = '3' } = {}) =>
  `<${table} action="${action}"><sys_id>${id(n)}</sys_id><sys_updated_on>${updated}</sys_updated_on><sys_mod_count>${mods}</sys_mod_count></${table}>`;
const unload = rows => `<?xml version="1.0" encoding="UTF-8"?>\n<unload unload_date="2026-11-25 06:48:57">\n${rows.join('\n')}\n</unload>\n`;
const FORM = '<form action="/sys_upload.do" method="post"><input name="sysparm_ck" value="tok123"><input type="file" name="attachFile"></form>';

const dirs = [];
after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });
function write(xml) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-import-'));
  dirs.push(dir);
  const file = path.join(dir, 'in.xml');
  fs.writeFileSync(file, xml);
  return file;
}

// db: table -> Map(sys_id -> row). upload: what the instance does with the file.
function fixture({ db = {}, upload = 'apply', form = FORM, unreadable = [] } = {}) {
  const commands = [];
  const builder = { command(c) { commands.push(c); return this; } };
  recordsCmd(fn => fn).builder(builder);
  const handler = commands.find(c => c.command === 'import <file>').handler;
  const calls = { requests: 0, posts: [], reads: [] };
  const tables = new Map(Object.entries(db).map(([t, rows]) => [t, new Map(rows.map(r => [r.sys_id, r]))]));
  let data;
  const app = {
    requireInstance() {},
    sdk: {
      baseURL: 'https://example.service-now.com',
      _warmSession: async () => { calls.requests++; return 'JSESSIONID=1'; },
      rawRequest: async (url, opts) => {
        calls.requests++;
        if (opts.method === 'GET') return form;
        calls.posts.push({ url, opts });
        if (upload === 'throw') throw new Error('fetch failed');
        if (upload === 'apply-then-throw' || upload === 'apply') {
          const xml = await opts.body.get('attachFile').text();
          for (const [, table, action, body] of xml.matchAll(/<(\w+) action="(\w+)">(.*?)<\/\1>/g)) {
            const field = name => body.match(new RegExp(`<${name}>(.*?)</${name}>`))?.[1];
            if (!tables.has(table)) tables.set(table, new Map());
            if (action === 'DELETE') tables.get(table).delete(field('sys_id'));
            else tables.get(table).set(field('sys_id'), { sys_id: field('sys_id'), sys_updated_on: field('sys_updated_on'), sys_mod_count: field('sys_mod_count') });
          }
          if (upload === 'apply-then-throw') throw new Error('socket hang up');
        }
        return '';
      },
      listStrict: async (table, params) => {
        calls.requests++;
        const ids = params.get('sysparm_query').replace(/^sys_idIN/, '').split(',');
        calls.reads.push({ table, ids, limit: params.get('sysparm_limit'), fields: params.get('sysparm_fields') });
        if (unreadable.includes(table)) throw new Error(`Invalid table ${table}`);
        return ids.map(i => tables.get(table)?.get(i)).filter(Boolean);
      },
    },
    ok(value, meta) { data = { value, meta }; },
  };
  return { calls, tables, get data() { return data; },
    run: async (args) => {
      const previous = process.exitCode;
      try { await handler({ yes: true, ...args }, app); return process.exitCode; } finally { process.exitCode = previous; }
    } };
}

test('import without --yes, or with --dry-run, previews the file and sends nothing', async () => {
  const file = write(unload([row('incident', 1), row('sys_journal_field', 2), row('incident', 3, { action: 'DELETE' })]));
  for (const args of [{ file, yes: false }, { file, yes: true, 'dry-run': true }]) {
    const f = fixture();
    await f.run(args);
    assert.equal(f.calls.requests, 0);
    assert.equal(f.data.value.dry_run, true);
    assert.deepEqual(f.data.value.tables, { incident: 2, sys_journal_field: 1 });
    assert.equal(f.data.value.deletes, 1);
    assert.equal(f.data.value.rerun, `jsn records import ${file} --yes`);
    // The hint keeps the profile, so following it cannot import into another instance.
    const pinned = fixture();
    await pinned.run({ ...args, profile: 'target' });
    assert.equal(pinned.data.value.rerun, `jsn records import ${file} --yes --profile target`);
    assert.match(f.data.meta.summary, /Dry run: would import 3 record\(s\) across 2 table\(s\), 1 marked DELETE; nothing was sent/);
  }
});

test('import refuses a file it could not verify, before any request', async () => {
  const cases = [
    ['<unload><incident action="INSERT_OR_UPDATE"><sys_id>', /Invalid unload XML/],
    ['<!DOCTYPE unload [<!ENTITY x SYSTEM "file:///etc/passwd">]><unload>&x;</unload>', /DOCTYPE/],
    ['<xml><incident/></xml>', /<unload> root/],
    [unload([]), /holds no records/],
    [unload(['<incident action="INSERT_OR_UPDATE"><active>true</active></incident>']), /needs a 32-character sys_id/],
    [unload([row('incident', 1, { action: 'INSERT' })]), /action "INSERT" is not INSERT_OR_UPDATE or DELETE/],
    [unload([row('incident', 1).replace(' action="INSERT_OR_UPDATE"', '')]), /action "" is not/],
    [unload([row('incident', 1), row('incident', 1, { action: 'DELETE' })]), /appears twice/],
    [unload([row('sys_remote_update_set', 1), row('sys_update_xml', 2)]), /jsn updatesets import/],
    [unload([row('x.y', 1)]), /Invalid table name in the file: x.y/],
  ];
  for (const [xml, message] of cases) {
    const f = fixture();
    await assert.rejects(f.run({ file: write(xml) }), message);
    assert.equal(f.calls.requests, 0);
    assert.equal(f.data, undefined);
  }
  const big = write(Buffer.alloc(50 * 1024 * 1024 + 1, 0x20));
  const f = fixture();
  await assert.rejects(f.run({ file: big }), /no larger than 50 MiB/);
  assert.equal(f.calls.requests, 0);
});

test('import uploads nothing when the upload form is unavailable', async () => {
  for (const form of ['<html>Log in</html>', FORM.replace('/sys_upload.do', '/login.do'), FORM.replace('attachFile', 'other'), FORM.replace(' value="tok123"', '')]) {
    const f = fixture({ form });
    await assert.rejects(f.run({ file: write(unload([row('incident', 1)])) }), /upload form is unavailable; nothing was uploaded/);
    assert.equal(f.calls.posts.length, 0);
    assert.equal(f.calls.reads.length, 0);
  }
});

test('import posts the file to sys_upload.do and reports success only when every record reads back as the file has it', async () => {
  const xml = unload([row('incident', 1), row('sys_journal_field', 2), row('incident', 3, { action: 'DELETE' })]);
  const f = fixture({ db: { incident: [{ sys_id: id(3), sys_updated_on: 'x', sys_mod_count: '0' }] } });
  assert.equal(await f.run({ file: write(xml) }), undefined);
  assert.equal(f.calls.posts.length, 1);
  const { url, opts } = f.calls.posts[0];
  assert.equal(url, 'https://example.service-now.com/sys_upload.do');
  assert.equal(opts.headers['X-UserToken'], 'tok123');
  assert.equal(opts.body.get('sysparm_ck'), 'tok123');
  assert.equal(opts.body.get('sysparm_target'), 'incident');
  // A referring URL or a Referer header turns success into a redirect (a 302 back to upload.do on a PDI).
  assert.equal(opts.body.has('sysparm_referring_url'), false);
  assert.equal(opts.headers.Referer, undefined);
  // The instance answers only once the load finishes.
  assert.equal(opts.timeout, 10 * 60 * 1000);
  assert.equal(await opts.body.get('attachFile').text(), xml);
  assert.equal(f.data.value.verified, true);
  assert.equal(f.data.value.landed, 3);
  assert.deepEqual(f.data.value.problems, []);
  assert.match(f.data.meta.summary, /^Imported 3 record\(s\) across 2 table\(s\), 1 marked DELETE; a re-read finds each record present \(gone, for DELETE\) with the file's sys_updated_on and sys_mod_count where it has them/);
  assert.deepEqual(f.calls.reads.map(r => [r.table, r.fields]), [['incident', 'sys_id,sys_updated_on,sys_mod_count'], ['sys_journal_field', 'sys_id,sys_updated_on,sys_mod_count']]);
});

test('an upload the instance answered but did not load is never reported as success', async () => {
  const xml = unload([row('incident', 1), row('incident', 2), row('incident', 3, { action: 'DELETE' })]);
  // Record 2 exists but differs from the file; record 3 should have been deleted.
  const f = fixture({ upload: 'noop', db: { incident: [{ sys_id: id(2), sys_updated_on: '2025-01-01 00:00:00', sys_mod_count: '3' }, { sys_id: id(3) }] } });
  assert.equal(await f.run({ file: write(xml) }), 1);
  assert.equal(f.data.value.verified, false);
  assert.equal(f.data.value.landed, 0);
  assert.deepEqual(f.data.value.problems.map(p => [p.sys_id, p.status]), [[id(1), 'missing'], [id(2), 'differs'], [id(3), 'still_present']]);
  assert.match(f.data.meta.summary, /^Import incomplete or unverified: 0 of 3 record\(s\) landed; 1 missing, 1 differs, 1 still present/);
});

test('a transport error after the upload still re-reads, and reports what landed', async () => {
  const xml = unload([row('incident', 1)]);
  const landed = fixture({ upload: 'apply-then-throw' });
  assert.equal(await landed.run({ file: write(xml) }), undefined);
  assert.equal(landed.data.value.verified, true);
  assert.equal(landed.data.value.upload_error, 'socket hang up');
  const lost = fixture({ upload: 'throw' });
  assert.equal(await lost.run({ file: write(xml) }), 1);
  assert.equal(lost.data.value.verified, false);
  assert.equal(lost.data.value.upload_error, 'fetch failed');
  assert.deepEqual(lost.data.value.problems.map(p => p.status), ['missing']);
});

test('a table the instance cannot read is reported unverified, and reads stay in chunks of 100', async () => {
  const xml = unload([...Array.from({ length: 250 }, (_, i) => row('incident', i + 1)), row('u_gone', 999)]);
  const f = fixture({ unreadable: ['u_gone'] });
  assert.equal(await f.run({ file: write(xml) }), 1);
  assert.deepEqual(f.calls.reads.map(r => [r.table, r.ids.length, r.limit]), [['incident', 100, '100'], ['incident', 100, '100'], ['incident', 50, '50'], ['u_gone', 1, '1']]);
  assert.equal(f.data.value.landed, 250);
  assert.deepEqual(f.data.value.problems, [{ table: 'u_gone', sys_id: id(999), action: 'INSERT_OR_UPDATE', status: 'unreadable', error: 'Invalid table u_gone' }]);
});

test('import is a mutation that read-only profiles refuse, its dry run is local, and its help names its guards', () => {
  assert.equal(isMutationCommand({ _: ['records', 'import'] }), true);
  assert.equal(isMutationCommand({ _: ['records', 'import'], dryRun: true }), false);
  const result = spawnSync(process.execPath, ['cli/bin/jsn.js', 'records', 'import', '--help'], {
    cwd: new URL('../../', import.meta.url), encoding: 'utf8',
    env: { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  for (const text of ['--yes', '--dry-run', 'action="DELETE"', 'business rules', 'exits nonzero']) assert.ok(result.stdout.includes(text), text);
});
