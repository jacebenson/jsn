// Tests for the second feature batch: query snippets + logs --follow.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { captureSubcommands, findCommand, wrapHandler } from './support/command-test-helpers.js';
import { makeApp } from './support/app-test-helpers.js';

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    const { logsCmd } = await import('../src/commands/logs.js');
    const cmd = logsCmd(wrapHandler);
    const follow = findCommand(captureSubcommands(cmd), 'follow');
    assert.ok(follow, 'logs follow subcommand exists');
  });

  it('refuses to follow when it cannot read where to start', async () => {
    const { logsCmd } = await import('../src/commands/logs.js');
    const follow = findCommand(captureSubcommands(logsCmd(wrapHandler)), 'follow');
    let reads = 0;
    const denied = Object.assign(new Error('Authentication rejected (HTTP 401)'), { code: 'auth_error' });
    const app = makeApp({ sdk: { listStrict: async () => { reads += 1; throw denied; } } });
    const stderr = process.stderr.write;
    process.stderr.write = () => true;
    try {
      await assert.rejects(follow.handler({ app, tail: 0, interval: 2000 }), (error) => error === denied);
    } finally {
      process.stderr.write = stderr;
    }
    assert.strictEqual(reads, 1);
  });

  it('filters --level by the number syslog stores for each name', async () => {
    const { logsCmd } = await import('../src/commands/logs.js');
    const follow = findCommand(captureSubcommands(logsCmd(wrapHandler)), 'follow');
    const stored = { trace: -2, debug: -1, information: 0, warning: 1, error: 2, fatal: 3 };
    const stderr = process.stderr.write;
    process.stderr.write = () => true;
    try {
      for (const [level, value] of Object.entries(stored)) {
        const queries = [];
        // The --tail read carries the filters; it fails on purpose, so the handler stops before polling.
        const app = makeApp({ sdk: { listStrict: async (table, params) => { queries.push(params.get('sysparm_query')); throw new Error('stop'); } } });
        await assert.rejects(follow.handler({ app, level, tail: 1, interval: 2000 }));
        assert.deepStrictEqual(queries, [`level=${value}^ORDERBYDESCsys_created_on`], level);
      }
    } finally {
      process.stderr.write = stderr;
    }
  });

  it('refuses an unknown --level before any request', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-logs-'));
    try {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/jsn.js', import.meta.url)), '--instance', 'https://example.invalid', 'logs', 'follow', '--level', 'Error'], {
        encoding: 'utf8',
        env: { ...process.env, XDG_CONFIG_HOME: dir, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' },
        timeout: 5000,
      });
      assert.strictEqual(result.status, 2);
      assert.match(result.stdout + result.stderr, /Invalid value for --level: Error\. Choose from: trace, debug, information, warning, error, fatal/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
