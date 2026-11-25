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
import { buildCLI } from '../src/cli.js';
import { renderHelp } from '../src/help.js';
import { rankedDiscoveries, discoverCommands } from '../src/commands/discover.js';
import { collectCapabilities } from '../src/capabilities.js';
import { isMutationCommand } from '../src/mutations.js';
import { sweepTower, formatTower } from '../src/commands/tower.js';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';

const SWEPT = [
  ['incident', 'active=true'],
  ['v_transaction', ''],
  ['sys_audit_delete', 'sys_created_on>=javascript:gs.beginningOfToday()'],
];
const counts = { incident: '42', v_transaction: '1', sys_audit_delete: '376' };

// Records every method called on the SDK, so a write of any name is counted.
function fixtureSdk(answer = table => ({ stats: { count: counts[table] } })) {
  const calls = [];
  const sdk = new Proxy({}, { get: (_, method) => async (...args) => {
    calls.push({ method, args });
    if (method !== 'aggregate') throw new Error(`unexpected ${String(method)}`);
    return answer(...args);
  } });
  return { sdk, calls };
}

test('the sweep is three Stats API counts and nothing else', async () => {
  const { sdk, calls } = fixtureSdk();
  const radar = await sweepTower(sdk);
  assert.deepEqual(calls.map(call => [call.method, call.args[0], call.args[1].query]), SWEPT.map(([table, query]) => ['aggregate', table, query]));
  assert.equal(calls.filter(call => call.method !== 'aggregate').length, 0);
  assert.deepEqual(radar.map(blip => [blip.table, blip.status, blip.count]), [['incident', 'tracked', 42], ['v_transaction', 'tracked', 1], ['sys_audit_delete', 'tracked', 376]]);
});

test('a denied, failed or malformed count is lost from the radar, never 0', async () => {
  const answers = {
    incident: () => { const error = new Error('Authentication rejected (HTTP 401)'); error.hint = 'Run: jsn auth login'; throw error; },
    v_transaction: () => ({}),
    sys_audit_delete: () => ({ stats: { count: 'many' } }),
  };
  const { sdk } = fixtureSdk(table => answers[table]());
  const radar = await sweepTower(sdk);
  assert.deepEqual(radar.map(blip => [blip.status, blip.count]), [['lost', null], ['lost', null], ['lost', null]]);
  assert.match(radar[0].error, /HTTP 401/);
  assert.equal(radar[0].hint, 'Run: jsn auth login');
  const text = formatTower({ instance: 'https://fixture.invalid', radar });
  assert.match(text, /\nRun: jsn auth login\n/);
  assert.equal((text.match(/lost from the radar/g) || []).length, 3);
  assert.doesNotMatch(text.split('Radar sweep')[1].split('Business reinvented')[0], /\b0\b/);
});

test('the tower is static and names the tagline it riffs on', async () => {
  const { sdk } = fixtureSdk();
  const data = { instance: 'https://fixture.invalid', radar: await sweepTower(sdk) };
  const text = formatTower(data);
  assert.equal(text, formatTower(data));
  assert.match(text, /The AI control tower for business reinvention/);
  assert.match(text, /AI Control Tower\. Powered by No Assist\./);
  assert.match(text, /Open incidents awaiting reinvention \.+ 42\n/);
  assert.match(text, /Transactions running right now \.+ 1\n/);
  assert.match(text, /Records deleted today \.+ 376\n/);
  assert.ok(text.endsWith('Business reinvented. 0 records changed.\n'));
  const killed = formatTower({ ...data, radar: [], kill_switch: true });
  assert.match(killed, /KILL SWITCH ENGAGED\. Radar powered down, no requests sent\./);
  assert.match(killed, /Powered by No Assist\./);
  assert.match(killed, /\nOtto the autopilot has been stopped\.\n/);
  assert.doesNotMatch(killed, /Radar sweep/);
  assert.ok(killed.endsWith('Business paused. 0 records changed.\n'));
});

test('tower is registered, read-only, and hidden from help and discovery', () => {
  assert.deepEqual(collectCapabilities().get('tower'), { mutationSubcommands: [] });
  assert.equal(isMutationCommand({ _: ['tower'] }), false);
  const cli = buildCLI([]);
  assert.ok('tower' in cli.getInternalMethods().getCommandInstance().getCommandHandlers());
  const registry = cli.commandRegistry({ details: true });
  assert.ok(!registry.commands.some(command => command.name === 'tower'));
  assert.ok(!registry.entries.some(entry => entry.path[0] === 'tower'));
  for (const full of [false, true]) assert.doesNotMatch(renderHelp({}, cli.commandRegistry(), { full }), /\btower\b/);
  for (const query of ['tower', 'control tower', 'business reinvention', 'radar sweep', 'kill switch']) {
    assert.deepEqual(discoverCommands(registry, { query }), [], query);
    assert.ok(!rankedDiscoveries(registry, { query }).some(result => result.args[0] === 'tower'), query);
  }
});

const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
const execute = promisify(execFile);

async function withHome(config, fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-tower-')));
  fs.mkdirSync(path.join(dir, 'servicenow'));
  if (config) fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify(config));
  const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
  try {
    return await fn(args => execute(process.execPath, [...loopbackCredentialArgs, cli, ...args], { env, cwd: dir, timeout: 20000 }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('real CLI: --json envelope, styled tower, a denied count, GET-only stats reads, absent from help and discover', async () => {
  const calls = [];
  const denied = new Set(['v_transaction']);
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    calls.push({ method: req.method, pathname: url.pathname, query: url.searchParams.get('sysparm_query') || '' });
    res.setHeader('Content-Type', 'application/json');
    const table = url.pathname.split('/').pop();
    if (!url.pathname.startsWith('/api/now/stats/')) return res.end(JSON.stringify({ result: [] }));
    if (denied.has(table)) { res.statusCode = 403; return res.end(JSON.stringify({ error: { message: 'Insufficient rights' }, status: 'failure' })); }
    res.end(JSON.stringify({ result: { stats: { count: counts[table] } } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const instance = `http://127.0.0.1:${server.address().port}`;
  try {
    await withHome({ default_profile: 'fixture', profiles: { fixture: { instance_url: instance, auth_method: 'basic', read_only: true } } }, async run => {
      const envelope = JSON.parse((await run(['tower', '--json'])).stdout);
      assert.equal(envelope.ok, true);
      assert.equal(envelope.data.instance, instance);
      assert.equal(envelope.data.superintelligence, false);
      assert.equal(envelope.data.kill_switch, false);
      assert.equal(envelope.data.changed, 0);
      assert.deepEqual(envelope.data.radar.map(blip => [blip.table, blip.status, blip.count]), [['incident', 'tracked', 42], ['v_transaction', 'lost', null], ['sys_audit_delete', 'tracked', 376]]);
      const human = (await run(['tower', '--format', 'styled'])).stdout;
      assert.match(human, /The AI control tower for business reinvention/);
      assert.match(human, /Transactions running right now \.+ lost from the radar/);
      assert.ok(human.endsWith('Business reinvented. 0 records changed.\n'));
      const stats = calls.filter(call => call.pathname.startsWith('/api/now/stats/'));
      assert.deepEqual(stats.slice(0, 3).map(call => [call.pathname.split('/').pop(), call.query]), SWEPT);
      // Every instance read is a stats GET; /angular.do is the SDK's session bootstrap, as in access-analyzer.test.js.
      assert.ok(calls.every(call => (call.method === 'GET' && call.pathname.startsWith('/api/now/stats/')) || call.pathname === '/angular.do'), JSON.stringify(calls));
      const quiet = calls.length;
      const killed = JSON.parse((await run(['tower', '--kill-switch', '--json'])).stdout);
      assert.deepEqual(killed.data, { instance, radar: [], kill_switch: true, superintelligence: false, changed: 0 });
      assert.match((await run(['tower', '--kill-switch', '--format', 'styled'])).stdout, /KILL SWITCH ENGAGED[^]*Business paused\. 0 records changed\.\n$/);
      assert.equal(calls.length, quiet, 'the kill switch sends no requests');
      for (const table of Object.keys(counts)) denied.add(table);
      const failed = await run(['tower', '--json']).then(() => assert.fail('an all-lost sweep must exit nonzero'), error => error);
      assert.equal(failed.code, 1);
      assert.deepEqual(JSON.parse(failed.stdout).data.radar.map(blip => [blip.status, blip.count]), [['lost', null], ['lost', null], ['lost', null]]);
      assert.ok(calls.every(call => (call.method === 'GET' && call.pathname.startsWith('/api/now/stats/')) || call.pathname === '/angular.do'), JSON.stringify(calls));
      const before = calls.length;
      for (const args of [['--help'], ['--all-commands', '--help'], ['--json'], ['discover', 'tower', '--json'], ['discover', 'control tower', '--json']]) {
        assert.doesNotMatch((await run(args)).stdout, /\btower\b/i, JSON.stringify(args));
      }
      assert.equal(calls.length, before);
    });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('real CLI with no profile shows the tower, an empty radar and the setup hint, and reads nothing', async () => {
  await withHome(null, async run => {
    const human = (await run(['tower', '--format', 'styled'])).stdout;
    assert.match(human, /The AI control tower for business reinvention/);
    assert.match(human, /Radar sweep: no instance in range\. The radar is empty\./);
    assert.match(human, /Run: jsn setup/);
    assert.doesNotMatch(human, /\.\.\. /);
    assert.ok(human.endsWith('Business reinvented. 0 records changed.\n'));
    const envelope = JSON.parse((await run(['tower', '--json'])).stdout);
    assert.deepEqual(envelope.data, { instance: null, radar: [], kill_switch: false, superintelligence: false, changed: 0 });
    assert.equal(envelope.notice, 'Run: jsn setup');
  });
});
