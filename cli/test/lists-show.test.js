// Contract: lists show resolves the view by sys_id, name or title (as forms
// show does; the default view is keyed by sys_id), then reads only the shared list
// layout for that table and view: no personal layout, no related list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listsCmd } from '../src/commands/lists.js';
import { captureCommands } from './support/command-test-helpers.js';
import { makeApp } from './support/app-test-helpers.js';

const ESS = '2a55c35290101310493a380252eb0e6a';
const LAYOUT = '4fc02453c0a8016400046136fbce129e';
const show = captureCommands(listsCmd(fn => fn)).find(c => c.command === 'show <table>').handler;

function setup(views) {
  const calls = [];
  const app = makeApp({ sdk: { list: async (table, params) => {
    calls.push({ table, query: params.get('sysparm_query') });
    if (table === 'sys_ui_view') return views;
    if (table === 'sys_ui_list') return [{ sys_id: { value: LAYOUT, display_value: LAYOUT }, view: { value: views[0]?.sys_id, display_value: views[0]?.title } }];
    return [{ element: 'number', position: '1' }, { element: 'short_description', position: '0' }];
  } } });
  return { app, calls };
}

test('a named view is found by its name and only the shared, non-related layout is read', async () => {
  const { app, calls } = setup([{ sys_id: ESS, name: 'ess', title: 'Self Service' }]);
  await show({ table: 'incident', view: 'ess' }, app);
  assert.deepEqual(calls, [
    { table: 'sys_ui_view', query: 'sys_id=ess^ORname=ess^ORtitle=ess' },
    { table: 'sys_ui_list', query: `name=incident^view=${ESS}^sys_userISEMPTY^parentISEMPTY` },
    { table: 'sys_ui_list_element', query: `list_id=${LAYOUT}^ORDERBYposition` },
  ]);
  assert.equal(app.lastOk.data.view, 'Self Service');
  assert.deepEqual(app.lastOk.data.columns.map(c => c.element), ['short_description', 'number']);
});

test('the default view, whose sys_id is "Default view" and name is empty, still resolves', async () => {
  const { app, calls } = setup([{ sys_id: 'Default view', name: '', title: 'Default view' }]);
  await show({ table: 'incident', view: 'Default view' }, app);
  assert.equal(calls[0].query, 'sys_id=Default view^ORname=Default view^ORtitle=Default view');
  assert.equal(calls[1].query, 'name=incident^view=Default view^sys_userISEMPTY^parentISEMPTY');
});

test('a view title, as lists list prints it, resolves when no view has that name', async () => {
  const { app, calls } = setup([{ sys_id: ESS, name: 'ess', title: 'Self Service' }]);
  await show({ table: 'incident', view: 'Self Service' }, app);
  assert.equal(calls[1].query, `name=incident^view=${ESS}^sys_userISEMPTY^parentISEMPTY`);
});

test('a name wins over another view\'s title, and a title two views share is refused before any layout read', async () => {
  const named = { sys_id: 'b'.repeat(32), name: 'Workspace', title: 'Agent' };
  const { app, calls } = setup([{ sys_id: 'a'.repeat(32), name: 'workspace', title: 'Workspace' }, named]);
  await show({ table: 'incident', view: 'Workspace' }, app);
  assert.equal(calls[1].query, `name=incident^view=${named.sys_id}^sys_userISEMPTY^parentISEMPTY`);
  const tie = setup([{ sys_id: 'a'.repeat(32), name: 'one', title: 'Shared' }, { sys_id: 'b'.repeat(32), name: 'two', title: 'Shared' }]);
  await assert.rejects(show({ table: 'incident', view: 'Shared' }, tie.app), /Multiple view/);
  assert.deepEqual(tie.calls.map(c => c.table), ['sys_ui_view']);
});

test('an unknown view stops before any layout read and is never reported as success', async () => {
  const { app, calls } = setup([]);
  await assert.rejects(show({ table: 'incident', view: 'No such view' }, app), /view not found: No such view/);
  assert.deepEqual(calls.map(c => c.table), ['sys_ui_view']);
  assert.equal(app.lastOk, undefined);
});
