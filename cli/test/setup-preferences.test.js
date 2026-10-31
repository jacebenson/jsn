import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { connectionPreferences, chooseConnectionPreferences, configureDocumentation, configureGlobalDefaults } from '../src/setup-preferences.js';
import { createConfig, loadConfig } from '../src/config.js';
function isolate(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-defaults-'));
  const previous = process.env.XDG_CONFIG_HOME, cwd = process.cwd();
  process.env.XDG_CONFIG_HOME = root; process.chdir(root);
  t.after(() => { process.chdir(cwd); if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; fs.rmSync(root, { recursive: true, force: true }); });
}
test('new profiles copy defaults while existing and legacy profiles retain their settings', () => {
  const config = { connectionDefaults: { read_only: true, skip_confirmations: true, include_counts: false } };
  assert.deepEqual(connectionPreferences(config), config.connectionDefaults);
  assert.deepEqual(connectionPreferences(config, { instance_url: 'https://example.test' }), { read_only: false, skip_confirmations: false, include_counts: true });
  assert.deepEqual(connectionPreferences(config, { read_only: true }, { 'read-only': false }), { read_only: false, skip_confirmations: false, include_counts: true });
});
test('connection defaults take one choice; customize exposes the three settings', async () => {
  let count = 0;
  const config = { connectionDefaults: { read_only: true, skip_confirmations: false, include_counts: false } };
  assert.deepEqual(await chooseConnectionPreferences(config, {}, { confirm: async () => { count++; return true; } }), config.connectionDefaults);
  assert.equal(count, 1);
  const answers = [false, false, true, true];
  assert.deepEqual(await chooseConnectionPreferences(config, {}, { confirm: async () => answers.shift() }), { read_only: false, skip_confirmations: false, include_counts: true });
  assert.equal(answers.length, 0);
});
test('global defaults and hosted source persist without changing profiles or trusting project defaults', async t => {
  isolate(t);
  const config = createConfig(); config.profiles.legacy = { instance_url: 'https://example.test' };
  const before = structuredClone(config.profiles), answers = [true, true, false, true];
  await configureGlobalDefaults(config, { prompts: { confirm: async () => answers.shift() } });
  const loaded = loadConfig();
  assert.deepEqual(loaded.connectionDefaults, { read_only: true, skip_confirmations: false, include_counts: false });
  assert.equal(loaded.docs.source, 'hosted'); assert.deepEqual(loaded.profiles, before);
  fs.mkdirSync('.servicenow');
  fs.writeFileSync('.servicenow/config.json', JSON.stringify({ docs: { url: 'https://wrong.example' }, connection_defaults: { read_only: false } }));
  assert.deepEqual(loadConfig().docs, loaded.docs);
});
test('declining hosted and local sources asks for a custom URL', async t => {
  isolate(t);
  const answers = [false, false], messages = [], config = createConfig();
  await configureDocumentation(config, { confirm: async prompt => { messages.push(prompt.message); return answers.shift(); }, input: async prompt => {
    assert.notEqual(prompt.validate('file:///tmp'), true); return 'https://docs.example.test/team';
  } });
  assert.deepEqual(messages, ['Use JSN-hosted documentation?', 'Run a local documentation server for you?']);
  assert.deepEqual(loadConfig().docs, { source: 'custom', url: 'https://docs.example.test/team/' });
});
