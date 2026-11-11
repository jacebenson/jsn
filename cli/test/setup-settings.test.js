import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
let answers = [], settings = 'defaults', questions = [];
mock.module('../src/prompts.js', { namedExports: {
  select: async () => settings,
  input: async () => { throw new Error('hosted docs need no URL'); },
  confirm: async question => { questions.push(question.message); return answers.shift(); },
} });
const { dispatchSetupAction, setupCmd } = await import('../src/commands/setup.js');
const { createConfig, loadConfig } = await import('../src/config.js');

test('hub and direct settings switches retain preference/documentation questions and persistence', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-explicit-settings-'));
  const previous = process.env.XDG_CONFIG_HOME, cwd = process.cwd();
  process.env.XDG_CONFIG_HOME = directory; process.chdir(directory);
  t.after(() => { process.chdir(cwd); if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); });
  const app = { config: createConfig(), ok() {}, isInteractive: () => false };
  app.config.profiles.existing = { instance_url: 'https://example.invalid', read_only: false };
  const existing = structuredClone(app.config.profiles);
  for (const hub of [true, false]) {
    questions = []; answers = [true, true, false]; settings = 'defaults';
    if (hub) await dispatchSetupAction(app, {}, 'advanced');
    else await setupCmd(fn => argv => fn(argv, app)).handler({ 'configure-defaults': true });
    assert.deepEqual(questions, ['Read-only connections (block changes)?', 'Confirm before deleting records?', 'Include result totals on list commands?']);
    assert.deepEqual(loadConfig().connectionDefaults, { read_only: true, skip_confirmations: false, include_counts: false });
    questions = []; answers = [true]; settings = 'docs';
    if (hub) await dispatchSetupAction(app, {}, 'advanced');
    else await setupCmd(fn => argv => fn(argv, app)).handler({ 'configure-docs': true });
    assert.deepEqual(questions, ['Use JSN-hosted documentation?']);
    assert.equal(loadConfig().docs.source, 'hosted');
    assert.deepEqual(loadConfig().profiles, existing);
  }
});
