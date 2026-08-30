import { getStringField, assertSafeExactMatch } from './helpers.js';
import { unwrapSysId } from './resolve-record.js';
import { getTableURL, hyperlink } from './output.js';

const FIELD_OPERATORS = /^(.*?)(NOT LIKE|NOT IN|ISNOTEMPTY|INSTANCEOF|STARTSWITH|ENDSWITH|BETWEEN|DATEPART|DYNAMIC|SAMEAS|NSAMEAS|GT_FIELD|LT_FIELD|GT_OR_EQUALS_FIELD|LT_OR_EQUALS_FIELD|VALCHANGES|CHANGES|CHANGEDFROM|CHANGEDTO|LIKE|ISEMPTY|IN|!=|>=|<=|=|>|<)(.*)$/;

function valueParts(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const technical = value.value ?? value.display_value;
    if (technical != null) return { technical: String(technical), display: String(value.display_value ?? technical) };
    const raw = readableRaw(value);
    return { technical: raw, display: raw };
  }
  const technical = value == null ? '' : String(value);
  return { technical, display: technical };
}

function readableRaw(value) {
  if (value == null) return '';
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return '[unreadable object]'; }
  }
  return String(value);
}

function answerElements(answer) {
  if (Array.isArray(answer)) return answer;
  return answer && typeof answer === 'object' && Array.isArray(answer.answerElementValues) ? answer.answerElementValues : [];
}

function formatAnswer(answer) {
  const elements = answerElements(answer);
  if (elements.length === 0) {
    if (answer && typeof answer === 'object' && !Array.isArray(answer) && answer.label != null) {
      const value = answer.value ?? answer.display_value ?? '';
      return `${answer.label}: ${formatDecisionValue(value, answer.display_value)}`;
    }
    return formatDecisionValue(answer);
  }
  return elements.map((element) => {
    const label = element && typeof element === 'object' ? (element.label ?? element.answerElementName ?? element.name ?? '') : '';
    const value = element && typeof element === 'object' ? element.value ?? element.display_value ?? element : element;
    const rendered = formatDecisionValue(value, element?.display_value);
    return label ? `${label}: ${rendered}` : rendered;
  }).join(', ');
}

function technicalAnswer(answer) {
  const elements = answerElements(answer);
  if (elements.length === 0) return valueParts(answer).technical;
  return elements.map((element) => valueParts(element).technical);
}

function displayAnswer(answer) {
  const elements = answerElements(answer);
  if (elements.length === 0) {
    if (answer && typeof answer === 'object' && !Array.isArray(answer)) return String(answer.display_value ?? answer.label ?? valueParts(answer).display);
    return valueParts(answer).display;
  }
  return elements.map((element) => valueParts(element).display);
}

function isNotFound(error) {
  return error?.code === 'not_found' || error?.status === 404 || error?.response?.status === 404;
}

export function parseConditionBranches(rawCondition) {
  const raw = rawCondition == null ? '' : String(rawCondition);
  return raw.split('^NQ').map((branchRaw) => ({
    raw: branchRaw,
    tokens: branchRaw.split('^').filter(Boolean).map((fragment) => {
      const match = fragment.match(FIELD_OPERATORS);
      if (!match || !match[1]) return { raw: fragment, unparseable: true };
      return { raw: fragment, field: match[1], operator: match[2], value: match[3] };
    }),
  }));
}

export function formatDecisionValue(value, displayValue) {
  if (Array.isArray(value)) {
    return value.map((item, index) => formatDecisionValue(item, Array.isArray(displayValue) ? displayValue[index] : undefined)).join(', ');
  }
  const parts = valueParts(value);
  const display = displayValue == null || displayValue === '' ? parts.display : String(displayValue);
  if (!display || display === parts.technical) return parts.technical;
  return `${display} (${parts.technical})`;
}

function inputName(input) {
  return getStringField(input, 'element') || getStringField(input, 'columnName') || getStringField(input, 'name') || getStringField(input, 'field') || getStringField(input, 'question') || getStringField(input, 'label');
}

function inputLabel(input) {
  return getStringField(input, 'label') || getStringField(input, 'columnName') || getStringField(input, 'name') || inputName(input);
}

function conditionOf(row) {
  return getStringField(row, 'condition') || getStringField(row, 'conditions') || getStringField(row, 'input_conditions');
}

function answerOf(row) {
  if (!row || typeof row !== 'object') return '';
  return row.answer ?? row.result ?? row.output ?? '';
}

function defaultOf(row) {
  if (!row || typeof row !== 'object') return '';
  return row.defaultAnswer ?? row.default ?? row.is_default ?? '';
}

function addFormatted(data, text) {
  Object.defineProperty(data, '_formatted', { value: text, enumerable: false, configurable: true });
  return data;
}

export function renderDecisionMatrix(detail, instanceURL = '') {
  const labels = detail.inputs.map(inputLabel);
  const hasUnparseable = detail.matrix.some((row) => row.unparseable);
  const headers = [...labels, ...(hasUnparseable ? ['Unparsed'] : []), 'Answer', 'Default', 'Active', 'Order'];
  const lines = [`Decision table: ${getStringField(detail.table, 'name') || getStringField(detail.table, 'sys_id') || ''}`, headers.join(' | '), headers.map(() => '---').join(' | ')];
  for (const row of detail.matrix) {
    lines.push(row.values.concat([...(hasUnparseable ? [row.unparseable] : []), row.answer, row.default, row.active, row.order]).map((v) => String(v ?? '')).join(' | '));
  }
  if (detail.matrix.length === 0) lines.push('(no decision rows)');
  if (detail.questions.some((q) => q.parsed_branches.length > 1)) lines.push('OR branches are shown as separate rows (NQ).');
  const tableId = unwrapSysId(detail.table);
  if (instanceURL && tableId) {
    const url = getTableURL(instanceURL, 'sys_decision', tableId);
    lines.push(`Open in Workflow Studio: ${hyperlink(url, url)}`);
  }
  return lines.join('\n') + '\n';
}

function conditionFieldForInput(field, name) {
  return field === name || field.startsWith(`${name}.`);
}

function conditionCell(input, token, choices, references) {
  const name = inputName(input);
  const label = inputLabel(input);
  const values = token.operator === 'IN' || token.operator === 'NOT IN' ? token.value.split(',').map((value) => value.trim()).filter(Boolean) : [token.value];
  const rendered = values.map((value) => formatDecisionValue(value, choices.get(`${name}\u0000${token.field}\u0000${value}`) || references.get(`${name}\u0000${value}`))).join(', ');
  return `${label} ${token.operator} ${rendered}`;
}

function choiceElement(field) {
  return field.slice(field.lastIndexOf('.') + 1);
}

function assertSafeReferenceId(value) {
  assertSafeExactMatch(value);
  const hasControlCharacter = value && [...value].some((character) => character.charCodeAt(0) < 32);
  const hasTraversalSegment = value === '.' || value === '..' || value.includes('../') || value.includes('..\\');
  if (value && (/[/?#\\]/.test(value) || hasControlCharacter || hasTraversalSegment || value.includes('%'))) {
    throw new Error('Unsafe identifier for exact-match lookup: contains URL path characters or traversal syntax. Refusing to fetch a reference record.');
  }
}

function assertSafeReferenceTable(value) {
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/.test(value)) {
    throw new Error('Unsafe reference table for lookup: contains invalid ServiceNow identifier characters. Refusing to fetch a reference record.');
  }
}

export async function inspectDecisionTable(app, table) {
  const sysId = unwrapSysId(table);
  const [inputs, questions] = await Promise.all([
    app.sdk.list('sys_decision_input', new URLSearchParams({ sysparm_query: `model=${sysId}^ORDERBYorder`, sysparm_display_value: 'all' })),
    app.sdk.list('sys_decision_question', new URLSearchParams({ sysparm_query: `decision_table=${sysId}^ORDERBYorder`, sysparm_display_value: 'all' })),
  ]);
  const choices = new Map();
  const references = new Map();
  for (const input of inputs) {
    const name = inputName(input);
    const referenceTable = getStringField(input, 'reference') || getStringField(input, 'reference_table');
    if (!name) continue;
    if (referenceTable) {
      assertSafeReferenceTable(referenceTable);
      references.set(name, referenceTable);
    }
  }
  const normalizedQuestions = questions.map((row) => {
    const objectRow = row && typeof row === 'object' ? row : {};
    const rawCondition = conditionOf(objectRow);
    const answer = answerOf(objectRow);
    return {
      ...objectRow,
      raw_question: row,
      malformed: !row || typeof row !== 'object' || !rawCondition,
      raw_condition: rawCondition,
      parsed_branches: parseConditionBranches(rawCondition),
      technical_answer: technicalAnswer(answer),
      display_answer: displayAnswer(answer),
      defaultAnswer: defaultOf(objectRow),
    };
  });
  for (const [name, referenceTable] of references) {
    const values = new Set();
    for (const row of normalizedQuestions) for (const branch of row.parsed_branches) for (const token of branch.tokens) {
      if (token.field === name && token.value) {
        for (const value of token.operator === 'IN' || token.operator === 'NOT IN' ? token.value.split(',') : [token.value]) {
          if (value.trim()) values.add(value.trim());
        }
      }
    }
    for (const value of values) {
      try {
        assertSafeReferenceId(value);
        const record = await app.sdk.get(referenceTable, value);
        const display = getStringField(record, 'name') || getStringField(record, 'label') || getStringField(record, 'number') || getStringField(record, 'sys_id');
        if (display) references.set(`${name}\u0000${value}`, display);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
  }
  for (const input of inputs) {
    const name = inputName(input);
    const sourceTable = getStringField(input, 'table') || getStringField(input, 'source_table') || getStringField(input, 'reference_table') || getStringField(input, 'reference');
    if (!name || !sourceTable) continue;
    assertSafeReferenceTable(sourceTable);
    const fields = new Set();
    for (const row of normalizedQuestions) for (const branch of row.parsed_branches) for (const token of branch.tokens) {
      if (token.field && conditionFieldForInput(token.field, name)) fields.add(token.field);
    }
    for (const field of fields) {
      const records = await app.sdk.list('sys_choice', new URLSearchParams({
        sysparm_query: `name=${sourceTable}^element=${choiceElement(field)}^language=en`,
        sysparm_display_value: 'all',
      }));
      for (const choice of records) choices.set(`${name}\u0000${field}\u0000${getStringField(choice, 'value')}`, getStringField(choice, 'label'));
    }
  }
  const matrix = [];
  for (const question of normalizedQuestions) {
    for (let branchIndex = 0; branchIndex < question.parsed_branches.length; branchIndex += 1) {
      const branch = question.parsed_branches[branchIndex];
      const tokenMap = new Map(branch.tokens.filter((t) => t.field).map((t) => [t.field, t]));
      matrix.push({
        question_sys_id: getStringField(question, 'sys_id'),
        branch: branchIndex + 1,
        condition: branch.raw,
        unparseable: branch.tokens.filter((token) => token.unparseable).map((token) => token.raw).join(' ^ '),
        values: inputs.map((input) => {
          const name = inputName(input);
          const token = [...tokenMap.values()].find((candidate) => conditionFieldForInput(candidate.field, name));
          if (!token) return question.malformed ? '[malformed question]' : '';
          if (token.unparseable) return `[unparseable: ${readableRaw(token.raw)}]`;
          return conditionCell(input, token, choices, references);
        }),
        answer: formatAnswer(answerOf(question)),
        default: formatDecisionValue(question.defaultAnswer),
        active: getStringField(question, 'active'),
        order: getStringField(question, 'order'),
      });
    }
  }
  const detail = { table, inputs, questions: normalizedQuestions, matrix };
  return addFormatted(detail, renderDecisionMatrix(detail, app.getEffectiveInstance?.() || ''));
}
