// Tests for the parent dev command — bare invocation must show help

import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('Dev Command Structure', () => {
  it('should export devCmd', async () => {
    const { devCmd } = await import('../src/commands/dev.js');
    assert.strictEqual(typeof devCmd, 'function');
  });

  it('uses optional [subcommand] so bare invocation shows help', async () => {
    const { devCmd } = await import('../src/commands/dev.js');
    const wrap = (fn) => fn;
    const cmd = devCmd(wrap);
    assert.match(cmd.command, /dev \[subcommand\]/);
  });

  it('bare handler prints the command list instead of being a silent stub', async () => {
    const { devCmd } = await import('../src/commands/dev.js');
    const wrap = (fn) => fn;
    const cmd = devCmd(wrap);

    // Capture console.log output
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      cmd.handler({ _: ['dev'] }); // bare invocation — no subcommand
    } finally {
      console.log = origLog;
    }

    const out = logs.join('\n');
    assert.ok(out.includes('Manage ServiceNow development artifacts'), 'missing heading');
    assert.ok(out.includes('updatesets'), 'missing command list');
    assert.ok(out.includes('eval'), 'missing eval in command list');
  });

  it('bare handler stays silent when a subcommand is present (its own handler runs)', async () => {
    const { devCmd } = await import('../src/commands/dev.js');
    const wrap = (fn) => fn;
    const cmd = devCmd(wrap);

    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      cmd.handler({ _: ['dev', 'flows'] });
    } finally {
      console.log = origLog;
    }

    assert.strictEqual(logs.length, 0, 'handler should not print when a subcommand ran');
  });
});
