// Contract: case reads use the caller's own credentials against the case
// table the instance actually exposes. No application is assumed, ACL-denied
// and uninstalled applications stay distinguishable, and no case command
// mutates records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { casesCmd } from '../src/commands/cases.js';
import { captureCommands } from './support/command-test-helpers.js';
import { makeApp } from './support/app-test-helpers.js';
import { isMutationCommand, refreshMutationCommands } from '../src/mutations.js';

const CSM = 'sn_customerservice_case';
const HR = 'sn_hr_core_case';
const CASE = { sys_id: 'e'.repeat(32), number: 'CS0001001', short_description: 'Printer offline', state: 'Open' };
const httpError = status => Object.assign(new Error(`HTTP ${status}`), { status });

function run(verb) {
  return captureCommands(casesCmd(fn => fn)).find(c => c.command === verb || c.command.startsWith(`${verb} `)).handler;
}

function setup(list) {
  const calls = [];
  const app = makeApp({ sdk: {
    list: async (table, params) => { calls.push({ table, params }); return list(table, params, calls); },
    create: async () => { throw new Error('cases must not create records'); },
    update: async () => { throw new Error('cases must not update records'); },
    delete: async () => { throw new Error('cases must not delete records'); },
  } });
  return { app, calls };
}
const argv = (args = {}) => ({ limit: 20, offset: 0, hr: false, ...args });

test('list detects the readable case application and never assumes one product table', async () => {
  const { app, calls } = setup(table => {
    if (table === CSM) throw httpError(400);
    return [{ number: 'HRC001', short_description: 'Badge request' }];
  });
  await run('list')(argv({ columns: 'number,short_description', app }), app);
  assert.deepEqual(calls.map(c => c.table), [CSM, HR, HR]);
  assert.equal(calls[2].params.get('sysparm_query'), 'ORDERBYDESCsys_updated_on');
  assert.equal(calls[2].params.get('sysparm_fields'), 'sys_id,number,short_description');
  assert.equal(calls[2].params.get('sysparm_limit'), '20');
  assert.deepEqual({ table: app.lastOk.data.table, application: app.lastOk.data.application, source: app.lastOk.data.table_source },
    { table: HR, application: 'HR Service Delivery', source: 'detected' });
  assert.equal(app.lastOk.data.count, 1);
});

test('--hr and --table read an explicit table without probing the other application', async () => {
  const { app, calls } = setup(() => [CASE]);
  await run('list')(argv({ hr: true, app }), app);
  assert.deepEqual(calls.map(c => c.table), [HR]);
  assert.equal(app.lastOk.data.table_source, 'explicit');
  assert.equal(app.lastOk.data.application, 'HR Service Delivery');

  const second = setup(() => []);
  await run('list')(argv({ table: 'u_custom_case', app: second.app }), second.app);
  assert.deepEqual(second.calls.map(c => c.table), ['u_custom_case']);
  assert.equal(second.app.lastOk.data.application, null);

  const conflict = setup(() => []);
  await assert.rejects(run('list')(argv({ hr: true, table: CSM, app: conflict.app }), conflict.app), /Choose --hr or --table/);
  assert.equal(conflict.calls.length, 0);
  const invalid = setup(() => []);
  await assert.rejects(run('list')(argv({ table: 'bad table^', app: invalid.app }), invalid.app), /--table takes a table name/);
  assert.equal(invalid.calls.length, 0);
});

test('an uninstalled case application is reported as unavailable input, not as an empty list', async () => {
  const { app } = setup(() => { throw httpError(400); });
  await assert.rejects(run('list')(argv({ app }), app), error => {
    assert.equal(error.code, 'usage_error');
    assert.match(error.message, new RegExp(CSM));
    assert.match(error.message, new RegExp(HR));
    assert.match(error.hint, /--table/);
    return true;
  });
  assert.equal(app.lastOk, undefined);
});

test('ACL-denied case access reports forbidden for every candidate instead of an empty list', async () => {
  const { app, calls } = setup(() => { throw httpError(403); });
  await assert.rejects(run('list')(argv({ app }), app), error => {
    assert.equal(error.code, 'forbidden');
    assert.equal(error.status, 403);
    assert.match(error.message, new RegExp(`${CSM} denied`));
    assert.match(error.message, new RegExp(`${HR} denied`));
    assert.match(error.hint, /ACLs/);
    return true;
  });
  assert.deepEqual(calls.map(c => c.table), [CSM, HR]);
  assert.equal(app.lastOk, undefined);
});

test('an explicit table that is missing or unreadable names the table in the error', async () => {
  const { app } = setup(() => { throw httpError(400); });
  await assert.rejects(run('list')(argv({ table: CSM, app }), app), error => {
    assert.equal(error.code, 'usage_error', 'a missing table is a caller mistake, not an opaque api_error that skips the JSON envelope');
    assert.match(error.message, new RegExp(`Reading ${CSM} failed`));
    assert.match(error.hint, /cases tables/);
    return true;
  });
});

test('show reads one case by number through ACLs and adds no write attempt', async () => {
  const { app, calls } = setup(() => [CASE]);
  await run('show')({ number: 'CS0001001', hr: false, app }, app);
  assert.equal(calls.at(-1).table, CSM);
  assert.equal(calls.at(-1).params.get('sysparm_query'), `number=CS0001001`);
  assert.equal(app.lastOk.data.number, 'CS0001001');
  assert.equal(app.lastOk.data._context.table, CSM);
  assert.ok(app.lastOk.opts.breadcrumbs[0].cmd.startsWith('jsn cases list'));
});

test('show surfaces denied access and a missing case distinctly', async () => {
  const denied = setup(() => { throw httpError(403); });
  await assert.rejects(run('show')({ number: 'CS0001001', app: denied.app }, denied.app), error => {
    assert.equal(error.code, 'forbidden');
    return true;
  });
  const missing = setup(() => []);
  await assert.rejects(run('show')({ number: 'CS9999999', app: missing.app }, missing.app));
});

test('search builds a bounded number/description query and rejects query separators', async () => {
  const { app, calls } = setup(() => [CASE]);
  await run('search')(argv({ text: 'printer', app }), app);
  assert.equal(calls.at(-1).params.get('sysparm_query'), 'numberLIKEprinter^ORshort_descriptionLIKEprinter^ORDERBYDESCsys_updated_on');
  const bad = setup(() => []);
  await assert.rejects(run('search')(argv({ text: 'printer^active=true', app: bad.app }), bad.app), /\^/);
  assert.equal(bad.calls.length, 0);
  await assert.rejects(run('search')(argv({ text: '  ', app: bad.app }), bad.app), /nonempty/);
});

test('tables reports each case application separately without claiming access', async () => {
  const { app } = setup(table => {
    if (table === CSM) throw httpError(403);
    return [];
  });
  await run('tables')({ app }, app);
  assert.deepEqual(app.lastOk.data.available, [HR]);
  assert.equal(app.lastOk.data.sources.find(s => s.table === CSM).reason, 'denied (HTTP 403)');
  assert.equal(app.lastOk.data.sources.find(s => s.table === CSM).application, 'Customer Service Management');
});

test('cases declares no mutation subcommands and registers read-only verbs', () => {
  casesCmd(fn => fn);
  refreshMutationCommands();
  assert.equal(isMutationCommand({ _: ['cases', 'list'] }), false);
  assert.equal(isMutationCommand({ _: ['cases', 'show', 'CS0001001'] }), false);
  const commands = captureCommands(casesCmd(fn => fn)).map(c => c.command);
  assert.deepEqual(commands, ['list', 'search <text>', 'show <number>', 'tables']);
});

test('the real CLI exposes cases in end-user help and discovers the subcommands', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-cases-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'servicenow'));
  fs.writeFileSync(path.join(root, 'servicenow', 'config.json'), JSON.stringify({ default_profile: 'limited', profiles: {
    limited: { instance_url: 'https://example.invalid', username: 'limited', command_audience: { username: 'limited', instance_url: 'https://example.invalid', mode: 'basic' } },
  } }));
  const cli = new URL('../bin/jsn.js', import.meta.url);
  const runCli = args => spawnSync(process.execPath, [fileURLToPath(cli), ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, XDG_CONFIG_HOME: root, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' } });
  const listing = runCli(['--profile', 'limited', '--json']);
  assert.equal(listing.status, 0, listing.stderr);
  assert.ok(JSON.parse(listing.stdout).data.commands.some(command => command.name === 'cases'));
  const help = runCli(['cases', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /list\s+List cases/);
  assert.match(help.stdout, /--hr for sn_hr_core_case/);
  const listHelp = runCli(['cases', 'list', '--help']);
  assert.equal(listHelp.status, 0, listHelp.stderr);
  assert.match(listHelp.stdout, /--hr/);
});
