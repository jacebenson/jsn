import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseConditionBranches, formatDecisionValue, inspectDecisionTable, renderDecisionMatrix } from '../src/decision-table-inspection.js';
import { decisiontablesCmd } from '../src/commands/dev/decisiontables.js';

describe('decision table condition parsing', () => {
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
  it('registers only read-only list and show commands', () => {
    const commands = [];
    const yargs = { command: (definition) => { commands.push(definition); return yargs; } };
    const cmd = decisiontablesCmd((handler) => handler);
    cmd.builder(yargs);
    assert.deepEqual(commands.map((c) => c.command), ['list', 'show <identifier>']);
  });

  it('uses the output wrapper for bare command guidance', () => {
    let result;
    const cmd = decisiontablesCmd((handler) => handler);
    cmd.handler({}, { ok: (data, meta) => { result = { data, meta }; } });
    assert.deepEqual(result.data.guidance, ['jsn decisiontables list', 'jsn decisiontables show <name_or_sys_id>']);
    assert.equal(result.meta.summary, 'Decision tables: choose list or show');
  });
});
