import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectUpdateSetXML, updateSetFilename } from '../src/update-set-xml.js';
import { SDKClient } from '../src/sdk.js';
import { isMutationCommand } from '../src/mutations.js';
import { needsMutationContext } from '../src/mutation-context.js';
import '../src/cli.js';
const id = 'a'.repeat(32), source = 'b'.repeat(32), memberID = 'c'.repeat(32);
const xml = `<unload><sys_remote_update_set action="INSERT_OR_UPDATE"><name>Example &amp; test</name><sys_id>${id}</sys_id><remote_sys_id>${source}</remote_sys_id><state>loaded</state></sys_remote_update_set><sys_update_xml action="INSERT_OR_UPDATE"><sys_id>${memberID}</sys_id><name>sys_properties_example</name><remote_update_set>${id}</remote_update_set><action>DELETE</action><target_name>Example</target_name><payload><![CDATA[<record_update><sys_properties action="DELETE"><name>example</name></sys_properties></record_update>]]></payload></sys_update_xml></unload>`;

test('XML inspection decodes fields, reports inert delete payloads, and handles implicit payload tables', () => {
  const result = inspectUpdateSetXML(xml);
  assert.equal(result.name, 'Example & test');
  assert.equal(result.count, 1);
  assert.deepEqual(result.summary, [{ table: 'sys_properties', action: 'DELETE', count: 1 }]);
  assert.equal(result.members[0].target_name, 'Example');
});
for (const [name, transform] of [
  ['malformed XML', s => s.slice(0, -5)],
  ['DTD', s => '<!DOCTYPE unload [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + s],
  ['arbitrary envelope table', s => s.replaceAll('sys_remote_update_set', 'sys_user')],
  ['delete envelope', s => s.replace('action="INSERT_OR_UPDATE"', 'action="DELETE"')],
  ['duplicate sets', s => s.replace('</unload>', s.match(/<sys_remote_update_set.*?<\/sys_remote_update_set>/s)[0] + '</unload>')],
  ['duplicate fields', s => s.replace('<state>', '<name>Other</name><state>')],
  ['committed set', s => s.replace('>loaded<', '>committed<')],
  ['unrelated members', s => s.replace(`<remote_update_set>${id}`, `<remote_update_set>${source}`)],
  ['nested envelope fields', s => s.replace('<name>Example &amp; test</name>', '<name><sys_user/></name>')],
  ['deceptive payload table', s => s.replace('<record_update>', '<record_update table="sys_user">')],
  ['deceptive payload action', s => s.replace('sys_properties action="DELETE"', 'sys_properties action="INSERT_OR_UPDATE"')],
  ['empty payload', s => s.replace(/<record_update>.*?<\/record_update>/s, '<record_update table="sys_properties"/>')],
  ['payload DTD', s => s.replace('<![CDATA[', '<![CDATA[<!DOCTYPE record_update>')],
]) test(`XML inspection refuses ${name}`, () => assert.throws(() => inspectUpdateSetXML(transform(xml))));

test('export filenames cannot escape the destination or be dotfiles', () => {
  assert.equal(updateSetFilename('Digital Helpdesk 0.1.77'), 'Digital-Helpdesk-0.1.77.xml');
  assert.equal(updateSetFilename('../../etc/passwd'), 'etc-passwd.xml');
  assert.equal(updateSetFilename('...'), 'update-set.xml');
  assert.ok(updateSetFilename('x'.repeat(1000)).length <= 184);
});

test('only the declared import preview bypasses mutations; real imports and reopen stay guarded', () => {
  assert.equal(isMutationCommand({ _: ['updatesets', 'import'], dryRun: true }), false);
  assert.equal(isMutationCommand({ _: ['updatesets', 'import'] }), true);
  assert.equal(isMutationCommand({ _: ['updatesets', 'reopen'] }), true);
  assert.equal(isMutationCommand({ _: ['records', 'delete'], dryRun: true }), true);
  assert.equal(needsMutationContext({ _: ['updatesets', 'import'] }), false);
});

test('dry-run works with no configured profile and does not contact an invalid instance', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-import-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'sample.xml'); fs.writeFileSync(file, xml);
  const run = spawnSync(process.execPath, ['bin/jsn.js', 'updatesets', 'import', file, '--dry-run', '--json'], {
    encoding: 'utf8', timeout: 10000,
    env: { ...process.env, XDG_CONFIG_HOME: root, SERVICENOW_INSTANCE_URL: 'http://127.0.0.1:1', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' },
  });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.equal(JSON.parse(run.stdout).data.dry_run, true);
});

function sdkFixture({ existing = false, mismatch = false, postError = false } = {}) {
  const sdk = new SDKClient('https://example.service-now.com', null);
  const calls = []; let posted = false;
  sdk._warmSession = async () => 'session=test';
  sdk.list = async table => {
    calls.push({ table });
    if (table === 'sys_remote_update_set') return existing || posted ? [{ sys_id: id, name: 'Example & test', state: 'loaded' }] : [];
    if (!posted) return [];
    return mismatch ? [] : [{ sys_id: memberID, name: 'sys_properties_example', action: 'DELETE' }];
  };
  sdk.rawRequest = async (endpoint, opts) => {
    calls.push({ endpoint, opts });
    if (opts.method === 'GET') return '<form action="/sys_upload.do"><input name="sysparm_ck" value="csrf"><input name="attachFile"></form>';
    posted = true;
    if (postError) throw new Error('connection lost');
    return '<html>Uploaded</html>';
  };
  return { sdk, calls };
}

test('native import uploads multipart XML and verifies every member without committing or selecting', async () => {
  const { sdk, calls } = sdkFixture();
  const result = await sdk.importUpdateSet(xml, inspectUpdateSetXML(xml));
  assert.equal(result.count, 1); assert.equal(result.state, 'loaded');
  const posts = calls.filter(call => call.opts?.method === 'POST');
  assert.equal(posts.length, 1);
  assert.match(posts[0].endpoint, /\/sys_upload.do$/);
  assert.equal(posts[0].opts.body.get('sysparm_target'), 'sys_remote_update_set');
  assert.equal(await posts[0].opts.body.get('attachFile').text(), xml);
});

test('an already loaded set with the same content is reported, never uploaded again', async () => {
  const { sdk, calls } = sdkFixture({ existing: true });
  const result = await sdk.importUpdateSet(xml, inspectUpdateSetXML(xml));
  assert.equal(result.already_loaded, true);
  assert.equal(result.sys_id, id);
  assert.equal(calls.some(call => call.endpoint), false, 'no upload form is opened');
});
test('a verification mismatch stays a failure and is never retried', async () => {
  const { sdk, calls } = sdkFixture({ mismatch: true });
  await assert.rejects(sdk.importUpdateSet(xml, inspectUpdateSetXML(xml)), /partially loaded/);
  assert.equal(calls.filter(call => call.opts?.method === 'POST').length, 1);
});

test('a lost upload response is reconciled by reading, never by uploading twice', async () => {
  const { sdk, calls } = sdkFixture({ postError: true });
  const result = await sdk.importUpdateSet(xml, inspectUpdateSetXML(xml));
  assert.equal(result.recovered_after_error, true);
  assert.equal(result.sys_id, id);
  assert.equal(result.members_match_inspection, true);
  assert.equal(calls.filter(call => call.opts?.method === 'POST').length, 1, 'exactly one upload attempt');
});

test('member collisions refuse before opening the upload form', async () => {
  const { sdk, calls } = sdkFixture();
  sdk.list = async table => table === 'sys_update_xml' ? [{ sys_id: memberID }] : [];
  await assert.rejects(sdk.importUpdateSet(xml, inspectUpdateSetXML(xml)), /refusing to overwrite or move/);
  assert.equal(calls.some(call => call.endpoint), false);
});

test('inspection includes subsidiary payload operations and platform-default actions', () => {
  const value = xml.replace('</record_update>', '<sys_translated_text action="delete_multiple"/><sys_documentation/></record_update>');
  assert.deepEqual(inspectUpdateSetXML(value).payload_operations, [
    { table: 'sys_properties', action: 'DELETE', count: 1 },
    { table: 'sys_translated_text', action: 'delete_multiple', count: 1 },
    { table: 'sys_documentation', action: 'platform_default', count: 1 },
  ]);
});

// Loading is not transactional with the HTTP response that reports it: the
// native upload can commit and still fail in transport. A bare "fetch failed"
// sent agents into a retry of work that had already happened.
const UPLOAD_HTML = '<form action="/sys_upload.do"><input name="sysparm_ck" value="tok"><input name="attachFile" type="file"></form>';
function importableSdk(list) {
  const sdk = new SDKClient('https://example.service-now.com', {});
  const calls = { uploads: 0 };
  sdk._warmSession = async () => 'sid=session';
  sdk.rawRequest = async (url) => {
    if (url.includes('/upload.do')) return UPLOAD_HTML;
    calls.uploads += 1;
    return '';
  };
  sdk.list = async (table, params) => list(table, String(params), calls);
  return { sdk, calls };
}

test('a transport error after a successful upload reports the loaded set instead of failing', async () => {
  const loaded = [{ sys_id: id, name: 'Example & test', state: 'loaded' }];
  let setQueries = 0;
  const { sdk } = importableSdk((table, query) => {
    if (table === 'sys_update_xml') return query.includes('remote_update_set') ? [{ sys_id: memberID }] : [];
    setQueries += 1;
    if (setQueries === 2) {
      const error = new Error('fetch failed');
      error.cause = { code: 'ECONNRESET' };
      throw error;
    }
    return setQueries === 1 ? [] : loaded;
  });
  const result = await sdk.importUpdateSet(xml, inspectUpdateSetXML(xml));
  assert.equal(result.recovered_after_error, true);
  assert.equal(result.sys_id, id);
  assert.equal(result.count, 1);
  assert.equal(result.members_match_inspection, true);
});

test('re-importing the same XML reports the existing set without uploading again', async () => {
  const { sdk, calls } = importableSdk((table) => (table === 'sys_remote_update_set'
    ? [{ sys_id: 'd'.repeat(32), name: 'Example & test', state: 'loaded' }] : []));
  const result = await sdk.importUpdateSet(xml, inspectUpdateSetXML(xml));
  assert.equal(result.already_loaded, true);
  assert.equal(result.sys_id, 'd'.repeat(32));
  assert.equal(calls.uploads, 0, 'nothing is uploaded a second time');
});

test('an identity collision with different content is still refused', async () => {
  const { sdk } = importableSdk((table) => (table === 'sys_remote_update_set'
    ? [{ sys_id: 'd'.repeat(32), name: 'Some other set', state: 'loaded' }] : []));
  await assert.rejects(() => sdk.importUpdateSet(xml, inspectUpdateSetXML(xml)), /refusing to overwrite/);
});

test('a failure that left nothing behind names the transport cause and sends the reader to the record list', async () => {
  let setQueries = 0;
  const { sdk } = importableSdk((table) => {
    if (table === 'sys_update_xml') return [];
    setQueries += 1;
    if (setQueries === 2) {
      const error = new Error('fetch failed');
      error.cause = { code: 'ECONNRESET' };
      throw error;
    }
    return [];
  });
  await assert.rejects(() => sdk.importUpdateSet(xml, inspectUpdateSetXML(xml)), (error) => {
    assert.match(error.message, /fetch failed \(ECONNRESET\)/);
    assert.match(error.hint, /Retrieved Update Sets/);
    return true;
  });
});
