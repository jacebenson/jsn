import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { attachmentFilename } from '../src/commands/attachments.js';
const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));

test('remote filenames cannot select directories, devices or dot paths', () => {
  for (const input of ['../../report.bin', 'C:\\temp\\report.bin', '/tmp/report.bin']) assert.equal(attachmentFilename(input, 'id'), 'report.bin');
  for (const input of ['', '.', '..', 'CON.txt', 'nul', 'COM1.xml']) assert.equal(attachmentFilename(input, 'id'), 'id.bin');
  assert.equal(attachmentFilename('report?.bin', 'id'), 'report_.bin');
});

test('standalone attachment CLI discovers, lists, transfers exact bytes and guards uploads through aliases', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jsn attachments '));
  let server;
  t.after(async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const bytes = Buffer.from([0, 255, 1, 128, 10]), calls = [], uploads = [];
  const metadata = { sys_id: 'attachment-id', file_name: '../../report.bin', size_bytes: String(bytes.length) };
  server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    calls.push({ method: request.method, path: url.pathname });
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/now/attachment/file' && request.method === 'POST') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      uploads.push({ bytes: Buffer.concat(chunks), query: Object.fromEntries(url.searchParams) });
      response.end(JSON.stringify({ result: metadata })); return;
    }
    if (url.pathname === '/api/now/attachment/attachment-id/file') {
      response.setHeader('Content-Type', 'application/octet-stream'); response.end(bytes); return;
    }
    if (url.pathname === '/api/now/attachment/attachment-id') { response.end(JSON.stringify({ result: metadata })); return; }
    if (url.pathname === '/api/now/attachment') {
      assert.equal(url.searchParams.get('sysparm_query'), 'table_sys_id=parent-id');
      response.end(JSON.stringify({ result: [metadata] })); return;
    }
    response.end(JSON.stringify({ result: [] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const instance = `http://127.0.0.1:${server.address().port}`;
  await fs.mkdir(path.join(directory, 'servicenow'));
  await fs.writeFile(path.join(directory, 'servicenow', 'config.json'), JSON.stringify({ default_profile: 'other', profiles: {
    other: { instance_url: 'http://example.invalid', auth_method: 'basic' },
    selected: { instance_url: instance, auth_method: 'basic' },
    readonly: { instance_url: instance, auth_method: 'basic', read_only: true },
  } }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SN_|SERVICENOW_)/i.test(key)));
  Object.assign(env, { XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret',
    JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
  async function run(args, code = 0, profile = 'selected') {
    let result;
    try { result = { ...await execute(process.execPath, [cli, '--profile', profile, ...args], { cwd: directory, env, timeout: 15000 }), code: 0 }; }
    catch (error) { result = error; }
    assert.equal(result.code, code, result.stderr || result.stdout);
    assert.ok(!(result.stdout + result.stderr).includes('fixture-secret'));
    return result.stdout;
  }
  const discovery = JSON.parse(await run(['discover', 'attachments', '--json']));
  assert.ok(discovery.data.commands.some(command => command.name === 'attachments'));
  const parent = JSON.parse(await run(['attachments', '--json']));
  assert.deepEqual(parent.data.subcommands.map(command => command.name), ['list', 'download', 'upload']);
  assert.match(await run(['attachments', 'upload', '--help']), /Parent table/);
  const listed = JSON.parse(await run(['attachments', 'list', '--sys-id', 'parent-id', '--json']));
  assert.equal(listed.data.attachments[0].sys_id, 'attachment-id');
  assert.equal(JSON.parse(await run(['attachment', 'list', '-s', 'parent-id', '--json', '--get', 'data.count'])), 1);
  const downloaded = JSON.parse(await run(['attachments', 'download', 'attachment-id', '--json']));
  assert.equal(downloaded.data.out, 'report.bin');
  assert.deepEqual(await fs.readFile(path.join(directory, 'report.bin')), bytes);
  await run(['attachments', 'get', 'attachment-id', '--json'], 1);
  await fs.writeFile(path.join(directory, 'report.bin'), 'keep local');
  await run(['attachments', 'get', 'attachment-id', '--json'], 1);
  assert.equal(await fs.readFile(path.join(directory, 'report.bin'), 'utf8'), 'keep local');
  await run(['attachments', 'get', 'attachment-id', '--overwrite', '--json']);
  assert.deepEqual(await fs.readFile(path.join(directory, 'report.bin')), bytes);
  const before = calls.length;
  await run(['attachments', 'download', 'attachment-id', '--out', 'chosen.bin', '--json']);
  assert.equal(calls.slice(before).filter(call => call.path === '/api/now/attachment/attachment-id').length, 0, '--out needs no filename metadata read');
  assert.deepEqual(await fs.readFile(path.join(directory, 'chosen.bin')), bytes);
  const file = path.join(directory, 'upload.bin'); await fs.writeFile(file, bytes);
  await run(['attachments', 'upload', file, '--table', 'incident', '--sys-id', 'parent-id', '--json'], 1);
  assert.equal(uploads.length, 0, 'upload requires approval');
  for (const [root, action] of [['attachments', 'upload'], ['attachments', 'add'], ['attachment', 'add']]) {
    const start = calls.length;
    await run([root, action, file, '--table', 'incident', '--sys-id', 'parent-id', '--force', '--json'], 1, 'readonly');
    assert.equal(calls.length, start, 'all upload aliases are blocked before requests on read-only profiles');
  }
  const uploaded = JSON.parse(await run(['attachments', 'upload', file, '--table', 'incident', '--sys-id', 'parent-id', '--force', '--json']));
  assert.equal(uploaded.data.sys_id, 'attachment-id');
  assert.deepEqual(uploads[0].bytes, bytes);
  assert.deepEqual(uploads[0].query, { table_name: 'incident', table_sys_id: 'parent-id', file_name: 'upload.bin' });
  await run(['attachments', 'add', file, '--table', 'incident', '--sys-id', 'parent-id', '--name', 'renamed.bin', '--force', '--json']);
  assert.equal(uploads[1].query.file_name, 'renamed.bin');
  await run(['records', 'attachments', '--json'], 2);
});
