// Retrieve from a configured remote instance and commit several sets in order.
//
// These exercise the real CLI handlers and a real SDKClient against a loopback
// HTTP fixture, so the exact CICD paths, query parameters, request bodies and
// polling sequence are observed on the wire. Nothing here touches an instance.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SDKClient } from '../src/sdk.js';
import { yargs } from '../src/cli-adapter.js';
import { updateSetsCmd } from '../src/commands/updatesets.js';

const SOURCE_ID = '1'.repeat(32);
const SET_ID = '2'.repeat(32);
const REMOTE_A = 'a'.repeat(32);
const REMOTE_B = 'b'.repeat(32);
const BINARY = path.join(import.meta.dirname, '..', 'bin', 'jsn.js');

async function withServer(t, respond) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const url = new URL(request.url, 'http://fixture');
    const entry = {
      method: request.method,
      pathname: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      headers: request.headers,
    };
    requests.push(entry);
    const result = await respond(entry);
    if (!result) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `unexpected request ${request.method} ${url.pathname}` } }));
      return;
    }
    response.writeHead(result.status ?? 200, { 'Content-Type': 'application/json' });
    response.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseURL: `http://127.0.0.1:${server.address().port}`, requests };
}

function makeApp(baseURL) {
  const results = [];
  const sdk = new SDKClient(baseURL, {
    getCredentials: () => ({ auth_method: 'gck', access_token: 'fixture-token' }),
    touchLastSeen: () => {},
  });
  // The SDK documents pollMs as a seam; keep the real dispatch code while
  // shortening the tracker interval so tests do not sleep on the 2s default.
  const retrieve = sdk.retrieveUpdateSet.bind(sdk);
  sdk.retrieveUpdateSet = (ids, opts = {}) => retrieve(ids, { pollMs: 1, ...opts });
  const commitMany = sdk.commitUpdateSets.bind(sdk);
  sdk.commitUpdateSets = (ids, opts = {}) => commitMany(ids, { pollMs: 1, ...opts });
  return {
    results,
    app: {
      sdk,
      requireInstance: () => {},
      getEffectiveInstance: () => baseURL,
      ok: (data, opts) => { results.push({ data, opts }); },
      output: { getFormat: () => 'auto' },
    },
  };
}

function handlerFor(name) {
  const command = updateSetsCmd((fn) => fn);
  const subcommands = [];
  const mockYargs = {
    command: (value) => { subcommands.push(typeof value === 'string' ? { command: value } : value); return mockYargs; },
  };
  command.builder(mockYargs);
  const found = subcommands.find((sub) => sub.command.split(' ')[0] === name);
  assert.ok(found, `missing subcommand ${name}`);
  return found.handler;
}

const call = (name, argv, app) => handlerFor(name)({ _: ['updatesets', name], ...argv }, app);

const sourcesRecord = {
  sys_id: SOURCE_ID,
  name: 'prod',
  url: 'https://deploy:secret@prod.service-now.com',
  type: 'instance',
  active: 'true',
  instance_id: 'prod_instance',
  instance_name: 'production',
};

test('sources lists only non-credential fields and redacts userinfo from the URL', async (t) => {
  const fixture = await withServer(t, (entry) => {
    assert.equal(entry.method, 'GET');
    assert.equal(entry.pathname, '/api/now/table/sys_update_set_source');
    assert.equal(entry.query.sysparm_query, 'ORDERBYname');
    assert.equal(entry.query.sysparm_display_value, 'false');
    assert.doesNotMatch(entry.query.sysparm_fields, /password|username/);
    return { body: { result: [sourcesRecord] } };
  });
  const { app, results } = makeApp(fixture.baseURL);

  await call('sources', {}, app);

  assert.equal(results[0].data.count, 1);
  assert.deepEqual(results[0].data.records[0], {
    sys_id: SOURCE_ID,
    name: 'prod',
    url: 'https://prod.service-now.com',
    type: 'instance',
    active: true,
    instance_id: 'prod_instance',
    instance_name: 'production',
    short_description: '',
  });
  assert.equal(JSON.stringify(results[0].data).includes('secret'), false);
});

test('retrieve posts update_set_id/update_source_id, keeps cleanup false, polls to terminal, and verifies the loaded copy', async (t) => {
  let polls = 0;
  const fixture = await withServer(t, (entry) => {
    if (entry.pathname === '/api/now/table/sys_update_set_source') {
      assert.equal(entry.query.sysparm_query, 'name=prod');
      return { body: { result: [sourcesRecord] } };
    }
    if (entry.pathname === '/api/sn_cicd/update_set/retrieve') {
      assert.equal(entry.method, 'POST');
      assert.equal(entry.query.update_set_id, SET_ID);
      assert.equal(entry.query.update_source_id, SOURCE_ID);
      assert.equal(entry.query.cleanup_retrieved, 'false');
      assert.equal(entry.query.auto_preview, 'false');
      assert.equal(entry.body, '');
      return { body: { result: { status: '0', status_label: 'Pending', links: { progress: { id: 'retrieve-1' } } } } };
    }
    if (entry.pathname === '/api/sn_cicd/progress/retrieve-1') {
      polls += 1;
      if (polls === 1) return { body: { result: { status: '1', status_label: 'Running', percent_complete: 40, links: { progress: { id: 'retrieve-1' } } } } };
      return { body: { result: { status: '2', status_label: 'Successful', percent_complete: 100, links: { progress: { id: 'retrieve-1' } } } } };
    }
    if (entry.pathname === '/api/now/table/sys_remote_update_set') {
      assert.equal(entry.query.sysparm_query, `remote_sys_id=${SET_ID}`);
      return {
        body: {
          result: [{
            sys_id: REMOTE_A,
            name: 'Remote Set',
            state: { display_value: 'Loaded', value: 'loaded' },
            remote_sys_id: SET_ID,
            update_set: '',
          }],
        },
      };
    }
    return null;
  });
  const { app, results } = makeApp(fixture.baseURL);

  await call('retrieve', { set: SET_ID, source: 'prod', yes: true, timeout: 30 }, app);

  assert.equal(polls, 2, 'the retrieve tracker is followed to a terminal status');
  const posts = fixture.requests.filter((entry) => entry.method === 'POST');
  assert.equal(posts.length, 1, 'exactly one mutation is dispatched');
  assert.equal(posts[0].pathname, '/api/sn_cicd/update_set/retrieve');
  assert.equal(results[0].data.state, 'loaded');
  assert.equal(results[0].data.update_set, 'Remote Set');
  assert.equal(results[0].data.sys_id, REMOTE_A);
  assert.equal(results[0].data.remote_sys_id, SET_ID);
  assert.equal(results[0].data.cleanup_retrieved, false);
  assert.equal(results[0].data.source.url, 'https://prod.service-now.com');
  assert.doesNotMatch(JSON.stringify(results[0].data), /secret/);
});

test('retrieve rejects a name before any request because the provider resolves the source sys_id', async (t) => {
  const fixture = await withServer(t, () => null);
  const { app } = makeApp(fixture.baseURL);
  await assert.rejects(
    call('retrieve', { set: 'My Update Set', source: 'prod', yes: true }, app),
    /source instance's update set sys_id/,
  );
  assert.equal(fixture.requests.length, 0);
});

test('retrieve reports an inactive source without dispatching', async (t) => {
  const fixture = await withServer(t, (entry) => entry.pathname === '/api/now/table/sys_update_set_source'
    ? { body: { result: [{ ...sourcesRecord, active: 'false' }] } }
    : null);
  const { app } = makeApp(fixture.baseURL);
  await assert.rejects(call('retrieve', { set: SET_ID, source: 'prod', yes: true }, app), /is inactive/);
  assert.equal(fixture.requests.filter((entry) => entry.method === 'POST').length, 0);
});

test('retrieve decodes a structured provider rejection instead of calling the route missing', async (t) => {
  const fixture = await withServer(t, (entry) => {
    if (entry.pathname === '/api/now/table/sys_update_set_source') return { body: { result: [sourcesRecord] } };
    if (entry.pathname === '/api/sn_cicd/update_set/retrieve') {
      return {
        status: 404,
        body: { result: { status: '3', status_label: 'Failed', error: 'Update set with id 2222 cannot be found' } },
      };
    }
    return null;
  });
  const { app } = makeApp(fixture.baseURL);

  await assert.rejects(call('retrieve', { set: SET_ID, source: 'prod', yes: true }, app), (error) => {
    assert.equal(error.code, 'api_error');
    assert.match(error.message, /cannot be found/);
    assert.doesNotMatch(error.message, /not available on this instance/);
    return true;
  });
});

test('retrieve reports a truly missing CICD route as unavailable', async (t) => {
  const fixture = await withServer(t, (entry) => {
    if (entry.pathname === '/api/now/table/sys_update_set_source') return { body: { result: [sourcesRecord] } };
    if (entry.pathname === '/api/sn_cicd/update_set/retrieve') return { status: 404, body: 'Not found' };
    return null;
  });
  const { app } = makeApp(fixture.baseURL);

  await assert.rejects(call('retrieve', { set: SET_ID, source: 'prod', yes: true }, app), (error) => {
    assert.equal(error.code, 'usage_error');
    assert.match(error.message, /CICD Update Set API is not available/);
    return true;
  });
});

test('an accepted retrieve without a progress tracker is an unknown outcome, not success', async (t) => {
  const fixture = await withServer(t, (entry) => {
    if (entry.pathname === '/api/now/table/sys_update_set_source') return { body: { result: [sourcesRecord] } };
    if (entry.pathname === '/api/sn_cicd/update_set/retrieve') {
      return { body: { result: { status: '0', status_label: 'Pending' } } };
    }
    return null;
  });
  const { app, results } = makeApp(fixture.baseURL);

  await assert.rejects(call('retrieve', { set: SET_ID, source: 'prod', yes: true }, app), /outcome is unknown/);
  assert.equal(results.length, 0);
  assert.equal(fixture.requests.filter((entry) => entry.pathname.startsWith('/api/sn_cicd/progress')).length, 0);
});

async function orderedFixture(t, { states = [ 'previewed', 'previewed' ], problems = [] } = {}) {
  const committedStates = new Map([[REMOTE_A, states[0]], [REMOTE_B, states[1]]]);
  let polls = 0;
  const fixture = await withServer(t, (entry) => {
    if (entry.pathname === '/api/now/table/sys_remote_update_set') {
      const query = entry.query.sysparm_query || '';
      if (query.startsWith('sys_id=')) {
        const sysID = query.slice('sys_id='.length);
        const name = sysID === REMOTE_A ? 'First' : 'Second';
        return { body: { result: [{ sys_id: sysID, name, state: { display_value: committedStates.get(sysID), value: committedStates.get(sysID) }, remote_sys_id: '', update_set: '' }] } };
      }
      return { body: { result: [] } };
    }
    if (entry.pathname === '/api/now/table/sys_update_preview_problem') {
      return { body: { result: problems } };
    }
    if (entry.pathname === '/api/now/table/sys_update_set') return { body: { result: [] } };
    if (entry.pathname === '/api/sn_cicd/update_set/commitMultiple') {
      assert.equal(entry.method, 'POST');
      assert.equal(entry.query.remote_update_set_ids, `${REMOTE_A},${REMOTE_B}`);
      assert.equal(entry.body, JSON.stringify({ force_commit: 'false' }));
      committedStates.set(REMOTE_A, 'committed');
      committedStates.set(REMOTE_B, 'committed');
      return { body: { result: { status: '0', status_label: 'Pending', links: { progress: { id: 'commit-1' } } } } };
    }
    if (entry.pathname === '/api/sn_cicd/progress/commit-1') {
      polls += 1;
      if (polls === 1) return { body: { result: { status: '1', status_label: 'Running', links: { progress: { id: 'commit-1' } } } } };
      return { body: { result: { status: '2', status_label: 'Successful', percent_complete: 100, links: { progress: { id: 'commit-1' } } } } };
    }
    return null;
  });
  return { ...fixture, polls: () => polls };
}

test('commit --ordered sends one commitMultiple request with the sets in the given order and verifies each transition', async (t) => {
  const fixture = await orderedFixture(t);
  const { app, results } = makeApp(fixture.baseURL);

  await call('commit', { name: [REMOTE_A, REMOTE_B], ordered: true, yes: true, timeout: 30 }, app);

  const posts = fixture.requests.filter((entry) => entry.method === 'POST');
  assert.equal(posts.length, 1, 'ordered commit dispatches exactly once');
  assert.equal(posts[0].pathname, '/api/sn_cicd/update_set/commitMultiple');
  assert.equal(fixture.polls(), 2, 'the commit tracker is followed to a terminal status');
  assert.deepEqual(results[0].data.sets.map((set) => set.sys_id), [REMOTE_A, REMOTE_B]);
  assert.deepEqual(results[0].data.sets.map((set) => set.state), ['committed', 'committed']);
  assert.equal(results[0].data.ordered, true);
  assert.match(results[0].opts.summary, /First → Second/);
});

test('commit --ordered refuses a set that has not previewed before any write', async (t) => {
  const fixture = await orderedFixture(t, { states: ['loaded', 'previewed'] });
  const { app, results } = makeApp(fixture.baseURL);

  await assert.rejects(
    call('commit', { name: [REMOTE_A, REMOTE_B], ordered: true, yes: true }, app),
    /has not been previewed yet/,
  );
  assert.equal(fixture.requests.filter((entry) => entry.method === 'POST').length, 0);
  assert.equal(results.length, 0);
});

test('commit --ordered refuses a set with unresolved preview problems before any write', async (t) => {
  const fixture = await orderedFixture(t, {
    problems: [{ sys_id: 'p1', status: 'open', description: 'Missing dependency', type: 'missing_dependency' }],
  });
  const { app } = makeApp(fixture.baseURL);

  await assert.rejects(
    call('commit', { name: [REMOTE_A, REMOTE_B], ordered: true, yes: true }, app),
    /has not previewed clean[\s\S]*Missing dependency/,
  );
  assert.equal(fixture.requests.filter((entry) => entry.method === 'POST').length, 0);
});

test('single commit keeps its existing one-set contract and endpoint', async (t) => {
  let state = 'previewed';
  const fixture = await withServer(t, (entry) => {
    if (entry.pathname === '/api/now/table/sys_update_set' || entry.pathname === '/api/now/table/sys_update_preview_problem') {
      return { body: { result: [] } };
    }
    if (entry.pathname === '/api/now/table/sys_remote_update_set') {
      return { body: { result: [{ sys_id: REMOTE_A, name: 'First', state: { display_value: state, value: state }, remote_sys_id: '', update_set: '' }] } };
    }
    if (entry.pathname === `/api/sn_cicd/update_set/commit/${REMOTE_A}`) {
      assert.equal(entry.method, 'POST');
      assert.equal(entry.body, '{}');
      state = 'committed';
      return { body: { result: { status: '2', status_label: 'Successful', percent_complete: 100 } } };
    }
    return null;
  });
  const { app, results } = makeApp(fixture.baseURL);

  await call('commit', { name: [REMOTE_A], yes: true }, app);

  assert.equal(fixture.requests.filter((entry) => entry.method === 'POST').length, 1);
  assert.equal(results[0].data.update_set, 'First');
  assert.equal(results[0].data.state, 'committed');
  assert.equal(results[0].data.ordered, undefined);
});

test('commit without --ordered refuses several sets before any request', async (t) => {
  const fixture = await withServer(t, () => null);
  const { app } = makeApp(fixture.baseURL);
  await assert.rejects(
    call('commit', { name: [REMOTE_A, REMOTE_B], yes: true }, app),
    /Pass --ordered/,
  );
  assert.equal(fixture.requests.length, 0);
});

test('the registered command routes --ordered positionals to a name array', async () => {
  let seen;
  await yargs(['updatesets', 'commit', '--ordered', REMOTE_A, REMOTE_B, '--yes'])
    .strictCommands().strictOptions()
    .option('json', { type: 'boolean' }).option('format', { type: 'string' })
    .command(updateSetsCmd((_wrap) => async (argv) => { seen = argv; }))
    .parse();
  assert.deepEqual(seen.name, [REMOTE_A, REMOTE_B]);
  assert.equal(seen.ordered, true);
});

test('the real binary refuses retrieve and ordered commit on a read-only profile with zero requests', async (t) => {
  const fixture = await withServer(t, () => null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-updatesets-readonly-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow', 'config.json'), JSON.stringify({
    default_profile: 'ro',
    active_profile: 'ro',
    profiles: {
      ro: { instance_url: fixture.baseURL, auth_method: 'basic', username: 'deploy', read_only: true },
    },
  }));
  const env = {
    ...process.env,
    HOME: dir,
    XDG_CONFIG_HOME: dir,
    JSN_NO_VERSION_CHECK: '1',
    JSN_NO_SKILL_CHECK: '1',
    NO_COLOR: '1',
  };

  for (const args of [
    ['updatesets', 'retrieve', SET_ID, '--source', 'prod', '--yes'],
    ['updatesets', 'commit', '--ordered', REMOTE_A, REMOTE_B, '--yes'],
  ]) {
    const result = spawnSync(process.execPath, [BINARY, ...args, '--json'], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 1, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, 'read_only');
  }
  assert.equal(fixture.requests.length, 0, 'read-only refusal happens before any instance request');
});
