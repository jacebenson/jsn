// Tests for the catalog command family and item_option_new type resolution.
// Regression net for the catalog.js inline type-map bug (select=3, date=4,
// datetime=5, checkbox=12, email=11 — all wrong) vs the canonical
// ServiceNow item_option_new.type values in helpers.js.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { captureSubcommands, findCommand, wrapHandler } from './support/command-test-helpers.js';
import { makeApp } from './support/app-test-helpers.js';


import { resolveItemOptionType } from '../src/helpers.js';
import { enrichCatalogItem, buildCatalogFormatted } from '../src/commands/catalog/enrich.js';

// ─── Canonical item_option_new type values ───
// Source of truth: ServiceNow's documented choice values for
// item_option_new.type (6=Single Line Text, 2=Multi Line Text, 3=Multiple
// Choice, 5=Select Box, 7=CheckBox, 8=Reference, 9=Date, 10=Date/Time,
// 26=Email). helpers.js:ITEM_OPTION_TYPE_NAMES encodes this set.
describe('resolveItemOptionType (canonical ServiceNow item_option_new.type values)', () => {
  const canonical = {
    string: 6, singlelinetext: 6, text: 6,
    multilinetext: 2, textarea: 2,
    multiplechoice: 3,
    select: 5, dropdown: 5, choice: 5,
    checkbox: 7, boolean: 1,
    reference: 8,
    date: 9,
    datetime: 10,
    email: 26,
  };
  for (const [name, id] of Object.entries(canonical)) {
    it(`maps ${name} → ${id}`, () => {
      assert.strictEqual(resolveItemOptionType(name), id);
    });
  }

  it('passes numeric values through unchanged', () => {
    assert.strictEqual(resolveItemOptionType(9), 9);
    assert.strictEqual(resolveItemOptionType('5'), 5);
  });

  it('defaults unknown/empty to 6 (Single Line Text)', () => {
    assert.strictEqual(resolveItemOptionType(null), 6);
    assert.strictEqual(resolveItemOptionType('bogus-type'), 6);
  });

  it('normalizes separators and case', () => {
    assert.strictEqual(resolveItemOptionType('Single Line Text'), 6);
    assert.strictEqual(resolveItemOptionType('date-time'), 10);
    assert.strictEqual(resolveItemOptionType('Select_Box'), 5);
  });
});

// ─── catalog create must use the canonical resolver ───
describe('catalog create --variable type resolution', () => {
  it('creates variables with canonical type IDs (not the old inline map)', async () => {
    const { catalogCmd } = await import('../src/commands/catalog.js');
    const cmd = catalogCmd(wrapHandler);
    const create = findCommand(captureSubcommands(cmd), 'create');
    assert.ok(create, 'create subcommand exists');

    const created = [];
    const sdk = {
      create: async (table, data) => {
        if (table === 'item_option_new') created.push(data);
        return { sys_id: 'item123' };
      },
    };
    const app = makeApp({ sdk });
    await create.handler(
      {
        app,
        name: 'Test Item',
        variable: ['dept:select:Department', 'start:date:Start date', 'when:datetime:When: exactly?', 'agree:checkbox:Agree', 'contact:email:Contact', 'hotel:yesno:Hotel needed?'],
      },
      app,
    );

    assert.strictEqual(created.length, 6, 'all 6 variables created');
    const byName = Object.fromEntries(created.map((c) => [c.name, c.type]));
    // These assertions FAIL against the old inline map
    // { select:'3', date:'4', datetime:'5', checkbox:'12', email:'11' }.
    assert.strictEqual(byName.dept, 5, 'select → 5 (Select Box)');
    assert.strictEqual(byName.start, 9, 'date → 9 (Date)');
    assert.strictEqual(byName.when, 10, 'datetime → 10 (Date/Time)');
    assert.strictEqual(byName.agree, 7, 'checkbox → 7 (CheckBox)');
    assert.strictEqual(byName.contact, 26, 'email → 26 (Email)');
    assert.strictEqual(byName.hotel, 1, 'yesno → 1 (Yes/No)');
    assert.deepStrictEqual(created.map((v) => v.question_text), [
      'Department', 'Start date', 'When: exactly?', 'Agree', 'Contact', 'Hotel needed?',
    ]);
  });
});

// ─── fake sdk data for enrichment tests ───
function buildEnrichSdk(overrides = {}) {
  const item = {
    sys_id: { value: 'abc123' },
    name: 'Test Item',
    short_description: 'A test item',
    category: { display_value: 'Hardware', value: 'cat1' },
    active: 'true',
    flow_designer_flow: { display_value: 'abc123', value: 'abc123' }, // unresolved display → get()
    workflow: { display_value: '', value: '' },
    delivery_plan: '',
    ...overrides.item,
  };
  const variables = overrides.variables ?? [
    { name: 'cpu', question_text: 'CPU', type: '6', mandatory: 'true', variable_set: '' },
    { name: 'ram', question_text: 'RAM', type: '5', mandatory: 'false', variable_set: { display_value: 'Standard Set', value: 'vs1' } },
    { name: 'disk', question_text: 'Disk', type: '5', mandatory: 'true', variable_set: { display_value: 'Standard Set', value: 'vs1' } },
  ];
  return {
    baseURL: overrides.baseURL ?? 'https://x.service-now.com',
    request: overrides.request,
    list: async (table) => {
      if (table === 'sc_cat_item') return [item];
      if (table === 'item_option_new') return variables;
      return [];
    },
    get: async (table, id) => {
      if (table === 'sys_hub_flow' && id === 'abc123') {
        if (overrides.flowGetThrows) throw new Error('403');
        return { name: 'Provision Server' };
      }
      return {};
    },
  };
}

describe('enrichCatalogItem', () => {
  it('assembles core envelope keys', async () => {
    const sdk = buildEnrichSdk();
    const { data } = await enrichCatalogItem({ sdk, instanceUrl: 'https://dev.example.service-now.com', sysID: 'abc123' });
    assert.strictEqual(data.name, 'Test Item');
    assert.strictEqual(data.short_description, 'A test item');
    assert.strictEqual(data.category, 'Hardware');
    assert.strictEqual(data.active, 'true');
    assert.strictEqual(data.url, 'https://dev.example.service-now.com/sc_cat_item.do?sys_id=abc123');
  });

  it('resolves flow name via sys_hub_flow when display_value is the raw sys_id', async () => {
    const sdk = buildEnrichSdk();
    const { data } = await enrichCatalogItem({ sdk, instanceUrl: 'https://x.service-now.com', sysID: 'abc123' });
    assert.strictEqual(data.flow, 'Provision Server');
    assert.strictEqual(data.flow_cmd, 'jsn flows show abc123');
  });

  it('falls back to the display value when sys_hub_flow get() fails', async () => {
    const sdk = buildEnrichSdk({ flowGetThrows: true });
    const { data } = await enrichCatalogItem({ sdk, instanceUrl: 'https://x.service-now.com', sysID: 'abc123' });
    assert.strictEqual(data.flow, 'abc123');
    assert.strictEqual(data.flow_cmd, 'jsn flows show abc123');
  });

  it('uses the display value directly when it differs from the sys_id', async () => {
    const sdk = buildEnrichSdk({
      item: { flow_designer_flow: { display_value: 'My Flow', value: 'abc123' } },
    });
    let getCalled = false;
    const origGet = sdk.get;
    sdk.get = async (...a) => { getCalled = true; return origGet(...a); };
    const { data } = await enrichCatalogItem({ sdk, instanceUrl: 'https://x.service-now.com', sysID: 'abc123' });
    assert.strictEqual(data.flow, 'My Flow');
    assert.strictEqual(getCalled, false, 'no sys_hub_flow lookup needed');
  });

  it('omits flow when the item has none', async () => {
    const sdk = buildEnrichSdk({ item: { flow_designer_flow: '' } });
    const { data } = await enrichCatalogItem({ sdk, instanceUrl: 'https://x.service-now.com', sysID: 'abc123' });
    assert.strictEqual(data.flow, undefined);
    assert.strictEqual(data.flow_cmd, undefined);
  });

  it('resolves workflow from display value', async () => {
    const sdk = buildEnrichSdk({
      item: {
        flow_designer_flow: '',
        workflow: { display_value: 'Fulfillment WF', value: 'wf9' },
      },
    });
    const { data } = await enrichCatalogItem({ sdk, instanceUrl: 'https://x.service-now.com', sysID: 'abc123' });
    assert.strictEqual(data.workflow, 'Fulfillment WF');
    assert.strictEqual(data.workflow_cmd, undefined);
  });

  it('resolves delivery_plan, falling back to execution_plan', async () => {
    const sdk = buildEnrichSdk({
      item: {
        flow_designer_flow: '',
        delivery_plan: { display_value: 'Standard Plan', value: 'dp1' },
      },
    });
    const { data } = await enrichCatalogItem({ sdk, instanceUrl: 'https://x.service-now.com', sysID: 'abc123' });
    assert.strictEqual(data.execution_plan, 'Standard Plan');

    const sdk2 = buildEnrichSdk({
      item: {
        flow_designer_flow: '',
        delivery_plan: '',
        execution_plan: { display_value: 'Legacy Plan', value: 'ep1' },
      },
    });
    const { data: data2 } = await enrichCatalogItem({ sdk: sdk2, instanceUrl: 'https://x.service-now.com', sysID: 'abc123' });
    assert.strictEqual(data2.execution_plan, 'Legacy Plan');
  });

  it('returns every answerable question with its name, type and flags when the catalog API is unavailable', async () => {
    const sdk = buildEnrichSdk();
    const { data, source } = await enrichCatalogItem({ sdk, instanceUrl: 'https://x.service-now.com', sysID: 'abc123' });
    assert.strictEqual(source, 'item_option_new');
    assert.strictEqual(data.variables_source, 'item_option_new');
    assert.strictEqual(data.variables_reported, false);
    assert.deepStrictEqual(data.variables, [
      { name: 'cpu', label: 'CPU', type: 6, friendly_type: 'single_line_text', mandatory: true, instance_supplied: false },
      { name: 'ram', label: 'RAM', type: 5, friendly_type: 'select_box', mandatory: false, instance_supplied: false },
      { name: 'disk', label: 'Disk', type: 5, friendly_type: 'select_box', mandatory: true, instance_supplied: false },
    ]);
    assert.deepStrictEqual(data.required_variables, ['cpu', 'disk']);
  });

  it('drops layout entries from the definition fallback', async () => {
    const sdk = buildEnrichSdk({ variables: [
      { name: 'note', question_text: '', type: '32', mandatory: 'false' },
      { name: 'help_block', question_text: 'Help', type: '23', mandatory: 'false' },
      { name: 'cpu', question_text: 'CPU', type: '6', mandatory: 'true' },
    ] });
    const { data } = await enrichCatalogItem({ sdk, instanceUrl: 'https://x.service-now.com', sysID: 'abc123' });
    assert.deepStrictEqual(data.variables.map(v => v.name), ['cpu']);
  });

  it('prefers the catalog API payload, which is what a submission must answer', async () => {
    const sdk = buildEnrichSdk({ request: async () => ({ result: { sys_id: 'abc123', variables: [
      { name: '', label: 'Options', type: 0, friendly_type: 'container_start', mandatory: false, children: [
        { name: 'agree', label: 'I agree', type: 7, friendly_type: 'check_box', mandatory: true },
      ] },
      { name: 'note', label: '<p>Read</p>', type: 32, friendly_type: 'rich_text_label', mandatory: false },
      { name: 'requested_for', label: 'Requested for', type: 31, friendly_type: 'requested_for', mandatory: true },
    ] } }) });
    const { data, source } = await enrichCatalogItem({ sdk, instanceUrl: 'https://x.service-now.com', sysID: 'abc123' });
    assert.strictEqual(source, 'catalog_api');
    assert.deepStrictEqual(data.variables.map(v => v.name), ['agree', 'requested_for']);
    assert.deepStrictEqual(data.required_variables, ['agree']);
    assert.deepStrictEqual(data.instance_supplied_variables, ['requested_for']);
    assert.strictEqual(data.variables_reported, true);
  });

  it('keeps the definition view when the catalog API throws, and says so', async () => {
    const sdk = buildEnrichSdk({ request: async () => { throw Object.assign(new Error('Cannot convert null to an object.'), { status: 500 }); } });
    const { data } = await enrichCatalogItem({ sdk, instanceUrl: 'https://x.service-now.com', sysID: 'abc123' });
    assert.strictEqual(data.variables_source, 'item_option_new');
    assert.strictEqual(data.variables_api_error, 'Cannot convert null to an object.');
    assert.deepStrictEqual(data.variables.map(v => v.name), ['cpu', 'ram', 'disk']);
  });

  it('omits the variables block when the item has no questions', async () => {
    const sdk = buildEnrichSdk({ variables: [] });
    const { data } = await enrichCatalogItem({ sdk, instanceUrl: 'https://x.service-now.com', sysID: 'abc123' });
    assert.deepStrictEqual(data.variables, []);
    assert.deepStrictEqual(data.required_variables, []);
  });

  it('throws Not found when the item does not exist', async () => {
    const sdk = { list: async () => [], get: async () => ({}) };
    await assert.rejects(
      () => enrichCatalogItem({ sdk, instanceUrl: 'https://x.service-now.com', sysID: 'nope' }),
      /Not found: nope/,
    );
  });
});

describe('buildCatalogFormatted', () => {
  it('renders details, flow, workflow and questions with their payload names', () => {
    const data = {
      name: 'Test Item',
      short_description: 'A test item',
      category: 'Hardware',
      active: 'true',
      url: 'https://x/sc_cat_item.do?sys_id=abc123',
      flow: 'Provision Server',
      flow_cmd: 'jsn flows show abc123',
      workflow: 'Fulfillment WF',
      execution_plan: 'Standard Plan',
      required_variables: ['cpu', 'disk'],
      instance_supplied_variables: [],
    };
    const variables = [
      { name: 'cpu', label: 'CPU', type: 6, friendly_type: null, mandatory: true, instance_supplied: false },
      { name: 'disk', label: 'Disk', type: 5, friendly_type: 'select_box', mandatory: true, instance_supplied: false },
    ];
    const out = buildCatalogFormatted(data, variables, 'item_option_new');
    assert.match(out, /Test Item \(sc_cat_item\)/);
    assert.match(out, /─ Details ─/);
    assert.match(out, /short_description: {2}A test item/);
    assert.match(out, /─ Flow ─\n {2}Provision Server\n {2}→ jsn flows show abc123/);
    assert.match(out, /─ Workflow ─\n {2}Fulfillment WF/);
    assert.match(out, /─ Catalog Questions \(item_option_new\) ─/);
    assert.match(out, / {2}cpu {2}CPU {2}\[6\] {2}\(required\)/);
    assert.match(out, / {2}disk {2}Disk {2}\[select_box\] {2}\(required\)/);
    assert.match(out, / {2}required: {2}cpu, disk/);
  });

  it('marks instance-supplied questions separately from required ones', () => {
    const out = buildCatalogFormatted({ name: 'Desk phone', active: 'true', required_variables: ['justification'], instance_supplied_variables: ['requested_for'] }, [
      { name: 'requested_for', label: 'Requested for', type: 31, friendly_type: 'requested_for', mandatory: true, instance_supplied: true },
      { name: 'justification', label: 'Business justification', type: 2, friendly_type: 'multi_line_text', mandatory: true, instance_supplied: false },
    ], 'catalog_api');
    assert.match(out, /─ Catalog Questions \(catalog API\) ─/);
    assert.match(out, / {2}requested_for {2}Requested for {2}\[requested_for\] {2}\(required, instance-supplied\)/);
    assert.match(out, / {2}instance-supplied: {2}requested_for/);
  });

  it('skips optional sections when absent and reports a failed catalog API read', () => {
    const out = buildCatalogFormatted({ name: 'Bare', active: 'true', variables_api_error: 'HTTP 500' }, [], 'item_option_new');
    assert.match(out, /Bare \(sc_cat_item\)/);
    assert.doesNotMatch(out, /─ Flow ─/);
    assert.doesNotMatch(out, /─ Workflow ─/);
    assert.doesNotMatch(out, /─ Catalog Questions ─/);
    assert.match(out, /─ Catalog API ─\n {2}unavailable: {2}HTTP 500/);
  });
});

// ─── catalog show handler: thin wrapper over the enrichment module ───
describe('catalog show handler', () => {
  it('emits the enriched envelope with _formatted and breadcrumbs', async () => {
    const { catalogCmd } = await import('../src/commands/catalog.js');
    const cmd = catalogCmd(wrapHandler);
    const show = findCommand(captureSubcommands(cmd), 'show <id>');
    assert.ok(show, 'show subcommand exists');

    const sdk = buildEnrichSdk();
    const app = makeApp({ sdk });
    await show.handler({ app, id: 'abc123def456abc123def456abc12345' });

    const { data, opts } = app.lastOk;
    assert.strictEqual(data.name, 'Test Item');
    assert.strictEqual(data.flow, 'Provision Server');
    assert.strictEqual(data.variables.length, 3);
    assert.deepStrictEqual(data.required_variables, ['cpu', 'disk']);
    assert.deepStrictEqual(opts.breadcrumbs.map(b => b.action), ['list', 'order']);
    assert.match(opts.summary, /Test Item — 3 question\(s\) from item_option_new/);
    // _formatted is non-enumerable so JSON output stays clean
    assert.strictEqual(Object.keys(data).includes('_formatted'), false);
    assert.match(data._formatted, /Test Item \(sc_cat_item\)/);
  });

  it('resolves a name to sys_id before enriching', async () => {
    const { catalogCmd } = await import('../src/commands/catalog.js');
    const cmd = catalogCmd(wrapHandler);
    const show = findCommand(captureSubcommands(cmd), 'show <id>');

    const sdk = buildEnrichSdk();
    const seen = [];
    const origList = sdk.list;
    sdk.list = async (table, params) => {
      if (table === 'sc_cat_item' && params.get('sysparm_query') === 'name=Test Item') {
        return [{ sys_id: 'abc123def456abc123def456abc12345' }];
      }
      seen.push(table);
      return origList(table, params);
    };
    const app = makeApp({ sdk });
    await show.handler({ app, id: 'Test Item' });
    assert.strictEqual(app.lastOk.data.name, 'Test Item');
  });
});
