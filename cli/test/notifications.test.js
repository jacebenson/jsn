import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describeNotification, mailScripts } from '../src/notifications.js';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';

const id = n => String(n).padStart(32, '0');
const TEMPLATE = id(7);
const pair = (value, display = value) => ({ value, display_value: display });
function notification(overrides = {}) {
  return { sys_id: pair(id(1)), name: pair('Incident opened'), collection: pair('incident', 'Incident'),
    generation_type: pair('engine', 'Record inserted or updated'), action_insert: pair('true'), action_update: pair('false'),
    event_name: pair(''), condition: pair('active=true'), advanced_condition: pair(''), content_type: pair('text/html', 'HTML'),
    template: pair('', ''), message_html: pair('<p>${number}</p>${mail_script:own_details}${mail_script:own_details}'), ...overrides };
}
const templateRow = (body, sysId = TEMPLATE) => ({ sys_id: pair(sysId), name: pair('Branded'), message_html: pair(body), email_layout: pair(id(8), 'Branded layout') });
function fakeSdk(result) {
  const calls = [];
  return { calls, async listStrict(table, params) {
    calls.push({ table, params: Object.fromEntries(params) });
    if (result instanceof Error) throw result;
    return result;
  } };
}
const withTemplate = overrides => notification({ template: pair(TEMPLATE, 'Branded'), ...overrides });
const without = (row, field) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== field));

test('a template with a body supplies the body, not the notification message_html', async () => {
  const sdk = fakeSdk([templateRow('<div>${mail_script:template_header}</div>')]);
  const { body } = await describeNotification(sdk, withTemplate());
  assert.deepEqual(body, { source: 'template', status: 'complete', template: { sys_id: TEMPLATE, name: 'Branded', layout: 'Branded layout' }, mail_scripts: ['template_header'] });
  assert.deepEqual(sdk.calls, [{ table: 'sysevent_email_template', params: { sysparm_query: `sys_id=${TEMPLATE}`,
    sysparm_fields: 'sys_id,name,message_html,email_layout', sysparm_limit: '1', sysparm_display_value: 'all' } }]);
});

test('an empty template leaves the notification body in play, and no template means no read', async () => {
  const empty = await describeNotification(fakeSdk([templateRow('')]), withTemplate());
  assert.deepEqual(empty.body, { source: 'notification', status: 'complete', template: { sys_id: TEMPLATE, name: 'Branded', layout: 'Branded layout' }, mail_scripts: ['own_details'] });
  const sdk = fakeSdk([]);
  const none = await describeNotification(sdk, notification());
  assert.deepEqual(none.body, { source: 'notification', status: 'complete', template: null, mail_scripts: ['own_details'] });
  assert.equal(sdk.calls.length, 0);
});

test('an unreadable, missing or different template is never reported as the notification body', async () => {
  const denied = Object.assign(new Error('Access forbidden (HTTP 403).'), { status: 403 });
  for (const result of [denied, [], [templateRow('<p>x</p>', id(9))], [null]]) {
    const { body } = await describeNotification(fakeSdk(result), withTemplate());
    assert.equal(body.source, null, JSON.stringify(result));
    assert.equal(body.status, 'unavailable');
    assert.equal(body.template.sys_id, TEMPLATE);
    assert.ok(!('mail_scripts' in body));
  }
  const sdk = fakeSdk([]);
  const malformed = await describeNotification(sdk, withTemplate({ template: pair('x^ORsys_idISNOTEMPTY', 'Odd') }));
  assert.equal(malformed.body.status, 'unavailable');
  assert.equal(sdk.calls.length, 0);
});

test('plain-text notifications claim no body source and read nothing', async () => {
  const sdk = fakeSdk([templateRow('<p>x</p>')]);
  const { body } = await describeNotification(sdk, withTemplate({ content_type: pair('text/plain', 'Plain text') }));
  assert.equal(body.source, null);
  assert.equal(body.status, 'unsupported');
  assert.equal(sdk.calls.length, 0);
  const own = await describeNotification(sdk, notification({ content_type: pair('text/plain', 'Plain text') }));
  assert.equal(own.body.status, 'unsupported');
  assert.equal(sdk.calls.length, 0);
});

test('labels or missing fields make delivery unavailable instead of guessing', async () => {
  const sdk = fakeSdk([templateRow('<p>x</p>')]);
  assert.equal((await describeNotification(sdk, withTemplate(), { displayValues: 'display' })).status, 'unavailable');
  assert.equal((await describeNotification(sdk, without(withTemplate(), 'template'))).status, 'unavailable');
  assert.equal((await describeNotification(sdk, without(withTemplate(), 'content_type'))).status, 'unavailable');
  assert.equal(sdk.calls.length, 0);
  const { body } = await describeNotification(fakeSdk([without(templateRow('<p>x</p>'), 'message_html')]), withTemplate());
  assert.equal(body.status, 'unavailable');
});

test('the trigger says what sends it: a record save, an event or a flow', async () => {
  const sdk = fakeSdk([]);
  assert.deepEqual((await describeNotification(sdk, notification())).trigger,
    { kind: 'record', table: 'incident', on_insert: true, on_update: false, condition: 'active=true', advanced_condition: false });
  assert.deepEqual((await describeNotification(sdk, notification({ generation_type: pair('event', 'Event is fired'), event_name: pair('incident.escalated'), advanced_condition: pair('answer = true;') }))).trigger,
    { kind: 'event', table: 'incident', event: 'incident.escalated', condition: 'active=true', advanced_condition: true });
  assert.deepEqual((await describeNotification(sdk, notification({ generation_type: pair('triggered', 'Triggered') }))).trigger,
    { kind: 'flow', table: 'incident' });
  assert.deepEqual(mailScripts('${mail_script:a} ${mail_script:b} ${mail_script:a} ${number}'), ['a', 'b']);
});

test('real CLI lists and shows notifications on a read-only profile and refuses writes', async () => {
  const calls = [];
  const record = withTemplate({ sys_scope: pair('global', 'Global'), sys_updated_on: pair('2026-01-01 00:00:00') });
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    calls.push({ method: req.method, pathname: url.pathname, query: url.searchParams.get('sysparm_query') });
    res.setHeader('Content-Type', 'application/json');
    const table = url.pathname.startsWith('/api/now/table/') ? url.pathname.split('/').pop() : '';
    if (req.method !== 'GET' && url.pathname !== '/angular.do') { res.statusCode = 405; res.end('{"error":{"message":"mutation refused"}}'); return; }
    const rows = table === 'sysevent_email_action' ? [record] : table === 'sysevent_email_template' ? [templateRow('<div>${mail_script:template_header}</div>')] : [];
    const shape = { true: 'display_value', false: 'value' }[url.searchParams.get('sysparm_display_value')];
    res.end(JSON.stringify({ result: shape ? rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value[shape]]))) : rows }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-notifications-'));
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: true } } }));
  const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1', JSN_NO_DOCS_CHECK: '1', CI: '1' });
  const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const run = args => promisify(execFile)(process.execPath, [...loopbackCredentialArgs, cli, ...args], { env, cwd: dir, timeout: 20000 });
  try {
    const list = JSON.parse((await run(['notifications', 'list', '--json'])).stdout);
    assert.equal(list.ok, true);
    assert.equal(list.data.table, 'sysevent_email_action');
    assert.deepEqual(list.data.columns, ['name', 'collection', 'generation_type', 'active', 'weight', 'sends_on', 'recipients', 'body']);
    const before = calls.length;
    const show = JSON.parse((await run(['notifications', 'show', id(1), '--json'])).stdout);
    assert.equal(show.ok, true);
    assert.deepEqual(show.data._delivery.body.mail_scripts, ['template_header']);
    assert.equal(show.data._delivery.trigger.kind, 'record');
    const reads = calls.slice(before).filter(call => call.pathname.startsWith('/api/now/table/'));
    assert.deepEqual(reads.map(call => [call.pathname, call.query]), [['/api/now/table/sysevent_email_action', `sys_id=${id(1)}`], ['/api/now/table/sysevent_email_template', `sys_id=${TEMPLATE}`]]);
    assert.equal(JSON.parse((await run(['notification', 'show', id(1), '--get', 'data._delivery.body.source'])).stdout), 'template');
    const human = await run(['notifications', 'show', id(1), '--format', 'styled']);
    assert.match(human.stdout, /Sends on: record insert on incident; condition: active=true\n {2}Body: template Branded \(layout Branded layout\); mail scripts: template_header\n/);
    assert.equal(JSON.parse((await run(['notifications', 'show', id(1), '--display-values', 'raw', '--get', 'data._delivery.body.source'])).stdout), 'template');
    const beforeLabels = calls.length;
    const labels = JSON.parse((await run(['notifications', 'show', id(1), '--display-values', 'display', '--json'])).stdout);
    assert.equal(labels.data._delivery.status, 'unavailable');
    assert.ok(calls.slice(beforeLabels).every(call => call.pathname !== '/api/now/table/sysevent_email_template'));
    assert.match((await run(['notifications', 'show', id(1), '--display-values', 'display', '--format', 'styled'])).stdout, /Delivery: unavailable\. Display values hide/);
    const help = (await run(['notifications', '--help'])).stdout;
    assert.match(help, /^ {2}show <identifier>/m);
    assert.doesNotMatch(help, /^ {2}(create|update|delete)\b/m);
    const beforeRejects = calls.length;
    for (const args of [['create', '-f', 'name=x'], ['update', id(1), '-f', 'name=x'], ['delete', id(1)]]) {
      await assert.rejects(run(['notifications', ...args, '--json']), undefined, JSON.stringify(args));
    }
    assert.equal(calls.length, beforeRejects);
    assert.ok(calls.every(call => call.method === 'GET' || call.pathname === '/angular.do'));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
