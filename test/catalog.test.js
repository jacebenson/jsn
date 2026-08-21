// Tests for the catalog command family and item_option_new type resolution.
// Regression net for the catalog.js inline type-map bug (select=3, date=4,
// datetime=5, checkbox=12, email=11 — all wrong) vs the canonical
// ServiceNow item_option_new.type values in helpers.js.

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { resolveItemOptionType } from '../src/helpers.js';
import { enrichCatalogItem, buildCatalogFormatted } from '../src/commands/catalog/enrich.js';

// ─── helpers to navigate the yargs command tree (mirrors features.test.js) ───
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
    const cmd = catalogCmd((fn) => fn);
    const create = collectSubcommands(cmd).find((s) => s.command === 'create');
    assert.ok(create, 'create subcommand exists');

    const created = [];
    const sdk = {
      create: async (table, data) => {
        if (table === 'item_option_new') created.push(data);
        return { sys_id: 'item123' };
      },
    };
    const app = buildApp(sdk);
    await create.handler(
      {
        app,
        name: 'Test Item',
        variable: ['dept:select', 'start:date', 'when:datetime', 'agree:checkbox', 'contact:email'],
      },
      app,
    );

    assert.strictEqual(created.length, 5, 'all 5 variables created');
    const byName = Object.fromEntries(created.map((c) => [c.name, c.type]));
    // These assertions FAIL against the old inline map
    // { select:'3', date:'4', datetime:'5', checkbox:'12', email:'11' }.
    assert.strictEqual(byName.dept, 5, 'select → 5 (Select Box)');
    assert.strictEqual(byName.start, 9, 'date → 9 (Date)');
    assert.strictEqual(byName.when, 10, 'datetime → 10 (Date/Time)');
    assert.strictEqual(byName.agree, 7, 'checkbox → 7 (CheckBox)');
    assert.strictEqual(byName.contact, 26, 'email → 26 (Email)');
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

  it('resolves workflow + workflow_cmd from display value and sys_id', async () => {
    const sdk = buildEnrichSdk({
      item: {
        flow_designer_flow: '',
        workflow: { display_value: 'Fulfillment WF', value: 'wf9' },
      },
    });
    const { data } = await enrichCatalogItem({ sdk, instanceUrl: 'https://x.service-now.com', sysID: 'abc123' });
    assert.strictEqual(data.workflow, 'Fulfillment WF');
    assert.strictEqual(data.workflow_cmd, 'jsn workflows show wf9');
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

  it('groups variables into standalone + sets with count', async () => {
    const sdk = buildEnrichSdk();
    const { data } = await enrichCatalogItem({ sdk, instanceUrl: 'https://x.service-now.com', sysID: 'abc123' });
    assert.strictEqual(data.variables.count, 3);
    assert.deepStrictEqual(data.variables.standalone, [
      { label: 'CPU', type: '6', mandatory: true },
    ]);
    assert.deepStrictEqual(data.variables.sets, [
      {
        name: 'Standard Set',
        variables: [
          { label: 'RAM', type: '5', mandatory: false },
          { label: 'Disk', type: '5', mandatory: true },
        ],
      },
    ]);
  });

  it('omits the variables block when the item has no variables', async () => {
    const sdk = buildEnrichSdk({ variables: [] });
    const { data } = await enrichCatalogItem({ sdk, instanceUrl: 'https://x.service-now.com', sysID: 'abc123' });
    assert.strictEqual(data.variables, undefined);
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
  it('renders details, flow, workflow and grouped variables', () => {
    const data = {
      name: 'Test Item',
      short_description: 'A test item',
      category: 'Hardware',
      active: 'true',
      url: 'https://x/sc_cat_item.do?sys_id=abc123',
      flow: 'Provision Server',
      flow_cmd: 'jsn flows show abc123',
      workflow: 'Fulfillment WF',
      workflow_cmd: 'jsn workflows show wf9',
      execution_plan: 'Standard Plan',
    };
    const standalone = [{ name: 'cpu', question_text: 'CPU', type: '6', mandatory: 'true' }];
    const sets = [{ name: 'Standard Set', variables: [{ name: 'ram', question_text: 'RAM', type: '5', mandatory: 'false' }] }];
    const out = buildCatalogFormatted(data, standalone, sets, 2);
    assert.match(out, /Test Item \(sc_cat_item\)/);
    assert.match(out, /─ Details ─/);
    assert.match(out, /short_description: {2}A test item/);
    assert.match(out, /─ Flow ─\n {2}Provision Server\n {2}→ jsn flows show abc123/);
    assert.match(out, /─ Workflow ─\n {2}Fulfillment WF\n {2}→ jsn workflows show wf9/);
    assert.match(out, /─ Catalog Variables ─/);
    assert.match(out, / {2}CPU: {2}6 \(mandatory\)/);
    assert.match(out, / {2}\[Standard Set\]\n {4}RAM: {2}5/);
  });

  it('skips optional sections when absent', () => {
    const out = buildCatalogFormatted({ name: 'Bare', active: 'true' }, [], [], 0);
    assert.match(out, /Bare \(sc_cat_item\)/);
    assert.doesNotMatch(out, /─ Flow ─/);
    assert.doesNotMatch(out, /─ Workflow ─/);
    assert.doesNotMatch(out, /─ Catalog Variables ─/);
  });
});

// ─── catalog show handler: thin wrapper over the enrichment module ───
describe('catalog show handler', () => {
  it('emits the enriched envelope with _formatted and breadcrumbs', async () => {
    const { catalogCmd } = await import('../src/commands/catalog.js');
    const cmd = catalogCmd((fn) => fn);
    const show = collectSubcommands(cmd).find((s) => s.command === 'show <id>');
    assert.ok(show, 'show subcommand exists');

    const sdk = buildEnrichSdk();
    const app = buildApp(sdk);
    await show.handler({ app, id: 'abc123def456abc123def456abc12345' }, app);

    const { data, opts } = app.lastOk;
    assert.strictEqual(data.name, 'Test Item');
    assert.strictEqual(data.flow, 'Provision Server');
    assert.strictEqual(data.variables.count, 3);
    assert.deepStrictEqual(opts.breadcrumbs, [
      { action: 'list', cmd: 'jsn catalogitems list', description: 'Back to all catalog items' },
    ]);
    assert.match(opts.summary, /Test Item — 3 variable\(s\)/);
    // _formatted is non-enumerable so JSON output stays clean
    assert.strictEqual(Object.keys(data).includes('_formatted'), false);
    assert.match(data._formatted, /Test Item \(sc_cat_item\)/);
  });

  it('resolves a name to sys_id before enriching', async () => {
    const { catalogCmd } = await import('../src/commands/catalog.js');
    const cmd = catalogCmd((fn) => fn);
    const show = collectSubcommands(cmd).find((s) => s.command === 'show <id>');

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
    const app = buildApp(sdk);
    await show.handler({ app, id: 'Test Item' }, app);
    assert.strictEqual(app.lastOk.data.name, 'Test Item');
  });
});
