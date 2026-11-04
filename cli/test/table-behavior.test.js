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

function rowValue(row, field) {
  const value = row?.[field];
  if (value && typeof value === 'object') return value.value ?? value.display_value;
  return value;
}

function parseCondition(token) {
  const match = /^([A-Za-z0-9_]+?)(NOT IN|ISNOTEMPTY|ISEMPTY|STARTSWITH|LIKE|IN|=)(.*)$/.exec(token);
  if (!match) return null;
  return { field: match[1], operation: match[2], value: match[3] };
}

function matchesCondition(row, condition) {
  const value = String(rowValue(row, condition.field) ?? '');
  if (condition.operation === 'ISEMPTY') return value === '';
  if (condition.operation === 'ISNOTEMPTY') return value !== '';
  const values = condition.value.split(',').map(item => item.trim());
  if (condition.operation === 'IN') return values.includes(value);
  if (condition.operation === 'NOT IN') return !values.includes(value);
  if (condition.operation === 'STARTSWITH') return value.startsWith(condition.value);
  if (condition.operation === 'LIKE') return value.toLowerCase().includes(condition.value.toLowerCase());
  return value === condition.value;
}

/** Minimal encoded-query evaluator for the operators the behavior reader emits. */
function matchesPart(row, part) {
  const groups = [];
  let group = [];
  for (const token of part.split('^')) {
    if (!token || token.startsWith('ORDERBY')) continue;
    const or = token.startsWith('OR');
    const condition = parseCondition(or ? token.slice(2) : token);
    if (!condition) continue;
    if (or && group.length) group.push(condition);
    else {
      if (group.length) groups.push(group);
      group = [condition];
    }
  }
  if (group.length) groups.push(group);
  return groups.every(alternatives => alternatives.some(condition => matchesCondition(row, condition)));
}

function matchesQuery(row, query) {
  return query.split('^NQ').some(part => matchesPart(row, part));
}

function orderFields(query) {
  return [...query.matchAll(/ORDERBY([A-Za-z0-9_]+)/g)].map(match => match[1]);
}

function compareValues(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  if (a === b) return 0;
  if (a === '') return -1;
  if (b === '') return 1;
  const numberA = Number(a);
  const numberB = Number(b);
  if (Number.isFinite(numberA) && Number.isFinite(numberB)) return numberA - numberB;
  return a < b ? -1 : 1;
}

function sortRows(rows, query) {
  const fields = [...new Set(orderFields(query))];
  if (!fields.length) return rows;
  return [...rows].sort((left, right) => {
    for (const field of fields) {
      const compared = compareValues(rowValue(left, field), rowValue(right, field));
      if (compared !== 0) return compared;
    }
    return 0;
  });
}

function pageRows(rows, url) {
  const limit = Number(url.searchParams.get('sysparm_limit') || rows.length);
  const offset = Number(url.searchParams.get('sysparm_offset') || 0);
  return rows.slice(offset, offset + limit);
}

const HIERARCHY = [
  { sys_id: INCIDENT, name: 'incident', label: 'Incident', super_class: TASK },
  { sys_id: TASK, name: 'task', label: 'Task', super_class: '' },
];

/**
 * Query-aware fixture. Tests still assert that ordering and filters travel in
 * sysparm_query; the fixture only applies the emitted query to fixed rows.
 */
function fixtureFetch({ hierarchy = HIERARCHY, dictionaries = {}, rows = {}, failures = {} } = {}) {
  return request => {
    const url = new URL(request.url);
    const table = url.pathname.split('/').pop();
    const query = url.searchParams.get('sysparm_query') || '';
    if (table === 'sys_db_object') {
      return response(pageRows(sortRows(hierarchy.filter(row => matchesQuery(row, query)), query), url));
    }
    if (table === 'sys_dictionary' && query.includes('elementISNOTEMPTY') && url.searchParams.get('sysparm_fields') === 'element') {
      const name = /(?:^|\^)name(?:IN|=)([^^]+)/.exec(query)?.[1];
      return response((dictionaries[name] || []).map(element => ({ element })));
    }
    if (failures[table]) return response([], failures[table]);
    const filtered = (rows[table] || []).filter(row => matchesQuery(row, query));
    return response(pageRows(sortRows(filtered, query), url));
  };
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
const ACTION_FIELDS = ['sys_id', 'name', 'action_name', 'table', 'active', 'condition', 'client', 'roles', 'form_button', 'form_link', 'form_context_menu', 'list_button', 'list_link', 'list_context_menu', 'list_banner_button', 'list_choice', 'show_insert', 'show_update', 'ui_type', 'form_button_v2', 'form_menu_button_v2', 'format_for_configurable_workspace', 'script', 'onclick', 'client_script_v2', 'order'];
const UI_POLICY_FIELDS = ['sys_id', 'short_description', 'table', 'active', 'sys_scope', 'conditions', 'on_load', 'reverse_if_false', 'inherit', 'global', 'view', 'run_scripts', 'ui_type', 'script_true', 'script_false', 'order'];
const UI_POLICY_ACTION_FIELDS = ['sys_id', 'ui_policy', 'field', 'mandatory', 'disabled', 'visible', 'cleared', 'value_action', 'value', 'field_message_type', 'field_message'];
const DATA_POLICY_FIELDS = ['sys_id', 'short_description', 'model_table', 'active', 'conditions', 'inherit', 'reverse_if_false', 'apply_import_set', 'apply_soap', 'enforce_ui', 'order'];
const DATA_POLICY_RULE_FIELDS = ['sys_id', 'sys_data_policy', 'field', 'mandatory', 'disabled'];
const DICTIONARY_FIELDS = ['sys_id', 'name', 'element', 'column_label', 'internal_type', 'max_length', 'mandatory', 'reference', 'default_value', 'active', 'sys_scope'];
const OVERRIDE_FIELDS = ['sys_id', 'name', 'element', 'base_table', 'mandatory', 'mandatory_override', 'read_only', 'read_only_override', 'read_only_option', 'default_value', 'default_value_override', 'reference_qual', 'reference_qual_override', 'calculation', 'calculation_override', 'attributes', 'attributes_override', 'dependent', 'display_override', 'active'];
const NOTIFICATION_FIELDS = ['sys_id', 'name', 'collection', 'active', 'event_name', 'type', 'condition', 'advanced_condition', 'subject', 'weight', 'recipient_fields', 'event_parm_1', 'event_parm_2', 'template', 'item', 'item_table', 'category', 'importance', 'digestable', 'message', 'message_html', 'message_text'];
const ACL_FIELDS = ['sys_id', 'name', 'operation', 'type', 'active', 'admin_overrides', 'decision_type', 'condition', 'applies_to', 'description', 'script'];
const STYLE_FIELDS = ['sys_id', 'name', 'element', 'value', 'style', 'alt', 'themed_style', 'active'];
const VIEW_FIELDS = ['sys_id', 'table', 'view', 'active', 'advanced', 'condition', 'script', 'match_conditions', 'device_type', 'overrides_user_preference'];
const FLOW_FIELDS = ['sys_id', 'table', 'name', 'active', 'on_insert', 'on_update', 'on_delete', 'condition', 'run_flow_in', 'run_on_extended', 'run_when_user_list', 'run_when_setting'];

/**
 * Realistic incident-sized inventory: more than 50 business rules and UI
 * actions, five Phase 1 categories, and >64 KiB of returned evidence. The long
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
    order: String(index + 1),
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
    order: String(index + 1),
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
    order: String(index + 1),
    conditions: `state=${index % 7}`,
    inherit: 'true',
  }));
  return {
    totals: { business_rules: 138, client_scripts: 60, ui_actions: 94, ui_policies: 30, data_policies: 10 },
    dictionaries: {
      sys_script: BR_FIELDS,
      sys_script_client: CLIENT_FIELDS,
      sys_ui_action: ACTION_FIELDS,
      sys_ui_policy: UI_POLICY_FIELDS,
      sys_ui_policy_action: UI_POLICY_ACTION_FIELDS,
      sys_data_policy2: DATA_POLICY_FIELDS,
      sys_data_policy_rule: DATA_POLICY_RULE_FIELDS,
      sys_dictionary: DICTIONARY_FIELDS,
      sys_dictionary_override: OVERRIDE_FIELDS,
      sysevent_email_action: NOTIFICATION_FIELDS,
      sys_security_acl: ACL_FIELDS,
      sys_ui_style: STYLE_FIELDS,
      sysrule_view: VIEW_FIELDS,
      sys_flow_record_trigger: FLOW_FIELDS,
    },
    rows: {
      sys_script: businessRules,
      sys_script_client: clientScripts,
      sys_ui_action: uiActions,
      sys_ui_policy: uiPolicies,
      sys_ui_policy_action: [],
      sys_data_policy2: dataPolicies,
      sys_data_policy_rule: [],
      sys_dictionary: [],
      sys_dictionary_override: [],
      sysevent_email_action: [],
      sys_security_acl: [],
      sys_ui_style: [],
      sysrule_view: [],
      sys_flow_record_trigger: [],
    },
  };
}

describe('table behavior discovery', () => {
  it('resolves parent ancestry and labels direct versus inherited business rules using GET only', async () => {
    const mock = withMockFetch(fixtureFetch({
      dictionaries: { sys_script: BR_FIELDS },
      rows: { sys_script: BR_ROWS },
    }));
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
      assert.equal(section.items[0].script, undefined, 'script bodies are never returned');
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
      assert.equal(query, 'collectionINincident,task,global^active=true^when=before^ORDERBYorder^ORDERBYname^ORDERBYsys_id');
    } finally {
      mock.restore();
    }
  });

  it('defaults to active configuration and includes inactive only when asked', async () => {
    const active = withMockFetch(fixtureFetch({ dictionaries: { sys_script: BR_FIELDS }, rows: { sys_script: BR_ROWS } }));
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['business_rules'] });
      assert.equal(data.filters.include_inactive, false);
      const query = new URL(active.captured.requests.find(request => new URL(request.url).pathname.endsWith('/sys_script')).url).searchParams.get('sysparm_query');
      assert.match(query, /active=true/);
    } finally {
      active.restore();
    }
    const all = withMockFetch(fixtureFetch({ dictionaries: { sys_script: BR_FIELDS }, rows: { sys_script: BR_ROWS } }));
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['business_rules'], includeInactive: true });
      assert.equal(data.filters.include_inactive, true);
      const query = new URL(all.captured.requests.find(request => new URL(request.url).pathname.endsWith('/sys_script')).url).searchParams.get('sysparm_query');
      assert.doesNotMatch(query, /active=true/);
    } finally {
      all.restore();
    }
  });

  it('honors direct-only and category filters', async () => {
    const mock = withMockFetch(fixtureFetch({ dictionaries: { sys_script: BR_FIELDS }, rows: { sys_script: [BR_ROWS[0]] } }));
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['business_rules'], directOnly: true });
      assert.equal(data.filters.direct_only, true);
      const query = new URL(mock.captured.requests.find(request => new URL(request.url).pathname.endsWith('/sys_script')).url).searchParams.get('sysparm_query');
      assert.equal(query, 'collection=incident^active=true^when=before^ORDERBYorder^ORDERBYname^ORDERBYsys_id');
      assert.equal(data.next_cursors.business_rules, undefined);
    } finally {
      mock.restore();
    }
    assert.deepEqual(normalizeCategories('business-rules,ui_actions'), ['business_rules', 'ui_actions']);
    assert.deepEqual(normalizeCategories('flows,dictionary,acls,dictionary_overrides,styles,view_rules,notifications'), [
      'flows', 'dictionary_entries', 'access_controls', 'dictionary_overrides', 'styles', 'view_rules', 'notifications',
    ]);
    assert.throws(() => normalizeCategories('workflows'), /Unknown behavior category/);
  });

  it('keeps UI policy field actions attached and marks inherited policies', async () => {
    const policyFields = ['sys_id', 'short_description', 'table', 'active', 'sys_scope', 'conditions', 'on_load', 'reverse_if_false', 'inherit', 'global', 'run_scripts', 'ui_type', 'script_true', 'order'];
    const actionFields = ['sys_id', 'ui_policy', 'field', 'mandatory', 'disabled', 'visible', 'cleared'];
    const mock = withMockFetch(fixtureFetch({
      dictionaries: { sys_ui_policy: policyFields, sys_ui_policy_action: actionFields },
      rows: {
        sys_ui_policy: [
          { sys_id: id('c'), short_description: 'Direct policy', table: 'incident', active: 'true', order: '10', conditions: 'state=1', mandatory: 'true' },
          { sys_id: id('d'), short_description: 'Inherited policy', table: 'task', active: 'true', order: '20', inherit: 'true' },
        ],
        sys_ui_policy_action: [{ sys_id: id('e'), ui_policy: id('c'), field: 'short_description', mandatory: 'true', disabled: 'false', visible: 'ignore' }],
      },
    }));
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
      assert.match(policyQuery, /ORDERBYorder\^ORDERBYname\^ORDERBYsys_id/);
    } finally {
      mock.restore();
    }
  });

  it('attaches server data-policy field requirements and inherited data policies', async () => {
    const policyFields = ['sys_id', 'short_description', 'model_table', 'active', 'conditions', 'inherit', 'reverse_if_false', 'apply_import_set', 'apply_soap', 'enforce_ui', 'order'];
    const ruleFields = ['sys_id', 'sys_data_policy', 'field', 'mandatory', 'disabled'];
    const mock = withMockFetch(fixtureFetch({
      dictionaries: { sys_data_policy2: policyFields, sys_data_policy_rule: ruleFields },
      rows: {
        sys_data_policy2: [
          { sys_id: id('e'), short_description: 'Direct data policy', model_table: 'incident', active: 'true', order: '10', conditions: 'state=1', enforce_ui: 'true' },
          { sys_id: id('7'), short_description: 'Inherited data policy', model_table: 'task', active: 'true', order: '20', inherit: 'true' },
        ],
        sys_data_policy_rule: [{ sys_id: id('8'), sys_data_policy: id('e'), field: 'caller_id', mandatory: 'true', disabled: 'false' }],
      },
    }));
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
    const mock = withMockFetch(fixtureFetch({
      dictionaries: { sys_script_client: ['sys_id', 'name', 'table', 'active', 'type', 'condition', 'script'] },
    }));
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
    const mock = withMockFetch(fixtureFetch({
      dictionaries: { sys_script: BR_FIELDS, sys_data_policy2: dataFields },
      failures: { sys_script: 403 },
      rows: { sys_data_policy2: [] },
    }));
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
    const first = withMockFetch(fixtureFetch({ dictionaries: { sys_script_client: fields }, rows: { sys_script_client: rows } }));
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
      assert.equal(new URL(first.captured.requests.find(request => new URL(request.url).pathname.endsWith('/sys_script_client')).url).searchParams.get('sysparm_limit'), '2');
    } finally {
      first.restore();
    }
    const second = withMockFetch(fixtureFetch({ dictionaries: { sys_script_client: fields }, rows: { sys_script_client: rows } }));
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['client_scripts'], limit: 1, cursors: { client_scripts: token } });
      assert.equal(data.categories[0].items[0].name, 'Two');
      const requests = second.captured.requests.filter(request => new URL(request.url).pathname.endsWith('/sys_script_client'));
      assert.ok(requests.some(request => new URL(request.url).searchParams.get('sysparm_offset') === '1'));
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
    const mock = withMockFetch(fixtureFetch({ dictionaries: { sys_script_client: fields }, rows: { sys_script_client: rows } }));
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
    const mock = withMockFetch(fixtureFetch());
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
    const mock = withMockFetch(fixtureFetch(fixture));
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
    const rootHierarchy = [{ sys_id: TASK, name: 'task', label: 'Task', super_class: '' }];
    const rows = [
      { sys_id: id('a'), name: 'Direct rule', collection: 'task', active: 'true', order: '100' },
      { sys_id: id('b'), name: 'Global rule', collection: 'global', active: 'true', order: '200' },
    ];
    const root = withMockFetch(fixtureFetch({ hierarchy: rootHierarchy, dictionaries: { sys_script: BR_FIELDS }, rows: { sys_script: rows } }));
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
      const scriptRequests = root.captured.requests.filter(request => new URL(request.url).pathname.endsWith('/sys_script'));
      const query = new URL(scriptRequests.at(-1).url).searchParams.get('sysparm_query');
      assert.equal(query, 'collectionINtask,global^active=true^whenISEMPTY^ORDERBYorder^ORDERBYname^ORDERBYsys_id');
    } finally {
      root.restore();
    }

    const includeInactive = withMockFetch(fixtureFetch({ hierarchy: rootHierarchy, dictionaries: { sys_script: BR_FIELDS }, rows: { sys_script: rows } }));
    try {
      await discoverTableBehavior(sdk(), 'task', { categories: ['business_rules'], includeInactive: true });
      const requests = includeInactive.captured.requests.filter(request => new URL(request.url).pathname.endsWith('/sys_script'));
      const query = new URL(requests.at(-1).url).searchParams.get('sysparm_query');
      assert.equal(query, 'collectionINtask,global^whenISEMPTY^ORDERBYorder^ORDERBYname^ORDERBYsys_id');
    } finally {
      includeInactive.restore();
    }

    const direct = withMockFetch(fixtureFetch({ hierarchy: rootHierarchy, dictionaries: { sys_script: BR_FIELDS }, rows: { sys_script: [rows[0]] } }));
    try {
      const data = await discoverTableBehavior(sdk(), 'task', { categories: ['business_rules'], directOnly: true });
      assert.deepEqual(data.categories[0].items.map(item => item.association), ['direct']);
      const requests = direct.captured.requests.filter(request => new URL(request.url).pathname.endsWith('/sys_script'));
      const query = new URL(requests.at(-1).url).searchParams.get('sysparm_query');
      assert.equal(query, 'collection=task^active=true^whenISEMPTY^ORDERBYorder^ORDERBYname^ORDERBYsys_id');
    } finally {
      direct.restore();
    }
  });

  it('accepts bounded non-hex ids and never sends query metacharacters from ids', async () => {
    const uiActions = withMockFetch(fixtureFetch({
      dictionaries: { sys_ui_action: ACTION_FIELDS },
      rows: {
        sys_ui_action: [
          { sys_id: 'sysverb_query', name: 'sysverb_query', table: 'global', active: 'true', order: '10', script: '', onclick: '', client_script_v2: '' },
          { sys_id: 'sysverb_post_update', name: 'sysverb_post_update', table: 'global', active: 'true', order: '20', script: '', onclick: '', client_script_v2: '' },
        ],
      },
    }));
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
      { sys_id: 'sysverb_query', short_description: 'Non-hex policy', table: 'incident', active: 'true', order: '10' },
      { sys_id: 'bad^table=incident', short_description: 'Malicious policy', table: 'incident', active: 'true', order: '20' },
    ];
    const policies = withMockFetch(fixtureFetch({
      dictionaries: { sys_ui_policy: UI_POLICY_FIELDS, sys_ui_policy_action: UI_POLICY_ACTION_FIELDS },
      rows: { sys_ui_policy: policyRows, sys_ui_policy_action: [] },
    }));
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

    const badHierarchy = withMockFetch(fixtureFetch({
      hierarchy: [{ sys_id: INCIDENT, name: 'incident', super_class: 'x^active=true' }],
    }));
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

  it('orders business rules by when phase, then order and name, with missing when last', async () => {
    const rows = [
      { sys_id: sid(6), name: 'No when', collection: 'incident', active: 'true', order: '1' },
      { sys_id: sid(5), name: 'Display', collection: 'incident', active: 'true', order: '9', when: 'display' },
      { sys_id: sid(4), name: 'Other z', collection: 'incident', active: 'true', order: '5', when: 'zzz' },
      { sys_id: sid(3), name: 'Async', collection: 'incident', active: 'true', order: '7', when: 'async' },
      { sys_id: sid(2), name: 'After', collection: 'incident', active: 'true', order: '3', when: 'after' },
      { sys_id: sid(1), name: 'Before B', collection: 'incident', active: 'true', order: '2', when: 'before' },
      { sys_id: sid(0), name: 'Before A', collection: 'incident', active: 'true', order: '1', when: 'before' },
    ];
    const mock = withMockFetch(fixtureFetch({ dictionaries: { sys_script: BR_FIELDS }, rows: { sys_script: rows } }));
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['business_rules'] });
      assert.deepEqual(data.categories[0].items.map(item => item.name), [
        'Before A', 'Before B', 'After', 'Async', 'Display', 'Other z', 'No when',
      ]);
      const queries = mock.captured.requests
        .filter(request => new URL(request.url).pathname.endsWith('/sys_script'))
        .map(request => new URL(request.url).searchParams.get('sysparm_query'));
      assert.deepEqual(queries.map(query => /when(=|NOT IN|ISEMPTY)/.exec(query)?.[1] || 'none'), ['=', '=', '=', '=', 'NOT IN', 'ISEMPTY']);
      assert.ok(queries.every(query => query.endsWith('ORDERBYsys_id')));
      assert.match(queries[4], /whenNOT INbefore,after,async,display\^whenISNOTEMPTY\^ORDERBYwhen\^ORDERBYorder\^ORDERBYname\^ORDERBYsys_id/);
    } finally {
      mock.restore();
    }
  });

  it('keeps per-category cursors aligned across ordering phases', async () => {
    const rows = [
      { sys_id: id('a'), name: 'Before', collection: 'incident', active: 'true', order: '1', when: 'before' },
      { sys_id: id('b'), name: 'After', collection: 'incident', active: 'true', order: '2', when: 'after' },
    ];
    const fixture = () => fixtureFetch({ dictionaries: { sys_script: BR_FIELDS }, rows: { sys_script: rows } });
    const first = withMockFetch(fixture());
    let token;
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['business_rules'], limit: 1 });
      assert.deepEqual(data.categories[0].items.map(item => item.name), ['Before']);
      token = data.categories[0].next_cursor;
      const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
      assert.equal(decoded.p, 1, 'continuation points at the after-phase');
      assert.equal(decoded.o, 0);
    } finally {
      first.restore();
    }
    const second = withMockFetch(fixture());
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['business_rules'], limit: 1, cursors: { business_rules: token } });
      assert.deepEqual(data.categories[0].items.map(item => item.name), ['After']);
      assert.equal(data.categories[0].has_more, false);
      const queries = second.captured.requests
        .filter(request => new URL(request.url).pathname.endsWith('/sys_script'))
        .map(request => new URL(request.url).searchParams.get('sysparm_query'));
      assert.ok(queries[0].includes('when=after'), 'cursor resumes at the stored phase, not phase 0');
    } finally {
      second.restore();
    }
  });

  it('includes table-level dictionary rows, labels them, and preserves raw overrides', async () => {
    const dictionaryRows = [
      { sys_id: id('1'), name: 'incident', element: 'caller_id', column_label: 'Caller', internal_type: 'reference', max_length: '32', mandatory: 'false', reference: 'sys_user', default_value: '', active: 'true' },
      { sys_id: id('2'), name: 'incident', element: '', column_label: '', internal_type: '', max_length: '', mandatory: 'false', reference: '', active: 'true' },
      { sys_id: id('3'), name: 'task', element: 'number', column_label: 'Number', internal_type: 'string', max_length: '40', mandatory: 'false', reference: '', default_value: '', active: 'false' },
    ];
    const dictionaryMock = withMockFetch(fixtureFetch({
      dictionaries: { sys_dictionary: DICTIONARY_FIELDS },
      rows: { sys_dictionary: dictionaryRows },
    }));
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['dictionary_entries'] });
      const section = data.categories[0];
      assert.equal(section.returned, 2, 'active-only by default');
      assert.equal(section.items[0].level, 'column');
      assert.equal(section.items[0].element, 'caller_id');
      assert.equal(section.items[0].reference_table, 'sys_user');
      assert.deepEqual(section.items[0].reference, { kind: 'dictionary_entries', source_table: 'sys_dictionary', sys_id: id('1') });
      const tableLevel = section.items.at(-1);
      assert.equal(tableLevel.level, 'table');
      assert.equal(tableLevel.table_level, true);
      assert.match(tableLevel.name, /table-level/);
      const query = new URL(dictionaryMock.captured.requests.find(request => new URL(request.url).pathname.endsWith('/sys_dictionary') && new URL(request.url).searchParams.get('sysparm_query').includes('nameIN') && new URL(request.url).searchParams.get('sysparm_fields') !== 'element').url).searchParams.get('sysparm_query');
      assert.equal(query, 'nameINincident,task^active=true^elementISNOTEMPTY^ORDERBYelement^ORDERBYsys_id');
    } finally {
      dictionaryMock.restore();
    }

    const allMock = withMockFetch(fixtureFetch({ dictionaries: { sys_dictionary: DICTIONARY_FIELDS }, rows: { sys_dictionary: dictionaryRows } }));
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['dictionary_entries'], includeInactive: true });
      assert.equal(data.categories[0].returned, 3);
      assert.ok(data.categories[0].items.some(item => item.element === 'number'));
      const queries = allMock.captured.requests
        .filter(request => new URL(request.url).pathname.endsWith('/sys_dictionary') && new URL(request.url).searchParams.get('sysparm_query').includes('nameIN'))
        .map(request => new URL(request.url).searchParams.get('sysparm_query'));
      assert.doesNotMatch(queries[0], /active=true/);
    } finally {
      allMock.restore();
    }

    const overrides = withMockFetch(fixtureFetch({
      dictionaries: { sys_dictionary_override: OVERRIDE_FIELDS },
      rows: {
        sys_dictionary_override: [
          { sys_id: id('4'), name: 'incident', element: 'caller_id', base_table: 'task', mandatory: 'false', mandatory_override: 'true', read_only: 'false', read_only_override: 'false', default_value: '', default_value_override: 'false', reference_qual: 'active=true', reference_qual_override: 'true', attributes: '', attributes_override: 'false', active: 'true' },
        ],
      },
    }));
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['dictionary_overrides'] });
      const item = data.categories[0].items[0];
      assert.equal(item.element, 'caller_id');
      assert.equal(item.base_table, 'task');
      assert.equal(item.mandatory_override, 'true');
      assert.equal(item.reference_qual_override, 'true');
      assert.equal(item.interpretation, 'Raw override values; no effective dictionary resolution is computed.');
      const query = new URL(overrides.captured.requests.find(request => new URL(request.url).pathname.endsWith('/sys_dictionary_override')).url).searchParams.get('sysparm_query');
      assert.match(query, /nameINincident,task/);
      assert.match(query, /active=true/);
      assert.match(query, /ORDERBYelement/);
    } finally {
      overrides.restore();
    }
  });

  it('summarizes notifications and ACL clause associations without returning bodies inline', async () => {
    const notificationBody = 'secret notification body '.repeat(20);
    const notifications = withMockFetch(fixtureFetch({
      dictionaries: { sysevent_email_action: NOTIFICATION_FIELDS },
      rows: {
        sysevent_email_action: [
          { sys_id: id('1'), name: 'Incident assigned', collection: 'incident', active: 'true', event_name: 'incident.assigned', type: 'email', condition: 'active=true', subject: 'Assigned', weight: '10', message: notificationBody, message_html: '<p>secret</p>', message_text: 'secret text' },
        ],
      },
    }));
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['notifications'] });
      const item = data.categories[0].items[0];
      assert.equal(item.event_name, 'incident.assigned');
      assert.equal(item.type, 'email');
      assert.equal(item.weight, 10);
      assert.equal(item.has_script, true);
      assert.ok(item.script_bytes > notificationBody.length);
      assert.equal(item.message, undefined);
      assert.ok(!JSON.stringify(data).includes(notificationBody));
      assert.ok(!JSON.stringify(data).includes('secret text'));
      const query = new URL(notifications.captured.requests.find(request => new URL(request.url).pathname.endsWith('/sysevent_email_action')).url).searchParams.get('sysparm_query');
      assert.match(query, /collectionINincident,task/);
      assert.match(query, /active=true/);
      assert.match(query, /ORDERBYname\^ORDERBYsys_id/);
    } finally {
      notifications.restore();
    }

    const aclRows = [
      { sys_id: id('1'), name: '*', operation: 'read', type: 'record', active: 'true', decision_type: 'allow', condition: '', script: '' },
      { sys_id: id('2'), name: '*.caller_id', operation: 'read', type: 'record', active: 'true', decision_type: 'allow' },
      { sys_id: id('3'), name: 'incident', operation: 'read', type: 'record', active: 'true', decision_type: 'allow' },
      { sys_id: id('4'), name: 'incident.*', operation: 'write', type: 'record', active: 'true', decision_type: 'allow' },
      { sys_id: id('5'), name: 'incident.caller_id', operation: 'read', type: 'record', active: 'true', decision_type: 'allow' },
      { sys_id: id('6'), name: 'task', operation: 'read', type: 'record', active: 'true', decision_type: 'allow' },
      { sys_id: id('7'), name: 'task.state', operation: 'write', type: 'record', active: 'true', decision_type: 'allow' },
    ];
    const acls = withMockFetch(fixtureFetch({ dictionaries: { sys_security_acl: ACL_FIELDS }, rows: { sys_security_acl: aclRows } }));
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['access_controls'] });
      const byName = Object.fromEntries(data.categories[0].items.map(item => [item.name, item]));
      assert.equal(byName['*'].association, 'global');
      assert.equal(byName['*'].association_detail, 'global_all');
      assert.equal(byName['*.caller_id'].association, 'global');
      assert.equal(byName['*.caller_id'].association_detail, 'global_field');
      assert.equal(byName.incident.association, 'direct');
      assert.equal(byName.incident.association_detail, 'direct_table');
      assert.equal(byName['incident.*'].association_detail, 'direct_table_wildcard');
      assert.equal(byName['incident.caller_id'].association_detail, 'direct_field');
      assert.equal(byName.task.association, 'inherited');
      assert.equal(byName.task.association_detail, 'ancestor_table');
      assert.equal(byName['task.state'].association_detail, 'ancestor_field');
      assert.equal(byName.incident.reference.kind, 'access_controls');
      const query = new URL(acls.captured.requests.find(request => new URL(request.url).pathname.endsWith('/sys_security_acl')).url).searchParams.get('sysparm_query');
      assert.ok(query.startsWith('name=*^ORnameSTARTSWITH*.^ORname=incident^ORnameSTARTSWITHincident.^ORname=task^ORnameSTARTSWITHtask.^active=true^nameISNOTEMPTY'));
      assert.match(query, /ORDERBYname\^ORDERBYoperation\^ORDERBYsys_id$/);
      assert.ok(acls.captured.requests.every(request => request.method === 'GET'));
    } finally {
      acls.restore();
    }

    const directAcls = withMockFetch(fixtureFetch({ dictionaries: { sys_security_acl: ACL_FIELDS }, rows: { sys_security_acl: aclRows } }));
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['access_controls'], directOnly: true });
      assert.ok(data.categories[0].items.every(item => item.association === 'direct'));
      const query = new URL(directAcls.captured.requests.find(request => new URL(request.url).pathname.endsWith('/sys_security_acl')).url).searchParams.get('sysparm_query');
      assert.ok(query.startsWith('name=incident^ORnameSTARTSWITHincident.^active=true'));
      assert.doesNotMatch(query, /name=\*|ORname=task/);
    } finally {
      directAcls.restore();
    }
  });

  it('inventories styles, distinguishes empty view rules, and reports inaccessible views', async () => {
    const styles = withMockFetch(fixtureFetch({
      dictionaries: { sys_ui_style: STYLE_FIELDS },
      rows: {
        sys_ui_style: [
          { sys_id: id('1'), name: 'task', element: 'state', active: 'true', value: 'color: red', style: 'color: red', alt: '', themed_style: '' },
          { sys_id: id('2'), name: 'incident', element: 'caller_id', active: 'true', value: 'color: blue', style: 'color: blue' },
        ],
      },
    }));
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['styles'] });
      assert.deepEqual(data.categories[0].items.map(item => item.name), ['incident', 'task']);
      assert.equal(data.categories[0].items[0].element, 'caller_id');
      assert.equal(data.categories[0].items[0].value, 'color: blue');
      const query = new URL(styles.captured.requests.find(request => new URL(request.url).pathname.endsWith('/sys_ui_style')).url).searchParams.get('sysparm_query');
      assert.ok(query.includes('nameINincident,task^active=true^nameISNOTEMPTY^ORDERBYname^ORDERBYelement^ORDERBYsys_id'), query);
    } finally {
      styles.restore();
    }

    const empty = withMockFetch(fixtureFetch({ dictionaries: { sysrule_view: VIEW_FIELDS }, rows: { sysrule_view: [] } }));
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['view_rules'] });
      const section = data.categories[0];
      assert.equal(section.status, 'complete');
      assert.equal(section.returned, 0);
      assert.equal(section.warnings.length, 0);
      const query = new URL(empty.captured.requests.find(request => new URL(request.url).pathname.endsWith('/sysrule_view')).url).searchParams.get('sysparm_query');
      assert.equal(query, 'tableINincident,task^active=true^viewISNOTEMPTY^ORDERBYview^ORDERBYsys_id');
    } finally {
      empty.restore();
    }

    const emptyViewRow = withMockFetch(fixtureFetch({
      dictionaries: { sysrule_view: VIEW_FIELDS },
      rows: { sysrule_view: [{ sys_id: id('1'), table: 'incident', view: '', active: 'true' }] },
    }));
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['view_rules'] });
      assert.equal(data.categories[0].items[0].view_empty, true);
      assert.equal(data.categories[0].items[0].view, undefined);
    } finally {
      emptyViewRow.restore();
    }

    const inaccessible = withMockFetch(fixtureFetch({
      dictionaries: { sysrule_view: VIEW_FIELDS },
      failures: { sysrule_view: 403 },
    }));
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['view_rules'] });
      assert.equal(data.categories[0].status, 'unavailable');
      assert.equal(data.categories[0].warnings[0].code, 'permission_denied');
      assert.notEqual(data.categories[0].status, 'complete');
    } finally {
      inaccessible.restore();
    }
  });

  it('reports record flow triggers and explicitly marks other trigger families unsupported', async () => {
    const mock = withMockFetch(fixtureFetch({
      dictionaries: { sys_flow_record_trigger: FLOW_FIELDS },
      rows: {
        sys_flow_record_trigger: [
          { sys_id: id('1'), table: 'task', name: 'Task flow', active: 'true', on_insert: 'true', on_update: 'true', on_delete: 'false', condition: 'state=1', run_flow_in: 'background', run_on_extended: 'false', run_when_user_list: '', run_when_setting: 'Run for Both Interactive and Non-Interactive Sessions' },
        ],
      },
    }));
    try {
      const data = await discoverTableBehavior(sdk(), 'incident', { categories: ['flows'] });
      const section = data.categories[0];
      assert.equal(section.status, 'complete');
      assert.equal(section.returned, 1);
      assert.equal(section.items[0].trigger_type, 'record');
      assert.equal(section.items[0].table, 'task');
      assert.equal(section.items[0].association_detail, 'ancestor_table');
      assert.equal(section.items[0].on_insert, true);
      assert.equal(section.items[0].on_update, true);
      assert.equal(section.items[0].on_delete, false);
      assert.deepEqual(section.trigger_support.supported, ['record']);
      const template = section.trigger_support.unsupported.find(trigger => trigger.type === 'template');
      assert.equal(template.table, 'sys_hub_trigger_template');
      assert.match(template.reason, /no text join is guessed/i);
      assert.ok(section.trigger_support.unsupported.some(trigger => trigger.type === 'catalog'));
      const query = new URL(mock.captured.requests.find(request => new URL(request.url).pathname.endsWith('/sys_flow_record_trigger')).url).searchParams.get('sysparm_query');
      assert.ok(query.includes('tableINincident,task^active=true^nameISNOTEMPTY^ORDERBYname^ORDERBYsys_id'), query);
    } finally {
      mock.restore();
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
    const inactiveRow = { sys_id: id('c'), name: 'Inactive rule', collection: 'x_case', active: 'false', sys_scope: 'global', order: '300', when: 'before' };
    const server = http.createServer((request, response_) => {
      const url = new URL(request.url, 'http://fixture.invalid');
      const query = url.searchParams.get('sysparm_query') || '';
      requests.push({ method: request.method, path: url.pathname, query });
      response_.setHeader('Content-Type', 'application/json');
      if (url.pathname.endsWith('/batch')) { response_.statusCode = 404; response_.end('{"error":"batch unsupported"}'); return; }
      if (url.pathname === '/angular.do') { response_.end('{}'); return; }
      if (url.pathname === '/api/now/table/sys_scope') { response_.end('{"result":[]}'); return; }
      assert.equal(request.method, 'GET');
      const table = url.pathname.split('/').pop();
      let rows = [];
      if (table === 'sys_db_object') {
        rows = query.includes('name=x_case') ? [{ sys_id: INCIDENT, name: 'x_case', label: 'Case', super_class: { value: TASK, display_value: 'x_task' } }]
          : query.includes(`sys_id=${TASK}`) ? [{ sys_id: TASK, name: 'x_task', label: 'Task', super_class: '' }]
            : [];
      } else if (table === 'sys_dictionary') {
        rows = ['sys_id', 'name', 'collection', 'active', 'sys_scope', 'order', 'when', 'action_insert', 'action_update', 'action_delete', 'action_query', 'filter_condition', 'advanced', 'abort_action', 'script', 'table', 'type', 'field', 'condition', 'applies_extended', 'ui_type', 'view', 'isolate_script'].map(element => ({ element }));
      } else if (table === 'sys_script') {
        rows = [...activeRows, inactiveRow].filter(row => matchesQuery(row, query));
        rows = pageRows(sortRows(rows, query), url);
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

      const alias = JSON.parse(await run('x_case', '--json', '--category', 'dictionary,acls,notifications,styles,view_rules,flows,dictionary_overrides'));
      assert.deepEqual(alias.data.filters.categories, [
        'dictionary_entries', 'access_controls', 'notifications', 'styles', 'view_rules', 'flows', 'dictionary_overrides',
      ]);

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
