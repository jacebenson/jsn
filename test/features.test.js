// Tests for the feature batch: records count, bulk update (dry-run), attachments,
// output --get extractor and --csv. Added alongside the feature batch.

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';

// ─── helpers to navigate the yargs command tree ───
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

// Handlers don't return app.ok's result — capture it on the mock app.
function buildApp(sdk) {
  const app = {
    sdk,
    config: { profiles: {}, activeProfile: null },
    requireInstance() {},
    getEffectiveInstance: () => 'https://dev.example.service-now.com',
    output: { getFormat: () => 'json' }, // non-auto → interactiveList short-circuits
    ok: (data, opts) => { app.lastOk = { data, opts }; },
  };
  return app;
}

// ─── helpers to navigate the yargs command tree ───

describe('records list totals (include_counts)', () => {
  it('includes the total by default', async () => {
    const { recordsCmd } = await import('../src/commands/records.js');
    const cmd = recordsCmd((fn) => fn);
    const list = collectSubcommands(cmd).find((s) => s.command === 'list');
    const sdk = { list: async () => [{ sys_id: 'r1' }], aggregateCount: async () => 67 };
    const app = buildApp(sdk);
    await list.handler({ app, table: 'incident', limit: 20, offset: 0, query: '', count: true }, app);
    assert.strictEqual(app.lastOk.data.pagination.total, 67);
    assert.match(app.lastOk.opts.summary, /of 67/);
  });

  it('--no-count omits the total', async () => {
    const { recordsCmd } = await import('../src/commands/records.js');
    const cmd = recordsCmd((fn) => fn);
    const list = collectSubcommands(cmd).find((s) => s.command === 'list');
    const sdk = { list: async () => [{ sys_id: 'r1' }], aggregateCount: async () => 67 };
    const app = buildApp(sdk);
    await list.handler({ app, table: 'incident', limit: 20, offset: 0, query: '', count: false }, app);
    assert.strictEqual(app.lastOk.data.pagination.total, undefined);
    assert.doesNotMatch(app.lastOk.opts.summary, /of 67/);
  });

  it('respects per-profile include_counts:false opt-out', async () => {
    const { recordsCmd } = await import('../src/commands/records.js');
    const cmd = recordsCmd((fn) => fn);
    const list = collectSubcommands(cmd).find((s) => s.command === 'list');
    const sdk = { list: async () => [{ sys_id: 'r1' }], aggregateCount: async () => 67 };
    const app = buildApp(sdk);
    app.config.activeProfile = 'shotlist';
    app.config.profiles.shotlist = { include_counts: false };
    await list.handler({ app, table: 'incident', limit: 20, offset: 0, query: '', count: true }, app);
    assert.strictEqual(app.lastOk.data.pagination.total, undefined);
  });
});

describe('records bulk (dry-run by default)', () => {
  it('dry-run previews count without mutating', async () => {
    const { recordsCmd } = await import('../src/commands/records.js');
    const cmd = recordsCmd((fn) => fn);
    const bulk = collectSubcommands(cmd).find((s) => s.command === 'bulk');

    let updates = 0;
    const sdk = {
      aggregateCount: async () => 12,
      list: async () => [],
      update: async () => { updates += 1; },
    };
    const app = buildApp(sdk);
    await bulk.handler(
      { app, table: 'incident', query: 'priority=1', set: '{"state":"3"}', 'dry-run': true, execute: false },
      app,
    );
    assert.strictEqual(app.lastOk.data.dry_run, true);
    assert.strictEqual(app.lastOk.data.count, 12);
    assert.strictEqual(updates, 0, 'no updates on dry run');
  });

  it('execute updates each matching record after confirmation', async () => {
    const { recordsCmd } = await import('../src/commands/records.js');
    const cmd = recordsCmd((fn) => fn);
    const bulk = collectSubcommands(cmd).find((s) => s.command === 'bulk');

    const updated = [];
    const sdk = {
      aggregateCount: async () => 2,
      list: async () => [{ sys_id: 'aaa' }, { sys_id: 'bbb' }],
      update: async (t, id) => { updated.push(id); },
    };
    // --force bypasses the interactive confirmation
    const app = buildApp(sdk);
    await bulk.handler(
      { app, table: 'incident', query: 'priority=1', set: '{"state":"3"}', 'dry-run': false, execute: true, force: true, limit: 200 },
      app,
    );
    assert.strictEqual(app.lastOk.data.updated, 2);
    assert.deepStrictEqual(updated, ['aaa', 'bbb']);
  });
});

describe('records attachments', () => {
  it('lists attachments for a record', async () => {
    const { recordsCmd } = await import('../src/commands/records.js');
    const cmd = recordsCmd((fn) => fn);
    const att = collectSubcommands(cmd).find((s) => s.command === 'attachments');
    assert.ok(att, 'attachments subcommand exists');

    const subs = collectSubcommands(att);
    const listSub = subs.find((s) => s && s.command === 'list');
    assert.ok(listSub, 'attachments list subcommand exists');

    const sdk = { listAttachments: async () => [{ sys_id: 'att1', file_name: 'notes.txt' }] };
    const app = buildApp(sdk);
    await listSub.handler({ app, 'sys-id': 'rec1' }, app);
    assert.strictEqual(app.lastOk.data.count, 1);
    assert.strictEqual(app.lastOk.data.attachments[0].file_name, 'notes.txt');
  });

  it('sdk.getAttachment returns file bytes', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const sdk = new SDKClient('https://dev.service-now.com', { getCredentials: async () => ({ username: 'u', password: 'p' }) });
    const buf = Buffer.from('hello');
    sdk._fetchWithAuth = async () => ({ ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
    const out = await sdk.getAttachment('att1');
    assert.strictEqual(out.toString(), 'hello');
  });

  it('records get --attachments attaches the file list to the record', async () => {
    const { recordsCmd } = await import('../src/commands/records.js');
    const cmd = recordsCmd((fn) => fn);
    const get = collectSubcommands(cmd).find((s) => s.command === 'get');

    const sdk = {
      list: async () => [{ sys_id: 'rec1', number: 'INC1' }],
      listAttachments: async () => [{ sys_id: 'a1', file_name: 'notes.txt' }],
    };
    const app = buildApp(sdk);
    await get.handler({ app, table: 'incident', 'sys-id': 'rec1', attachments: true }, app);
    assert.deepStrictEqual(app.lastOk.data._attachments, [{ sys_id: 'a1', file_name: 'notes.txt' }]);
    assert.strictEqual(app.lastOk.data.number, 'INC1');
  });
});

describe('output --get extractor', () => {
  let outputMod;
  beforeEach(async () => { outputMod = await import('../src/output.js'); });
  afterEach(() => mock.reset());

  it('resolves dotted + indexed paths against an object', () => {
    const { resolvePath } = outputMod;
    const obj = { data: { records: [{ number: 'INC001' }, { number: 'INC002' }] } };
    assert.strictEqual(resolvePath(obj, 'data.records.0.number'), 'INC001');
    assert.strictEqual(resolvePath(obj, '.data.records[1].number'), 'INC002');
    assert.strictEqual(resolvePath(obj, 'data.missing'), undefined);
  });

  it('--get emits only the extracted value', () => {
    const { OutputWriter, FormatJSON } = outputMod;
    const chunks = [];
    const w = new OutputWriter({ format: FormatJSON, writer: { write: (s) => chunks.push(s), isTTY: false } });
    w.setJqFilter('data.records.0.number');
    w.ok({ records: [{ number: 'INC001' }] }, {});
    const text = chunks.join('');
    assert.match(text, /INC001/);
    assert.doesNotMatch(text, /"ok"/, 'envelope should be collapsed by --get');
  });

  it('writes CSV from a records payload', () => {
    const { OutputWriter, FormatCSV } = outputMod;
    const chunks = [];
    const w = new OutputWriter({ format: FormatCSV, writer: { write: (s) => chunks.push(s), isTTY: false } });
    w.ok({ records: [{ number: 'INC001', state: 'New' }, { number: 'INC,002', state: 'On Hold' }] }, {});
    const text = chunks.join('');
    assert.match(text, /number,state/);
    assert.match(text, /"INC,002"/, 'CSV field with comma is quoted');
  });
});
