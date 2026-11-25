import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as direct from '../src/midserver-direct.js';
import * as locations from '../src/midserver-locations.js';

const url = 'https://example.service-now.com';
let homeDirectory, directory, failStop, events, asynchronousExit;
mock.module('../src/midserver-locations.js', { namedExports: {
  ...locations,
  resolveMidInstallationDirectory: (instance, name, options) => locations.resolveMidInstallationDirectory(instance, name, { ...options, homeDirectory }),
  forgetMidInstallationDirectory: (instance, name, options) => { events.push('forget'); return locations.forgetMidInstallationDirectory(instance, name, { ...options, homeDirectory }); },
} });
mock.module('../src/midserver-direct.js', { namedExports: {
  ...direct,
  readDirectInstallation: (_url, _name, resolved) => {
    assert.equal(resolved, directory);
    return { installDir: resolved, name: 'fixture', platform: 'windows', state: 'console-running' };
  },
  runDirectInstallation: (_metadata, action) => {
    events.push(action);
    if (failStop) throw new Error('owned runtime remains');
    return action === 'start' ? Promise.resolve().then(() => { asynchronousExit = true; return { platform: 'windows', state: 'prepared', interrupted: 'SIGINT' }; }) : { state: 'prepared' };
  },
  removeDirectInstallation: () => { events.push('teardown'); if (failStop) throw new Error('owned runtime remains'); fs.rmSync(directory, { recursive: true }); },
} });
const { midserversCmd } = await import('../src/commands/midservers.js');
const commands = [], builder = { command(command) { commands.push(command); return builder; } };
midserversCmd(handler => handler).builder(builder);
const command = action => commands.find(c => c.command.split(' ')[0] === action);
function fixture(t) {
  homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-command-integration-'));
  t.after(() => fs.rmSync(homeDirectory, { recursive: true, force: true }));
  directory = path.join(homeDirectory, 'custom');
  fs.mkdirSync(path.join(directory, 'agent', 'logs'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'agent', 'logs', 'agent0.log'), 'fixture log\n');
  locations.registerMidInstallationDirectory(url, 'fixture', directory, { homeDirectory });
  failStop = false; events = []; asynchronousExit = false;
  const results = [];
  return { results, app: {
    config: { profiles: {} }, getEffectiveInstance: () => url, output: { getFormat: () => 'json' },
    ok: (data, options) => { if (events.includes('start')) assert.equal(asynchronousExit, true); results.push({ data, options }); },
    sdk: { list: async () => [{ sys_id: 'a'.repeat(32), name: 'fixture' }], delete: async () => { events.push('delete'); } },
  } };
}
test('start awaits console reconciliation and custom registry discovery reaches start/stop/logs without directory', async t => {
  const { app, results } = fixture(t);
  for (const action of ['start', 'stop', 'logs']) await command(action).handler({ identifier: 'fixture', tail: 10 }, app);
  assert.match(results[0].options.summary, /SIGINT.*verified/);
  assert.equal(results[0].data.state, 'prepared');
  assert.match(results[2].data.text, /fixture log/);
  assert.equal(locations.resolveMidInstallationDirectory(url, 'fixture', { homeDirectory }), directory);
});
test('failed teardown retains directory, mapping and instance record; verified teardown forgets before record deletion', async t => {
  const { app } = fixture(t);
  failStop = true;
  await assert.rejects(command('remove').handler({ identifier: 'fixture', force: true }, app), /runtime remains/);
  assert.deepEqual(events, ['teardown']);
  assert.equal(fs.existsSync(directory), true);
  assert.equal(locations.resolveMidInstallationDirectory(url, 'fixture', { homeDirectory }), directory);
  failStop = false; events = [];
  await command('remove').handler({ identifier: 'fixture', force: true }, app);
  assert.deepEqual(events, ['teardown', 'forget', 'delete']);
  assert.equal(fs.existsSync(directory), false);
  assert.notEqual(locations.resolveMidInstallationDirectory(url, 'fixture', { homeDirectory }), directory);
});
