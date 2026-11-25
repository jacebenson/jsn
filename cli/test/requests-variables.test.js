import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SDKClient } from '../src/sdk.js';
import { captureCommands } from './support/command-test-helpers.js';
import { requestsCmd } from '../src/commands/requests.js';
import { OutputWriter } from '../src/output.js';

const RITM = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const answer = (question, value, ritm = RITM) => ({
  request_item: { value: ritm, display_value: 'RITM0010001' },
  'sc_item_option.item_option_new': { value: `q-${question}`, display_value: question },
  'sc_item_option.value': { value, display_value: value },
});

// sc_item_option has no request_item column, so an instance ignores that filter and returns every
// answer on the instance; the mock does the same for the old read.
function fixtureClient(ownRows) {
  const client = new SDKClient('https://fixture.service-now.com', {});
  client.calls = [];
  client.request = async (endpoint) => {
    const url = new URL(endpoint);
    const table = url.pathname.split('/').pop();
    client.calls.push({ table, params: Object.fromEntries(url.searchParams) });
    if (table === 'sc_item_option') return { result: [{ item_option_new: { display_value: 'Other item question' }, value: { value: 'other answer' } }] };
    if (table === 'sc_item_option_mtom' && url.searchParams.get('sysparm_query').startsWith(`request_item=${RITM}^`)) return { result: ownRows };
    return { result: [] };
  };
  return client;
}

describe('requests show catalog variables', () => {
  it('reads answers through sc_item_option_mtom by the RITM sys_id, never unrelated rows', async () => {
    const column = { ...answer('Device', ''), 'sc_item_option.item_option_new.variable_set.type': { value: 'one_to_many', display_value: 'Multi Row' } };
    const client = fixtureClient([answer('Colour', 'teal'), column, answer('Laptop', 'MacBook Pro')]);
    const result = await client.fetchCatalogVariables(RITM);
    assert.deepEqual(result, { variables: [{ question: 'Colour', value: 'teal' }, { question: 'Laptop', value: 'MacBook Pro' }], truncated: false });
    assert.equal(client.calls.length, 1);
    assert.deepEqual(client.calls[0], { table: 'sc_item_option_mtom', params: {
      sysparm_display_value: 'all',
      sysparm_fields: 'request_item,sc_item_option.item_option_new,sc_item_option.value,sc_item_option.item_option_new.variable_set.type',
      sysparm_query: `request_item=${RITM}^ORDERBYsc_item_option.order`,
      sysparm_limit: '101',
      sysparm_exclude_reference_link: 'true',
    } });
  });

  it('refuses answers that belong to another requested item instead of showing them', async () => {
    const client = fixtureClient([answer('Colour', 'teal'), answer('Colour', 'amber', 'f'.repeat(32))]);
    await assert.rejects(client.fetchCatalogVariables(RITM), /another requested item/);
  });

  it('keeps 100 answers and reports truncation when a 101st exists', async () => {
    const rows = Array.from({ length: 101 }, (_, i) => answer(`Q${i}`, `v${i}`));
    const result = await fixtureClient(rows).fetchCatalogVariables(RITM);
    assert.equal(result.variables.length, 100);
    assert.equal(result.variables.at(-1).question, 'Q99');
    assert.equal(result.truncated, true);
    const exact = await fixtureClient(rows.slice(0, 100)).fetchCatalogVariables(RITM);
    assert.equal(exact.truncated, false);
  });

  it('treats a response with no result array as an error, not an empty variable list', async () => {
    const client = new SDKClient('https://fixture.service-now.com', {});
    client.request = async () => ({ error: 'unexpected' });
    await assert.rejects(client.fetchCatalogVariables(RITM), /Malformed table response for sc_item_option_mtom/);
  });

  const show = captureCommands(requestsCmd(fn => fn)).filter(c => c.command.startsWith('show')).at(-1);
  const runShow = async (fetchCatalogVariables) => {
    const envelopes = [];
    const sdk = { list: async () => [{ sys_id: RITM, number: 'RITM0010001' }], fetchAttachments: async () => [], fetchCatalogVariables, fetchMultiRowVariables: async () => ({ sets: [], truncated: false }) };
    await show.handler({ number: 'RITM0010001' }, { sdk, getEffectiveInstance: () => 'https://fixture.invalid', ok: (data, opts) => envelopes.push({ data, opts }) });
    assert.equal(envelopes.length, 1);
    return envelopes[0];
  };

  it('requests show warns when the variable list is truncated', async () => {
    const { data, opts } = await runShow(async () => ({ variables: [{ question: 'q', value: 'v' }], truncated: true }));
    assert.deepEqual(data._variables, [{ question: 'q', value: 'v' }]);
    assert.deepEqual(opts.meta.warnings, [`Showing the first 100 catalog variables; more exist. List the rest: jsn records list --table sc_item_option_mtom --query "request_item=${RITM}^ORDERBYsc_item_option.order" --fields sc_item_option.item_option_new,sc_item_option.value --offset 100 --limit 1000 --json`]);
  });

  it('requests show warns instead of showing no variables when the read fails', async () => {
    const { data, opts } = await runShow(async () => { throw new Error('HTTP 403 Forbidden'); });
    assert.equal(data._variables, null);
    assert.deepEqual(opts.meta.warnings, ['Catalog variables were not read: HTTP 403 Forbidden']);
  });

  it('requests show adds no warnings when every variable was read', async () => {
    const { opts } = await runShow(async () => ({ variables: [], truncated: false }));
    assert.equal(opts.meta, undefined);
  });
});

const cell = (set, row, question, value, parent = RITM) => ({
  parent_id: { value: parent, display_value: 'RITM0010001' },
  variable_set: { value: `set-${set}`, display_value: set },
  row_index: { value: row, display_value: row },
  item_option_new: { value: `q-${question}`, display_value: question },
  value: { value, display_value: value },
});

describe('requests show multi-row variable sets', () => {
  const mrvsClient = (result) => {
    const client = new SDKClient('https://fixture.service-now.com', {});
    client.calls = [];
    client.request = async (endpoint) => {
      const url = new URL(endpoint);
      client.calls.push({ table: url.pathname.split('/').pop(), params: Object.fromEntries(url.searchParams) });
      return { result };
    };
    return client;
  };

  it('reads answers by the RITM sys_id and groups them by set and row', async () => {
    const client = mrvsClient([
      cell('Peripherals', 'r1', 'Device', 'Mouse'), cell('Peripherals', 'r1', 'Quantity', '2'),
      cell('Peripherals', 'r2', 'Device', 'Dock'), cell('Peripherals', 'r2', 'Quantity', '1'),
      cell('Travellers', 't1', 'Name', 'Ada'),
    ]);
    const result = await client.fetchMultiRowVariables(RITM);
    assert.deepEqual(result, { truncated: false, sets: [
      { set: 'Peripherals', rows: [[{ question: 'Device', value: 'Mouse' }, { question: 'Quantity', value: '2' }], [{ question: 'Device', value: 'Dock' }, { question: 'Quantity', value: '1' }]] },
      { set: 'Travellers', rows: [[{ question: 'Name', value: 'Ada' }]] },
    ] });
    assert.deepEqual(client.calls, [{ table: 'sc_multi_row_question_answer', params: {
      sysparm_display_value: 'all',
      sysparm_fields: 'parent_id,variable_set,row_index,item_option_new,value',
      sysparm_query: `parent_id=${RITM}^parent_table_name=sc_req_item^ORDERBYvariable_set^ORDERBYrow_index^ORDERBYitem_option_new.order`,
      sysparm_limit: '501',
      sysparm_exclude_reference_link: 'true',
    } }]);
  });

  it('refuses rows that belong to another record instead of showing them', async () => {
    const client = mrvsClient([cell('Peripherals', 'r1', 'Device', 'Mouse'), cell('Peripherals', 'x1', 'Device', 'Not mine', 'f'.repeat(32))]);
    await assert.rejects(client.fetchMultiRowVariables(RITM), /another record/);
  });

  it('keeps 500 answers and reports truncation when a 501st exists', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => cell('Big', `r${i}`, 'Q', `v${i}`));
    const result = await mrvsClient(rows).fetchMultiRowVariables(RITM);
    assert.equal(result.sets[0].rows.length, 500);
    assert.equal(result.truncated, true);
    assert.equal((await mrvsClient(rows.slice(0, 500)).fetchMultiRowVariables(RITM)).truncated, false);
  });

  it('treats a response with no result array as an error', async () => {
    const client = new SDKClient('https://fixture.service-now.com', {});
    client.request = async () => ({});
    await assert.rejects(client.fetchMultiRowVariables(RITM), /Malformed table response for sc_multi_row_question_answer/);
  });

  const show = captureCommands(requestsCmd(fn => fn)).filter(c => c.command.startsWith('show')).at(-1);
  const runShow = async (fetchMultiRowVariables) => {
    const envelopes = [];
    const sdk = { list: async () => [{ sys_id: RITM, number: 'RITM0010001' }], fetchAttachments: async () => [],
      fetchCatalogVariables: async () => ({ variables: [], truncated: false }), fetchMultiRowVariables };
    await show.handler({ number: 'RITM0010001' }, { sdk, getEffectiveInstance: () => 'https://fixture.invalid', ok: (data, opts) => envelopes.push({ data, opts }) });
    return envelopes[0];
  };

  it('requests show attaches the sets, and warns on truncation or a failed read', async () => {
    const sets = [{ set: 'Peripherals', rows: [[{ question: 'Device', value: 'Mouse' }]] }];
    let { data, opts } = await runShow(async (id, limit) => { assert.equal(id, RITM); assert.equal(limit, 500); return { sets, truncated: false }; });
    assert.deepEqual(data._variable_sets, sets);
    assert.equal(opts.meta, undefined);
    ({ opts } = await runShow(async () => ({ sets, truncated: true })));
    assert.deepEqual(opts.meta.warnings, [`Showing the first 500 multi-row variable answers; more exist. List the rest: jsn records list --table sc_multi_row_question_answer --query "parent_id=${RITM}^ORDERBYvariable_set^ORDERBYrow_index^ORDERBYitem_option_new.order" --fields variable_set,row_index,item_option_new,value --offset 500 --limit 1000 --json`]);
    ({ data, opts } = await runShow(async () => { throw new Error('HTTP 403 Forbidden'); }));
    assert.equal(data._variable_sets, null);
    assert.deepEqual(opts.meta.warnings, ['Multi-row variable sets were not read: HTTP 403 Forbidden']);
  });

  it('human output prints each set with numbered rows', () => {
    let output = '';
    new OutputWriter({ format: 'styled', writer: { write: text => { output += text; } } }).ok({ sys_id: RITM, number: 'RITM0010001', _context: { table: 'sc_req_item' },
      _variables: [{ question: 'Colour', value: 'teal' }],
      _variable_sets: [{ set: 'Peripherals', rows: [[{ question: 'Device', value: 'Mouse' }, { question: 'Notes', value: 'left\nhanded' }], [{ question: 'Device', value: 'Dock' }]] }] });
    assert.ok(output.includes('─ Catalog Variables ─\n  Colour:  teal\n'));
    assert.ok(output.includes('─ Variable set: Peripherals ─\n  Row 1\n    Device:  Mouse\n    Notes:\n      left\n      handed\n  Row 2\n    Device:  Dock\n'), output);
  });
});
