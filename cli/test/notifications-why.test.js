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
import { buildCLI } from '../src/cli.js';
import { isMutationCommand } from '../src/mutations.js';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';

const id = n => String(n).padStart(32, '0');
const pair = (value, display = value) => ({ value, display_value: display });
const ENGINE = id(1);
const EVENT = id(2);
const FLOW = id(3);
const RECORD = id(20);
const USER = id(30);
const EMAIL = id(40);
const TEMPLATE = id(50);

const notificationRows = () => [
  {
    sys_id: pair(ENGINE), name: pair('Incident commented for ITIL'), collection: pair('incident', 'Incident'),
    generation_type: pair('engine', 'Record inserted or updated'), active: pair('true'), weight: pair('20'),
    action_insert: pair('false'), action_update: pair('true'), event_name: pair(''), condition: pair('commentsVALCHANGES'),
    advanced_condition: pair(''), content_type: pair('text/html', 'HTML only'), template: pair('', ''),
    message_html: pair('<p>${mail_script:own_details}</p>'), message_text: pair(''), recipient_users: pair(''),
    recipient_groups: pair(''), recipient_fields: pair('assigned_to,watch_list'), event_parm_1: pair('false'),
    event_parm_2: pair('false'), send_self: pair('false'), exclude_delegates: pair('false'), sys_scope: pair('global', 'Global'),
  },
  {
    sys_id: pair(EVENT), name: pair('Incident resolved'), collection: pair('incident', 'Incident'),
    generation_type: pair('event', 'Event is fired'), active: pair('true'), weight: pair('0'),
    action_insert: pair('false'), action_update: pair('false'), event_name: pair('incident.resolved'),
    condition: pair(''), advanced_condition: pair(''), content_type: pair('text/html', 'HTML only'),
    template: pair(TEMPLATE, 'Branded'), message_html: pair('<p>own</p>'), message_text: pair(''),
    recipient_users: pair(''), recipient_groups: pair(''), recipient_fields: pair('caller_id'),
    event_parm_1: pair('false'), event_parm_2: pair('false'), send_self: pair('false'), exclude_delegates: pair('false'),
    sys_scope: pair('global', 'Global'),
  },
  {
    sys_id: pair(FLOW), name: pair('Incident Priority Raised'), collection: pair('incident', 'Incident'),
    generation_type: pair('triggered', 'Triggered'), active: pair('true'), weight: pair('0'),
    action_insert: pair('false'), action_update: pair('false'), event_name: pair(''), condition: pair(''),
    advanced_condition: pair(''), content_type: pair('text/html', 'HTML only'), template: pair(''),
    message_html: pair('<p>flow</p>'), message_text: pair(''), recipient_users: pair(''), recipient_groups: pair(''),
    recipient_fields: pair('assigned_to'), event_parm_1: pair('false'), event_parm_2: pair('false'),
    send_self: pair('false'), exclude_delegates: pair('false'), sys_scope: pair('global', 'Global'),
  },
];

const eventRows = () => [
  { sys_id: id(60), name: 'notification_engine.process', instance: RECORD, parm1: ENGINE, parm2: USER,
    state: 'processed', processed: '2026-11-22 09:20:04', process_on: '2026-11-22 09:19:56',
    sys_created_on: '2026-11-22 09:19:56', queue: '', table: 'incident' },
  { sys_id: id(61), name: 'incident.resolved', instance: RECORD, parm1: USER, parm2: '',
    state: 'processed', processed: '2026-11-22 10:00:00', process_on: '2026-11-22 09:59:58',
    sys_created_on: '2026-11-22 09:59:58', queue: '', table: 'incident' },
];

const emailRows = () => [
  { sys_id: EMAIL, instance: RECORD, subject: 'Incident INC0010007 - comments added', recipients: 'abel.tuter@example.com',
    user_id: USER, state: 'ready', status: '', notification_type: 'SMTP', weight: '20', target_table: 'incident',
    sys_created_on: '2026-11-22 09:20:03' },
];

const logRows = () => [
  { sys_id: id(70), notification: ENGINE, event: id(60), email: EMAIL, sys_created_on: '2026-11-22 09:20:04' },
];

const userRow = () => ({
  sys_id: pair(USER), user_name: pair('abel.tuter', 'abel.tuter'), name: pair('Abel Tuter', 'Abel Tuter'),
  email: pair('abel.tuter@example.com', 'abel.tuter@example.com'), active: pair('true', 'true'),
  notification: pair('2', 'Enable'),
});

const recordRow = () => ({
  sys_id: pair(RECORD), number: pair('INC0010007', 'INC0010007'), name: pair('', ''), short_description: pair('Fixture incident', 'Fixture incident'),
  assigned_to: pair(USER, 'Abel Tuter'), watch_list: pair('', ''),
});

const templateRows = () => [
  { sys_id: pair(TEMPLATE), name: pair('Branded', 'Branded'), message_html: pair('<div>${mail_script:template_header}</div>'), email_layout: pair(id(80), 'Layout') },
];

function fixtureTables() {
  return {
    sysevent_email_action: notificationRows(),
    sysevent_email_template: templateRows(),
    sysevent: eventRows(),
    sys_email: emailRows(),
    sys_email_log: logRows(),
    sys_user: [userRow()],
    incident: [recordRow()],
    cmn_notif_device: [{ sys_id: pair(id(90)), name: pair('Primary email', 'Primary email'), type: pair('Email', 'Email'),
      active: pair('true', 'true'), primary_email: pair('true', 'true'), email_address: pair('abel.tuter@example.com', 'abel.tuter@example.com'),
      phone_number: pair(''), order: pair('100', '100') }],
    cmn_notif_message: [{ sys_id: pair(id(91)), notification: pair(ENGINE, 'Incident commented for ITIL'), collection: pair('incident', 'incident'),
      device: pair(id(90), 'Primary email'), name: pair('Incident commented for ITIL', 'Incident commented for ITIL'), condition: pair('') }],
    sys_choice: [{ sys_id: pair(id(92)), value: '1', label: 'Disable' }, { sys_id: pair(id(93)), value: '2', label: 'Enable' }],
    sys_properties: [{ sys_id: pair(id(94)), name: 'glide.email.smtp.active', value: 'false' },
      { sys_id: pair(id(95)), name: 'glide.user.default_notification', value: '1' }],
  };
}

function shape(rows, display) {
  const field = display === 'all' ? row => row : display === 'true' ? row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value?.display_value ?? value]))
    : row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value?.value ?? value]));
  return rows.map(field);
}

function filterRows(rows, query) {
  if (!query) return rows;
  const exact = String(query).match(/^(name|sys_id|number|user_name)=([^^]+)$/);
  if (!exact) return rows;
  const [, field, wanted] = exact;
  return rows.filter(row => String(row[field]?.value ?? row[field] ?? '') === decodeURIComponent(wanted));
}

function xmlAnswer(value) {
  return JSON.stringify(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function startFixture({ failRecipientLog = true, failEmailLog = false } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    calls.push({ method: req.method, pathname: url.pathname, params: url.searchParams });
    res.setHeader('Content-Type', 'application/json');
    const send = (status, payload) => { res.statusCode = status; res.end(JSON.stringify(payload)); };
    if (url.pathname === '/xmlhttp.do' && req.method === 'POST') {
      res.setHeader('Content-Type', 'text/xml');
      res.statusCode = 200;
      res.end(`<xml answer="${xmlAnswer({ subject: 'Simulated subject', body: '<p>simulated</p>', includedUsers: {}, excludedUsers: {}, includedEmails: {} })}"></xml>`);
      return;
    }
    if (req.method !== 'GET') return send(405, { error: { message: 'mutation refused' } });
    if (url.pathname.startsWith('/api/now/stats/')) {
      const table = url.pathname.split('/').pop();
      if (table === 'syslog_email' && failRecipientLog) return send(403, { error: { message: 'Access forbidden' } });
      return send(200, { result: { stats: { count: String((fixtureTables()[table] || []).length) } } });
    }
    if (!url.pathname.startsWith('/api/now/table/')) return send(404, { error: { message: 'not found' } });
    const table = url.pathname.split('/').pop();
    if (table === 'syslog_email' && failRecipientLog) return send(403, { error: { message: 'Access forbidden' } });
    if (table === 'sys_email_log' && failEmailLog) return send(403, { error: { message: 'Access forbidden' } });
    const rows = filterRows(fixtureTables()[table] || [], url.searchParams.get('sysparm_query'));
    return send(200, { result: shape(rows, url.searchParams.get('sysparm_display_value')) });
  });
  return { server, calls };
}

async function runCli(args, { readOnly = false, fixture }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-notifications-why-'));
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({
    default_profile: 'fixture',
    profiles: { fixture: { instance_url: `http://127.0.0.1:${fixture.server.address().port}`, auth_method: 'basic', read_only: readOnly } },
  }));
  const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'),
    SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1',
    JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1', JSN_NO_DOCS_CHECK: '1', CI: '1' });
  const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  try {
    return await promisify(execFile)(process.execPath, [...loopbackCredentialArgs, cli, ...args], { env, cwd: dir, timeout: 20000 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('preview is declared as a mutation; list, show and why are reads', () => {
  buildCLI();
  assert.equal(isMutationCommand({ _: ['notifications', 'preview', 'name', 'incident', 'INC1'] }), true);
  for (const verb of ['list', 'show', 'why']) assert.equal(isMutationCommand({ _: ['notifications', verb] }), false);
});

test('list resolves the body and recipients for a page in bounded template reads', async () => {
  const fixture = startFixture();
  fixture.server.listen(0, '127.0.0.1');
  await once(fixture.server, 'listening');
  try {
    const result = await runCli(['notifications', 'list', '--json'], { fixture });
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.data.count, 3);
    const [engine, event, flow] = body.data.records;
    assert.equal(engine.sends_on, 'record update; condition commentsVALCHANGES');
    assert.equal(engine.body, 'own message_html');
    assert.equal(event.body, 'template Branded');
    assert.equal(flow.body, 'own message_html');
    assert.equal(flow.sends_on, 'flow (not covered by notifications why)');
    const templateReads = fixture.calls.filter(call => call.pathname === '/api/now/table/sysevent_email_template');
    assert.equal(templateReads.length, 1, 'one batched template read for the page');
    assert.match(templateReads[0].params.get('sysparm_query'), /^sys_idIN/);
    assert.ok(fixture.calls.every(call => call.method === 'GET' || call.pathname === '/angular.do'));
  } finally {
    fixture.server.closeAllConnections();
    await new Promise(resolve => fixture.server.close(resolve));
  }
});

test('why attributes engine and event evidence, keeps unavailable recipient reasons unavailable, and shows values when nothing logged', async () => {
  const fixture = startFixture();
  fixture.server.listen(0, '127.0.0.1');
  await once(fixture.server, 'listening');
  try {
    const result = await runCli(['notifications', 'why', 'incident', 'INC0010007', 'abel.tuter', '--json'], { fixture });
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, true);
    const data = body.data;
    assert.equal(data.record.label, 'INC0010007');
    assert.equal(data.coverage.notifications_read, 3);
    assert.equal(data.coverage.covered, 2);
    assert.equal(data.coverage.flow_not_covered, 1);
    assert.equal(data.user.email, 'abel.tuter@example.com');
    assert.equal(data.user.notification_setting.label, 'Enable');
    assert.equal(data.user.devices[0].email_address, 'abel.tuter@example.com');
    assert.equal(data.user.subscriptions.for_this_table.length, 1);

    const engine = data.notifications.find(item => item.sys_id === ENGINE);
    assert.equal(engine.evidence.status, 'logged');
    assert.equal(engine.evidence.events.count, 1);
    assert.equal(engine.evidence.events.rows[0].parm2, USER);
    assert.equal(engine.evidence.emails.count, 1);
    assert.equal(engine.evidence.emails.rows[0].subject, 'Incident INC0010007 - comments added');
    assert.equal(engine.recipient_log.status, 'unavailable');
    assert.match(engine.recipient_log.reason, /403/);
    assert.equal(engine.subscriptions.matching.length, 1);

    const event = data.notifications.find(item => item.sys_id === EVENT);
    assert.equal(event.evidence.status, 'logged');
    assert.equal(event.evidence.events.rows[0].name, 'incident.resolved');
    assert.equal(event.evidence.emails.count, 0);

    const flow = data.notifications.find(item => item.sys_id === FLOW);
    assert.equal(flow.evidence.status, 'not_covered');

    assert.ok(data.gaps.some(gap => /flow-triggered/.test(gap)));
    assert.ok(data.gaps.some(gap => /save_when_no_recipients/.test(gap)));
    assert.ok(data.gaps.some(gap => /SMTP is disabled/.test(gap)));
    assert.ok(fixture.calls.every(call => call.method === 'GET' || call.pathname === '/angular.do'), 'why only reads records');
  } finally {
    fixture.server.closeAllConnections();
    await new Promise(resolve => fixture.server.close(resolve));
  }
});

test('why keeps sysevent proof when the email index is denied', async () => {
  const fixture = startFixture({ failEmailLog: true });
  fixture.server.listen(0, '127.0.0.1');
  await once(fixture.server, 'listening');
  try {
    const result = await runCli(['notifications', 'why', 'incident', 'INC0010007', 'abel.tuter', '--json'], { fixture });
    const data = JSON.parse(result.stdout).data;
    const engine = data.notifications.find(item => item.sys_id === ENGINE);
    assert.equal(engine.evidence.status, 'logged', 'the sysevent proves it fired');
    assert.equal(engine.evidence.events.count, 1);
    assert.equal(engine.evidence.emails.status, 'unavailable');
    assert.match(data.gaps.join(' '), /Email evidence|Could not read the email-to-notification index/);
  } finally {
    fixture.server.closeAllConnections();
    await new Promise(resolve => fixture.server.close(resolve));
  }
});

test('why shows recipient configuration and record values when nothing was logged', async () => {
  const fixture = startFixture();
  fixture.server.listen(0, '127.0.0.1');
  await once(fixture.server, 'listening');
  try {
    // Remove the evidence for the engine notification by making the event page empty.
    fixture.server.removeAllListeners('request');
    fixture.server.on('request', (req, res) => {
      const url = new URL(req.url, 'http://fixture.invalid');
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/api/now/stats/sysevent') { res.end(JSON.stringify({ result: { stats: { count: '0' } } })); return; }
      if (url.pathname === '/api/now/stats/sys_email') { res.end(JSON.stringify({ result: { stats: { count: '0' } } })); return; }
      if (url.pathname === '/api/now/stats/syslog_email') { res.statusCode = 403; res.end(JSON.stringify({ error: { message: 'Access forbidden' } })); return; }
      if (!url.pathname.startsWith('/api/now/table/')) { res.statusCode = 404; res.end('{}'); return; }
      const table = url.pathname.split('/').pop();
      const empty = table === 'sysevent' || table === 'sys_email' || table === 'sys_email_log';
      const rows = empty ? [] : filterRows(fixtureTables()[table] || [], url.searchParams.get('sysparm_query'));
      res.end(JSON.stringify({ result: shape(rows, url.searchParams.get('sysparm_display_value')) }));
    });
    const result = await runCli(['notifications', 'why', 'incident', 'INC0010007', 'abel.tuter', '--json'], { fixture });
    const data = JSON.parse(result.stdout).data;
    const engine = data.notifications.find(item => item.sys_id === ENGINE);
    assert.equal(engine.evidence.status, 'not_logged');
    assert.deepEqual(engine.record_values.fields.assigned_to, { value: USER, display_value: 'Abel Tuter' });
    assert.ok(engine.recipients.fields.includes('assigned_to'));
  } finally {
    fixture.server.closeAllConnections();
    await new Promise(resolve => fixture.server.close(resolve));
  }
});

test('preview refuses a read-only profile before any request', async () => {
  const fixture = startFixture();
  fixture.server.listen(0, '127.0.0.1');
  await once(fixture.server, 'listening');
  try {
    await assert.rejects(runCli(['notifications', 'preview', 'Incident commented for ITIL', 'incident', 'INC0010007', '--force', '--json'], { readOnly: true, fixture }));
    assert.equal(fixture.calls.filter(call => call.pathname === '/xmlhttp.do').length, 0);
  } finally {
    fixture.server.closeAllConnections();
    await new Promise(resolve => fixture.server.close(resolve));
  }
});

test('preview requires confirmation, posts the simulator, and reports unchanged write counts', async () => {
  const fixture = startFixture();
  fixture.server.listen(0, '127.0.0.1');
  await once(fixture.server, 'listening');
  try {
    await assert.rejects(runCli(['notifications', 'preview', 'Incident commented for ITIL', 'incident', 'INC0010007', '--json'], { fixture }));
    assert.equal(fixture.calls.filter(call => call.pathname === '/xmlhttp.do').length, 0);

    const result = await runCli(['notifications', 'preview', 'Incident commented for ITIL', 'incident', 'INC0010007', '--force', '--json'], { fixture });
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, true);
    const posts = fixture.calls.filter(call => call.pathname === '/xmlhttp.do');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].method, 'POST');
    assert.equal(posts[0].params.get('sysparm_processor'), 'NotificationSimulator');
    assert.equal(posts[0].params.get('sysparm_name'), 'simulate');
    assert.equal(posts[0].params.get('sysparm_email_action_id'), ENGINE);
    assert.equal(posts[0].params.get('sysparm_record_id'), RECORD);
    assert.equal(body.data.simulation.parsed, true);
    assert.equal(body.data.simulation.value.subject, 'Simulated subject');
    assert.equal(body.data.recipients.status, 'unavailable');
    assert.equal(body.data.write_check.sys_email.unchanged, true);
    assert.equal(body.data.write_check.sysevent.unchanged, true);
    assert.equal(body.data.write_check.syslog_email.status, 'unavailable');
    assert.ok(fixture.calls.every(call => call.method === 'GET' || ['/angular.do', '/xmlhttp.do'].includes(call.pathname)));
  } finally {
    fixture.server.closeAllConnections();
    await new Promise(resolve => fixture.server.close(resolve));
  }
});
