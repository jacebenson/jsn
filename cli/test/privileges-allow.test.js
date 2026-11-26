import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { privilegesCmd } from '../src/commands/_simple.js';
import { yargs } from '../src/cli-adapter.js';
import { rankedDiscoveries } from '../src/commands/discover.js';
import { isMutationCommand } from '../src/mutations.js';
import { errAPI } from '../src/errors.js';
import { makeApp } from './support/app-test-helpers.js';
import { captureCommands, findHandler, wrapHandler } from './support/command-test-helpers.js';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';

const handler = findHandler(captureCommands(privilegesCmd(wrapHandler)), 'allow');
const id = c => c.repeat(32);
const REQ = id('1');
const ref = (value, display_value = value) => ({ value, display_value });
const rca = (status, extra = {}) => ({
  sys_id: ref(REQ), status: ref(status, ['Requested', 'Denied', 'Allowed', 'Invalidated'][status]), operation: ref('execute', 'Execute API'),
  source_scope: ref(id('a'), 'Payroll Sync'), source_table: ref('sys_script_include'), source: ref(id('c'), 'SalarySync'),
  target_scope: ref(id('b'), 'Pay Core'), target_table: ref('sys_script_include'), target: ref(id('d'), 'Script Include: GradeTable'),
  rca_type: ref('real_rca', 'Real RCA'), sys_updated_on: ref('2026-11-26 02:20:37'), sys_scope: ref(id('b'), 'Pay Core'), 'target_scope.scoped_administration': ref('false'), ...extra,
});
const READ = ['listStrict', 'sys_restricted_caller_access', {
  sysparm_query: `sys_id=${REQ}`, sysparm_limit: '2', sysparm_display_value: 'all',
  sysparm_fields: 'sys_id,status,operation,source_scope,source_table,source,target_scope,target_table,target,rca_type,sys_updated_on,sys_scope,target_scope.scoped_administration',
}];

// reads[] answers the request reads in turn: the lookup, then the read-back after the write.
function fixture({ reads = [[rca('0')], [rca('2')]], updateError, mutationContext } = {}) {
  const calls = [];
  let n = 0;
  const sdk = {
    listStrict: async (table, params) => { calls.push(['listStrict', table, Object.fromEntries(params)]); const r = reads[Math.min(n++, reads.length - 1)]; if (r instanceof Error) throw r; return r; },
    update: async (table, sysId, data) => { calls.push(['update', table, sysId, data]); if (updateError) throw updateError; return {}; },
    mutationContext,
  };
  return { calls, app: makeApp({ sdk }) };
}
const writes = calls => calls.filter(c => c[0] === 'update');

test('discover finds allow by the words for approving a blocked call', () => {
  const registry = yargs().option('json', { type: 'boolean' }).command(privilegesCmd(fn => fn)).commandRegistry({ details: true });
  for (const query of ['approve rca', 'allow restricted caller access', 'approve cross-scope access request']) {
    assert.equal(rankedDiscoveries(registry, { query })[0]?.invocation, 'jsn privileges allow <request>', query);
  }
});

test('allow is a mutation, so read-only profiles refuse it, and requests stays a read', () => {
  assert.equal(isMutationCommand({ _: ['privileges', 'allow'] }), true);
  assert.equal(isMutationCommand({ _: ['privileges', 'requests'] }), false);
});

test('previews without --yes: one read, the status change, and a rerun that keeps the profile; nothing written', async () => {
  const { calls, app } = fixture({ reads: [[rca('1', { 'target_scope.scoped_administration': ref('true') })]] });
  await handler({ app, request: REQ, yes: false, profile: 'dev', _: ['privileges', 'allow'] });
  assert.deepEqual(calls, [READ]);
  const { data, opts } = app.lastOk;
  assert.equal(data.dry_run, true);
  assert.deepEqual(data.change, { status: { from: 'denied', to: 'allowed' } });
  assert.equal(data.application_administration, true);
  assert.equal(data.request.source.name, 'SalarySync');
  assert.equal(data.request.target_scope.name, 'Pay Core');
  assert.equal(data.rerun, `jsn privileges allow ${REQ} --yes --profile dev`);
  assert.match(opts.summary, /^Dry run: would allow request 1{32} \(Denied -> Allowed\); nothing written$/);
  assert.match(data._formatted, /Would allow request 1{32}:\n {2}Denied -> Allowed +Execute API +Payroll Sync: SalarySync +-> +Pay Core: Script Include: GradeTable/);
  assert.match(data._formatted, /Pay Core has application administration on: only its application admins can allow this request/);
  assert.match(data._formatted, /Run: jsn privileges allow 1{32} --yes --profile dev/);
});

test('--yes sets status 2 on that one row, reads it back, and reports Allowed', async () => {
  const { calls, app } = fixture();
  await handler({ app, request: ` ${REQ} `, yes: true, _: ['privileges', 'allow'] });
  assert.deepEqual(calls, [READ, ['update', 'sys_restricted_caller_access', REQ, { status: '2' }], READ]);
  const { data, opts } = app.lastOk;
  assert.equal(data.dry_run, false);
  assert.equal(data.allowed, true);
  assert.equal(data.request.status, 'allowed');
  assert.equal(data.rerun, undefined);
  assert.equal(opts.summary, `Allowed request ${REQ}`);
  assert.match(data._formatted, /^Allowed request 1{32}:\n {2}Requested -> Allowed +Execute API +Payroll Sync: SalarySync/);
  assert.doesNotMatch(data._formatted, /application administration/);
});

test('rejected input reads and writes nothing', async () => {
  for (const request of [undefined, '', 'abc', id('g'), `${REQ}^ORsys_idISNOTEMPTY`, id('1').slice(1)]) {
    const { calls, app } = fixture();
    await assert.rejects(handler({ app, request, yes: true, _: ['privileges', 'allow'] }), err => err.code === 'usage_error' && /sys_id/.test(err.message), String(request));
    assert.equal(calls.length, 0, String(request));
  }
});

test('an Allowed request is refused before any write, with the command that lists allowed rows', async () => {
  const { calls, app } = fixture({ reads: [[rca('2')]] });
  await assert.rejects(handler({ app, request: REQ, yes: true, _: ['privileges', 'allow'] }), err => err.code === 'usage_error' && /already Allowed/.test(err.message) && /--status allowed/.test(err.hint));
  assert.deepEqual(writes(calls), []);
});

test('missing, denied and malformed reads never write or report success', async () => {
  const cases = [
    [[[]], 'not_found'],
    [[errAPI(403, 'x')], 'forbidden'],
    [[[rca('0', { sys_id: ref(id('9')) })]], 'malformed_response'],
    [[[rca('0'), rca('0')]], 'malformed_response'],
    [[[rca('0', { status: ref('', '') })]], 'malformed_response'],
    [[[rca('0', { status: ref('7', 'Seven') })]], 'malformed_response'],
    [[['not a row']], 'malformed_response'],
  ];
  for (const [reads, code] of cases) {
    const { calls, app } = fixture({ reads });
    await assert.rejects(handler({ app, request: REQ, yes: true, _: ['privileges', 'allow'] }), err => err.code === code, code);
    assert.deepEqual(writes(calls), [], code);
    assert.equal(app.lastOk, undefined, code);
  }
});

test('a refused write names application administration when the target app has it on', async () => {
  const on = fixture({ reads: [[rca('0', { 'target_scope.scoped_administration': ref('true') })]], updateError: errAPI(403, 'x') });
  await assert.rejects(handler({ app: on.app, request: REQ, yes: true, _: ['privileges', 'allow'] }), err => err.status === 403 && /Pay Core has application administration on/.test(err.hint));
  assert.equal(on.calls.length, 2, 'no read-back after a refused write');
  const off = fixture({ updateError: errAPI(403, 'x') });
  await assert.rejects(handler({ app: off.app, request: REQ, yes: true, _: ['privileges', 'allow'] }), err => err.status === 403 && !/application administration/.test(err.hint));
  const other = fixture({ reads: [[rca('0', { 'target_scope.scoped_administration': ref('true') })]], updateError: errAPI(500, 'x') });
  await assert.rejects(handler({ app: other.app, request: REQ, yes: true, _: ['privileges', 'allow'] }), err => !/application administration/.test(err.hint || ''));
  const preview = fixture();
  await handler({ app: preview.app, request: REQ, yes: false, _: ['privileges', 'allow'] });
  assert.doesNotMatch(preview.app.lastOk.data._formatted, /application administration/);
});

test('a read-back that is not Allowed exits nonzero and never reports success', async () => {
  for (const back of [[rca('0')], [rca('3')], []]) {
    const { calls, app } = fixture({ reads: [[rca('0')], back] });
    await assert.rejects(handler({ app, request: REQ, yes: true, _: ['privileges', 'allow'] }), err => back.length ? /not confirmed/.test(err.message) && /Requested|Invalidated/.test(err.message) && /--status all/.test(err.hint) : err.code === 'not_found');
    assert.equal(writes(calls).length, 1);
    assert.equal(app.lastOk, undefined);
  }
  const admin = fixture({ reads: [[rca('0', { 'target_scope.scoped_administration': ref('true') })], [rca('0')]] });
  await assert.rejects(handler({ app: admin.app, request: REQ, yes: true, _: ['privileges', 'allow'] }), err => /not confirmed/.test(err.message) && /Pay Core has application administration on/.test(err.hint));
});

test('a verified capture context in another application refuses the write; the matching one allows it', async () => {
  const other = fixture({ mutationContext: { verified: true, application_id: id('e') } });
  await assert.rejects(handler({ app: other.app, request: REQ, yes: true, _: ['privileges', 'allow'] }), err => err.code === 'usage_error' && /Restricted caller access request scope is unknown or differs/.test(err.message));
  assert.deepEqual(other.calls, [READ], 'refused after the read, before any write');
  const blank = fixture({ reads: [[rca('0', { sys_scope: ref('', '') })]], mutationContext: { verified: true, application_id: id('b') } });
  await assert.rejects(handler({ app: blank.app, request: REQ, yes: true, _: ['privileges', 'allow'] }), err => err.code === 'usage_error');
  assert.deepEqual(writes(blank.calls), []);
  const same = fixture({ mutationContext: { verified: true, application_id: id('b') } });
  await handler({ app: same.app, request: REQ, yes: true, _: ['privileges', 'allow'] });
  assert.equal(writes(same.calls).length, 1);
  assert.equal(same.app.lastOk.data.allowed, true);
  assert.equal(same.app.lastOk.data.request.sys_scope, undefined, 'the record scope stays out of the output');
});

test('real CLI: a read-only profile refuses allow before any request; help and the family list name it', async () => {
  const calls = [];
  const server = createServer((req, res) => { calls.push({ method: req.method, pathname: new URL(req.url, 'http://fixture.invalid').pathname }); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ result: [rca('0')] })); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-privileges-allow-')));
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: true } } }));
  const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
  const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const run = args => promisify(execFile)(process.execPath, [...loopbackCredentialArgs, cli, 'privileges', ...args], { env, cwd: dir, timeout: 20000 });
  try {
    for (const args of [['allow', REQ, '--yes', '--json'], ['allow', REQ, '--json']]) {
      const error = await run(args).then(() => null, e => e);
      assert.ok(error, JSON.stringify(args));
      assert.equal(JSON.parse(error.stdout).code, 'read_only', JSON.stringify(args));
    }
    assert.deepEqual(calls.filter(call => call.pathname.startsWith('/api/now/table/')), [], 'refused before any table request');
    assert.match((await run(['allow', '--help'])).stdout, /Allowed[\s\S]*application administration/);
    assert.match((await run([])).stdout, /allow/);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
