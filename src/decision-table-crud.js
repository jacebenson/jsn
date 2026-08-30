const INPUT_TYPE_RUNTIME = {
  String: 'string', Integer: 'integer', 'True/False': 'true/false', Choice: 'choice', Reference: 'reference', Date: 'date', 'Date/Time': 'date_time',
};
const ANSWER_TYPE_RUNTIME = {
  Boolean: 'boolean', Choice: 'choice', Currency: 'currency', Decimal: 'decimal', Due_date: 'due_date', Glide_date: 'glide_date', Glide_date_time: 'glide_date_time', Glide_duration: 'glide_duration', Integer: 'integer', Longint: 'longint', Reference: 'reference', String: 'string',
};
const INPUT_TYPES = new Set([...Object.keys(INPUT_TYPE_RUNTIME), ...Object.values(INPUT_TYPE_RUNTIME)]);
const ANSWER_TYPES = new Set([...Object.keys(ANSWER_TYPE_RUNTIME), ...Object.values(ANSWER_TYPE_RUNTIME)]);
const ACCESS = new Set(['package_private', 'public']);
const CHILD_KINDS = ['inputs', 'answerElements', 'inputChoices', 'answerElementChoices', 'conditions', 'questions'];

function fail(message) { throw new TypeError(`Invalid decision table payload: ${message}`); }
function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`); return value; }
function nonEmptyString(value, label) { if (typeof value !== 'string' || value.trim() === '') fail(`${label} is required`); return value; }
function rowId(value, label) { nonEmptyString(value, label); if (!/^[0-9a-f]{32}$/i.test(value)) fail(`${label} must be a 32-character hexadecimal sys_id`); return value; }
function deleting(row) { return row._delete || row.deleted || row.remove; }
const CREATE_FIELDS = {
  parent: ['accessibleFrom', 'name', 'scope'],
  input: ['label', 'maxsize', 'order', 'reference', 'type'],
  answerElement: ['label', 'maxsize', 'order', 'reference', 'type'],
  inputChoice: ['inputID', 'label', 'order', 'value'],
  answerElementChoice: ['answerElementID', 'label', 'order', 'value'],
  condition: ['decisionInput', 'defaultOperator', 'label', 'description', 'order'],
  question: ['active', 'answer', 'condition', 'defaultAnswer', 'order'],
};
const UPDATE_FIELDS = {
  parent: ['accessibleFrom', 'name'],
  input: ['active', 'defaultValue', 'label', 'mandatory', 'maxsize', 'order', 'readonly'],
  answerElement: ['comments', 'label', 'maxsize'],
  inputChoice: ['label', 'order', 'value'],
  answerElementChoice: ['label', 'order', 'value'],
  choice: ['label', 'order', 'value'],
  condition: ['defaultOperator', 'description', 'label'],
  question: ['active', 'answer', 'condition', 'defaultAnswer', 'label', 'order'],
};
function allowFields(row, label, kind, update) {
  const existing = update && Boolean(row.sys_id);
  const fields = existing ? UPDATE_FIELDS[kind] : CREATE_FIELDS[kind];
  const aliases = !existing && kind === 'inputChoice' ? ['input'] : (!existing && kind === 'answerElementChoice' ? ['answerElement'] : []);
  const allowed = new Set([...fields, 'sys_id', '_key', '_delete', 'deleted', 'remove', ...aliases]);
  for (const key of Object.keys(row)) if (!allowed.has(key)) fail(`${label}.${key} is not documented`);
}
function validateRow(row, label, required = [], kind, update = false) {
  object(row, label);
  allowFields(row, label, kind, update);
  if (deleting(row)) { rowId(row.sys_id, `${label}.sys_id`); return; }
  required.forEach((field) => nonEmptyString(row[field], `${label}.${field}`));
  if (row.sys_id != null) rowId(row.sys_id, `${label}.sys_id`);
}
function validateInput(row, i, update = false) {
  validateRow(row, `inputs[${i}]`, update && row.sys_id ? [] : ['label', 'type'], 'input', update);
  if (deleting(row)) return;
  if (row.type != null && !INPUT_TYPES.has(row.type)) fail(`inputs[${i}].type is not documented`);
  if (row.type === 'Reference' || row.type === 'reference') nonEmptyString(row.reference, `inputs[${i}].reference`);
  if (row.maxsize != null && (row.type !== 'String' && row.type !== 'string' || !Number.isInteger(row.maxsize) || row.maxsize < 0)) fail(`inputs[${i}].maxsize is only valid for String and must be a non-negative integer`);
  if (row.order != null && !Number.isInteger(row.order)) fail(`inputs[${i}].order must be an integer`);
}
function validateAnswer(row, i, update = false) {
  if (!update && row?.name != null) fail(`answerElements[${i}].name is unsupported over REST because it cannot be persisted safely`);
  validateRow(row, `answerElements[${i}]`, update && row.sys_id ? [] : ['label', 'type'], 'answerElement', update);
  if (deleting(row)) return;
  if (row.type != null && !ANSWER_TYPES.has(row.type)) fail(`answerElements[${i}].type is not documented`);
  if (row.type === 'Reference' || row.type === 'reference') nonEmptyString(row.reference, `answerElements[${i}].reference`);
  if (row.maxsize != null && (row.type !== 'String' && row.type !== 'string' || !Number.isInteger(row.maxsize) || row.maxsize < 0)) fail(`answerElements[${i}].maxsize is only valid for String and must be a non-negative integer`);
}
function validateQuestion(row, i, update = false) {
  validateRow(row, `questions[${i}]`, [], 'question', update);
  if (deleting(row)) return;
  if (row.condition != null && typeof row.condition !== 'string') fail(`questions[${i}].condition must be a string`);
  if (row.answer != null && !Array.isArray(row.answer)) fail(`questions[${i}].answer must be an array`);
  if (row.answer) row.answer.forEach((answer, j) => { object(answer, `questions[${i}].answer[${j}]`); if (answer.name != null && typeof answer.name !== 'string') fail(`questions[${i}].answer[${j}].name must be a string`); if (answer.value != null && typeof answer.value !== 'string') fail(`questions[${i}].answer[${j}].value must be a string`); });
  if (!update && (typeof row.active !== 'boolean' || typeof row.defaultAnswer !== 'boolean' || !Number.isInteger(row.order))) fail(`questions[${i}] requires active, defaultAnswer, and order`);
}
function validateChoice(row, label, ref, update = false) {
  const kind = ref === 'input' ? 'inputChoice' : 'answerElementChoice';
  validateRow(row, label, update ? [] : ['label', 'value'], kind, update);
  if (row[`${ref}ID`] != null) fail(`${label}.${ref}ID is unsupported; use ${ref} _key references instead`);
  if (!deleting(row) && (!update || !row.sys_id)) nonEmptyString(row[ref], `${label}.${ref}`);
}
function validateCondition(row, i, inputs, update = false) {
  validateRow(row, `conditions[${i}]`, update ? [] : ['decisionInput', 'label'], 'condition', update);
  if (!update && !/^[0-9a-f]{32}$/i.test(row.decisionInput) && !inputs.some((input) => input?._key === row.decisionInput)) fail(`conditions[${i}].decisionInput must be a 32-character hexadecimal sys_id or a declared input _key`);
}

export function parseDecisionTablePayload(input, { operation = 'create' } = {}) {
  let payload = input;
  if (typeof input === 'string') { try { payload = JSON.parse(input); } catch { fail('must contain valid JSON'); } }
  object(payload, 'payload');
  const allowedTopLevel = new Set(['parent', ...CHILD_KINDS, 'removals']);
  for (const key of Object.keys(payload)) if (!allowedTopLevel.has(key)) fail(`${key} is not documented`);
  const parent = object(payload.parent, 'parent');
  if (operation !== 'update') nonEmptyString(parent.name, 'parent.name');
  allowFields(parent, 'parent', 'parent', operation === 'update');
  if (parent.accessibleFrom != null && !ACCESS.has(parent.accessibleFrom)) fail('parent.accessibleFrom is not documented');
  if (parent.scope != null) nonEmptyString(parent.scope, 'parent.scope');
  for (const kind of CHILD_KINDS) if (payload[kind] != null && !Array.isArray(payload[kind])) fail(`${kind} must be an array`);
  const normalized = { ...payload };
  for (const kind of CHILD_KINDS) normalized[kind] = payload[kind] || [];
  normalized.inputs.forEach((row, i) => validateInput(row, i, operation === 'update'));
  normalized.answerElements.forEach((row, i) => validateAnswer(row, i, operation === 'update'));
  normalized.questions.forEach((row, i) => validateQuestion(row, i, operation === 'update'));
  normalized.inputChoices.forEach((row, i) => validateChoice(row, `inputChoices[${i}]`, 'input', operation === 'update'));
  normalized.answerElementChoices.forEach((row, i) => validateChoice(row, `answerElementChoices[${i}]`, 'answerElement', operation === 'update'));
  normalized.conditions.forEach((row, i) => validateCondition(row, i, normalized.inputs, operation === 'update'));
  if (payload.removals != null) {
    object(payload.removals, 'removals');
    for (const kind of CHILD_KINDS) if (payload.removals[kind] != null) { if (!Array.isArray(payload.removals[kind])) fail(`removals.${kind} must be an array`); payload.removals[kind].forEach((id, i) => rowId(id, `removals.${kind}[${i}]`)); }
  }
  normalized.removals = Object.fromEntries(CHILD_KINDS.map((kind) => [kind, payload.removals?.[kind] || []]));
  return structuredClone(normalized);
}

function exactSysId(record, label) {
  const value = record?.sys_id;
  const id = value && typeof value === 'object' ? value.value : value;
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/i.test(id)) throw new Error(`ServiceNow returned an invalid ${label} sys_id.`);
  return id;
}
function persistedValue(value) { return value && typeof value === 'object' ? (value.value ?? value.display_value) : value; }
function validatePersistedFields(record, body, label, expectedId) {
  const actualId = exactSysId(record, label);
  if (expectedId && actualId.toLowerCase() !== expectedId.toLowerCase()) throw new Error(`ServiceNow returned the wrong ${label} sys_id on readback.`);
  for (const [field, expected] of Object.entries(body)) if (persistedValue(record?.[field]) === undefined || String(persistedValue(record[field])) !== String(expected)) throw new Error(`ServiceNow did not persist ${label} field ${field} as requested.`);
}
function restParentBody(parent, scope) { const body = { name: parent.name, access: parent.accessibleFrom || 'package_private' }; const effectiveScope = scope || parent.scope; if (effectiveScope && effectiveScope !== 'global') body.sys_scope = effectiveScope; return body; }
function restInputBody(input, parentId) { const body = { model: parentId, label: input.label }; if (input.type != null) body.internal_type = INPUT_TYPE_RUNTIME[input.type] || input.type; if (input.maxsize != null) body.max_length = input.maxsize; if (input.order != null) body.order = input.order; if (input.reference != null) body.reference = input.reference; return body; }
function restAnswerElementBody(input, parentId) { const body = { model: parentId, label: input.label }; if (input.type != null) body.internal_type = ANSWER_TYPE_RUNTIME[input.type] || input.type; if (input.maxsize != null) body.max_length = input.maxsize; if (input.order != null) body.order = input.order; if (input.reference != null) body.reference = input.reference; return body; }
function normalizedAnswerElementField(label, id) { const normalized = label.toLowerCase().replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, ''); if (!normalized) throw new Error(`ServiceNow returned a blank answer element element for ${id}, and its label is unusable for fallback mapping.`); return `u_${normalized}`; }
function answerElementField(record, field, id, fallbackLabel) { const value = record?.[field]; const unwrapped = persistedValue(value); if (typeof unwrapped === 'string' && unwrapped.trim()) return unwrapped; if (field === 'element' && fallbackLabel != null) return normalizedAnswerElementField(fallbackLabel, id); throw new Error(`ServiceNow did not return answer element ${id} ${field} on readback.`); }
function restInputChoiceBody(choice, input) { const body = { name: input.name, element: input.element, label: choice.label, value: choice.value }; if (choice.order != null) body.sequence = choice.order; return body; }
function restAnswerElementChoiceBody(choice, input) { const body = { name: input.name, element: input.element, label: choice.label, value: choice.value }; if (choice.order != null) body.sequence = choice.order; return body; }
function restConditionBody(condition, parentId, inputId) { const body = { decision_table: parentId, decision_input: inputId, label: condition.label }; if (condition.defaultOperator != null) body.default_operator = condition.defaultOperator; if (condition.description != null) body.description = condition.description; if (condition.order != null) body.order = condition.order; return body; }
function unsupportedCreateChildren(payload) { if (payload.questions.length) throw new Error('Decision table REST mutation has unsupported child kinds: questions.'); }
function isNotFoundError(error) { return error?.status === 404 || error?.code === 404 || error?.code === '404'; }

export class DecisionTableCRUD {
  constructor(sdk, { scope = '' } = {}) { this.sdk = sdk; this.scope = scope; }

  async createViaRest(document) {
    const payload = parseDecisionTablePayload(document, { operation: 'create' });
    unsupportedCreateChildren(payload);
    if (this.scope && payload.parent.scope && payload.parent.scope !== this.scope) throw new Error('Decision table create parent.scope must match the authenticated execution scope.');
    const created = [];
    try {
      const parentBody = restParentBody(payload.parent, this.scope);
      const parentRecord = await this.sdk.create('sys_decision', parentBody);
      const parentId = exactSysId(parentRecord, 'decision table');
      created.push({ table: 'sys_decision', id: parentId });
      const parent = await this.sdk.get('sys_decision', parentId);
      if (!parent) throw new Error('ServiceNow did not return the created decision table on readback.');
      validatePersistedFields(parent, parentBody, 'decision table', parentId);
      const inputs = [];
      const inputMap = new Map();
      for (const input of payload.inputs) {
        const body = restInputBody(input, parentId);
        const record = await this.sdk.create('sys_decision_input', body);
        const id = exactSysId(record, 'decision input');
        created.push({ table: 'sys_decision_input', id });
        const readback = await this.sdk.get('sys_decision_input', id);
        if (!readback) throw new Error(`ServiceNow did not return decision input ${id} on readback.`);
        validatePersistedFields(readback, body, 'decision input', id);
        const mapped = payload.inputChoices.some((choice) => choice.input === input._key) ? { ...readback, name: answerElementField(readback, 'name', id), element: answerElementField(readback, 'element', id, input.label) } : readback;
        inputs.push(mapped);
        if (input._key) inputMap.set(input._key, { ...mapped, sys_id: id });
      }
      const inputChoices = [];
      for (const choice of payload.inputChoices) {
        const input = choice.input ? inputMap.get(choice.input) : null;
        if (!input) throw new Error(`Decision table create inputChoices requires input _key; unknown key: ${choice.input ?? choice.inputID}.`);
        const body = restInputChoiceBody(choice, input);
        const record = await this.sdk.create('sys_choice', body);
        const id = exactSysId(record, 'input choice');
        created.push({ table: 'sys_choice', id });
        const readback = await this.sdk.get('sys_choice', id);
        if (!readback) throw new Error(`ServiceNow did not return input choice ${id} on readback.`);
        validatePersistedFields(readback, body, 'input choice', id);
        inputChoices.push(readback);
      }
      const conditions = [];
      for (const condition of payload.conditions) {
        const input = inputMap.get(condition.decisionInput);
        const inputId = input?.sys_id || condition.decisionInput;
        const body = restConditionBody(condition, parentId, inputId);
        const record = await this.sdk.create('sn_decision_table_decision_condition', body);
        const conditionId = exactSysId(record, 'decision condition');
        created.push({ table: 'sn_decision_table_decision_condition', id: conditionId });
        const readback = await this.sdk.get('sn_decision_table_decision_condition', conditionId);
        if (!readback) throw new Error(`ServiceNow did not return decision condition ${conditionId} on readback.`);
        validatePersistedFields(readback, body, 'decision condition', conditionId);
        conditions.push(readback);
      }
      const answerElements = [];
      const answerElementMap = new Map();
      for (const answerElement of payload.answerElements) {
        const body = restAnswerElementBody(answerElement, parentId);
        const record = await this.sdk.create('sys_decision_multi_result_element', body);
        const id = exactSysId(record, 'answer element');
        created.push({ table: 'sys_decision_multi_result_element', id });
        const readback = await this.sdk.get('sys_decision_multi_result_element', id);
        if (!readback) throw new Error(`ServiceNow did not return answer element ${id} on readback.`);
        validatePersistedFields(readback, body, 'answer element', id);
        const mapped = { ...readback, name: answerElementField(readback, 'name', id), element: answerElementField(readback, 'element', id, answerElement.label) };
        answerElements.push(mapped);
        if (answerElement._key) answerElementMap.set(answerElement._key, { ...mapped, sys_id: id });
      }
      const answerElementChoices = [];
      for (const choice of payload.answerElementChoices) {
        const answerElement = choice.answerElement ? answerElementMap.get(choice.answerElement) : null;
        if (!answerElement) throw new Error(`Decision table create answerElementChoices requires answerElement _key; unknown key: ${choice.answerElement ?? choice.answerElementID}.`);
        const body = restAnswerElementChoiceBody(choice, answerElement);
        const record = await this.sdk.create('sys_choice', body);
        const id = exactSysId(record, 'answer-element choice');
        created.push({ table: 'sys_choice', id });
        const readback = await this.sdk.get('sys_choice', id);
        if (!readback) throw new Error(`ServiceNow did not return answer-element choice ${id} on readback.`);
        validatePersistedFields(readback, body, 'answer-element choice', id);
        answerElementChoices.push(readback);
      }
      return { status: 'Success', parent, inputs, inputChoices, conditions, answerElements, answerElementChoices };
    } catch (error) {
      const rollbackFailures = [];
      for (const record of [...created].reverse()) {
        try {
          await this.sdk.delete(record.table, record.id);
          try {
            if (await this.sdk.get(record.table, record.id)) rollbackFailures.push(true);
          } catch (readbackError) {
            if (!isNotFoundError(readbackError)) rollbackFailures.push(readbackError);
          }
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      }
      if (rollbackFailures.length) throw new Error('Decision table create failed and rollback could not be verified.', { cause: error });
      if (error instanceof TypeError && error.message.startsWith('Invalid decision table payload:')) throw error;
      if (error instanceof Error && error.message.startsWith('Decision table create')) throw error;
      throw new Error('Decision table create failed; created records were rolled back by exact sys_id.', { cause: error });
    }
  }

  async update(_id, document) {
    const payload = parseDecisionTablePayload(document, { operation: 'update' });
    if (payload.questions.length) throw new Error('Decision table update does not support questions over REST.');
    throw new Error('Decision table update is intentionally unsupported over REST until complete graph support can be verified safely.');
  }

  async delete(id) {
    rowId(id, 'decision table sys_id');
    if (typeof this.sdk.delete !== 'function' || typeof this.sdk.get !== 'function') throw new Error('Decision table delete requires Table API delete and readback support.');
    try {
      await this.sdk.delete('sys_decision', id);
      try {
        const remaining = await this.sdk.get('sys_decision', id);
        if (remaining) throw new Error(`ServiceNow still returned decision table ${id} after deletion.`);
      } catch (readbackError) {
        if (!isNotFoundError(readbackError)) throw readbackError;
      }
      return { status: 'Success', sys_id: id };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('ServiceNow still returned')) throw error;
      throw new Error('Decision table delete failed; deletion could not be verified.', { cause: error });
    }
  }

  create(document) { return this.createViaRest(document); }
}
