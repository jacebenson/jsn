import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { withMockFetch } from './helpers/mock-transport.js';
import { SDKClient } from '../src/sdk.js';
import { discoverTableBehavior, normalizeCategories } from '../src/table-behavior.js';
import { credKey } from '../src/auth/credential-store.js';

const execute = promisify(execFile);
const id = character => character.repeat(32);
const INCIDENT = id('1');
const TASK = id('2');

function response(rows, status = 200) {
  return { status, body: status >= 400 ? { error: { message: 'fixture error' } } : { result: rows } };
}

function dictionary(fields) {
  return response(fields.map(element => ({ element })));
}

function hierarchyRows() {
  return [
    response([{ sys_id: INCIDENT, name: 'incident', label: 'Incident', super_class: { value: TASK, display_value: 'task' } }]),
    response([{ sys_id: TASK, name: 'task', label: 'Task', super_class: '' }]),
  ];
}

function sdk() {
  return new SDKClient('http://fixture.invalid', {
    getCredentials: () => ({ auth_method: 'gck', access_token: 'fixture-token' }),
  });
}

const BR_FIELDS = ['sys_id', 'name', 'collection', 'active', 'sys_scope', 'order', 'when', 'action_insert', 'action_update', 'action_delete', 'action_query', 'filter_condition', 'advanced', 'abort_action', 'script'];
const BR_ROWS = [
  { sys_id: id('a'), name: 'Direct rule', collection: 'incident', active: 'true', sys_scope: 'global', order: '100', when: 'before', action_update: 'true', action_insert: 'false', action_delete: 'false', action_query: 'false', advanced: 'false', abort_action: 'false', filter_condition: 'active=true', script: 'gs.info(1)' },
  { sys_id: id('b'), name: 'Inherited rule', collection: 'task', active: 'true', sys_scope: 'global', order: '200', when: 'after', action_insert: 'true', action_update: 'false', action_delete: 'false', action_query: 'false', advanced: 'false', abort_action: 'false', script: 'gs.info(2)' },
];

const sid = value => value.toString(16).padStart(32, '0');

const CLIENT_FIELDS = ['sys_id', 'name', 'table', 'active', 'type', 'field', 'ui_type', 'view', 'global', 'applies_extended', 'isolate_script', 'condition', 'script'];
const ACTION_FIELDS = ['sys_id', 'name', 'action_name', 'table', 'active', 'condition', 'client', 'roles', 'form_button', 'form_link', 'form_context_menu', 'list_button', 'list_link', 'list_context_menu', 'list_banner_button', 'list_choice', 'show_insert', 'show_update', 'ui_type', 'form_button_v2', 'form_menu_button_v2', 'format_for_configurable_workspace', 'script', 'onclick', 'client_script_v2'];
const UI_POLICY_FIELDS = ['sys_id', 'short_description', 'table', 'active', 'sys_scope', 'conditions', 'on_load', 'reverse_if_false', 'inherit', 'global', 'view', 'run_scripts', 'ui_type', 'script_true', 'script_false'];
const UI_POLICY_ACTION_FIELDS = ['sys_id', 'ui_policy', 'field', 'mandatory', 'disabled', 'visible', 'cleared', 'value_action', 'value', 'field_message_type', 'field_message'];
const DATA_POLICY_FIELDS = ['sys_id', 'short_description', 'model_table', 'active', 'conditions', 'inherit', 'reverse_if_false', 'apply_import_set', 'apply_soap', 'enforce_ui'];
const DATA_POLICY_RULE_FIELDS = ['sys_id', 'sys_data_policy', 'field', 'mandatory', 'disabled'];

/**
 * Realistic incident-sized inventory: more than 50 business rules and UI
 * actions, five categories, and >64 KiB of returned evidence. The long
 * conditions keep the fixture above the old 65536-byte default.
 */
function bigIncidentFixture() {
  const businessRules = Array.from({ length: 138 }, (_, index) => ({
    sys_id: sid(index + 1),
    name: `Business rule ${index + 1}`,
    collection: index % 5 === 0 ? 'task' : 'incident',
    active: 'true',
    sys_scope: 'global',
    order: String(index),
    when: 'before',
    action_update: 'true',
    action_insert: 'false',
    action_delete: 'false',
    action_query: 'false',
    advanced: 'false',
    abort_action: 'false',
    filter_condition: `state=${index % 7}^short_descriptionLIKE${'x'.repeat(480)}`,
    script: 'gs.info("rule")',
  }));
  const clientScripts = Array.from({ length: 60 }, (_, index) => ({
    sys_id: sid(1000 + index),
    name: `Client script ${index + 1}`,
    table: 'incident',
    active: 'true',
    type: 'onChange',
    field: 'state',
    condition: `state=${index % 7}`,
    script: 'function onChange() { return true; }',
  }));
  const uiActions = Array.from({ length: 94 }, (_, index) => ({
    sys_id: sid(2000 + index),
    name: `UI action ${index + 1}`,
    action_name: `action_${index + 1}`,
    table: index % 10 === 0 ? 'task' : 'incident',
    active: 'true',
    condition: `state=${index % 7}^short_descriptionLIKE${'y'.repeat(80)}`,
    client: 'true',
    form_button: 'true',
    script: '',
    onclick: '',
    client_script_v2: '',
  }));
  const uiPolicies = Array.from({ length: 30 }, (_, index) => ({
    sys_id: sid(3000 + index),
    short_description: `UI policy ${index + 1}`,
    table: index % 4 === 0 ? 'task' : 'incident',
    active: 'true',
    conditions: `state=${index % 7}`,
    inherit: 'true',
    script_true: '',
    script_false: '',
  }));
  const dataPolicies = Array.from({ length: 10 }, (_, index) => ({
    sys_id: sid(4000 + index),
    short_description: `Data policy ${index + 1}`,
    model_table: index % 5 === 0 ? 'task' : 'incident',
    active: 'true',
    conditions: `state=${index % 7}`,
    inherit: 'true',
  }));
  return {
    totals: { business_rules: 138, client_scripts: 60, ui_actions: 94, ui_policies: 30, data_policies: 10 },
    responses: [
      ...hierarchyRows(),
      dictionary(BR_FIELDS), response(businessRules),
      dictionary(CLIENT_FIELDS), response(clientScripts),
      dictionary(ACTION_FIELDS), response(uiActions),
      dictionary(UI_POLICY_FIELDS), response(uiPolicies),
      dictionary(UI_POLICY_ACTION_FIELDS), response([]),
      dictionary(DATA_POLICY_FIELDS), response(dataPolicies),
      dictionary(DATA_POLICY_RULE_FIELDS), response([]),
    ],
  };
}

describe('table behavior discovery', () => {
  it('resolves parent ancestry and labels direct versus inherited business rules using GET only', async () => {
    const mock = withMockFetch([
      ...hierarchyRows(),
      dictionary(BR_FIELDS),
      response(BR_ROWS),
    ]);
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['business_rules'] });
      assert.deepEqual(data.ancestors, ['task']);
      assert.equal(data.categories.length, 1);
      const section = data.categories[0];
      assert.equal(section.status, 'complete');
      assert.equal(section.direct_count, 1);
      assert.equal(section.inherited_count, 1);
      assert.equal(section.items[0].association, 'direct');
      assert.equal(section.items[0].association_detail, 'exact_table');
      assert.equal(section.items[0].inherited, false);
      assert.equal(section.items[1].association, 'inherited');
      assert.equal(section.items[1].association_detail, 'ancestor_table');
      assert.equal(section.items[1].inherited, true);
      assert.deepEqual(section.items[1].operations, ['insert']);
      assert.equal(section.items[0].has_script, true);
      assert.equal(section.items[0].script, undefined, 'script bodies are not retrieved in Phase 1');
      assert.deepEqual(data.totals, {
        returned: 2, direct: 1, inherited: 1,
        unavailable_categories: 0, unsupported_categories: 0, partial_categories: 0,
      });
      assert.ok(mock.captured.callCount > 0);
      assert.ok(mock.captured.requests.every(request => request.method === 'GET'));
      assert.ok(mock.captured.requests.every(request => request.body === null));
      assert.ok(mock.captured.requests.every(request => new URL(request.url).pathname.startsWith('/api/now/table/')));
      const scriptQuery = mock.captured.requests.find(request => new URL(request.url).pathname.endsWith('/sys_script'));
      const query = new URL(scriptQuery.url).searchParams.get('sysparm_query');
      assert.equal(query, 'collectionINincident,task,global^active=true^ORDERBYsys_id');
    } finally {
      mock.restore();
    }
  });

  it('defaults to active configuration and includes inactive only when asked', async () => {
    const active = withMockFetch([...hierarchyRows(), dictionary(BR_FIELDS), response(BR_ROWS)]);
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['business_rules'] });
      assert.equal(data.filters.include_inactive, false);
      const query = new URL(active.captured.requests.at(-1).url).searchParams.get('sysparm_query');
      assert.match(query, /active=true/);
    } finally {
      active.restore();
    }
    const all = withMockFetch([...hierarchyRows(), dictionary(BR_FIELDS), response(BR_ROWS)]);
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['business_rules'], includeInactive: true });
      assert.equal(data.filters.include_inactive, true);
      const query = new URL(all.captured.requests.at(-1).url).searchParams.get('sysparm_query');
      assert.doesNotMatch(query, /active=true/);
    } finally {
      all.restore();
    }
  });

  it('honors direct-only and category filters', async () => {
    const mock = withMockFetch([...hierarchyRows(), dictionary(BR_FIELDS), response([BR_ROWS[0]])]);
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['business_rules'], directOnly: true });
      assert.equal(data.filters.direct_only, true);
      const query = new URL(mock.captured.requests.at(-1).url).searchParams.get('sysparm_query');
      assert.equal(query, 'collection=incident^active=true^ORDERBYsys_id');
      assert.equal(data.next_cursors.business_rules, undefined);
    } finally {
      mock.restore();
    }
    assert.deepEqual(normalizeCategories('business-rules,ui_actions'), ['business_rules', 'ui_actions']);
    assert.throws(() => normalizeCategories('flows'), /Unknown behavior category/);
  });

  it('keeps UI policy field actions attached and marks inherited policies', async () => {
    const policyFields = ['sys_id', 'short_description', 'table', 'active', 'sys_scope', 'conditions', 'on_load', 'reverse_if_false', 'inherit', 'global', 'run_scripts', 'ui_type', 'script_true'];
    const actionFields = ['sys_id', 'ui_policy', 'field', 'mandatory', 'disabled', 'visible', 'cleared'];
    const mock = withMockFetch([
      ...hierarchyRows(),
      dictionary(policyFields),
      response([
        { sys_id: id('c'), short_description: 'Direct policy', table: 'incident', active: 'true', conditions: 'state=1', mandatory: 'true' },
        { sys_id: id('d'), short_description: 'Inherited policy', table: 'task', active: 'true', inherit: 'true' },
      ]),
      dictionary(actionFields),
      response([{ sys_id: id('e'), ui_policy: id('c'), field: 'short_description', mandatory: 'true', disabled: 'false', visible: 'ignore' }]),
    ]);
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['ui_policies'] });
      const section = data.categories[0];
      assert.equal(section.layer, 'client');
      assert.equal(section.enforcement, 'client');
      assert.equal(section.direct_count, 1);
      assert.equal(section.inherited_count, 1);
      assert.equal(section.items[0].field_actions[0].field, 'short_description');
      assert.equal(section.items[0].field_actions[0].mandatory, 'true');
      assert.equal(section.items[1].association_detail, 'ancestor_inherit_flag');
      const policyQuery = new URL(mock.captured.requests.find(request => new URL(request.url).pathname.endsWith('/sys_ui_policy')).url).searchParams.get('sysparm_query');
      assert.match(policyQuery, /tableINtask\^inherit=true/);
      assert.match(policyQuery, /active=true/);
    } finally {
      mock.restore();
    }
  });

  it('attaches server data-policy field requirements and inherited data policies', async () => {
    const policyFields = ['sys_id', 'short_description', 'model_table', 'active', 'conditions', 'inherit', 'reverse_if_false', 'apply_import_set', 'apply_soap', 'enforce_ui'];
    const ruleFields = ['sys_id', 'sys_data_policy', 'field', 'mandatory', 'disabled'];
    const mock = withMockFetch([
      ...hierarchyRows(),
      dictionary(policyFields),
      response([
        { sys_id: id('e'), short_description: 'Direct data policy', model_table: 'incident', active: 'true', conditions: 'state=1', enforce_ui: 'true' },
        { sys_id: id('7'), short_description: 'Inherited data policy', model_table: 'task', active: 'true', inherit: 'true' },
      ]),
      dictionary(ruleFields),
      response([{ sys_id: id('8'), sys_data_policy: id('e'), field: 'caller_id', mandatory: 'true', disabled: 'false' }]),
    ]);
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['data_policies'] });
      const section = data.categories[0];
      assert.equal(section.layer, 'server');
      assert.equal(section.enforcement, 'server');
      assert.equal(section.direct_count, 1);
      assert.equal(section.inherited_count, 1);
      assert.equal(section.items[0].field_actions[0].field, 'caller_id');
      assert.equal(section.items[0].field_actions[0].mandatory, 'true');
      assert.equal(section.items[1].association_detail, 'ancestor_inherit_flag');
      const query = new URL(mock.captured.requests.find(request => new URL(request.url).pathname.endsWith('/sys_data_policy2')).url).searchParams.get('sysparm_query');
      assert.match(query, /model_tableINtask\^inherit=true/);
    } finally {
      mock.restore();
    }
  });

  it('reports a missing source layout as unsupported instead of issuing a query', async () => {
    const mock = withMockFetch([
      ...hierarchyRows(),
      dictionary(['sys_id', 'name', 'table', 'active', 'type', 'condition', 'script']),
    ]);
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['client_scripts'] });
      assert.equal(data.categories[0].status, 'unsupported');
      assert.equal(data.categories[0].warnings[0].code, 'unsupported_layout');
      assert.equal(data.categories[0].items.length, 0);
      assert.equal(data.totals.unsupported_categories, 1);
      assert.equal(mock.captured.requests.filter(request => new URL(request.url).pathname.endsWith('/sys_script_client')).length, 0);
    } finally {
      mock.restore();
    }
  });

  it('reports an inaccessible source separately from a successful empty category', async () => {
    const dataFields = ['sys_id', 'short_description', 'model_table', 'active', 'conditions', 'inherit'];
    const mock = withMockFetch([
      ...hierarchyRows(),
      dictionary(BR_FIELDS),
      response([], 403),
      dictionary(dataFields),
      response([]),
    ]);
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['business_rules', 'data_policies'] });
      const [rules, policies] = data.categories;
      assert.equal(rules.status, 'unavailable');
      assert.equal(rules.items.length, 0);
      assert.equal(rules.warnings[0].code, 'permission_denied');
      assert.equal(policies.status, 'complete');
      assert.equal(policies.items.length, 0);
      assert.equal(policies.warnings.length, 0);
      assert.equal(data.totals.unavailable_categories, 1);
    } finally {
      mock.restore();
    }
  });

  it('bounds per-category results with continuation metadata', async () => {
    const fields = ['sys_id', 'name', 'table', 'active', 'type', 'field', 'condition', 'script', 'applies_extended', 'isolate_script', 'ui_type', 'view'];
    const rows = [
      { sys_id: id('f'), name: 'One', table: 'incident', active: 'true', type: 'onLoad' },
      { sys_id: id('9'), name: 'Two', table: 'incident', active: 'true', type: 'onChange' },
    ];
    const first = withMockFetch([...hierarchyRows(), dictionary(fields), response(rows)]);
    let token;
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['client_scripts'], limit: 1 });
      const section = data.categories[0];
      assert.equal(section.items.length, 1);
      assert.equal(section.returned, 1);
      assert.equal(section.has_more, true);
      assert.equal(section.status, 'partial');
      assert.ok(section.next_cursor);
      assert.equal(data.next_cursors.client_scripts, section.next_cursor);
      token = section.next_cursor;
      assert.equal(new URL(first.captured.requests.at(-1).url).searchParams.get('sysparm_limit'), '2');
    } finally {
      first.restore();
    }
    const second = withMockFetch([...hierarchyRows(), dictionary(fields), response([rows[1]])]);
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['client_scripts'], limit: 1, cursors: { client_scripts: token } });
      assert.equal(data.categories[0].items[0].name, 'Two');
      assert.equal(new URL(second.captured.requests.at(-1).url).searchParams.get('sysparm_offset'), '1');
      assert.equal(data.categories[0].has_more, false);
    } finally {
      second.restore();
    }
  });

  it('omits whole oversized pages with explicit truncation metadata and never cuts script bodies', async () => {
    const fields = ['sys_id', 'name', 'table', 'active', 'condition', 'script', 'applies_extended', 'isolate_script', 'type', 'field', 'ui_type', 'view'];
    const rows = Array.from({ length: 30 }, (_, index) => ({
      sys_id: id((index % 10).toString()).replace(/.$/, String(index % 10)),
      name: `Action ${index}`,
      table: 'incident',
      active: 'true',
      condition: `x=${'y'.repeat(120)}`,
    }));
    const mock = withMockFetch([...hierarchyRows(), dictionary(fields), response(rows)]);
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['client_scripts'], maxBytes: 4096 });
      const section = data.categories[0];
      assert.equal(section.truncated, true);
      assert.equal(section.status, 'partial');
      assert.ok(section.omitted > 0);
      assert.ok(section.next_cursor);
      assert.ok(Buffer.byteLength(JSON.stringify(data), 'utf8') <= 4096);
      assert.ok(section.items.every(item => item.script === undefined));
      assert.ok(section.warnings.some(warning => warning.code === 'truncated'));
    } finally {
      mock.restore();
    }
  });

  it('rejects invalid table names, limits, and cursor tokens before reading', async () => {
    await assert.rejects(() => discoverTableBehavior(sdk(), 'bad^name', { categories: ['business_rules'] }), /Invalid table name/);
    await assert.rejects(() => discoverTableBehavior(sdk(), 'incident', { categories: ['business_rules'], limit: 0 }), /--limit/);
    await assert.rejects(() => discoverTableBehavior(sdk(), 'incident', { categories: ['business_rules'], maxBytes: 10 }), /--max-bytes/);
    const mock = withMockFetch(hierarchyRows());
    try {
      await assert.rejects(
        () => discoverTableBehavior(sdk(), 'incident', { categories: ['business_rules'], cursors: { business_rules: 'not-a-token' } }),
        /Invalid cursor token/
      );
    } finally {
      mock.restore();
    }
  });

  it('uses defaults that return a full incident-sized inventory beyond 64 KiB', async () => {
    const fixture = bigIncidentFixture();
    const mock = withMockFetch(fixture.responses);
    try {
      const data = await discoverTableBehavior(sdk(), 'incident');
      assert.equal(data.filters.limit, 200);
      assert.equal(data.filters.max_bytes, 524288);
      const byCategory = Object.fromEntries(data.categories.map(section => [section.category, section]));
      for (const [category, expected] of Object.entries(fixture.totals)) {
        assert.equal(byCategory[category].returned, expected, `${category} returns its full inventory by default`);
        assert.equal(byCategory[category].truncated, false, `${category} is not budget-truncated by default`);
        assert.equal(byCategory[category].has_more, false, `${category} has no continuation by default`);
        assert.equal(byCategory[category].status, 'complete', `${category} status`);
      }
      assert.ok(Buffer.byteLength(JSON.stringify(data), 'utf8') > 65536, 'fixture exceeds the old default budget');
      assert.deepEqual(data.totals, {
        returned: 332, direct: 284, inherited: 48,
        unavailable_categories: 0, unsupported_categories: 0, partial_categories: 0,
      });
    } finally {
      mock.restore();
    }
  });

  it('includes active global business rules for root tables and keeps direct-only semantics', async () => {
    const rootHierarchy = [response([{ sys_id: TASK, name: 'task', label: 'Task', super_class: '' }])];
    const rows = [
      { sys_id: id('a'), name: 'Direct rule', collection: 'task', active: 'true' },
      { sys_id: id('b'), name: 'Global rule', collection: 'global', active: 'true' },
    ];
    const root = withMockFetch([...rootHierarchy, dictionary(BR_FIELDS), response(rows)]);
    try {
      const data = await discoverTableBehavior(sdk(), 'task', { categories: ['business_rules'] });
      assert.deepEqual(data.ancestors, []);
      const section = data.categories[0];
      assert.equal(section.returned, 2);
      assert.equal(section.direct_count, 1);
      assert.equal(section.inherited_count, 1);
      const globalRule = section.items.find(item => item.name === 'Global rule');
      assert.equal(globalRule.association, 'inherited');
      assert.equal(globalRule.association_detail, 'global_actions');
      assert.equal(globalRule.inherited, true);
      const query = new URL(root.captured.requests.at(-1).url).searchParams.get('sysparm_query');
      assert.equal(query, 'collectionINtask,global^active=true^ORDERBYsys_id');
    } finally {
      root.restore();
    }

    const includeInactive = withMockFetch([...rootHierarchy, dictionary(BR_FIELDS), response(rows)]);
    try {
      await discoverTableBehavior(sdk(), 'task', { categories: ['business_rules'], includeInactive: true });
      const query = new URL(includeInactive.captured.requests.at(-1).url).searchParams.get('sysparm_query');
      assert.equal(query, 'collectionINtask,global^ORDERBYsys_id');
    } finally {
      includeInactive.restore();
    }

    const direct = withMockFetch([...rootHierarchy, dictionary(BR_FIELDS), response([rows[0]])]);
    try {
      const data = await discoverTableBehavior(sdk(), 'task', { categories: ['business_rules'], directOnly: true });
      assert.deepEqual(data.categories[0].items.map(item => item.association), ['direct']);
      const query = new URL(direct.captured.requests.at(-1).url).searchParams.get('sysparm_query');
      assert.equal(query, 'collection=task^active=true^ORDERBYsys_id');
    } finally {
      direct.restore();
    }
  });

  it('accepts bounded non-hex ids and never sends query metacharacters from ids', async () => {
    const uiActions = withMockFetch([
      ...hierarchyRows(),
      dictionary(ACTION_FIELDS),
      response(['sysverb_query', 'sysverb_post_update'].map(sys_id => ({
        sys_id, name: sys_id, table: 'global', active: 'true', script: '', onclick: '', client_script_v2: '',
      }))),
    ]);
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['ui_actions'] });
      assert.equal(data.categories[0].returned, 2);
      assert.equal(data.categories[0].status, 'complete');
      assert.deepEqual(data.categories[0].items.map(item => item.reference.sys_id), ['sysverb_query', 'sysverb_post_update']);
      assert.ok(data.categories[0].items.every(item => item.association_detail === 'global_actions'));
    } finally {
      uiActions.restore();
    }

    const policyRows = [
      { sys_id: 'sysverb_query', short_description: 'Non-hex policy', table: 'incident', active: 'true' },
      { sys_id: 'bad^table=incident', short_description: 'Malicious policy', table: 'incident', active: 'true' },
    ];
    const policies = withMockFetch([
      ...hierarchyRows(),
      dictionary(UI_POLICY_FIELDS),
      response(policyRows),
      dictionary(UI_POLICY_ACTION_FIELDS),
      response([]),
    ]);
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['ui_policies'] });
      const section = data.categories[0];
      assert.equal(section.returned, 1);
      assert.equal(section.items[0].reference.sys_id, 'sysverb_query');
      assert.ok(section.warnings.some(warning => warning.code === 'malformed_response'));
      const relatedRequest = policies.captured.requests.find(request => new URL(request.url).pathname.endsWith('/sys_ui_policy_action'));
      assert.ok(relatedRequest, 'safe non-hex policy ids reach the related read');
      assert.equal(new URL(relatedRequest.url).searchParams.get('sysparm_query'), 'ui_policyINsysverb_query');
      assert.ok(policies.captured.requests.every(request => !decodeURIComponent(request.url).includes('bad^table=incident')));
    } finally {
      policies.restore();
    }

    const badHierarchy = withMockFetch([
      response([{ sys_id: INCIDENT, name: 'incident', super_class: 'x^active=true' }]),
    ]);
    try {
      await assert.rejects(
        () => discoverTableBehavior(sdk(), 'incident', { categories: ['business_rules'] }),
        /Invalid parent table reference/
      );
      assert.equal(badHierarchy.captured.callCount, 1, 'the unsafe parent id stops the hierarchy walk');
    } finally {
      badHierarchy.restore();
    }
  });
});

describe('tables behavior CLI', () => {
  it('supports the output envelope, filters, and sends only read requests', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-table-behavior-'));
    const requests = [];
    const activeRows = [
      { sys_id: id('a'), name: 'Direct rule', collection: 'x_case', active: 'true', sys_scope: 'global', order: '100', when: 'before', action_update: 'true' },
      { sys_id: id('b'), name: 'Inherited rule', collection: 'x_task', active: 'true', sys_scope: 'global', order: '200', when: 'after', action_insert: 'true' },
    ];
    const inactiveRow = { sys_id: id('c'), name: 'Inactive rule', collection: 'x_case', active: 'false', sys_scope: 'global', when: 'before' };
    const server = http.createServer((request, response_) => {
      const url = new URL(request.url, 'http://fixture.invalid');
      requests.push({ method: request.method, path: url.pathname, query: url.searchParams.get('sysparm_query') || '' });
      response_.setHeader('Content-Type', 'application/json');
      if (url.pathname.endsWith('/batch')) { response_.statusCode = 404; response_.end('{"error":"batch unsupported"}'); return; }
      if (url.pathname === '/angular.do') { response_.end('{}'); return; }
      if (url.pathname === '/api/now/table/sys_scope') { response_.end('{"result":[]}'); return; }
      assert.equal(request.method, 'GET');
      const table = url.pathname.split('/').pop();
      const query = url.searchParams.get('sysparm_query') || '';
      let rows = [];
      if (table === 'sys_db_object') {
        rows = query.includes(`name=x_case`) ? [{ sys_id: INCIDENT, name: 'x_case', label: 'Case', super_class: { value: TASK, display_value: 'x_task' } }]
          : query.includes(`sys_id=${TASK}`) ? [{ sys_id: TASK, name: 'x_task', label: 'Task', super_class: '' }]
            : [];
      } else if (table === 'sys_dictionary') {
        rows = ['sys_id', 'name', 'collection', 'active', 'sys_scope', 'order', 'when', 'action_insert', 'action_update', 'action_delete', 'action_query', 'filter_condition', 'advanced', 'abort_action', 'script', 'table', 'type', 'field', 'condition', 'applies_extended', 'ui_type', 'view', 'isolate_script'].map(element => ({ element }));
      } else if (table === 'sys_script') {
        rows = [...activeRows, inactiveRow];
        if (query.includes('active=true')) rows = rows.filter(row => row.active === 'true');
        if (/^collection=x_case(\^|$)/.test(query)) rows = rows.filter(row => row.collection === 'x_case');
      }
      response_.end(JSON.stringify({ result: rows }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const instance = `http://127.0.0.1:${server.address().port}`;
      const configDir = path.join(directory, 'servicenow');
      fs.mkdirSync(path.join(configDir, 'credentials'), { recursive: true });
      fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ default_profile: 'selected', profiles: {
        selected: { instance_url: instance, username: 'fixture-user', auth_method: 'basic', read_only: true },
      } }));
      fs.writeFileSync(path.join(configDir, 'credentials', `${credKey(instance, 'fixture-user')}.json`), JSON.stringify({ auth_method: 'basic', username: 'fixture-user', password: 'fixture-password' }));
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SN_|SERVICENOW_)/i.test(key)));
      Object.assign(env, {
        XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, PATH: '',
        JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1', JSN_NO_HEADER: '1',
      });
      const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
      const run = async (...args) => {
        requests.length = 0;
        const result = await execute(process.execPath, [cli, 'tables', 'behavior', ...args, '--profile', 'selected'], {
          env, cwd: directory, encoding: 'utf8', timeout: 20000,
        });
        assert.equal(result.stderr, '');
        assert.ok(!result.stdout.includes('fixture-password'));
        return result.stdout;
      };

      const data = JSON.parse(await run('x_case', '--json', '--category', 'business_rules'));
      assert.equal(data.data.table, 'x_case');
      assert.equal(data.data._formatted, undefined, 'JSON output is not inflated by the human view');
      assert.deepEqual(data.data.ancestors, ['x_task']);
      assert.equal(data.data.categories.length, 1);
      assert.equal(data.data.categories[0].items.length, 2, 'active-only by default');
      assert.deepEqual(data.data.categories[0].items.map(item => item.association), ['direct', 'inherited']);
      assert.equal(data.data.totals.direct, 1);
      assert.equal(data.data.totals.inherited, 1);
      assert.equal(JSON.parse(await run('x_case', '--json', '--category', 'business_rules', '--get', 'data.totals.returned')), 2);

      const all = JSON.parse(await run('x_case', '--json', '--category', 'business_rules', '--include-inactive'));
      assert.equal(all.data.categories[0].items.length, 3);
      assert.ok(all.data.categories[0].items.some(item => item.name === 'Inactive rule'));

      const direct = JSON.parse(await run('x_case', '--json', '--category', 'business_rules', '--direct-only'));
      assert.equal(direct.data.categories[0].items.length, 1);
      assert.equal(direct.data.categories[0].items[0].association, 'direct');

      const styled = await run('x_case', '--styled', '--category', 'business_rules');
      assert.match(styled, /Table behavior: x_case/);
      assert.match(styled, /Inherited from: x_task/);
      assert.match(styled, /BUSINESS RULES \[server\]/);

      assert.ok(requests.length > 0);
      const tableRequests = requests.filter(request => request.path.startsWith('/api/now/table/'));
      assert.ok(tableRequests.length > 0);
      assert.ok(tableRequests.every(request => request.method === 'GET'), JSON.stringify(tableRequests.filter(request => request.method !== 'GET')));
      assert.ok(requests.every(request => request.path.startsWith('/api/now/table/') || request.path === '/angular.do' || request.path === '/api/now/v1/batch'));
    } finally {
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
