// The mutating surface of `jsn events reprocess`.
//
// The command must run the instance's own Reprocess Event UI action script, cap
// the batch, refuse unattended use without --force, read every new copy back,
// and stay completely inert under --dry-run.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { captureSubcommands, findCommand, wrapHandler } from './support/command-test-helpers.js';
import { eventsCmd } from '../src/commands/events.js';
import { isMutationCommand } from '../src/mutations.js';
import { collectCapabilities, isLocalPreview, mutationPaths } from '../src/capabilities.js';
import {
  REPROCESS_RESULT_MARKER, buildReprocessScript, executeReprocess, formatReprocessPreview, parseReprocessOutput, planReprocess,
} from '../src/events-reprocess.js';

const SOURCE_ID = 'a1'.repeat(16);
const DERIVED_ID = 'b2'.repeat(16);
const COPY_ID = 'c3'.repeat(16);
const ACTION_ID = 'd4'.repeat(16);
const HOSTILE_ID = '9a'.repeat(16);

const ACTION_SCRIPT = [
  "current.state = 'ready';",
  'current.processed = "NULL";',
  'current.processing_duration = "NULL";',
  'current.insert();',
].join('\n');

const EVENTS = [
  {
    sys_id: SOURCE_ID, name: 'asset.restock', queue: '', state: 'processed',
    parm1: '10', parm2: '5', process_on: '2026-11-22 01:00:02', processed: '2026-11-22 01:00:04',
    sys_created_on: '2026-11-22 01:00:02',
  },
  {
    sys_id: DERIVED_ID, name: 'asset.restock', queue: '', state: 'ready',
    parm1: 'orig_event:abc', parm2: '5', process_on: '2026-11-22 01:00:05', processed: '',
    sys_created_on: '2026-11-22 01:00:02',
  },
  {
    // An instance-supplied name that is not a plain name: the consumer preview
    // must skip it instead of sending it as an encoded-query value.
    sys_id: HOSTILE_ID, name: 'javascript:gs.getUserName()', queue: '', state: 'processed',
    parm1: '1', parm2: '', process_on: '2026-11-22 01:00:02', processed: '2026-11-22 01:00:04',
    sys_created_on: '2026-11-22 01:00:02',
  },
];

const ACTIONS = [{ sys_id: 'e5'.repeat(16), event_name: 'asset.restock', active: 'true', condition_script: '' }];
const NOTIFICATIONS = [{ sys_id: 'f6'.repeat(16), name: 'Asset Restocking', event_name: 'asset.restock', active: 'true', collection: 'alm_asset' }];

function matchesQuery(row, query) {
  for (const term of String(query || '').split('^').filter(Boolean)) {
    if (/^ORDERBY/i.test(term)) continue;
    const state = /^state=(.+)$/.exec(term);
    if (state && row.state !== state[1]) return false;
    const name = /^name=(.+)$/.exec(term);
    if (name && row.name !== name[1]) return false;
    const sysId = /^sys_id=(.+)$/.exec(term);
    if (sysId && row.sys_id !== sysId[1]) return false;
  }
  return true;
}

function nameMatcher(query) {
  const equal = /event_name=([^^]+)/.exec(query);
  if (equal) return row => row.event_name === equal[1];
  const list = /event_nameIN([^^]+)/.exec(query);
  if (list) {
    const names = new Set(list[1].split(','));
    return row => names.has(row.event_name);
  }
  return () => true;
}

function makeSdk({ scriptOutput = null } = {}) {
  const calls = [];
  const writes = [];
  const copies = {
    [COPY_ID]: { sys_id: COPY_ID, name: 'asset.restock', state: 'ready', queue: '', process_on: '2026-11-26 12:00:10' },
  };
  const sdk = {
    calls,
    writes,
    async list(table, params = {}) {
      calls.push({ op: 'list', table, params });
      const query = String(params.sysparm_query || '');
      if (table === 'sysevent') return EVENTS.filter(row => matchesQuery(row, query));
      if (table === 'sysevent_script_action') return ACTIONS.filter(nameMatcher(query));
      if (table === 'sysevent_email_action') return NOTIFICATIONS.filter(nameMatcher(query));
      if (table === 'sys_ui_action') {
        return [{
          sys_id: ACTION_ID, name: 'Reprocess Event', table: 'sysevent', active: 'true',
          condition: 'current.canWrite()', script: ACTION_SCRIPT,
        }];
      }
      return [];
    },
    async aggregateCount(table, query) {
      calls.push({ op: 'aggregateCount', table, query });
      if (table === 'sysevent') return EVENTS.filter(row => matchesQuery(row, query)).length;
      return 0;
    },
    async get(table, id) {
      calls.push({ op: 'get', table, id });
      return copies[id] || null;
    },
    async executeScript(script, scope, opts) {
      calls.push({ op: 'executeScript', script, scope, opts });
      writes.push(['executeScript', script]);
      return scriptOutput;
    },
    async create(...args) { writes.push(['create', args]); throw new Error('create must not be used'); },
    async update(...args) { writes.push(['update', args]); throw new Error('update must not be used'); },
    async delete(...args) { writes.push(['delete', args]); throw new Error('delete must not be used'); },
  };
  return sdk;
}

function appFor(sdk) {
  return {
    sdk,
    config: { profiles: {}, activeProfile: null },
    requireInstance() {},
    getEffectiveInstance: () => 'https://dev.example.service-now.com',
    ok(data, opts) { this.lastOk = { data, opts }; },
  };
}

function reprocessCommand() {
  return findCommand(captureSubcommands(eventsCmd(wrapHandler)), 'reprocess [sys-id]');
}

describe('events reprocess declaration', () => {
  it('is a declared mutation that a read-only profile refuses, with a declared local preview', () => {
    const caps = collectCapabilities().get('events');
    assert.deepStrictEqual(caps.mutationSubcommands, ['reprocess']);
    assert.deepStrictEqual(caps.localPreviewSubcommands, ['reprocess']);
    assert.strictEqual(caps.mutationContext, 'operational');
    assert.ok(mutationPaths().some(path => path[0] === 'events' && path[1] === 'reprocess'));
    assert.ok(isMutationCommand({ _: ['events', 'reprocess', SOURCE_ID] }));
    assert.ok(!isMutationCommand({ _: ['events', 'show', SOURCE_ID] }));
    assert.ok(isLocalPreview({ _: ['events', 'reprocess'], dryRun: true }));
  });

  it('caps the batch and needs an explicit selector', async () => {
    const sdk = makeSdk();
    await assert.rejects(planReprocess(sdk, {}), /sys_id or --query/);
    await assert.rejects(planReprocess(sdk, { 'sys-id': SOURCE_ID, query: 'state=error' }), /not both/);
    const capped = await planReprocess(sdk, { query: 'name=asset.restock', limit: 1000 });
    assert.strictEqual(capped.selection.limit, 50);
  });
});

describe('events reprocess planning', () => {
  it('reads the UI action live and skips events the platform condition refuses', async () => {
    const plan = await planReprocess(makeSdk(), { query: 'name=asset.restock', limit: 10 });
    assert.strictEqual(plan.action.sys_id, ACTION_ID);
    assert.match(plan.action.script, /current\.insert\(\)/);
    assert.deepStrictEqual(plan.queueable.map(event => event.sys_id), [SOURCE_ID]);
    assert.strictEqual(plan.skipped.length, 1);
    assert.strictEqual(plan.skipped[0].sys_id, DERIVED_ID);
    assert.match(plan.skipped[0].reason, /orig_event/);
    assert.strictEqual(plan.consumers.notifications[0].name, 'Asset Restocking');
    assert.strictEqual(plan.consumers.script_actions[0].sys_id, 'e5'.repeat(16));
    assert.strictEqual(plan.selection.total_matching, 2);
  });

  it('skips a consumer name that is not a plain name instead of querying it', async () => {
    const sdk = makeSdk();
    const plan = await planReprocess(sdk, { 'sys-id': HOSTILE_ID });
    assert.deepStrictEqual(plan.consumers.names, []);
    assert.deepStrictEqual(plan.consumers.skipped_names, ['javascript:gs.getUserName()']);
    assert.deepStrictEqual(plan.consumers.script_actions, []);
    assert.deepStrictEqual(plan.consumers.notifications, []);
    const consumerCalls = sdk.calls.filter(call => call.table === 'sysevent_script_action' || call.table === 'sysevent_email_action');
    assert.deepStrictEqual(consumerCalls, [], 'no consumer query may carry an unqueryable name');
    // The event is still selectable for reprocessing; only the preview lookup is skipped.
    assert.deepStrictEqual(plan.queueable.map(event => event.sys_id), [HOSTILE_ID]);
    assert.match(formatReprocessPreview(plan), /Names not queryable for consumers/);
  });

  it('embeds the platform script verbatim in a bounded runner', () => {
    const script = buildReprocessScript(ACTION_SCRIPT, [SOURCE_ID]);
    assert.ok(script.includes(ACTION_SCRIPT), 'the UI action script must be embedded unchanged');
    assert.ok(script.includes(`'${SOURCE_ID}'`));
    assert.match(script, /current\.canWrite\(\)/);
    assert.match(script, /orig_event:/);
    assert.match(script, /copy_sys_id/);
    assert.ok(script.trimEnd().endsWith(`${REPROCESS_RESULT_MARKER}" + JSON.stringify(jsnResults));`));
  });

  it('refuses to claim an outcome without the result marker', () => {
    const parsed = parseReprocessOutput(`noise\n${REPROCESS_RESULT_MARKER}[{"sys_id":"${SOURCE_ID}","status":"queued","copy_sys_id":"${COPY_ID}"}]`);
    assert.strictEqual(parsed[0].copy_sys_id, COPY_ID);
    assert.throws(() => parseReprocessOutput('Background script ran with no marker'), /outcome is unknown/);
    assert.throws(() => parseReprocessOutput(`${REPROCESS_RESULT_MARKER}{not json}`), /malformed|outcome is unknown/);
  });

  it('reads every new copy back before counting it as queued', async () => {
    const marker = `${REPROCESS_RESULT_MARKER}[{"sys_id":"${SOURCE_ID}","status":"queued","copy_sys_id":"${COPY_ID}"}]`;
    const sdk = makeSdk({ scriptOutput: marker });
    const plan = await planReprocess(sdk, { 'sys-id': SOURCE_ID });
    const result = await executeReprocess(sdk, plan);
    assert.strictEqual(result.success_count, 1);
    assert.strictEqual(result.failure_count, 0);
    assert.strictEqual(result.results[0].verified, true);
    assert.strictEqual(result.results[0].copy.state, 'ready');
    assert.strictEqual(result.writes_performed, true);
    const readback = sdk.calls.find(call => call.op === 'get');
    assert.strictEqual(readback.id, COPY_ID);
    // Only the background script writes; the command never uses table CRUD.
    assert.deepStrictEqual(sdk.writes.map(entry => entry[0]), ['executeScript']);
  });
});

describe('events reprocess command', () => {
  it('prints consumers and writes nothing with --dry-run', async () => {
    const sdk = makeSdk();
    const app = appFor(sdk);
    await reprocessCommand().handler({ app, query: 'name=asset.restock', limit: 10, dryRun: true });
    assert.strictEqual(sdk.writes.length, 0);
    assert.strictEqual(app.lastOk.data.writes_performed, false);
    assert.strictEqual(app.lastOk.data.dry_run, true);
    assert.match(app.lastOk.opts.summary, /nothing written/);
    const preview = app.lastOk.data._formatted;
    assert.match(preview, /NOTIFICATIONS THAT WILL RUN AGAIN/);
    assert.match(preview, /Asset Restocking/);
    assert.match(preview, /Nothing has been written/);
  });

  it('refuses an unattended batch without --force', async () => {
    const sdk = makeSdk();
    const app = appFor(sdk);
    await assert.rejects(
      reprocessCommand().handler({ app, query: 'name=asset.restock', limit: 10 }),
      (error) => error.code === 'confirmation_required',
    );
    assert.strictEqual(sdk.writes.length, 0);
  });

  it('reports a verified batch and a partial batch honestly', async () => {
    const marker = JSON.stringify([
      { sys_id: SOURCE_ID, status: 'queued', copy_sys_id: COPY_ID },
    ]);
    const sdk = makeSdk({ scriptOutput: `${REPROCESS_RESULT_MARKER}${marker}` });
    const app = appFor(sdk);
    await reprocessCommand().handler({ app, 'sys-id': SOURCE_ID, force: true });
    assert.strictEqual(app.lastOk.data.success_count, 1);
    assert.strictEqual(app.lastOk.data.failure_count, 0);
    assert.match(app.lastOk.data._formatted, /1 queued and verified; 0 failed/);
  });
});
