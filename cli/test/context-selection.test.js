import { it } from 'node:test';
import assert from 'node:assert/strict';
import { setCurrentApplication, setCurrentUpdateSet } from '../src/context.js';
import { SDKClient } from '../src/sdk.js';
import { updateSetsCmd } from '../src/commands/updatesets.js';

function command(name) {
  const commands = [];
  const cli = { command(value) { commands.push(value); return cli; } };
  updateSetsCmd(fn => fn).builder(cli);
  return commands.find(value => value.command.split(' ')[0] === name);
}

function commandApp(sdk) {
  const request = sdk.request.bind(sdk);
  sdk.request = async (endpoint, options) => {
    const path = new URL(endpoint).pathname;
    if (path === '/api/now/table/sys_update_set') return { result: [{ sys_id: 'named-set', name: 'Named', state: 'in progress', application: 'scope-id' }] };
    if (path === '/api/now/table/sys_user') return { result: [{ sys_id: 'user' }] };
    return request(endpoint, options);
  };
  return { sdk, ok() { this.succeeded = true; } };
}

it('selects scope before the set through the actual set handler', async () => {
  const { sdk, state } = provider();
  const app = commandApp(sdk);
  await command('set').handler({ name: 'Named' }, app);
  assert.equal(app.succeeded, true);
  assert.equal(state.current, 'named-set');
  assert.deepEqual(state.calls.filter(call => call.method === 'PUT').map(call => call.path), [
    '/api/now/ui/concoursepicker/application', '/api/now/ui/concoursepicker/updateset',
  ]);
});

it('does not report success or select the set after scope selection fails', async () => {
  const { sdk, state } = provider();
  const app = commandApp(sdk);
  const request = sdk.request.bind(sdk);
  sdk.request = async (endpoint, options) => {
    if (endpoint.endsWith('/concoursepicker/application')) throw new Error('scope denied');
    return request(endpoint, options);
  };
  await assert.rejects(() => command('set').handler({ name: 'Named' }, app), /scope denied/);
  assert.equal(app.succeeded, undefined);
  assert.equal(state.current, 'default');
});

it('reports a created update set even when auto-selection fails, with an explicit warning', async () => {
  const { sdk } = provider();
  const app = commandApp(sdk);
  const request = sdk.request.bind(sdk);
  sdk.request = async (endpoint, options) => {
    if (new URL(endpoint).pathname === '/api/now/table/sys_update_set' && options?.method === 'POST') return { result: { sys_id: 'created-set' } };
    if (endpoint.endsWith('/concoursepicker/updateset')) throw new Error('picker denied');
    return request(endpoint, options);
  };
  let output;
  app.ok = (data, options) => { output = { data, ...options }; };
  await command('create').handler({ name: 'Named' }, app);
  assert.equal(output.data.sys_id, 'created-set');
  assert.match(output.summary, /Created update set: Named; not selected as current: picker denied/);
  assert.match(output.summary, /jsn updatesets set "Named"/);
});

// Models the live #288 reproduction: preference CRUD leaves an already-warmed
// session's effective picker selection unchanged.
function provider() {
  const state = { stored: 'default', current: 'default', scope: 'global', calls: [], captures: [] };
  const sdk = new SDKClient('https://test.service-now.com', {});
  sdk.request = async (endpoint, opts = {}) => {
    const path = new URL(endpoint).pathname;
    const method = opts.method || 'GET';
    const data = opts.body ? JSON.parse(opts.body) : null;
    state.calls.push({ path, method, data });
    if (path.endsWith('/concoursepicker/application')) {
      if (method === 'PUT') { state.scope = data.app_id; state.current = state.stored = 'default'; }
      return { result: { current: state.scope } };
    }
    if (path.endsWith('/concoursepicker/updateset')) {
      if (method === 'PUT') state.current = state.stored = data.sysId;
      return { result: { current: { sysId: state.current, name: state.current } } };
    }
    if (path.includes('/table/sys_user_preference')) {
      if (method === 'PUT') state.stored = data.value;
      return { result: [{ sys_id: 'preference', value: state.stored }] };
    }
    state.captures.push({ method, set: state.current });
    return { result: { sys_id: 'owned-record' } };
  };
  return { sdk, state };
}

it('updates the effective warmed session before create, update and delete captures', async () => {
  const { sdk, state } = provider();
  await setCurrentUpdateSet(sdk, 'user', 'named-set');
  await sdk.create('sc_cat_item', { name: 'probe' });
  await sdk.update('sys_hub_flow', 'owned-record', { name: 'probe' });
  await sdk.delete('sc_cat_item', 'owned-record');
  assert.equal(state.stored, 'named-set');
  assert.deepEqual(state.captures, ['POST', 'PUT', 'DELETE'].map(method => ({ method, set: 'named-set' })));
  assert.equal(state.calls.some(call => call.path.includes('/table/sys_user_preference') && call.method !== 'GET'), false);
});

it('switches application through the session-aware picker', async () => {
  const { sdk, state } = provider();
  await setCurrentApplication(sdk, 'user', 'scope-id');
  assert.equal(state.scope, 'scope-id');
  assert.deepEqual(state.calls[0], { path: '/api/now/ui/concoursepicker/application', method: 'PUT', data: { app_id: 'scope-id' } });
});

for (const [name, select] of [['update set', setCurrentUpdateSet], ['application', setCurrentApplication]]) {
  it(`rejects an ineffective ${name} selection instead of reporting success`, async () => {
    const sdk = { baseURL: 'https://test.service-now.com', request: async () => ({ result: { current: { sysId: 'wrong' } } }) };
    await assert.rejects(() => select(sdk, 'user', 'requested'), /selection.*not applied/i);
  });
  it(`propagates a denied ${name} picker write without falling back to preference CRUD`, async () => {
    const denied = new Error('403 forbidden');
    const sdk = { baseURL: 'https://test.service-now.com', request: async () => { throw denied; } };
    await assert.rejects(() => select(sdk, 'user', 'requested'), error => error === denied);
  });
}
