import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { inspectUpdateSetXML } from '../src/update-set-xml.js';
import { createContext } from '../scripts/acceptance/support.mjs';

const RUN = 'acceptance_fixture_001';
const ID = 'a'.repeat(32);
const CAPTURE = 'b'.repeat(32);
const ok = data => ({ exitCode: 0, stdout: '', stderr: '', json: { ok: true, data } });
const no = message => ({ exitCode: 1, stdout: '', stderr: '', json: { ok: false, code: 'confirmation_required', error: message } });

for (const [originalScope, propertyLifecycle] of [['global', false], ['c'.repeat(32), false], ['global', true]]) test(`real CLI context wire contract restores original by name and exact picker IDs (${originalScope}${propertyLifecycle ? ', property denial journal' : ''})`, { timeout: 60000 }, async t => {
  const { scenarios } = await import('./acceptance/workflows.mjs');
  const scenario = scenarios.find(s => s.id === 'workflows.context');
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'jsn-context-wire-'));
  const original = { sys_id: ID, name: 'Original working set', application: originalScope, state: 'in progress' };
  const records = [original], requests = [], commands = [];
  let app = original.application, selected = ID, rejectSelection = false, property;
  const propertyId = '9'.repeat(32);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    let text = ''; for await (const chunk of req) text += chunk;
    const body = text && req.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null;
    requests.push({ method: req.method, path: url.pathname, query: url.searchParams.get('sysparm_query'), body });
    res.setHeader('Content-Type', 'application/json');
    let result;
    const kind = url.pathname.split('/').at(-1);
    if (url.pathname === '/angular.do') result = {};
    else if (url.pathname.startsWith('/api/now/ui/concoursepicker/')) {
      if (rejectSelection && kind === 'updateset' && req.method === 'PUT') {
        res.statusCode = 403; res.end(JSON.stringify({ error: { message: 'Synthetic selection refusal' } })); return;
      }
      if (req.method === 'PUT') {
        if (kind === 'application') { app = body.app_id; selected = 'e'.repeat(32); }
        else selected = body.sysId;
      }
      result = { current: kind === 'application' ? app : { sysId: selected } };
    } else if (url.pathname.startsWith('/api/now/table/')) {
      const [, , , , table, recordId] = url.pathname.split('/');
      const query = url.searchParams.get('sysparm_query') || '';
      if (table === 'sys_user') result = [{ sys_id: 'f'.repeat(32), user_name: 'fixture' }];
      else if (table === 'sys_scope') {
        const scope = recordId || query.split('=')[1];
        result = { sys_id: scope, scope, name: scope };
        if (!recordId) result = [result];
      } else if (table === 'sys_user_preference') result = [{ value: query.includes('apps.current_app') ? app : selected }];
      else if (table === 'sys_dictionary') result = ['name', 'value', 'description'].map(element => ({ element, mandatory: false }));
      else if (table === 'sys_properties') {
        if (req.method === 'POST') property = { sys_id: propertyId, sys_scope: 'global', ...body };
        else if (req.method === 'PUT' || req.method === 'PATCH') Object.assign(property, body);
        else if (req.method === 'DELETE') { assert.equal(recordId, propertyId); property = null; }
        result = recordId || req.method !== 'GET' ? property ?? {} : property ? [property] : [];
      } else if (table === 'sys_update_set') {
        if (req.method === 'POST') { result = { sys_id: CAPTURE, ...body }; records.push(result); }
        else if (recordId) result = records.find(r => r.sys_id === recordId) || null;
        // Exact name matching is deliberate: accepting any argument hid the live defect.
        else result = records.filter(r => query === `name=${r.name}` || query === `sys_id=${r.sys_id}`).slice(0, Number(url.searchParams.get('sysparm_limit')) || 50);
      } else { res.statusCode = 500; result = { unexpected_table: table }; }
    } else { res.statusCode = 500; result = { unexpected_path: url.pathname }; }
    res.end(JSON.stringify({ result }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  const instance = `http://127.0.0.1:${server.address().port}`;
  const ctx = createContext({ mode: 'pdi', allowWrites: true, profile: 'fixture', outputDir: path.join(root, 'run') }, { target: instance });
  const config = path.join(ctx.outputDir, 'config');
  await fs.mkdir(path.join(config, 'servicenow'), { recursive: true });
  await fs.writeFile(path.join(config, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: {
    fixture: { instance_url: instance, auth_method: 'basic', username: 'fixture' },
  } }));
  const env = { HOME: path.join(ctx.outputDir, 'home'), XDG_CONFIG_HOME: config, PATH: path.join(ctx.outputDir, 'empty-path'),
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent-jsn-acceptance-bus', SN_USERNAME: 'fixture', SN_PASSWORD: 'synthetic-fixture-only' };
  const command = ctx.command;
  ctx.command = async (args, opts = {}) => {
    commands.push(args);
    const result = await command(args, { ...opts, env });
    if (propertyLifecycle && args[0] === 'properties' && args[1] === 'delete' && !args.includes('--force')) {
      assert.notEqual(result.exitCode, 0);
      assert.equal(result.json.ok, false);
      assert.equal(result.json.code, 'confirmation_required');
      assert.equal(typeof result.json.error, 'string');
      const journal = JSON.parse(await fs.readFile(path.join(ctx.outputDir, 'artifacts.json'), 'utf8'));
      assert.equal(journal.writeIntents.at(-1).status, 'resolved', 'real CLI refusal must settle before forced delete');
      assert.equal(requests.filter(r => r.method === 'DELETE').length, 0, 'refusal sends no provider DELETE');
      assert.equal(property.sys_id, propertyId);
    }
    return result;
  };
  ctx.read = async (table, { id, query, fields, limit }) => {
    const params = new URLSearchParams({ sysparm_fields: fields.join(','), sysparm_limit: String(limit) });
    if (query) params.set('sysparm_query', query);
    const response = await fetch(`${instance}/api/now/table/${table}${id ? '/' + id : ''}?${params}`);
    assert.equal(response.status, 200); return (await response.json()).result;
  };
  await scenario.run(ctx);
  assert.equal(selected, CAPTURE);
  assert.equal(commands.some(a => a[0] === 'updatesets' && a[1] === 'set'), false, 'create already selects the capture');
  if (propertyLifecycle) {
    const { scenarios: resources } = await import('./acceptance/resources.mjs');
    await resources.find(s => s.id === 'resources.properties').run(ctx);
    assert.equal(property, null, 'independent exact-ID absence after forced deletion');
    assert.deepEqual(await ctx.cleanup(), [`retained-capture:${CAPTURE}`]);
    assert.deepEqual(await ctx.cleanup(), [`retained-capture:${CAPTURE}`]);
    assert.equal(requests.filter(r => r.method === 'DELETE').length, 1, 'cleanup must not redispatch DELETE');
    const journal = JSON.parse(await fs.readFile(path.join(ctx.outputDir, 'artifacts.json'), 'utf8'));
    assert.equal(journal.artifacts.find(a => a.id === propertyId).cleaned, true);
    assert.equal(ctx.state.get('writes.unresolved'), false);
    assert.equal(ctx.state.get('cleanup.unresolvedChildren'), false);
  }
  await scenario.cleanup(ctx);
  assert.equal(app, original.application);
  assert.equal(selected, original.sys_id);
  assert.deepEqual(commands.filter(a => a[0] === 'updatesets' && a[1] === 'set').map(a => a[2]), [original.name]);
  assert.ok(requests.some(r => r.query === `name=${original.name}`));
  assert.equal(requests.some(r => r.query === `name=${ID}` || r.query === `name=${CAPTURE}`), false);
  const journal = JSON.parse(await fs.readFile(path.join(ctx.outputDir, 'artifacts.json'), 'utf8'));
  assert.ok(journal.writeIntents.length > 0);
  assert.ok(journal.writeIntents.every(i => i.status === 'resolved'), 'real JSON acknowledgement resolves selection journal');
  // Session-token bootstrap POSTs are authentication, not record/context writes.
  assert.deepEqual(requests.filter(r => r.method !== 'GET' && r.path !== '/angular.do').map(r => [r.method, r.path]), [
    ['PUT', '/api/now/ui/concoursepicker/application'], ['POST', '/api/now/table/sys_update_set'], ['PUT', '/api/now/ui/concoursepicker/updateset'],
    ...(propertyLifecycle ? [['POST', '/api/now/table/sys_properties'], ['PUT', `/api/now/table/sys_properties/${propertyId}`], ['DELETE', `/api/now/table/sys_properties/${propertyId}`]] : []),
    ['PUT', '/api/now/ui/concoursepicker/application'], ['PUT', '/api/now/ui/concoursepicker/application'], ['PUT', '/api/now/ui/concoursepicker/updateset'],
  ]);
  // A real selection failure is not an expected-denial bypass or a retry grant.
  rejectSelection = true;
  ctx.state.set('workflows.context', { captureId: CAPTURE });
  const failed = await ctx.command(['updatesets', 'set', original.name, '--json']);
  assert.notEqual(failed.exitCode, 0);
  assert.equal(ctx.state.get('writes.unresolved'), true);
  const afterFailure = requests.length;
  await assert.rejects(scenario.cleanup(ctx), /Unresolved/);
  assert.equal(requests.length, afterFailure, 'no restore/retry while selection outcome is uncertain');
  assert.equal(ctx.state.get('workflows.context').captureId, CAPTURE);
  const uncertain = JSON.parse(await fs.readFile(path.join(ctx.outputDir, 'artifacts.json'), 'utf8'));
  assert.equal(uncertain.writeIntents.at(-1).status, 'uncertain');
});

test('capture create with selection drift retains allocation and never retries selection', async t => {
  const { scenarios } = await import('./acceptance/workflows.mjs');
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'jsn-capture-drift-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const commands = [], artifacts = [];
  let created = false;
  const ctx = { mode: 'pdi', runKey: RUN, outputDir: root, state: new Map(),
    async registerArtifact(artifact) { artifacts.push(artifact); },
    async read(table, query) {
      const record = { sys_id: query.id === CAPTURE ? CAPTURE : ID, name: 'Original', application: 'global', state: 'in progress' };
      return query.id ? record : [record];
    },
    async command(args) {
      commands.push(args);
      if (args[1] === 'create') { created = true; return ok({ sys_id: CAPTURE }); }
      assert.equal(args[0], 'rest', 'no selection fallback or create retry');
      return ok({ result: { current: args[1].endsWith('/application') ? 'global' : { sysId: ID } } });
    },
  };
  await assert.rejects(scenarios.find(s => s.id === 'workflows.context').run(ctx), /capture drifted/);
  assert.equal(created, true);
  assert.deepEqual(artifacts.map(a => a.id), [CAPTURE]);
  assert.equal(ctx.state.get('workflows.context').captureId, CAPTURE);
  assert.equal(commands.filter(a => a[0] === 'updatesets').length, 1);
});

test('context refuses unsafe originals and restoration drift without context writes', async t => {
  const { scenarios } = await import('./acceptance/workflows.mjs');
  const scenario = scenarios.find(s => s.id === 'workflows.context');
  for (const fault of ['duplicate-same-scope', 'duplicate-other-scope', 'missing', 'empty-shape', 'unsafe-name', 'empty-name', 'wrong-scope', 'complete', 'wrong-id']) {
    for (const phase of ['run', 'cleanup']) await t.test(`${phase}: ${fault}`, async () => {
      const commands = [];
      const record = { sys_id: ID, name: 'Original', application: 'global', state: 'in progress' };
      if (fault === 'unsafe-name') record.name = 'Original^ORactive=true';
      if (fault === 'empty-name') record.name = '';
      if (fault === 'wrong-scope') record.application = 'c'.repeat(32);
      if (fault === 'complete') record.state = 'complete';
      if (fault === 'wrong-id') record.sys_id = CAPTURE;
      const snapshot = { application: 'global', updateset: ID };
      const ctx = { mode: 'pdi', runKey: RUN, state: new Map(phase === 'cleanup' ? [['workflows.originalContext', snapshot], ['workflows.context', { captureId: CAPTURE }]] : []),
        async command(args) { commands.push(args); return ok({ result: { current: args[1].endsWith('/application') ? 'global' : { sysId: ID } } }); },
        async read(table, query) {
          if (query.id) return fault === 'missing' ? null : record;
          if (fault === 'empty-shape') return {};
          if (fault.startsWith('duplicate')) return [record, { ...record, sys_id: 'd'.repeat(32), application: fault.endsWith('other-scope') ? 'c'.repeat(32) : 'global' }];
          return [record];
        },
      };
      await assert.rejects(scenario[phase](ctx), /ambiguous|restored|missing|differs/);
      assert.equal(commands.some(a => a[0] !== 'rest'), false, 'refusal must precede any mutation');
      if (phase === 'cleanup') assert.equal(ctx.state.get('workflows.context').captureId, CAPTURE);
    });
  }
  for (const flag of ['writes.unresolved', 'cleanup.unresolvedChildren']) await t.test(flag, async () => {
    const ctx = { state: new Map([['workflows.originalContext', { application: 'global', updateset: ID }], [flag, true]]),
      async command() { assert.fail('uncertainty must prevent context dispatch'); }, async read() { assert.fail('uncertainty must not be auto-reconciled'); } };
    await assert.rejects(scenario.cleanup(ctx), /Unresolved/);
  });
});

function catalogFixture({ wrongAnswer = false } = {}) {
  const ids = Object.fromEntries(['item', 'variable', 'flow', 'trigger', 'request', 'ritm', 'task', 'answer', 'link', 'action', 'instance', 'version'].map((key, i) => [key, (i + 1).toString(16).repeat(32)]));
  const events = [], artifacts = [], data = new Map();
  const put = (table, key, fields) => data.set(`${table}:${ids[key]}`, { sys_id: ids[key], ...fields });
  put('sys_hub_action_type_definition', 'action', { name: 'Create Catalog Task' });
  const name = `jsn_acceptance_${RUN}_catalog`;
  const ctx = { runKey: RUN, mode: 'pdi', state: new Map([
    ['workflows.context', { captureId: CAPTURE, scope: 'global' }], ['workflows.allowRetainedFlows', true],
    ['workflows.catalogRecipe', { actionTypeId: ids.action, inputs: { request_item: '{{trigger.current}}', short_description: '$RUN_NAME' } }],
  ]),
    async registerArtifact(artifact) { artifacts.push(artifact); events.push(['register', artifact]); },
    async read(table, query) {
      events.push(['read', table, query]);
      if (table === 'sys_update_set') return { sys_id: CAPTURE, name: RUN, state: 'in progress' };
      if (table === 'sys_dictionary') return ['name', 'short_description', 'flow_designer_flow', 'question_text', 'type', 'order', 'cat_item', 'mandatory', 'active'].map(element => ({ element, reference: element === 'flow_designer_flow' ? 'sys_hub_flow' : '' }));
      if (query.id) return data.get(`${table}:${query.id}`) ?? null;
      return [...data.entries()].filter(([key]) => key.startsWith(table + ':')).map(([, value]) => value);
    },
    async command(args) {
      events.push(['command', args]);
      if (args[0] === 'rest') return ok({ result: { current: { sysId: CAPTURE } } });
      if (args[0] === 'actions') return ok({ inputs: [{ name: 'request_item', type: 'reference' }, { name: 'short_description', type: 'string' }] });
      if (args[0] === 'catalogitems' && args[1] === 'create') { put('sc_cat_item', 'item', { name }); return ok({ sys_id: ids.item }); }
      if (args[0] === 'records' && args[1] === 'create') { put('item_option_new', 'variable', JSON.parse(args[args.indexOf('--data') + 1])); return ok({ sys_id: ids.variable }); }
      if (args[0] === 'flows' && args[1] === 'create') { put('sys_hub_flow', 'flow', { name: name + '_fulfillment', active: false }); return ok({ flow: { id: ids.flow }, trigger: { id: ids.trigger }, actions: [{ sysId: ids.instance }], version: { sys_id: ids.version } }); }
      if (args[0] === 'flows' && args[1] === 'publish') { data.get('sys_hub_flow:' + ids.flow).active = true; return ok({ active: true }); }
      if (args[0] === 'records' && args[1] === 'update') { data.get('sc_cat_item:' + ids.item).flow_designer_flow = ids.flow; return ok({}); }
      if (args[0] === 'catalogitems' && args[1] === 'order') {
        if (args.includes('{}')) return no('Missing required catalog variable');
        if (args.includes('--dry-run')) return ok({ submitted: false });
        if (!args.includes('--force')) return no('confirmation required');
        put('sc_request', 'request', {}); put('sc_req_item', 'ritm', { request: ids.request, cat_item: ids.item });
        put('sc_task', 'task', { request_item: ids.ritm, short_description: name });
        put('sc_item_option', 'answer', { item_option_new: ids.variable, value: wrongAnswer ? 'wrong' : RUN });
        put('sc_item_option_mtom', 'link', { request_item: ids.ritm, sc_item_option: ids.answer });
        return ok({ submitted: true, request_id: ids.request });
      }
      if (args[1] === 'delete') {
        const artifact = artifacts.find(a => a.id === args[args.indexOf('--sys-id') + 1]);
        data.delete(`${artifact.table}:${artifact.id}`); return ok({ deleted: true });
      }
      return ok({});
    },
  };
  return { ctx, events, artifacts, ids, data };
}

function resourceFixture(options = {}) {
  const events = [];
  let record;
  const ctx = {
    runKey: RUN, mode: 'pdi', state: new Map([['workflows.context', { captureId: CAPTURE, scope: 'global' }]]),
    async registerArtifact(artifact) { events.push(['register', artifact]); if (options.checkpointError) throw Error('checkpoint unavailable'); },
    async read(table, query) {
      events.push(['read', table, query]);
      if (table === 'sys_dictionary') return ['name', 'value', 'description'].map(element => ({ element, mandatory: 'false', read_only: 'false' }));
      if (table === 'sys_update_set') return { sys_id: CAPTURE, name: RUN, state: 'in progress' };
      return record ? { ...record, ...(options.stale && { value: 'wrong' }) } : null;
    },
    async command(args) {
      events.push(['command', args]);
      if (args[0] === 'rest') return ok({ result: { current: { sysId: CAPTURE } } });
      if (args[1] === 'create') { record = { sys_id: ID, ...JSON.parse(args[args.indexOf('--data') + 1]) }; return ok(record); }
      if (args[1] === 'update') { Object.assign(record, JSON.parse(args[args.indexOf('--data') + 1])); return ok(record); }
      if (args[1] === 'delete') {
        if (!args.includes('--force')) return no('confirmation required');
        record = null; return ok({ deleted: true });
      }
      return ok(record);
    },
  };
  return { ctx, events };
}

test('context snapshots before selection, restores exact IDs, and refuses unknown originals before writes', async () => {
  const { scenarios } = await import('./acceptance/workflows.mjs');
  const scenario = scenarios.find(s => s.id === 'workflows.context');
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'jsn-context-'));
  const commands = [];
  let app = 'c'.repeat(32), updateSet = 'd'.repeat(32);
  const fixture = resourceFixture();
  fixture.ctx.outputDir = dir;
  fixture.ctx.state.clear();
  fixture.ctx.read = async (table, query) => {
    const record = query.id === CAPTURE ? { sys_id: CAPTURE, name: RUN, state: 'in progress', application: 'global' } :
      { sys_id: 'd'.repeat(32), name: 'Original working set', application: 'c'.repeat(32), state: 'in progress' };
    return query.id ? record : [record];
  };
  fixture.ctx.command = async args => {
    commands.push(args);
    if (args[0] === 'rest') return ok({ result: { current: args[1].endsWith('/application') ? app : { sysId: updateSet } } });
    if (args[0] === 'updatesets' && args[1] === 'create') {
      const snapshot = JSON.parse(await fs.readFile(path.join(dir, 'workflow-context.json'), 'utf8'));
      assert.deepEqual(snapshot, { application: app, updateset: updateSet });
      app = 'global'; updateSet = CAPTURE; return ok({ sys_id: CAPTURE });
    }
    if (args[0] === 'updatesets' && args[1] === 'set') {
      assert.equal(args[2], 'Original working set'); updateSet = 'd'.repeat(32);
    }
    if (args[0] === 'scopes' && args[1] === 'set') app = args[2];
    return ok({});
  };
  try {
    await scenario.run(fixture.ctx);
    await scenario.cleanup(fixture.ctx);
    assert.equal(app, 'c'.repeat(32));
    assert.equal(updateSet, 'd'.repeat(32));
    assert.ok(commands.some(args => args[0] === 'updatesets' && args[1] === 'create' && args.includes('global')));
    const unknown = resourceFixture(); unknown.ctx.command = async () => ok({});
    await assert.rejects(scenario.run(unknown.ctx), /cannot be restored/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('flow lifecycle executes edit preview/save, publish and bounded independent execution/effect readback', async () => {
  const { scenarios } = await import('./acceptance/workflows.mjs');
  const scenario = scenarios.find(s => s.id === 'workflows.flow-lifecycle');
  const { ctx, events } = resourceFixture();
  ctx.state.set('workflows.allowRetainedFlows', true);
  const name = `jsn_acceptance_${RUN}_flow`;
  const flowId = 'c'.repeat(32), executionId = 'd'.repeat(32);
  let active = false;
  const read = ctx.read;
  ctx.read = async (table, query) => {
    if (table === 'sys_hub_flow') return { sys_id: flowId, name, active };
    if (table === 'sys_flow_context') { events.push(['execution-read', query]); return { sys_id: executionId, state: 'COMPLETE' }; }
    if (table === 'syslog') return [{ sys_id: 'e'.repeat(32), message: name + '_updated' }];
    return read(table, query);
  };
  const cli = ctx.command;
  ctx.command = async args => {
    if (args[0] !== 'flows') return cli(args);
    events.push(['command', args]);
    if (args[1] === 'create') return ok({ flow: { id: flowId }, trigger: { id: 'e'.repeat(32) }, actions: [{ sysId: 'f'.repeat(32) }], version: { sys_id: '1'.repeat(32) } });
    if (args[1] === 'update') return args.includes('--preview') ? ok({ preview: true }) : args.includes('--force') ? ok({}) : no('confirmation required');
    if (args[1] === 'publish') { if (!args.includes('--force')) return no('confirmation required'); active = true; return ok({ active }); }
    if (args[1] === 'status') return ok({ ok: true });
    if (args[1] === 'test') return ok({ accepted: true, context_id: executionId });
    return ok({});
  };
  await assert.rejects(scenario.run(ctx), /native flow deletion/);
  const result = ctx.state.get('workflows.flow-lifecycle.evidence');
  assert.ok(result.verified.includes('execution-completion'));
  assert.ok(events.some(e => e[0] === 'execution-read'));
  assert.ok(events.some(e => e[0] === 'register' && e[1].id === flowId && e[1].cleanupArgs === null));
  assert.deepEqual(events.filter(e => e[0] === 'command' && e[1][0] === 'flows').map(e => e[1][1]), ['schemas', 'create', 'show', 'update', 'update', 'update', 'unlock', 'publish', 'publish', 'status', 'test', 'executions']);
});

test('catalog orchestration creates its full dependency chain before order and verifies actual fulfillment and answers', async () => {
  const { scenarios } = await import('./acceptance/workflows.mjs');
  const { ctx, events, artifacts, ids, data } = catalogFixture();
  await assert.rejects(scenarios.find(s => s.id === 'workflows.catalog-fulfillment').run(ctx), /native flow deletion/);
  const result = ctx.state.get('workflows.catalog-fulfillment.evidence');
  assert.ok(result.verified.includes('fulfillment-effect'));
  const commands = events.filter(e => e[0] === 'command').map(e => e[1]);
  assert.deepEqual(commands.map(args => args.slice(0, 2).join(' ')), [
    'rest /api/now/ui/concoursepicker/updateset', 'actions action-type-schema', 'catalogitems create', 'records create', 'flows create', 'flows publish', 'records update', 'catalogitems show',
    'catalogitems order', 'catalogitems order', 'catalogitems order', 'catalogitems order',
  ]);
  const variableCreate = events.findIndex(e => e[0] === 'command' && e[1][0] === 'records' && e[1][1] === 'create');
  assert.ok(events.findIndex(e => e[0] === 'register' && e[1].id === ids.item) < variableCreate);
  assert.equal(artifacts.find(a => a.id === ids.task).dependsOn[0], ids.ritm);
  assert.ok(artifacts.find(a => a.id === ids.link).dependsOn.includes(ids.answer));
  assert.equal(new Set(artifacts.map(a => a.id)).size, artifacts.length);
  // Exercise exact cleanup argv against the synthetic provider in reverse
  // dependency order. Retained flow components deliberately cannot be cleaned.
  const pending = artifacts.filter(a => a.cleanupArgs);
  const deleted = [];
  while (pending.length) {
    const index = pending.findIndex(a => !pending.some(other => other !== a && other.dependsOn.includes(a.id)));
    assert.notEqual(index, -1);
    const [artifact] = pending.splice(index, 1);
    await ctx.command(artifact.cleanupArgs);
    assert.equal(await ctx.read(artifact.table, { id: artifact.id }), null);
    deleted.push(artifact.id);
  }
  assert.ok(deleted.indexOf(ids.task) < deleted.indexOf(ids.ritm));
  assert.ok(deleted.indexOf(ids.ritm) < deleted.indexOf(ids.request));
  assert.ok(deleted.indexOf(ids.link) < deleted.indexOf(ids.answer));
  assert.ok(data.has('sys_hub_flow:' + ids.flow), 'no invented flow deletion');
});

test('catalog accepted order with wrong persisted variable value is failure', async () => {
  const { scenarios } = await import('./acceptance/workflows.mjs');
  await assert.rejects(scenarios.find(s => s.id === 'workflows.catalog-fulfillment').run(catalogFixture({ wrongAnswer: true }).ctx), /readback differs/);
});

test('all declared resource bindings run with their own schema; missing/read-only/mandatory metadata blocks before create', async () => {
  const { scenarios, fixtures } = await import('./acceptance/resources.mjs');
  for (const fixture of fixtures) {
    const model = resourceFixture();
    const read = model.ctx.read;
    model.ctx.read = async (table, query) => table === 'sys_dictionary' ? Object.keys(fixture.create('synthetic')).map(element => ({ element })) : read(table, query);
    await scenarios.find(s => s.id === `resources.${fixture.command}`).run(model.ctx);
    assert.ok(model.events.some(e => e[0] === 'register' && e[1].table === fixture.table));
  }
  for (const metadata of [[], [{ element: 'name', read_only: true }], [{ element: 'name' }, { element: 'value' }, { element: 'description' }, { element: 'unsafe_required', mandatory: true }]]) {
    const fixture = resourceFixture();
    const read = fixture.ctx.read;
    fixture.ctx.read = async (table, query) => table === 'sys_dictionary' ? metadata : read(table, query);
    await assert.rejects(scenarios.find(s => s.id === 'resources.properties').run(fixture.ctx), /dictionary|read-only|mandatory/);
    assert.equal(fixture.events.some(e => e[0] === 'command' && e[1][1] === 'create'), false);
  }
});

test('owned resource runs actual scenario contract, checkpoints before update and independently reads back', async () => {
  const { scenarios } = await import('./acceptance/resources.mjs');
  const { ctx, events } = resourceFixture();
  await scenarios.find(s => s.id === 'resources.properties').run(ctx);
  const commands = events.filter(e => e[0] === 'command').map(e => e[1].slice(0, 2).join(' '));
  assert.deepEqual(commands, ['rest /api/now/ui/concoursepicker/updateset', 'properties create', 'properties show', 'properties update', 'properties delete', 'properties delete']);
  assert.ok(events.findIndex(e => e[0] === 'register') < events.findIndex(e => e[0] === 'command' && e[1][1] === 'update'));
  const artifact = events.find(e => e[0] === 'register')[1];
  assert.equal(artifact.id, ID);
  assert.deepEqual(artifact.dependsOn, [CAPTURE]);
  assert.deepEqual(artifact.cleanupArgs, ['properties', 'delete', ID, '--force', '--json']);
  assert.ok(events.filter(e => e[0] === 'read' && e[1] === 'sys_properties').length >= 4);
});

test('checkpoint failure stops dependent writes; stale readback never passes', async () => {
  const { scenarios } = await import('./acceptance/resources.mjs');
  const scenario = scenarios.find(s => s.id === 'resources.properties');
  const fixture = resourceFixture({ checkpointError: true });
  await assert.rejects(scenario.run(fixture.ctx), /checkpoint unavailable/);
  assert.equal(fixture.events.some(e => e[0] === 'command' && e[1][1] === 'update'), false);
  await assert.rejects(scenario.run(resourceFixture({ stale: true }).ctx), /readback/);
});


test('workflow polling is bounded and asynchronous errors are failures', async () => {
  const { poll } = await import('./acceptance/workflows.mjs');
  let count = 0;
  await assert.rejects(poll(async () => { count++; return { state: 'RUNNING' }; }, r => r.state === 'COMPLETE', { attempts: 3, intervalMs: 0 }), /did not converge/);
  assert.equal(count, 3);
  await assert.rejects(poll(async () => ({ state: 'ERROR' }), () => false, { attempts: 3, intervalMs: 0 }), /ERROR/);
});

test('flow and catalog gaps block before creating partial artifacts', async () => {
  const { scenarios } = await import('./acceptance/workflows.mjs');
  for (const id of ['workflows.flow-lifecycle', 'workflows.catalog-fulfillment']) {
    const fixture = resourceFixture();
    await assert.rejects(scenarios.find(s => s.id === id).run(fixture.ctx), /Flow deletion|fulfillment recipe/);
    assert.equal(fixture.events.some(e => e[0] === 'command' && e[1][1] === 'create'), false);
  }
});

function updateSetFixture(outputDir, options = {}) {
  const events = [];
  const records = new Map();
  let inspection;
  const { ctx } = resourceFixture();
  ctx.outputDir = outputDir;
  ctx.registerArtifact = async artifact => { events.push(['register', artifact]); };
  ctx.read = async (table, query) => {
    events.push(['read', table, query]);
    if (table === 'sys_update_set') return { sys_id: query.id, name: query.id === CAPTURE ? RUN : inspection.name, state: 'in progress' };
    if (table === 'sys_dictionary') return ['name', 'value', 'description'].map(element => ({ element }));
    return records.get(table + ':' + query.id) ?? null;
  };
  ctx.command = async args => {
    events.push(['command', args]);
    if (args[0] === 'rest') return ok({ result: { current: { sysId: CAPTURE } } });
    if (args[1] === 'import') {
      const xml = await fs.readFile(args[2], 'utf8');
      inspection = inspectUpdateSetXML(xml);
      if (!args.includes('--yes')) return no('confirmation required');
      records.set('sys_remote_update_set:' + inspection.sys_id, { sys_id: inspection.sys_id, name: inspection.name, state: 'loaded' });
      for (const member of inspection.members) records.set('sys_update_xml:' + member.sys_id, { ...member, remote_update_set: inspection.sys_id });
      // These are explicit synthetic provider responses, not platform evidence.
      const propertyId = xml.match(/<sys_properties action="INSERT_OR_UPDATE"><sys_id>([a-f0-9]{32})/)[1];
      ctx.state.set('synthetic.property', { sys_id: propertyId, name: inspection.name + '_property', value: RUN });
      return ok({ ...inspection, state: 'loaded' });
    }
    if (args[1] === 'commit' && !args.includes('--yes')) return { exitCode: 1, json: { ok: false, code: 'usage_error', error: 'not been previewed' } };
    if (args[1] === 'preview') {
      const remote = records.get('sys_remote_update_set:' + args[2]); remote.state = 'previewed';
      return ok({ sys_id: args[2], state: 'previewed', unresolved: options.unresolved ? 1 : 0, truncated: false });
    }
    if (args[1] === 'problems') return ok({ unresolved: options.unresolved ? 1 : 0, truncated: false });
    if (args[1] === 'commit') {
      records.get('sys_remote_update_set:' + args[2]).state = 'committed';
      const property = ctx.state.get('synthetic.property'); records.set('sys_properties:' + property.sys_id, property);
      return ok({ sys_id: args[2], state: 'committed', local_update_set: { sys_id: 'c'.repeat(32) } });
    }
    return ok({});
  };
  return { ctx, events };
}

test('update-set workflow imports owned XML, previews before commit, independently verifies property', async () => {
  const { scenarios } = await import('./acceptance/workflows.mjs');
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'jsn-workflow-'));
  try {
    const { ctx, events } = updateSetFixture(dir);
    await scenarios.find(s => s.id === 'workflows.update-set-transfer').run(ctx);
    const actions = events.filter(e => e[0] === 'command').map(e => e[1][1]);
    assert.deepEqual(actions, ['/api/now/ui/concoursepicker/updateset', 'import', 'import', 'commit', 'preview', 'problems', 'commit']);
    const commit = events.findIndex(e => e[0] === 'command' && e[1][1] === 'commit' && e[1].includes('--yes'));
    const property = events.find(e => e[0] === 'register' && e[1].table === 'sys_properties')[1];
    assert.ok(events.findIndex(e => e[0] === 'register' && e[1] === property) < commit);
    assert.ok(events.some(e => e[0] === 'read' && e[1] === 'sys_properties' && e[2].id === property.id));
    const manifest = events.filter(e => e[0] === 'register').map(e => e[1]);
    assert.equal(new Set(manifest.map(a => a.id)).size, manifest.length);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('unresolved preview never reaches commit', async () => {
  const { scenarios } = await import('./acceptance/workflows.mjs');
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'jsn-workflow-'));
  try {
    const { ctx, events } = updateSetFixture(dir, { unresolved: true });
    await assert.rejects(scenarios.find(s => s.id === 'workflows.update-set-transfer').run(ctx), /unresolved/);
    assert.equal(events.some(e => e[0] === 'command' && e[1][1] === 'commit' && e[1].includes('--yes')), false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('public CLI boundary: property scenario, readonly guard, malformed payload and ACL rejection', { timeout: 60000 }, async t => {
  const { scenarios } = await import('./acceptance/resources.mjs');
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'jsn-public-workflow-'));
  const writes = [], requests = [], checkpoints = [];
  let property, rejectUpdate = false;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    requests.push([req.method, url.pathname]);
    res.setHeader('Content-Type', 'application/json');
    let result;
    if (url.pathname === '/angular.do') result = {};
    else if (url.pathname === '/api/now/ui/concoursepicker/updateset') result = { current: { sysId: CAPTURE } };
    else if (url.pathname.startsWith('/api/now/table/')) {
      const [, , , , table, recordId] = url.pathname.split('/');
      const query = url.searchParams.get('sysparm_query') || '';
      if (table === 'sys_user') result = [{ sys_id: 'd'.repeat(32), user_name: 'fixture' }];
      else if (table === 'sys_user_preference') result = [{ value: query.includes('apps.current_app') ? 'global' : CAPTURE }];
      else if (table === 'sys_scope') result = { sys_id: 'global', scope: 'global' };
      else if (table === 'sys_update_set') result = { sys_id: CAPTURE, name: RUN, state: 'in progress', application: 'global' };
      else if (table === 'sys_dictionary') result = ['name', 'value', 'description'].map(element => ({ element, mandatory: false }));
      else if (table === 'sys_properties') {
        if (req.method !== 'GET') {
          let body = ''; for await (const chunk of req) body += chunk;
          const data = body ? JSON.parse(body) : null;
          writes.push([req.method, recordId, data]);
          if (req.method === 'POST') property = { sys_id: ID, sys_scope: 'global', ...data };
          else if (req.method === 'PATCH' || req.method === 'PUT') {
            if (rejectUpdate) { res.statusCode = 403; res.end(JSON.stringify({ error: { message: 'Synthetic ACL denied' } })); return; }
            Object.assign(property, data);
          } else if (req.method === 'DELETE') property = null;
          result = property ?? {};
        } else result = recordId ? property : property ? [property] : [];
      } else { res.statusCode = 500; result = { unexpected_table: table }; }
    } else { res.statusCode = 500; result = { unexpected_path: url.pathname }; }
    res.end(JSON.stringify({ result }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  const instance = `http://127.0.0.1:${server.address().port}`;
  await fs.mkdir(path.join(root, 'servicenow'));
  await fs.writeFile(path.join(root, 'servicenow', 'config.json'), JSON.stringify({ default_profile: 'selected', profiles: {
    selected: { instance_url: instance, auth_method: 'basic', username: 'fixture' },
    readonly: { instance_url: instance, auth_method: 'basic', username: 'fixture', read_only: true },
  } }));
  const execute = promisify(execFile);
  const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const env = { HOME: root, PATH: '', XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root, JSN_DATA_HOME: path.join(root, 'data'),
    SN_USERNAME: 'fixture', SN_PASSWORD: 'synthetic-fixture-only', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_DOCS_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' };
  async function cliCommand(args, profile = 'selected') {
    if (typeof profile === 'object') profile = 'selected'; // ctx.command options are not a profile selector
    let result;
    try { result = { ...await execute(process.execPath, [cli, ...args, '--profile', profile], { cwd: root, env, timeout: 15000 }), exitCode: 0 }; }
    catch (error) { result = { stdout: error.stdout, stderr: error.stderr, exitCode: error.code }; }
    assert.ok(!(result.stdout + result.stderr).includes(env.SN_PASSWORD), 'synthetic secret leaked');
    result.json = result.stdout.trim() ? JSON.parse(result.stdout) : null;
    return result;
  }
  const ctx = { runKey: RUN, mode: 'pdi', state: new Map([['workflows.context', { captureId: CAPTURE }]]), command: cliCommand,
    async read(table, { id, query, fields, limit }) {
      const params = new URLSearchParams({ sysparm_limit: String(limit), sysparm_fields: fields.join(',') });
      if (query) params.set('sysparm_query', query);
      const response = await fetch(`${instance}/api/now/table/${table}${id ? '/' + id : ''}?${params}`);
      assert.equal(response.status, 200);
      return (await response.json()).result;
    },
    async registerArtifact(artifact) { checkpoints.push({ ...artifact, writes: writes.length }); },
  };
  await scenarios.find(s => s.id === 'resources.properties').run(ctx);
  assert.deepEqual(writes.map(w => w[0]), ['POST', 'PUT', 'DELETE']);
  assert.equal(checkpoints[0].writes, 1, 'ownership checkpoint precedes dependent PATCH');
  assert.equal(property, null);
  const before = requests.length;
  const readonly = await cliCommand(['properties', 'create', '--data', JSON.stringify({ name: RUN }), '--json'], 'readonly');
  assert.notEqual(readonly.exitCode, 0);
  assert.match(JSON.stringify(readonly.json), /read.only/i);
  assert.equal(requests.length, before, 'readonly guard must prevent even lookup');
  const count = writes.length;
  const invalid = await cliCommand(['properties', 'create', '--data', '[]', '--json']);
  assert.notEqual(invalid.exitCode, 0);
  assert.equal(writes.length, count, 'invalid payload must not POST');
  property = { sys_id: ID, name: RUN, value: 'old', sys_scope: 'global' };
  rejectUpdate = true;
  const rejected = await cliCommand(['properties', 'update', ID, '--data', '{"value":"new"}', '--json']);
  assert.notEqual(rejected.exitCode, 0);
  assert.equal(property.value, 'old');
  assert.equal(writes.length, count + 1, 'ACL failure is never automatically retried');
});
