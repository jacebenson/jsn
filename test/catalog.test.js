// Tests for the catalog command family and item_option_new type resolution.
// Regression net for the catalog.js inline type-map bug (select=3, date=4,
// datetime=5, checkbox=12, email=11 — all wrong) vs the canonical
// ServiceNow item_option_new.type values in helpers.js.

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { resolveItemOptionType } from '../src/helpers.js';

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

