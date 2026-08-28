import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { perfCmd } from '../src/commands/perf.js';
import { FormatJSON, OutputWriter } from '../src/output.js';

function commandTree() {
  const commands = [];
  const yargs = {
    command(definition) { commands.push(definition); return this; },
    option() { return this; },
  };
  perfCmd(fn => fn).builder(yargs);
  return commands;
}

function sdkFor() {
  return {
    async list(table) {
      if (table === 'sys_cluster_state') return [];
      return [];
    },
    async get() { return null; },
    async aggregate() { return { groups: [] }; },
    async aggregateCount(table) { return table === 'incident' ? 7 : 0; },
  };
}

function appFor(sdk = sdkFor()) {
  let serialized = '';
  const writer = new Writable({
    write(chunk, _encoding, callback) {
      serialized += chunk.toString();
      callback();
    },
  });
  const output = new OutputWriter({ format: FormatJSON, writer });
  return {
    app: {
      sdk,
      output,
      session: { profileName: 'admin', username: 'admin' },
      context: { profileName: 'admin' },
      requireInstance() {},
      getEffectiveInstance: () => 'https://dev.example',
      ok(data, opts) { this.output.ok(data, opts); },
    },
    envelope() { return JSON.parse(serialized); },
  };
}

function command(name) {
  const definition = commandTree().find(item => item.command === name);
  assert.ok(definition, `missing perf ${name} command`);
  return definition;
}

let dataHome;

test.beforeEach(() => {
  dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-perf-command-'));
  process.env.JSN_DATA_HOME = dataHome;
});

test.afterEach(() => {
  delete process.env.JSN_DATA_HOME;
  fs.rmSync(dataHome, { recursive: true, force: true });
});

test('perf capture preserves the JSON envelope and detailed _formatted field', async () => {
  const { app, envelope } = appFor();
  await command('capture').handler({ label: 'baseline' }, app);
  const result = envelope();

  assert.deepEqual(Object.keys(result), ['ok', 'data', 'summary', 'breadcrumbs']);
  assert.equal(result.ok, true);
  assert.equal(result.data.label, 'baseline');
  assert.deepEqual(result.data.collectors.map(collector => collector.name).sort(), [
    'platform_health', 'transactions', 'error_warning_summary', 'event_queue',
    'ecc_queue', 'flow_executions', 'record_counts', 'scheduled_and_cleanup',
  ].sort());
  assert.equal(typeof result.data._formatted, 'string');
  assert.match(result.data._formatted, /CAPTURED DETAILS/);
  assert.equal(result.summary, `Performance capture ${result.data.run_id}: complete`);
  assert.deepEqual(result.breadcrumbs.map(item => item.action), ['list', 'show', 'compare']);
});

test('perf list preserves the JSON envelope and list _formatted field', async () => {
  const { captureRun } = await import('../src/perf.js');
  await captureRun({ sdk: sdkFor(), instance: 'https://dev.example', profile: 'admin', label: 'baseline' });
  const { app, envelope } = appFor();
  await command('list').handler({ limit: 50 }, app);
  const result = envelope();

  assert.deepEqual(Object.keys(result), ['ok', 'data', 'summary', 'breadcrumbs']);
  assert.equal(result.ok, true);
  assert.equal(result.data.count, 1);
  assert.equal(result.data.runs[0].label, 'baseline');
  assert.equal(typeof result.data._formatted, 'string');
  assert.match(result.data._formatted, /RUN ID\s+STATUS\s+LABEL\s+INSTANCE/);
  assert.equal(result.summary, '1 performance capture(s)');
  assert.equal(result.breadcrumbs[0].action, 'capture');
});

test('perf show preserves the JSON envelope and detailed _formatted field', async () => {
  const { captureRun } = await import('../src/perf.js');
  const run = await captureRun({ sdk: sdkFor(), instance: 'https://dev.example', profile: 'admin', label: 'baseline' });
  const { app, envelope } = appFor();
  await command('show [run_id]').handler({ run_id: run.run_id }, app);
  const result = envelope();

  assert.deepEqual(Object.keys(result), ['ok', 'data', 'summary', 'breadcrumbs']);
  assert.equal(result.ok, true);
  assert.equal(result.data.run_id, run.run_id);
  assert.equal(typeof result.data._formatted, 'string');
  assert.match(result.data._formatted, new RegExp(`Run ${run.run_id}`));
  assert.equal(result.summary, `Performance capture ${run.run_id}`);
  assert.deepEqual(result.breadcrumbs.map(item => item.action), ['list', 'compare']);
});

test('perf compare preserves the JSON envelope and comparison _formatted field', async () => {
  const { captureRun } = await import('../src/perf.js');
  const baseline = await captureRun({ sdk: sdkFor(), instance: 'https://dev.example', profile: 'admin', label: 'baseline' });
  await new Promise(resolve => setTimeout(resolve, 1100));
  const newer = await captureRun({ sdk: sdkFor(), instance: 'https://dev.example', profile: 'admin', label: 'new' });
  const { app, envelope } = appFor();
  await command('compare [baseline] [new]').handler({ baseline: baseline.run_id, new: newer.run_id }, app);
  const result = envelope();

  assert.deepEqual(Object.keys(result), ['ok', 'data', 'summary', 'breadcrumbs']);
  assert.equal(result.ok, true);
  assert.equal(result.data.baseline_run_id, baseline.run_id);
  assert.equal(result.data.new_run_id, newer.run_id);
  assert.equal(typeof result.data._formatted, 'string');
  assert.match(result.data._formatted, /Performance comparison:/);
  assert.equal(result.summary, `Performance comparison: ${result.data.status}`);
  assert.deepEqual(result.breadcrumbs.map(item => item.action), ['list', 'show', 'show']);
});
