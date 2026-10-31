import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseConditionBranches, formatDecisionValue, inspectDecisionTable, renderDecisionMatrix } from '../src/decision-table-inspection.js';
import { decisiontablesCmd } from '../src/commands/decisiontables.js';
import { assertSafeExactMatch } from '../src/helpers.js';

describe('decision table condition parsing', () => {
  it('rejects wildcard exact-match identifiers without weakening existing guards', () => {
    assert.throws(() => assertSafeExactMatch('name*'), /Unsafe identifier for exact-match lookup: contains wildcard \(\*\)/);
    assert.throws(() => assertSafeExactMatch('name^ORactive=true'), /ServiceNow query characters/);
  });
  it('preserves AND tokens and technical values', () => {
    const result = parseConditionBranches('priority=4^state=-3');
    assert.deepStrictEqual(result, [{
      raw: 'priority=4^state=-3',
      tokens: [
        { raw: 'priority=4', field: 'priority', operator: '=', value: '4' },
        { raw: 'state=-3', field: 'state', operator: '=', value: '-3' },
      ],
    }]);
  });

  it('preserves NQ branches and malformed fragments', () => {
    const result = parseConditionBranches('priority=4^NQstate=-3^broken');
    assert.equal(result.length, 2);
    assert.equal(result[1].tokens[1].unparseable, true);
    assert.equal(result[1].tokens[1].raw, 'broken');
  });

  it('parses INSTANCEOF and BETWEEN without misclassifying their names', () => {
    const result = parseConditionBranches('xINSTANCEOFtask^opened_atBETWEEN2026-01-01@2026-02-01');
    assert.deepEqual(result[0].tokens, [
      { raw: 'xINSTANCEOFtask', field: 'x', operator: 'INSTANCEOF', value: 'task' },
      { raw: 'opened_atBETWEEN2026-01-01@2026-02-01', field: 'opened_at', operator: 'BETWEEN', value: '2026-01-01@2026-02-01' },
    ]);
  });
});

describe('decision table inspection', () => {
  it('formats choice display values, references, unresolved values, and alternate rows', async () => {
    const calls = [];
    const app = { sdk: { list: async (table, _params) => {
      calls.push(table);
      if (table === 'sys_decision_input') return [{ sys_id: 'i1', field: 'priority', label: 'Priority', table: 'task' }, { sys_id: 'i2', field: 'caller_id', label: 'Caller', table: 'task' }];
      if (table === 'sys_decision_question') return [{ sys_id: 'q1', condition: 'priority=4^caller_id=u1^NQpriority=99^unknown=x', answer: { value: 'yes', display_value: 'Yes' }, active: 'true', order: '10' }];
      if (table === 'sys_choice') return [{ value: '4', label: 'High' }];
      return [];
    } } };
    const detail = await inspectDecisionTable(app, { sys_id: 'dt1', name: 'Approval' });
    assert.deepEqual(detail.questions[0].parsed_branches.map((b) => b.raw), ['priority=4^caller_id=u1', 'priority=99^unknown=x']);
    assert.equal(detail.matrix[0].values[0], 'Priority = High (4)');
    assert.equal(detail.matrix[0].values[1], 'Caller = u1');
    assert.equal(detail.matrix[1].values[0], 'Priority = 99');
    assert.match(detail._formatted, /OR branches/);
    assert.deepEqual(calls.slice(0, 2), ['sys_decision_input', 'sys_decision_question']);
  });

  it('uses documented relationships and fields, resolves choices, defaults, and dot-walked inputs', async () => {
    const calls = [];
    const app = { sdk: {
      list: async (table, params) => {
        calls.push([table, params.toString()]);
        if (table === 'sys_decision_input') return [{ sys_id: 'i1', model: 'dt1', name: 'change_request', columnName: 'change_request', label: 'Change', source_table: 'change_request' }, { sys_id: 'i2', model: 'dt1', name: 'caller_id', label: 'Caller', reference_table: 'sys_user' }, { sys_id: 'i3', model: 'dt1', name: 'priority', label: 'Priority', source_table: 'task' }];
        if (table === 'sys_decision_question') return [{ sys_id: 'q1', decision_table: 'dt1', condition: 'change_request.state=2^caller_id=some-id^priority=1', defaultAnswer: 'fallback', active: 'true', order: '10' }];
        if (table === 'sys_choice') return [{ value: '1', label: 'Critical', language: 'en' }];
        return [];
      },
      get: async (table, id) => {
        assert.equal(table, 'sys_user');
        assert.equal(id, 'some-id');
        return { sys_id: id, name: 'Alex' };
      },
    } };
    const detail = await inspectDecisionTable(app, { sys_id: 'dt1', name: 'Changes' });
    assert.match(decodeURIComponent(calls[0][1]), /model=dt1/);
    assert.match(decodeURIComponent(calls[1][1]), /decision_table=dt1/);
    assert.equal(detail.inputs[0].name, 'change_request');
    assert.equal(detail.questions[0].defaultAnswer, 'fallback');
    assert.equal(detail.matrix[0].values[0], 'Change = 2');
    assert.equal(detail.matrix[0].values[1], 'Caller = Alex (some-id)');
    assert.equal(detail.matrix[0].values[2], 'Priority = Critical (1)');
    assert.match(detail.matrix[0].condition, /change_request.state=2/);
  });

  it('uses the element field when ServiceNow wraps the input name metadata', async () => {
    const app = { sdk: { list: async (table) => {
      if (table === 'sys_decision_input') return [{
        element: { value: 'releaseops_plugin_is_installed', display_value: 'releaseops_plugin_is_installed' },
        name: { value: 'var__m_sys_decision_input_dt1', display_value: 'var__m_sys_decision_input_dt1' },
        label: { value: 'ReleaseOps plugin is active', display_value: 'ReleaseOps plugin is active' },
      }];
      if (table === 'sys_decision_question') return [{ condition: 'releaseops_plugin_is_installed=true^EQ' }];
      return [];
    } } };
    const detail = await inspectDecisionTable(app, { sys_id: 'dt1', name: 'Wrapped input' });
    assert.equal(detail.matrix[0].values[0], 'ReleaseOps plugin is active = true');
  });

  it('supports empty inputs and rows', async () => {
    const app = { sdk: { list: async (table) => table === 'sys_decision_input' || table === 'sys_decision_question' ? [] : [] } };
    const detail = await inspectDecisionTable(app, { sys_id: 'empty', name: 'Empty' });
    assert.deepEqual(detail.inputs, []);
    assert.deepEqual(detail.matrix, []);
    assert.match(detail._formatted, /no decision rows/);
  });

  it('formats technical values when display lookup is unavailable', () => {
    assert.equal(formatDecisionValue('4'), '4');
    assert.equal(formatDecisionValue({ value: 'u1', display_value: 'Alex' }), 'Alex (u1)');
  });

  it('uses the raw sys_id and readable name from wrapped table fields', async () => {
    const queries = [];
    const app = { sdk: { list: async (table, params) => {
      queries.push([table, params.get('sysparm_query')]);
      if (table === 'sys_decision_input') return [{ name: 'priority', label: 'Priority', source_table: 'task' }];
      if (table === 'sys_decision_question') return [{ condition: 'priority=1', answer: 'yes' }];
      return [];
    } }, getEffectiveInstance: () => 'https://dev265639.service-now.com' };
    const detail = await inspectDecisionTable(app, {
      sys_id: { value: 'dt1', display_value: 'Approval' },
      name: { value: 'Approval', display_value: 'Approval' },
    });
    assert.equal(queries[0][1], 'model=dt1^ORDERBYorder');
    assert.equal(queries[1][1], 'decision_table=dt1^ORDERBYorder');
    assert.match(detail._formatted, /^Decision table: Approval\n/);
    assert.match(detail._formatted, /https:\/\/dev265639\.service-now\.com\/now\/workflow-studio\/builder\?table=sys_decision&sysId=dt1/);
    assert.doesNotMatch(detail._formatted, /\[object Object\]/);
  });

  it('renders structured multi-result answers without losing their JSON shape', async () => {
    const app = { sdk: { list: async (table) => {
      if (table === 'sys_decision_input') return [{ name: 'priority', label: 'Priority', source_table: 'task' }];
      if (table === 'sys_decision_question') return [{ condition: 'priority=4', answer: [
        { name: 'approval', value: 'yes', display_value: 'Approved' },
        { name: 'route', value: 'manager', display_value: 'Manager' },
      ] }];
      return [];
    } } };
    const detail = await inspectDecisionTable(app, { sys_id: 'dt1', name: 'Multi' });
    assert.deepEqual(detail.questions[0].answer, [
      { name: 'approval', value: 'yes', display_value: 'Approved' },
      { name: 'route', value: 'manager', display_value: 'Manager' },
    ]);
    assert.deepEqual(detail.questions[0].technical_answer, ['yes', 'manager']);
    assert.equal(detail.matrix[0].answer, 'approval: Approved (yes), route: Manager (manager)');
    assert.doesNotMatch(detail.matrix[0].answer, /\[object Object\]/);
  });

  it('renders operators and technical values in every condition cell', () => {
    const detail = {
      table: { name: 'Readable' },
      inputs: [{ name: 'risk', label: 'Risk' }, { name: 'state', label: 'State' }],
      questions: [{ parsed_branches: [{ raw: 'risk>=3^state=-3', tokens: [] }] }],
      matrix: [{ values: ['Risk >= High (3)', 'State = Closed (-3)'], answer: 'yes', default: '', active: 'true', order: '1' }],
    };
    assert.match(renderDecisionMatrix(detail), /Risk >= High \(3\) \| State = Closed \(-3\)/);
  });

  it('renders IN condition values with each display value and preserves NQ rows', async () => {
    const app = { sdk: { list: async (table) => {
      if (table === 'sys_decision_input') return [{ name: 'risk', label: 'Risk', source_table: 'task' }];
      if (table === 'sys_decision_question') return [{ condition: 'riskIN2,3^NQrisk=1' }];
      if (table === 'sys_choice') return [{ value: '2', label: 'Medium' }, { value: '3', label: 'Low' }, { value: '1', label: 'High' }];
      return [];
    } } };
    const detail = await inspectDecisionTable(app, { sys_id: 'dt1', name: 'Readable' });
    assert.equal(detail.matrix[0].values[0], 'Risk IN Medium (2), Low (3)');
    assert.equal(detail.matrix[1].values[0], 'Risk = High (1)');
  });

  it('does not resolve dot-walked base inputs as references and uses the actual field for choices', async () => {
    const calls = [];
    const app = { sdk: {
      list: async (table, params) => {
        calls.push([table, params.toString()]);
        if (table === 'sys_decision_input') return [{ name: 'change_request', label: 'Change', source_table: 'change_request', reference_table: 'change_request' }];
        if (table === 'sys_decision_question') return [{ condition: 'change_request.state=-3' }];
        if (table === 'sys_choice') return [{ value: '-3', label: 'Closed' }];
        return [];
      },
      get: async () => { throw new Error('dot-walk must not be fetched'); },
    } };
    const detail = await inspectDecisionTable(app, { sys_id: 'dt1', name: 'Changes' });
    assert.equal(detail.matrix[0].values[0], 'Change = Closed (-3)');
    assert.equal(calls.filter(([table]) => table === 'sys_choice').length, 1);
    assert.match(decodeURIComponent(calls.find(([table]) => table === 'sys_choice')[1]), /element=state/);
    assert.equal(calls.filter(([table]) => table === 'change_request').length, 0);
  });

  it('preserves wrapped multi-answer JSON and renders answer elements readably', async () => {
    const answer = {
      multipleAnswerRecord: 'mar1',
      answerElementValues: [
        { answerElementName: 'approval', label: 'Approval', value: 'yes', table: 'task' },
        { answerElementName: 'route', label: 'Route', value: 'manager', table: 'task' },
      ],
    };
    const app = { sdk: { list: async (table) => {
      if (table === 'sys_decision_input') return [{ name: 'priority', label: 'Priority', source_table: 'task' }];
      if (table === 'sys_decision_question') return [{ condition: 'priority=4', answer }];
      return [];
    } } };
    const detail = await inspectDecisionTable(app, { sys_id: 'dt1', name: 'Wrapped' });
    assert.deepEqual(detail.questions[0].answer, answer);
    assert.match(detail.matrix[0].answer, /Approval: yes/);
    assert.match(detail.matrix[0].answer, /Route: manager/);
    assert.doesNotMatch(detail.matrix[0].answer, /\[object Object\]/);
  });

  it('preserves display and technical values for wrapped answer elements', async () => {
    const answer = {
      answerElementValues: [{ answerElementName: 'approval', label: 'Approval', value: 'yes', display_value: 'Approved' }],
    };
    const app = { sdk: { list: async (table) => {
      if (table === 'sys_decision_input') return [{ name: 'priority', label: 'Priority', source_table: 'task' }];
      if (table === 'sys_decision_question') return [{ condition: 'priority=4', answer }];
      return [];
    } } };
    const detail = await inspectDecisionTable(app, { sys_id: 'dt1', name: 'Wrapped display' });
    assert.deepEqual(detail.questions[0].technical_answer, ['yes']);
    assert.deepEqual(detail.questions[0].display_answer, ['Approved']);
    assert.equal(detail.matrix[0].answer, 'Approval: Approved (yes)');
  });

  it('renders documented single answers with their readable label and technical value', async () => {
    const app = { sdk: { list: async (table) => {
      if (table === 'sys_decision_input') return [{ name: 'priority', label: 'Priority', source_table: 'task' }];
      if (table === 'sys_decision_question') return [{ condition: 'priority=4', answer: { label: 'CAB Approval', value: 'answer-id', table: 'chg_approval_def' } }];
      return [];
    } } };
    const detail = await inspectDecisionTable(app, { sys_id: 'dt1', name: 'Single answer' });
    assert.equal(detail.matrix[0].answer, 'CAB Approval: answer-id');
  });

  it('preserves malformed question rows and renders a visible fallback', async () => {
    const app = { sdk: { list: async (table) => {
      if (table === 'sys_decision_input') return [{ name: 'priority', label: 'Priority', source_table: 'task' }];
      if (table === 'sys_decision_question') return [null, { condition: null, answer: { broken: true } }];
      return [];
    } } };
    const detail = await inspectDecisionTable(app, { sys_id: 'dt1', name: 'Malformed' });
    assert.equal(detail.questions[0].raw_question, null);
    assert.equal(detail.questions[0].malformed, true);
    assert.match(detail.matrix[0].values[0], /malformed/i);
    assert.doesNotMatch(detail._formatted, /undefined|\[object Object\]/);
  });

  it('rejects adversarial reference values before sdk.get', async () => {
    let getCalls = 0;
    const app = { sdk: {
      list: async (table) => {
        if (table === 'sys_decision_input') return [{ name: 'caller_id', reference_table: 'sys_user' }];
        if (table === 'sys_decision_question') return [{ condition: 'caller_id=abc/def?x#frag' }];
        return [];
      },
      get: async () => { getCalls += 1; return { name: 'unexpected' }; },
    } };
    await assert.rejects(() => inspectDecisionTable(app, { sys_id: 'dt1', name: 'Unsafe' }), /Unsafe identifier/);
    assert.equal(getCalls, 0);
  });

  it('rejects traversal and encoded path separators in reference values', async () => {
    for (const value of ['.', '..', 'a\\b', '%2Fetc%2Fpasswd']) {
      let getCalls = 0;
      const app = { sdk: {
        list: async (table) => {
          if (table === 'sys_decision_input') return [{ name: 'caller_id', reference_table: 'sys_user' }];
          if (table === 'sys_decision_question') return [{ condition: `caller_id=${value}` }];
          return [];
        },
        get: async () => { getCalls += 1; return { name: 'unexpected' }; },
      } };
      await assert.rejects(() => inspectDecisionTable(app, { sys_id: 'dt1', name: 'Unsafe path' }), /Unsafe identifier/);
      assert.equal(getCalls, 0);
    }
  });

  it('rejects adversarial reference table names before sdk.get', async () => {
    let getCalls = 0;
    const app = { sdk: {
      list: async (table) => {
        if (table === 'sys_decision_input') return [{ name: 'caller_id', reference_table: 'sys_user/evil' }];
        if (table === 'sys_decision_question') return [{ condition: 'caller_id=abc123' }];
        return [];
      },
      get: async () => { getCalls += 1; return { name: 'unexpected' }; },
    } };
    await assert.rejects(() => inspectDecisionTable(app, { sys_id: 'dt1', name: 'Unsafe table' }), /Unsafe reference table/);
    assert.equal(getCalls, 0);
  });

  it('rejects adversarial choice source table names before sys_choice lookup', async () => {
    const listCalls = [];
    const app = { sdk: {
      list: async (table, params) => {
        listCalls.push({ table, query: params?.get('sysparm_query') });
        if (table === 'sys_decision_input') return [{ name: 'priority', source_table: 'task^ORactive=true' }];
        if (table === 'sys_decision_question') return [{ condition: 'priority=1' }];
        return [];
      },
    } };
    await assert.rejects(() => inspectDecisionTable(app, { sys_id: 'dt1', name: 'Unsafe source table' }), /Unsafe reference table/);
    assert.equal(listCalls.filter((call) => call.table === 'sys_choice').length, 0);
  });
});

describe('decisiontables command wiring', () => {
  it('uses the interactive picker with name and scope labels', async () => {
    const commands = [];
    const yargs = { command: (definition) => { commands.push(definition); return yargs; } };
    const cmd = decisiontablesCmd((handler) => handler);
    cmd.builder(yargs);

    let promptConfig;
    let promptChoices;
    let pickerFields;
    let output;
    const app = {
      requireInstance() {},
      output: { getFormat: () => 'auto' },
      sdk: {
        aggregateCount: async () => 1,
        list: async (_table, params) => {
          const fields = params?.get('sysparm_fields');
          if (fields) pickerFields = fields;
          return [
            { sys_id: 'dt1', name: 'Approval', sys_scope: { value: 'x', display_value: 'x_app' } },
            { sys_id: 'dt2', name: 'Global approval', sys_scope: { value: 'global', display_value: 'Global' } },
          ];
        },
      },
      promptFn: async (config) => {
        promptConfig = config;
        promptChoices = await config.source(undefined, 0, {});
        return { name: 'Approval [x_app]', value: { sys_id: 'dt1', name: 'Approval', sys_scope: { value: 'x', display_value: 'x_app' } } };
      },
      getEffectiveInstance: () => 'https://example.service-now.com',
      ok(data, meta) { output = { data, meta }; },
    };

    await commands[0].handler({ limit: 20 }, app);

    assert.equal(promptChoices[0].name, 'Approval [x_app]');
    assert.equal(promptChoices[1].name, 'Global approval');
    assert.equal(pickerFields, 'sys_id,name,sys_scope');
    assert.doesNotMatch(pickerFields, /order/);
    assert.equal(promptConfig.message, 'Select a decision table');
    assert.equal(output.data.table.name, 'Approval');
  });

  it('does not fall back to listing when the picker is cancelled', async () => {
    const commands = [];
    const yargs = { command: (definition) => { commands.push(definition); return yargs; } };
    const cmd = decisiontablesCmd((handler) => handler);
    cmd.builder(yargs);

    let listCalls = 0;
    let outputCalls = 0;
    const app = {
      requireInstance() {},
      output: { getFormat: () => 'auto' },
      sdk: {
        aggregateCount: async () => 1,
        list: async () => { listCalls += 1; return []; },
      },
      promptFn: async () => undefined,
      ok() { outputCalls += 1; },
    };

    await commands[0].handler({ limit: 20 }, app);

    assert.equal(listCalls, 0);
    assert.equal(outputCalls, 0);
  });

  it('registers list, inspection, and CRUD commands', () => {
    const commands = [];
    const yargs = { command: (definition) => { commands.push(definition); return yargs; } };
    const cmd = decisiontablesCmd((handler) => handler);
    cmd.builder(yargs);
    assert.deepEqual(commands.map((c) => c.command), ['list', 'show <identifier>', 'create', 'update <identifier>', 'delete <identifier>']);
  });

  it('uses the output wrapper for bare command guidance', () => {
    let result;
    const cmd = decisiontablesCmd((handler) => handler);
    cmd.handler({}, { ok: (data, meta) => { result = { data, meta }; } });
    assert.deepEqual(result.data.guidance, [
      'jsn decisiontables list',
      'jsn decisiontables show <name_or_sys_id>',
      "jsn decisiontables create --data '<json>' (or --data-file <path>)",
      "jsn decisiontables update <sys_id> --data '<json>' (or --data-file <path>)",
      'jsn decisiontables delete <name_or_sys_id>',
    ]);
    assert.equal(result.meta.summary, 'Manage decision tables');
  });

  it('resolves active scope before CRUD execution and preserves delete guards', async () => {
    const commands = [];
    const yargs = { command: (definition) => { commands.push(definition); return yargs; } };
    decisiontablesCmd((handler) => handler).builder(yargs);
    const calls = [];
    const app = { context: { scope: 'x_demo' }, config: { profiles: {} }, requireInstance() {}, sdk: {
      list: async (table, params) => { calls.push([table, params.get('sysparm_query')]); return table === 'sys_decision' ? [{ sys_id: '0123456789abcdef0123456789abcdef', name: 'A' }] : []; },
      resolveScope: async (scope) => { calls.push(['resolveScope', scope]); return 'scope-sys-id'; },
      async delete(table, id) { calls.push(['delete', table, id]); },
      async get(table, id) { calls.push(['get', table, id]); return null; },
    }, ok() {} };
    await commands.find((c) => c.command === 'delete <identifier>').handler({ identifier: '0123456789abcdef0123456789abcdef', force: true }, app);
    assert.deepEqual(calls.at(-3), ['resolveScope', 'x_demo']);
    assert.deepEqual(calls.at(-2), ['delete', 'sys_decision', '0123456789abcdef0123456789abcdef']);
    assert.deepEqual(calls.at(-1), ['get', 'sys_decision', '0123456789abcdef0123456789abcdef']);
    assert.ok(calls.some(([table, query]) => table === 'sys_decision_input' && query === 'model=0123456789abcdef0123456789abcdef'));
    assert.ok(!calls.some(([table]) => table === 'sys_choice'));
  });

  it('uses REST methods for create and fails closed before update mutation', async () => {
    const commands = [];
    const yargs = { command: (definition) => { commands.push(definition); return yargs; } };
    decisiontablesCmd((handler) => handler).builder(yargs);
    const calls = [];
    const app = { context: { scope: 'x_demo' }, requireInstance() {}, sdk: {
      resolveScope: async (scope) => { calls.push(['resolveScope', scope]); return 'scope-sys-id'; },
      list: async (table, params) => { calls.push([table, params.get('sysparm_query')]); return [{ sys_id: '0123456789abcdef0123456789abcdef', name: 'A' }]; },
      create: async (table, body) => { calls.push(['create', table, body]); return { sys_id: '0123456789abcdef0123456789abcdef', ...body }; },
      get: async (table, id) => { calls.push(['get', table, id]); return { sys_id: id, name: 'A', access: 'package_private', sys_scope: 'scope-sys-id' }; },
    }, ok() {} };
    await commands.find((c) => c.command === 'create').handler({ data: JSON.stringify({ parent: { name: 'A' }, inputs: [], questions: [] }) }, app);
    assert.deepEqual(calls.slice(0, 3), [['resolveScope', 'x_demo'], ['create', 'sys_decision', { name: 'A', access: 'package_private', sys_scope: 'scope-sys-id' }], ['get', 'sys_decision', '0123456789abcdef0123456789abcdef']]);
    await assert.rejects(() => commands.find((c) => c.command === 'update <identifier>').handler({ identifier: '0123456789abcdef0123456789abcdef', data: JSON.stringify({ parent: {}, inputs: [], questions: [] }) }, app), /intentionally unsupported over REST/);
    assert.equal(calls.filter(([method]) => method === 'create').length, 1);
  });

  it('verifies an update target is in the active scope before mutation', async () => {
    const commands = [];
    const yargs = { command: (definition) => { commands.push(definition); return yargs; } };
    decisiontablesCmd((handler) => handler).builder(yargs);
    const calls = [];
    const app = {
      context: { scope: 'x_demo' },
      requireInstance() {},
      sdk: {
        resolveScope: async () => 'scope-sys-id',
        list: async (table, params) => { calls.push([table, params.toString()]); return []; },
        executeScript: async () => { calls.push(['script']); return 'JSN_DECISION_TABLE_RESULT:{"status":"Success"}'; },
      },
      ok() {},
    };
    await assert.rejects(
      () => commands.find((c) => c.command === 'update <identifier>').handler({ identifier: '0123456789abcdef0123456789abcdef', data: '{"parent":{}}' }, app),
      /not found in active scope/i,
    );
    assert.equal(calls.filter(([table]) => table === 'sys_decision').length, 1);
    assert.match(decodeURIComponent(calls.find(([table]) => table === 'sys_decision')[1]), /sys_id=0123456789abcdef0123456789abcdef\^sys_scope=scope-sys-id/);
    assert.equal(calls.filter(([table]) => table === 'script').length, 0);
  });

  it('fails closed for global update when the exact target cannot be resolved', async () => {
    const commands = [];
    const yargs = { command: (definition) => { commands.push(definition); return yargs; } };
    decisiontablesCmd((handler) => handler).builder(yargs);
    let scriptCalls = 0;
    const app = {
      requireInstance() {},
      sdk: {
        list: async () => [],
        executeScript: async () => { scriptCalls += 1; return 'JSN_DECISION_TABLE_RESULT:{"status":"Success"}'; },
      },
      ok() {},
    };
    await assert.rejects(
      () => commands.find((c) => c.command === 'update <identifier>').handler({ identifier: '0123456789abcdef0123456789abcdef', data: '{"parent":{}}' }, app),
      /not found/i,
    );
    assert.equal(scriptCalls, 0);
  });

  it('uses global scope when no active scope exists', async () => {
    const commands = [];
    const yargs = { command: (definition) => { commands.push(definition); return yargs; } };
    decisiontablesCmd((handler) => handler).builder(yargs);
    const calls = [];
    const app = {
      requireInstance() {},
      sdk: {
        resolveScope: async () => { calls.push('resolveScope'); return 'unexpected'; },
        create: async (table) => { calls.push(['create', table]); return { sys_id: '0123456789abcdef0123456789abcdef' }; },
        get: async (table, id) => { calls.push(['get', table, id]); return { sys_id: id, name: 'A', access: 'package_private' }; },
        executeScript: async (_script, scope) => { calls.push(['script', scope]); return 'JSN_DECISION_TABLE_RESULT:{"status":"Success"}'; },
      },
      ok() {},
    };
    await commands.find((c) => c.command === 'create').handler({ data: JSON.stringify({ parent: { name: 'A' }, inputs: [], questions: [] }) }, app);
    assert.deepEqual(calls, [['create', 'sys_decision'], ['get', 'sys_decision', '0123456789abcdef0123456789abcdef']]);
  });

  it('fails closed when generated choice relationship values contain query metacharacters', async () => {
    const commands = [];
    const yargs = { command: (definition) => { commands.push(definition); return yargs; } };
    decisiontablesCmd((handler) => handler).builder(yargs);
    const id = '0123456789abcdef0123456789abcdef';
    const calls = [];
    const app = {
      requireInstance() {},
      sdk: {
        list: async (table, params) => {
          calls.push([table, params?.get('sysparm_query')]);
          if (table === 'sys_decision') return [{ sys_id: id, name: 'A' }];
          if (table === 'sys_decision_input') return [{ sys_id: 'abcdef0123456789abcdef0123456789', name: 'state^ORactive=true', element: 'state' }];
          return [];
        },
        delete: async () => { calls.push(['delete']); },
      },
      ok() {},
    };

    await assert.rejects(
      () => commands.find((c) => c.command === 'delete <identifier>').handler({ identifier: id, force: true }, app),
      /Cannot prove that the decision table is empty; refusing deletion/i,
    );
    assert.equal(calls.filter(([table]) => table === 'sys_choice').length, 0);
    assert.equal(calls.filter(([table]) => table === 'delete').length, 0);
  });

  it('queries the valid multi-result element table in the delete guard', async () => {
    const commands = [];
    const yargs = { command: (definition) => { commands.push(definition); return yargs; } };
    decisiontablesCmd((handler) => handler).builder(yargs);
    const id = '0123456789abcdef0123456789abcdef';
    const calls = [];
    const app = {
      config: { profiles: {} },
      requireInstance() {},
      sdk: {
        list: async (table, params) => {
          calls.push([table, params?.get('sysparm_query')]);
          if (table === 'sys_decision') return [{ sys_id: id, name: 'A' }];
          if (table === 'sn_decision_multi_result_element') throw new Error('Invalid table');
          return [];
        },
        executeScript: async () => 'JSN_DECISION_TABLE_RESULT:{"status":"Success"}',
        delete: async () => {},
        get: async () => null,
      },
      ok() {},
    };

    await commands.find((c) => c.command === 'delete <identifier>').handler({ identifier: id, force: true }, app);

    assert.ok(calls.some(([table, query]) => table === 'sys_decision_multi_result_element' && query === `decision_table=${id}`));
    assert.ok(!calls.some(([table]) => table === 'sn_decision_multi_result_element'));
  });

  it('requires delete confirmation after exact child guards pass', async () => {
    const commands = [];
    const yargs = { command: (definition) => { commands.push(definition); return yargs; } };
    decisiontablesCmd((handler) => handler).builder(yargs);
    let resolved = 0;
    let executed = 0;
    const app = {
      config: { profiles: {} },
      requireInstance() {},
      sdk: {
        list: async (table) => table === 'sys_decision' ? [{ sys_id: '0123456789abcdef0123456789abcdef', name: 'A' }] : [],
        resolveScope: async () => { resolved += 1; return 'scope-sys-id'; },
        executeScript: async () => { executed += 1; return 'JSN_DECISION_TABLE_RESULT:{"status":"Success"}'; },
      },
      ok() {},
    };
    await assert.rejects(
      () => commands.find((c) => c.command === 'delete <identifier>').handler({ identifier: '0123456789abcdef0123456789abcdef' }, app),
      /confirmation required/i,
    );
    assert.equal(resolved, 0);
    assert.equal(executed, 0);
  });

  it('constrains delete-by-name resolution to active scope and refuses collisions', async () => {
    const commands = [];
    const yargs = { command: (definition) => { commands.push(definition); return yargs; } };
    decisiontablesCmd((handler) => handler).builder(yargs);
    const queries = [];
    const app = { context: { scope: 'x_demo' }, requireInstance() {}, sdk: {
      resolveScope: async () => 'scope-id',
      list: async (table, params) => { if (table === 'sys_decision') { queries.push(params); return [{ sys_id: 'dt1', name: 'A' }, { sys_id: 'dt2', name: 'A' }]; } return []; },
    } };
    await assert.rejects(() => commands.find((c) => c.command === 'delete <identifier>').handler({ identifier: 'A', force: true }, app), /ambiguous/i);
    assert.equal(queries.length, 1);
    assert.match(queries[0].get('sysparm_query'), /name=A\^sys_scope=scope-id/);
  });

  it('fails safely when scoped delete resolution returns an unusable record', async () => {
    const commands = [];
    const yargs = { command: (definition) => { commands.push(definition); return yargs; } };
    decisiontablesCmd((handler) => handler).builder(yargs);
    const app = { context: { scope: 'x_demo' }, requireInstance() {}, sdk: { resolveScope: async () => 'scope-id', list: async (table) => table === 'sys_decision' ? [{ name: 'A' }] : [] } };
    await assert.rejects(() => commands.find((c) => c.command === 'delete <identifier>').handler({ identifier: 'A', force: true }, app), /not found|identifier/i);
  });
});
