import { formatRecordForDisplay, getStringField, interactiveList } from '../../helpers.js';

export function flowsCmd(wrap) {
  return {
    command: 'flows [subcommand]',
    aliases: ['flow'],
    describe: 'Manage Flow Designer flows',
    builder: (yargs) => {
      return yargs
        .command({
          command: 'list',
          aliases: ['ls'],
          describe: 'List flows',
          builder: (y) => y
            .option('query', { type: 'string', describe: 'Encoded query (e.g. "nameLIKEincident" or "active=true")' })
            .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns (e.g. "number,short_description")' })
            .option('limit', { alias: 'l', type: 'number', default: 20, describe: 'Max records' }),
          handler: wrap(async (argv, app) => {
            const columns = argv.columns ? argv.columns.split(',') : ['name', 'active', 'description', 'sys_created_by', 'sys_updated_on'];
            const query = argv.query || '';

            // Interactive picker
            const picked = await interactiveList({
              app, table: 'sys_hub_flow', singular: 'flow', columns, limit: argv.limit, query, labelField: 'name',
              formatLabel: r => `${getStringField(r, 'name')} ${getStringField(r, 'active') === 'true' ? '' : '[inactive]'}`,
            });
            if (picked) {
              const inspection = await app.sdk.inspectFlow(getStringField(picked, 'sys_id'));
              const formatted = formatFlowInspection(inspection, app.getEffectiveInstance());
              return app.ok({ ...inspection, _formatted: formatted }, {
                summary: `Flow: ${inspection.flow.name}`,
                breadcrumbs: [{ action: 'list', cmd: 'jsn dev flows list', description: 'Back to all flows' }],
              });
            }

            // Text/table fallback
            const params = new URLSearchParams();
            params.set('sysparm_limit', String(argv.limit));
            params.set('sysparm_display_value', 'all');
            params.set('sysparm_fields', ['sys_id', ...columns].join(','));
            const q = argv.query ? argv.query + '^ORDERBYDESCsys_updated_on' : 'ORDERBYDESCsys_updated_on';
            params.set('sysparm_query', q);
            const records = await app.sdk.list('sys_hub_flow', params);
            app.ok({
              table: 'sys_hub_flow',
              count: records.length,
              columns,
              records: records.map(r => formatRecordForDisplay(r, columns)),
              context: { instance_url: app.getEffectiveInstance() },
            }, { summary: `${records.length} flow(s)` });
          }),
        })
        .command({
          command: 'show <identifier>',
          aliases: ['get'],
          describe: 'Show flow details by name or sys_id',
          handler: wrap(async (argv, app) => {
            const inspection = await app.sdk.inspectFlow(argv.identifier);
            const formatted = formatFlowInspection(inspection, app.getEffectiveInstance());
            const data = { ...inspection, _formatted: formatted };
            app.ok(data, {
              summary: `Flow: ${inspection.flow.name}`,
              breadcrumbs: [
                { action: 'list', cmd: 'jsn dev flows list', description: 'Back to all flows' },
              ],
            });
          }),
        })
        .command({
          command: 'create',
          describe: 'Create a new flow (not yet implemented)',
          builder: (y) => y
            .option('data', { type: 'string', describe: 'JSON data for the flow' }),
          handler: wrap(async (_argv, _app) => {
            throw new Error('Flow creation requires the Flow Designer GraphQL API - not yet implemented.\n'
              + 'Use the ServiceNow web UI to create flows, then use "jsn dev flows list" to view them.');
          }),
        })
        .command({
          command: 'update <identifier>',
          describe: 'Update a flow (not yet implemented)',
          builder: (y) => y
            .option('data', { type: 'string', describe: 'JSON data to update' }),
          handler: wrap(async (_argv, _app) => {
            throw new Error('Flow updates require the Flow Designer GraphQL API - not yet implemented.\n'
              + 'Use the ServiceNow web UI to update flows, then use "jsn dev flows list" to view them.');
          }),
        })
        .command({
          command: 'delete <identifier>',
          describe: 'Delete a flow (not yet implemented)',
          handler: wrap(async (_argv, _app) => {
            throw new Error('Flow deletion requires the Flow Designer GraphQL API - not yet implemented.\n'
              + 'Use the ServiceNow web UI to delete flows.');
          }),
        });
    },
    handler: () => {},
  };
}

function formatFlowInspection(inspection, instanceURL) {
  const lines = [];
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
  lines.push(...formatFlowStructure(inspection));

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

function formatFlowStructure(inspection) {
  const payload = inspection.payload;
  if (Object.keys(payload).length > 0) {
    return formatFlowStructureFromPayload(payload);
  }
  return formatFlowStructureFallback(inspection);
}

function formatFlowStructureFromPayload(payload) {
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

  function walk(steps, indent) {
    for (const step of steps) {
      const pad = '    '.repeat(indent);
      lines.push(...formatStepLine(stepNum, pad, step));
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
      walk(children, indent + 1);
    }
  }

  walk(roots, 0);
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
      steps.push({ order: parseOrderField(action), text: name });
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
      steps.push({ order: parseOrderField(logic), text: name });
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

  return steps.map((step, i) => `${i + 1}. ${step.text}`);
}

function formatStepLine(stepNum, pad, step) {
  switch (step.stepType) {
    case 'logic':
      return formatLogicStep(stepNum, pad, step.data);
    case 'subflow':
      return formatSubFlowStep(stepNum, pad, step.data);
    default:
      return formatActionStep(stepNum, pad, step.data);
  }
}

function formatActionStep(stepNum, pad, action) {
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

  let actionDisplay = actionName;
  if (tableName && actionName === 'Update Record') {
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
      if (inputName === 'table_name') continue;

      let inputValue = firstNonEmpty(getStringField(raw, 'displayValue'), getStringField(raw, 'value'));
      if (!inputValue) continue;
      if (inputValue.length > 50) {
        inputValue = inputValue.slice(0, 47) + '...';
      }

      let label = inputName;
      if (raw.parameter && typeof raw.parameter === 'object') {
        label = firstNonEmpty(getStringField(raw.parameter, 'label'), label);
      }

      lines.push(`${pad}    ${label}: ${inputValue}`);
    }
  }

  return lines;
}

function formatSubFlowStep(stepNum, pad, subFlow) {
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

  lines.push(`${pad}   jsn flows "${subFlowName}"`);
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
