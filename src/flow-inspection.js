import { getStringField } from './helpers.js';

/**
 * Inspect a flow through the narrow remote adapter and render its deep view.
 * The adapter only needs inspectFlow and inspectCustomAction.
 */
export async function inspectFlow({ adapter, identifier, instanceURL = '', depth = 2 }) {
  if (!adapter || typeof adapter.inspectFlow !== 'function') {
    throw new TypeError('flow inspection adapter must provide inspectFlow');
  }
  const inspection = await adapter.inspectFlow(identifier);
  const normalizedDepth = Math.max(1, Math.floor(depth ?? 2));
  const ctx = {
    sdk: adapter,
    instanceURL,
    depth: normalizedDepth,
    visited: new Set([inspection.flow?.sysID]),
  };
  const formatted = await formatFlowInspection(inspection, ctx);
  return { ...inspection, _formatted: formatted };
}

export async function formatFlowInspection(inspection, ctx) {
  const lines = [];
  const instanceURL = ctx?.instanceURL || '';
  const flow = inspection.flow;

  lines.push('');
  lines.push(`Flow: ${flow.name}`);
  lines.push('');

  const status = flow.active ? 'Active' : 'Inactive';
  let version = flow.version || inferFlowVersion(inspection);
  lines.push(`  Status: ${status} | Version: ${version}`);
  lines.push(`  Sys ID: ${flow.sysID}`);
  if (instanceURL && flow.sysID) {
    lines.push(`  Link: ${instanceURL}/sys_hub_flow.do?sys_id=${flow.sysID}`);
  }

  // Flow variables section
  if (inspection.flowVariables && inspection.flowVariables.length > 0) {
    const vars = [...inspection.flowVariables].sort((a, b) => {
      const ao = parseInt(getStringField(a, 'order'), 10) || 0;
      const bo = parseInt(getStringField(b, 'order'), 10) || 0;
      return ao - bo;
    });
    lines.push('');
    lines.push('▶ FLOW VARIABLES');
    lines.push('─'.repeat(50));
    for (const v of vars) {
      const name = firstNonEmpty(getStringField(v, 'label'), getStringField(v, 'name'), 'Variable');
      const typeName = firstNonEmpty(getStringField(v, 'type_label'), getStringField(v, 'type'), '');
      if (typeName) {
        lines.push(`  • ${name}: ${typeName}`);
      } else {
        lines.push(`  • ${name}`);
      }
    }
  }

  // Subflow I/O section
  if (flow.type && flow.type.toLowerCase() === 'subflow') {
    lines.push('');
    lines.push('▶ SUBFLOW');
    lines.push('─'.repeat(50));

    if (inspection.flowInputs && inspection.flowInputs.length > 0) {
      lines.push(`  Inputs (${inspection.flowInputs.length})`);
      for (const input of inspection.flowInputs) {
        const name = firstNonEmpty(getStringField(input, 'label'), getStringField(input, 'name'), 'Input');
        const typeName = getStringField(input, 'type');
        if (typeName) {
          lines.push(`    • ${name}: ${typeName}`);
        } else {
          lines.push(`    • ${name}`);
        }
      }
    }

    if (inspection.flowOutputs && inspection.flowOutputs.length > 0) {
      if (inspection.flowInputs && inspection.flowInputs.length > 0) {
        lines.push('');
      }
      lines.push(`  Outputs (${inspection.flowOutputs.length})`);
      for (const out of inspection.flowOutputs) {
        const name = firstNonEmpty(getStringField(out, 'label'), getStringField(out, 'name'), 'Output');
        const typeName = getStringField(out, 'type');
        if (typeName) {
          lines.push(`    • ${name}: ${typeName}`);
        } else {
          lines.push(`    • ${name}`);
        }
      }
    }
  }

  // Trigger section
  const { name: triggerName, type: triggerType, table: triggerTable, time: triggerTime, condition: triggerCondition } = extractTriggerDetails(inspection);
  if (triggerName || triggerType || triggerTable || triggerTime || triggerCondition) {
    lines.push('');
    lines.push('▶ TRIGGER');
    lines.push('─'.repeat(50));
    if (triggerName) lines.push(`  Name: ${triggerName}`);
    if (triggerType) lines.push(`  Type: ${titleCase(triggerType.replace(/_/g, ' '))}`);
    if (triggerTable) lines.push(`  Table: ${triggerTable}`);
    if (triggerTime) lines.push(`  Time: ${triggerTime}`);
    if (triggerCondition) lines.push(`  Condition: ${formatTriggerCondition(triggerCondition)}`);
  }

  // Flow structure section
  lines.push('');
  lines.push('⚡ FLOW STRUCTURE');
  lines.push('─'.repeat(50));
  const structureLines = await formatFlowStructure(inspection, ctx);
  lines.push(...structureLines);
  // Note limitation only when we couldn't reconstruct detail from the payload OR the gzip fallback
  const hasPayload = inspection.payload && Object.keys(inspection.payload).length > 0;
  const hasDecodedLogic = (inspection.flowLogicInstances || []).some(l => l._decodedValues);
  if (!hasPayload && !hasDecodedLogic) {
    lines.push('');
    lines.push('  (step detail limited — no flow definition data available)');
  }

  lines.push('');
  return lines.join('\n') + '\n';
}

function extractTriggerDetails(inspection) {
  let name = '';
  let type = '';
  let table = '';
  let time = '';
  let condition = '';

  if (inspection.version && typeof inspection.version === 'object') {
    name = getStringField(inspection.version, 'trigger_name');
    type = getStringField(inspection.version, 'trigger_type');
    table = getStringField(inspection.version, 'trigger_table');
    time = getStringField(inspection.version, 'trigger_time');
  }

  if ((!name || !type || !table || !time || !condition) && Object.keys(inspection.payload).length > 0) {
    const triggers = inspection.payload.triggerInstances;
    if (Array.isArray(triggers) && triggers.length > 0) {
      const trigger = triggers[0];
      if (trigger && typeof trigger === 'object') {
        name = firstNonEmpty(name, getStringField(trigger, 'name'));
        type = firstNonEmpty(type, getStringField(trigger, 'type'));
        if (Array.isArray(trigger.inputs)) {
          for (const input of trigger.inputs) {
            if (!input || typeof input !== 'object') continue;
            const k = getStringField(input, 'name');
            const v = firstNonEmpty(getStringField(input, 'displayValue'), getStringField(input, 'value'));
            if (k === 'table') table = firstNonEmpty(table, v);
            if (k === 'time') time = firstNonEmpty(time, v);
            if (k === 'condition') condition = firstNonEmpty(condition, v);
          }
        }
      }
    }
  }

  if (!name && inspection.triggerInstances && inspection.triggerInstances.length > 0) {
    const first = inspection.triggerInstances[0];
    name = firstNonEmpty(name, getStringField(first, 'name'), getStringField(first, 'display_text'), getNestedString(first, 'trigger_definition', 'display_value'));
    type = firstNonEmpty(type, getStringField(first, 'trigger_type'), getNestedString(first, 'trigger_definition', 'display_value'));
  }

  if (time.includes(' ')) {
    const parts = time.split(' ');
    if (parts.length === 2) {
      time = parts[1];
    }
  }

  return { name, type, table, time, condition };
}

function inferFlowVersion(inspection) {
  if (Object.keys(inspection.payload).length > 0) return 'Unset (Assumed V1)';
  if (inspection.actionInstances && inspection.actionInstances.length > 0) return 'Unset (Assumed V1)';
  return 'Unset';
}

async function formatFlowStructure(inspection, ctx) {
  const names = await collectCatalogVarNames(inspection, ctx);
  if (names.size > 0) {
    if (!ctx.catalogVarNames) ctx.catalogVarNames = new Map();
    for (const [k, v] of names) ctx.catalogVarNames.set(k, v);
  }
  const labelCache = buildLabelCache(inspection.payload);
  if (labelCache.size > 0) {
    if (!ctx.labelCache) ctx.labelCache = new Map();
    for (const [k, v] of labelCache) ctx.labelCache.set(k, v);
  }
  const payload = inspection.payload;
  if (Object.keys(payload).length > 0) {
    return formatFlowStructureFromPayload(payload, ctx);
  }
  return formatFlowStructureFallback(inspection);
}

/**
 * The ProcessFlow payload carries a label cache (also serialized as
 * labelCacheAsJsonString) mapping data-pill names like "<step-uid>.<var>"
 * to the human labels the Flow Designer UI shows, e.g.
 * "1 - Get Catalog Variables➛session_title". Build a Map so guid-prefixed
 * pills can be rendered readably.
 */
function buildLabelCache(payload) {
  const cache = new Map();
  if (!payload || typeof payload !== 'object') return cache;
  let entries = payload.label_cache;
  if (!Array.isArray(entries)) {
    try {
      entries = JSON.parse(payload.labelCacheAsJsonString || '[]');
    } catch {
      entries = [];
    }
  }
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const name = getStringField(e, 'name');
    const label = getStringField(e, 'label');
    if (name && label) cache.set(name, label);
  }
  return cache;
}

const GUID_PILL_RE = /\{\{([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([^}]+)\}\}/g;

/**
 * Replace opaque guid-prefixed pills ({{<32-hex-guid>.<var>}}) with their
 * human label from the payload's label cache. Readable step refs like
 * {{Created_1.table_name}} are NOT matched and stay raw.
 */
function resolveGuidPills(value, labelCache) {
  if (!labelCache || labelCache.size === 0 || !value) return value;
  return String(value).replace(GUID_PILL_RE, (m, guid, name) => {
    const label = labelCache.get(`${guid}.${name}`);
    return label ? `{{${label}}}` : m;
  });
}

/**
 * ServiceNow serializes catalog variable selections in action inputs as
 * comma-separated "sys_id:table" pairs (e.g. Get Catalog Variables / Create
 * Catalog Task steps). The payload carries the source table on the parameter
 * attributes, but the value itself also names it in each token. Resolve those
 * sys_ids to readable labels (question_text, falling back to name) with one
 * batched Table API query per distinct table.
 */
async function collectCatalogVarNames(inspection, ctx) {
  const names = new Map();
  if (!ctx?.sdk) return names;

  const refs = new Map(); // table -> Set<sys_id>
  const TOKEN_RE = /([0-9a-f]{32}):([a-z_]+)/g;

  function addRefsFromValue(value) {
    if (!value) return;
    for (const m of String(value).matchAll(TOKEN_RE)) {
      const [, id, table] = m;
      if (!refs.has(table)) refs.set(table, new Set());
      refs.get(table).add(id);
    }
  }

  function walk(items) {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      if (Array.isArray(item.inputs)) {
        for (const input of item.inputs) {
          if (!input || typeof input !== 'object') continue;
          addRefsFromValue(firstNonEmpty(getStringField(input, 'displayValue'), getStringField(input, 'value')));
        }
      }
      if (Array.isArray(item.flowBlock)) walk(item.flowBlock);
    }
  }

  const payload = inspection?.payload;
  if (payload && typeof payload === 'object') {
    walk(payload.actionInstances);
    if (Array.isArray(payload.flowLogicInstances)) {
      for (const logic of payload.flowLogicInstances) walk(logic?.flowBlock);
    }
  }
  // Fallback table sources may also carry inputs (e.g. decoded logic values)
  walk(inspection?.actionInstances);
  if (Array.isArray(inspection?.flowLogicInstances)) {
    for (const logic of inspection.flowLogicInstances) {
      if (logic?._decodedValues?.inputs) {
        for (const input of logic._decodedValues.inputs) {
          if (!input || typeof input !== 'object') continue;
          addRefsFromValue(firstNonEmpty(getStringField(input, 'displayValue'), getStringField(input, 'value')));
        }
      }
    }
  }

  for (const [table, ids] of refs) {
    const idList = [...ids];
    for (let i = 0; i < idList.length; i += 100) {
      const chunk = idList.slice(i, i + 100);
      try {
        const params = new URLSearchParams();
        params.set('sysparm_query', `sys_idIN${chunk.join(',')}`);
        params.set('sysparm_fields', 'sys_id,name,question_text');
        params.set('sysparm_display_value', 'all');
        params.set('sysparm_limit', String(chunk.length));
        const records = await ctx.sdk.list(table, params);
        for (const r of records) {
          const id = getStringField(r, 'sys_id');
          const label = firstNonEmpty(getStringField(r, 'question_text'), getStringField(r, 'name'));
          if (id && label) names.set(id, label);
        }
      } catch {
        // resolution failed (no access, deleted record) — leave raw sys_ids
      }
    }
  }

  return names;
}

/**
 * Replace catalog variable "sys_id:table" pairs with readable labels when the
 * resolver map has them. Returns null when the value isn't a catalog-variable
 * list (so callers keep rendering it raw).
 */
function resolveCatalogVarValue(value, catalogVarNames) {
  if (!catalogVarNames || catalogVarNames.size === 0 || !value) return null;
  const trimmed = String(value).trim();
  if (!/^([0-9a-f]{32}:[a-z_]+)(,[0-9a-f]{32}:[a-z_]+)*,?$/.test(trimmed)) return null;
  return String(value).replace(/([0-9a-f]{32}):[a-z_]+/g, (m, id) => {
    const label = catalogVarNames.get(id);
    return label || m;
  });
}

async function formatFlowStructureFromPayload(payload, ctx) {
  const childUIDs = new Set();

  function markChildren(items) {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const uid = getStringField(item, 'uiUniqueIdentifier');
      if (uid) childUIDs.add(uid);
      if (Array.isArray(item.flowBlock)) {
        markChildren(item.flowBlock);
      }
    }
  }

  if (Array.isArray(payload.flowLogicInstances)) {
    for (const logic of payload.flowLogicInstances) {
      if (!logic || typeof logic !== 'object') continue;
      if (Array.isArray(logic.flowBlock)) {
        markChildren(logic.flowBlock);
      }
    }
  }

  const roots = [];

  function addFromPayload(key, stepType) {
    const items = payload[key];
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const uid = getStringField(item, 'uiUniqueIdentifier');
      if (uid && childUIDs.has(uid)) continue;
      roots.push({ stepType, data: item, order: parseOrderField(item) });
    }
  }

  addFromPayload('actionInstances', 'action');
  addFromPayload('subFlowInstances', 'subflow');
  addFromPayload('flowLogicInstances', 'logic');

  roots.sort((a, b) => a.order - b.order);

  if (roots.length === 0) {
    return ['  (no steps found)'];
  }

  const lines = [];
  let stepNum = 1;

  async function walk(steps, indent) {
    for (const step of steps) {
      const pad = '    '.repeat(indent);
      lines.push(...await formatStepLine(stepNum, pad, step, ctx));
      stepNum++;

      if (step.stepType !== 'logic') continue;
      const block = step.data.flowBlock;
      if (!Array.isArray(block) || block.length === 0) continue;

      const children = [];
      for (const raw of block) {
        if (!raw || typeof raw !== 'object') continue;
        children.push({
          stepType: classifyPayloadItem(raw),
          data: raw,
          order: parseOrderField(raw),
        });
      }
      children.sort((a, b) => a.order - b.order);
      await walk(children, indent + 1);
    }
  }

  await walk(roots, 0);
  return lines;
}

function formatFlowStructureFallback(inspection) {
  const steps = [];

  if (inspection.actionInstances) {
    for (const action of inspection.actionInstances) {
      const name = firstNonEmpty(
        getNestedString(action, 'action_type', 'display_value'),
        getStringField(action, 'name'),
        getStringField(action, 'display_text'),
        'Action',
      );
      steps.push({ order: parseOrderField(action), text: name, comment: getStringField(action, 'comment') });
    }
  }

  if (inspection.flowLogicInstances) {
    for (const logic of inspection.flowLogicInstances) {
      const name = firstNonEmpty(
        getNestedString(logic, 'logic_definition', 'display_value'),
        getStringField(logic, 'name'),
        getStringField(logic, 'display_text'),
        'Logic',
      );
      steps.push({
        order: parseOrderField(logic),
        text: name,
        comment: getStringField(logic, 'comment'),
        decoded: logic._decodedValues || null,
      });
    }
  }

  if (inspection.subFlowInstances) {
    for (const sf of inspection.subFlowInstances) {
      const name = firstNonEmpty(
        getNestedString(sf, 'subflow', 'display_value'),
        getStringField(sf, 'name'),
        getStringField(sf, 'display_text'),
        'Subflow',
      );
      steps.push({ order: parseOrderField(sf), text: '↪ ' + name });
    }
  }

  steps.sort((a, b) => a.order - b.order);

  if (steps.length === 0) {
    return ['  (no steps found)'];
  }

  const lines = [];
  steps.forEach((step, i) => {
    const num = `${i + 1}.`;
    // Decoded gzip values carry the same input detail as a V2 payload
    if (step.decoded && (step.text === 'If' || step.text === 'Else If')) {
      let condition = '';
      let conditionLabel = '';
      if (Array.isArray(step.decoded.inputs)) {
        for (const raw of step.decoded.inputs) {
          if (!raw || typeof raw !== 'object') continue;
          const inputName = getStringField(raw, 'name');
          if (inputName === 'condition') {
            condition = firstNonEmpty(getStringField(raw, 'displayValue'), getStringField(raw, 'value'));
          }
          if (inputName === 'condition_name') {
            conditionLabel = firstNonEmpty(getStringField(raw, 'displayValue'), getStringField(raw, 'value'));
          }
        }
      }
      let displayText = step.text;
      if (conditionLabel) {
        displayText = `${step.text}: ${conditionLabel}`;
      } else if (condition && condition.length < 60) {
        displayText = `${step.text}: ${condition}`;
      }
      lines.push(`  ${num} ${displayText}`);
      if (condition && condition.length >= 60 && !conditionLabel) {
        lines.push(`     Condition: ${condition}`);
      }
    } else if (step.decoded && step.text === 'Set Flow Variables') {
      lines.push(`  ${num} ${step.text}`);
      const vars = step.decoded.variables || step.decoded.flowVariables;
      if (Array.isArray(vars) && vars.length > 0) {
        lines.push(`     Variables Set:`);
        for (const raw of vars) {
          if (!raw || typeof raw !== 'object') continue;
          const varName = getStringField(raw, 'name');
          const varValue = firstNonEmpty(getStringField(raw, 'displayValue'), getStringField(raw, 'value'));
          if (!varName) continue;
          lines.push(varValue ? `       • ${varName} = ${varValue}` : `       • ${varName}`);
        }
      }
    } else {
      lines.push(`  ${num} ${step.text}`);
    }
    if (step.comment) {
      lines.push(`     Annotation: ${step.comment}`);
    }
  });

  return lines;
}

async function formatStepLine(stepNum, pad, step, ctx) {
  switch (step.stepType) {
    case 'logic':
      return formatLogicStep(stepNum, pad, step.data);
    case 'subflow':
      return formatSubFlowStep(stepNum, pad, step.data, ctx);
    default:
      return formatActionStepWithChildren(stepNum, pad, step.data, ctx);
  }
}

async function formatActionStepWithChildren(stepNum, pad, action, ctx) {
  const lines = formatActionStep(stepNum, pad, action, ctx);
  const depth = ctx?.depth ?? 1;
  if (!ctx?.sdk?.inspectCustomAction || depth <= 1) return lines;

  const actionName = getActionName(action);
  if (!actionName) return lines;

  if (!ctx.customActionCache) ctx.customActionCache = new Map();
  if (!ctx.customActionCache.has(actionName)) {
    ctx.customActionCache.set(actionName, ctx.sdk.inspectCustomAction(actionName).catch(() => null));
  }
  const details = await ctx.customActionCache.get(actionName);
  const steps = details?.steps;
  if (!Array.isArray(steps) || steps.length === 0 || !hasUsefulActionSteps(actionName, steps)) return lines;

  lines.push(`${pad}   ↳ Internal action steps`);
  const ordered = [...steps].sort((a, b) => parseOrderField(a) - parseOrderField(b));
  ordered.forEach((step, index) => {
    const label = firstNonEmpty(getStringField(step, 'label'), getStringField(step, 'name'), 'Action step');
    const type = getNestedString(step, 'step_type', 'display_value') || getStringField(step, 'step_type');
    const suffix = type ? ` - ${type}` : '';
    lines.push(`${pad}      Step ${index + 1}: ${label}${suffix}`);
    appendStepValues(lines, pad + '         ', step, ctx);
  });
  return lines;
}

function hasUsefulActionSteps(actionName, steps) {
  if (steps.length !== 1) return true;
  const step = steps[0];
  const label = firstNonEmpty(getStringField(step, 'label'), getStringField(step, 'name'))
    .replace(/\s+step$/i, '').trim().toLowerCase();
  return label !== actionName.trim().toLowerCase();
}

function appendStepValues(lines, pad, step, ctx) {
  for (const field of ['inputs', 'outputs', 'extended_inputs', 'extended_outputs']) {
    const value = getStringField(step, field);
    if (!value) continue;
    const resolved = resolveGuidPills(value, ctx?.labelCache);
    for (const part of resolved.split('^')) {
      if (part) lines.push(`${pad}${field}: ${part}`);
    }
  }
}

function getActionName(action) {
  return firstNonEmpty(
    getNestedString(action, 'actionType', 'fName'),
    getStringField(action, 'actionName'),
    getStringField(action, 'actionInternalName'),
    getStringField(action, 'name'),
  );
}

export function formatActionStep(stepNum, pad, action, ctx) {
  const lines = [];
  let actionName = firstNonEmpty(
    getNestedString(action, 'actionType', 'fName'),
    getStringField(action, 'actionName'),
    getStringField(action, 'actionInternalName'),
    getStringField(action, 'name'),
    'Unknown Action',
  );

  const idx = actionName.indexOf(' : ');
  if (idx > 0) {
    actionName = actionName.slice(idx + 3).trim();
  }

  let tableName = '';
  if (Array.isArray(action.inputs)) {
    for (const raw of action.inputs) {
      if (!raw || typeof raw !== 'object') continue;
      if (getStringField(raw, 'name') === 'table_name') {
        tableName = firstNonEmpty(getStringField(raw, 'displayValue'), getStringField(raw, 'value'));
        break;
      }
    }
  }

  const showsTableSuffix = tableName && (actionName === 'Update Record' || actionName === 'Create or Update Record');
  let actionDisplay = actionName;
  if (showsTableSuffix) {
    actionDisplay = actionName + ' - ' + tableName;
  }

  const comment = firstNonEmpty(getStringField(action, 'comment'), getStringField(action, 'displayText'));
  if (comment) {
    lines.push(`${pad}${stepNum}. ${actionDisplay} (${comment})`);
  } else {
    lines.push(`${pad}${stepNum}. ${actionDisplay}`);
  }

  if (Array.isArray(action.inputs)) {
    for (const raw of action.inputs) {
      if (!raw || typeof raw !== 'object') continue;
      const inputName = getStringField(raw, 'name');
      if (inputName === 'table_name' && showsTableSuffix) continue;

      let inputValue = firstNonEmpty(getStringField(raw, 'displayValue'), getStringField(raw, 'value'));

      // Catalog variable selections arrive as "sys_id:table" pairs; resolve
      // them to readable names when we have a resolver map (built per flow).
      const resolvedCatalog = resolveCatalogVarValue(inputValue, ctx?.catalogVarNames);
      if (resolvedCatalog) inputValue = resolvedCatalog;

      // Opaque guid-prefixed pills ({{<32-hex>.<var>}}) get their human
      // label from the payload's label cache. Readable step refs stay raw.
      inputValue = resolveGuidPills(inputValue, ctx?.labelCache);

      let label = inputName;
      if (raw.parameter && typeof raw.parameter === 'object') {
        label = firstNonEmpty(getStringField(raw.parameter, 'label'), label);
      }

      if (!inputValue) {
        lines.push(`${pad}    ${label}: (not set)`);
        continue;
      }

      // ServiceNow writes multi-field payloads (encoded-query style) as
      // "field=value^field2=value2". Split those onto one line per field;
      // plain long strings stay on a single line, untruncated.
      if (inputValue.includes('^')) {
        for (const field of inputValue.split('^')) {
          if (field) lines.push(`${pad}    ${label}: ${field}`);
        }
      } else {
        lines.push(`${pad}    ${label}: ${inputValue}`);
      }
    }
  }

  return lines;
}

export async function formatSubFlowStep(stepNum, pad, subFlow, ctx) {
  const lines = [];
  const subFlowName = firstNonEmpty(
    getNestedString(subFlow, 'subFlowType', 'fName'),
    getStringField(subFlow, 'subFlowName'),
    getStringField(subFlow, 'subFlowInternalName'),
    getNestedString(subFlow, 'subFlow', 'name'),
    getStringField(subFlow, 'name'),
    'Unknown Subflow',
  );

  const comment = getStringField(subFlow, 'comment');
  if (comment) {
    lines.push(`${pad}${stepNum}. ↪ ${subFlowName} (${comment})`);
  } else {
    lines.push(`${pad}${stepNum}. ↪ ${subFlowName}`);
  }

  // Recurse into the subflow when depth allows and we haven't already seen it.
  // Note: `subflowSysId` on the instance is a snapshot id (sys_hub_flow_snapshot),
  // NOT the flow id. The embedded `subFlow.parentFlow` is the real flow sys_id.
  const subflowSysId = firstNonEmpty(
    getNestedString(subFlow, 'subFlow', 'parentFlow'),
    getStringField(subFlow, 'subflowSysId'),
    getNestedString(subFlow, 'subFlow', 'sys_id'),
    getStringField(subFlow, 'sys_id'),
  );
  const depth = ctx?.depth ?? 1;
  const canRecurse = ctx?.sdk && subflowSysId && depth > 1 && !ctx.visited.has(subflowSysId);

  if (!canRecurse) {
    if (!subflowSysId) {
      lines.push(`${pad}   (subflow definition not found)`);
    } else if (depth <= 1) {
      lines.push(`${pad}   jsn flows show "${subFlowName}"`);
    }
    return lines;
  }

  ctx.visited.add(subflowSysId);
  try {
    const subInspection = await ctx.sdk.inspectFlow(subflowSysId);
    const subCtx = { ...ctx, depth: depth - 1 };
    const subLines = await formatFlowStructure(subInspection, subCtx);
    if (subLines.length === 0) {
      lines.push(`${pad}   (no steps found)`);
    } else {
      const innerPad = pad + '   ';
      for (const l of subLines) {
        lines.push(innerPad + l.replace(/^ {2}/, ''));
      }
    }
  } catch (e) {
    lines.push(`${pad}   (could not load subflow: ${e.message})`);
  }
  return lines;
}

function formatLogicStep(stepNum, pad, logic) {
  const lines = [];
  const logicType = firstNonEmpty(getNestedString(logic, 'flowLogicDefinition', 'name'), getStringField(logic, 'name'), 'Logic Step');

  const comment = getStringField(logic, 'comment');
  let condition = '';
  let conditionLabel = '';

  if (logicType === 'If' || logicType === 'Else If') {
    if (Array.isArray(logic.inputs)) {
      for (const raw of logic.inputs) {
        if (!raw || typeof raw !== 'object') continue;
        const inputName = getStringField(raw, 'name');
        if (inputName === 'condition') {
          condition = firstNonEmpty(getStringField(raw, 'displayValue'), getStringField(raw, 'value'));
        }
        if (inputName === 'condition_name') {
          conditionLabel = firstNonEmpty(getStringField(raw, 'displayValue'), getStringField(raw, 'value'));
        }
      }
    }
  }

  let displayText = logicType;
  if (conditionLabel) {
    displayText = logicType + ': ' + conditionLabel;
  } else if (condition && condition.length < 60) {
    displayText = logicType + ': ' + condition;
  }

  lines.push(`${pad}${stepNum}. ${displayText}`);

  if (condition && condition.length >= 60 && !conditionLabel) {
    lines.push(`${pad}   Condition: ${condition}`);
  }
  if (comment) {
    lines.push(`${pad}   Annotation: ${comment}`);
  }

  if (logicType === 'Set Flow Variables') {
    if (Array.isArray(logic.flowVariables) && logic.flowVariables.length > 0) {
      lines.push(`${pad}   Variables Set:`);
      for (const raw of logic.flowVariables) {
        if (!raw || typeof raw !== 'object') continue;
        const varName = getStringField(raw, 'name');
        const varValue = firstNonEmpty(getStringField(raw, 'displayValue'), getStringField(raw, 'value'));
        if (!varName) continue;
        if (varValue) {
          lines.push(`${pad}     • ${varName} = ${varValue}`);
        } else {
          lines.push(`${pad}     • ${varName}`);
        }
      }
    }
  }

  return lines;
}

function classifyPayloadItem(m) {
  if (m.flowLogicDefinition) return 'logic';
  if (m.subFlowType) return 'subflow';
  if (m.subflowSysId) return 'subflow';
  if (m.subFlow) return 'subflow';
  return 'action';
}

function getNestedString(record, parent, field) {
  const node = record?.[parent];
  if (!node || typeof node !== 'object') return '';
  return getStringField(node, field);
}

function firstNonEmpty(...values) {
  for (const v of values) {
    if (v && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function titleCase(s) {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function formatTriggerCondition(condition) {
  if (!condition) return '';
  let result = condition;
  result = result.replace(/\^OR/g, ' OR ');
  result = result.replace(/\^/g, ' AND ');
  result = result.replace(/!=/g, ' != ');
  result = result.replace(/>=/g, ' >= ');
  result = result.replace(/<=/g, ' <= ');
  result = result.replace(/=/g, ' = ');
  result = result.replace(/>/g, ' > ');
  result = result.replace(/</g, ' < ');
  result = result.replace(/LIKE/g, ' LIKE ');
  while (result.includes('  ')) {
    result = result.replace(/ {2}/g, ' ');
  }
  return result.trim();
}

function parseOrderField(record) {
  const order = getStringField(record, 'order');
  const n = parseInt(order, 10);
  return isNaN(n) ? 0 : n;
}
