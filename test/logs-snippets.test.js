// Tests for the second feature batch: query snippets + logs --follow.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { captureSubcommands, findCommand, wrapHandler } from './support/command-test-helpers.js';
import { makeApp } from './support/app-test-helpers.js';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
    const cmd = snippetsCmd(wrapHandler);
    const save = findCommand(captureSubcommands(cmd), 'save <name>');
    const list = findCommand(captureSubcommands(cmd), 'list');
    assert.ok(save && list);

    const app = makeApp({ sdk: {} });
    await save.handler({ app, name: 'prod-critical', table: 'incident', query: 'priority=1^active=true', columns: 'number,short_description' });
    assert.strictEqual(app.lastOk.data.name, 'prod-critical');

    await list.handler({ app });
    assert.strictEqual(app.lastOk.data.count, 1);
    assert.strictEqual(app.lastOk.data.snippets[0].table, 'incident');
  });

  it('run executes the snippet query against the sdk', async () => {
    const cmd = snippetsCmd(wrapHandler);
    const save = findCommand(captureSubcommands(cmd), 'save <name>');
    const run = findCommand(captureSubcommands(cmd), 'run <name>');

    const records = [{ number: 'INC001' }];
    const sdk = { list: async () => records };
    const app = makeApp({ sdk });

    await save.handler({ app, name: 'crit', table: 'incident', query: 'priority=1' });
    await run.handler({ app, name: 'crit' });
    assert.strictEqual(app.lastOk.data.count, 1);
    assert.strictEqual(app.lastOk.data.records[0].number, 'INC001');
  });

  it('delete removes the snippet', async () => {
    const cmd = snippetsCmd(wrapHandler);
    const save = findCommand(captureSubcommands(cmd), 'save <name>');
    const del = findCommand(captureSubcommands(cmd), 'delete <name>');
    const list = findCommand(captureSubcommands(cmd), 'list');
    const app = makeApp({ sdk: {} });

    await save.handler({ app, name: 'x', table: 'sys_user', query: '' });
    // --force to bypass the interactive confirm
    await del.handler({ app, name: 'x', force: true });
    await list.handler({ app });
    assert.strictEqual(app.lastOk.data.count, 0);
  });
});

describe('logs follow', () => {
  it('registers the follow subcommand', async () => {
    const { logsCmd } = await import('../src/commands/dev/logs.js');
    const cmd = logsCmd(wrapHandler);
    const follow = findCommand(captureSubcommands(cmd), 'follow');
    assert.ok(follow, 'logs follow subcommand exists');
  });
});
