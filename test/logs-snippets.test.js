// Tests for the second feature batch: query snippets + logs --follow.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function collectSubcommands(cmd) {
  const subs = [];
  const mockYargs = {
    command: (c) => { subs.push(typeof c === 'string' ? { command: c } : c); return mockYargs; },
    option: () => mockYargs,
    positional: () => mockYargs,
    demandCommand: () => mockYargs,
  };
  cmd.builder(mockYargs);
  return subs;
}

function buildApp(sdk) {
  const app = {
    sdk,
    config: { profiles: {}, activeProfile: null },
    requireInstance() {},
    getEffectiveInstance: () => 'https://dev.example.service-now.com',
    ok: (data, opts) => { app.lastOk = { data, opts }; },
  };
  return app;
}

describe('query snippets', () => {
  let tmpDir;
  let snippetsCmd;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-snippets-'));
    process.env.XDG_CONFIG_HOME = tmpDir; // globalConfigDir honours this first
    ({ snippetsCmd } = await import('../src/commands/snippets.js'));
  });

  afterEach(() => {
    delete process.env.XDG_CONFIG_HOME;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves and lists a snippet', async () => {
    const cmd = snippetsCmd((fn) => fn);
    const save = collectSubcommands(cmd).find((s) => s.command === 'save <name>');
    const list = collectSubcommands(cmd).find((s) => s.command === 'list');
    assert.ok(save && list);

    const app = buildApp({});
    await save.handler({ app, name: 'prod-critical', table: 'incident', query: 'priority=1^active=true', columns: 'number,short_description' }, app);
    assert.strictEqual(app.lastOk.data.name, 'prod-critical');

    await list.handler({ app }, app);
    assert.strictEqual(app.lastOk.data.count, 1);
    assert.strictEqual(app.lastOk.data.snippets[0].table, 'incident');
  });

  it('run executes the snippet query against the sdk', async () => {
    const cmd = snippetsCmd((fn) => fn);
    const save = collectSubcommands(cmd).find((s) => s.command === 'save <name>');
    const run = collectSubcommands(cmd).find((s) => s.command === 'run <name>');

    const records = [{ number: 'INC001' }];
    const sdk = { list: async () => records };
    const app = buildApp(sdk);

    await save.handler({ app, name: 'crit', table: 'incident', query: 'priority=1' }, app);
    await run.handler({ app, name: 'crit' }, app);
    assert.strictEqual(app.lastOk.data.count, 1);
    assert.strictEqual(app.lastOk.data.records[0].number, 'INC001');
  });

  it('delete removes the snippet', async () => {
    const cmd = snippetsCmd((fn) => fn);
    const save = collectSubcommands(cmd).find((s) => s.command === 'save <name>');
    const del = collectSubcommands(cmd).find((s) => s.command === 'delete <name>');
    const list = collectSubcommands(cmd).find((s) => s.command === 'list');
    const app = buildApp({});

    await save.handler({ app, name: 'x', table: 'sys_user', query: '' }, app);
    // --force to bypass the interactive confirm
    await del.handler({ app, name: 'x', force: true }, app);
    await list.handler({ app }, app);
    assert.strictEqual(app.lastOk.data.count, 0);
  });
});

describe('logs follow', () => {
  it('registers the follow subcommand', async () => {
    const { logsCmd } = await import('../src/commands/dev/logs.js');
    const cmd = logsCmd((fn) => fn);
    const subs = collectSubcommands(cmd);
    const follow = subs.find((s) => s && s.command === 'follow');
    assert.ok(follow, 'logs follow subcommand exists');
  });
});
