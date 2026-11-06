import { analyzeWorkflowGraph } from './workflow-graph.js';
import { assertSafeExactMatch } from './helpers.js';
import { errAmbiguous, errNotFound, errUsage } from './errors.js';

/**
 * Read-only inspection of legacy Workflow Editor automation (the `wf_*`
 * tables). This is deliberately a reader: it never checks a workflow out,
 * publishes, edits or converts anything, so it works against published and
 * checked-out workflows alike and never needs a draft.
 *
 * Flow Designer (`sys_hub_flow`) inspection lives in `flow-inspection.js`;
 * these are different engines with different records and must not be
 * conflated in output.
 *
 * Table layout supported here (legacy Workflow Editor):
 *
 *   wf_workflow          name, table, description
 *   wf_workflow_version  workflow, name, table, published, active, checked_out,
 *                        checked_out_by, condition, condition_type, start,
 *                        full_sequences
 *   wf_activity          workflow_version, activity_definition, name, parent,
 *                        stage, x/y/width/height, input
 *   wf_condition         activity, name, condition, order, else_flag, error, event
 *   wf_transition        from, to, condition
 *   wf_stage             workflow_version, name, value, order
 *   sys_variable_value   document=wf_activity, document_key=<activity sys_id>,
 *                        variable.element (script, table, field, ...), value
 *   wf_element_definition  activity type name/description
 *
 * Required permissions: read on the tables above. Reading a workflow does not
 * require checking it out. Tables or columns outside the reader's ACL are
 * reported as `inaccessible`/`unavailable` in `coverage` and
 * `integrity.inaccessible` rather than being rendered as empty data.
 */

const WORKFLOW = 'wf_workflow';
const VERSION = 'wf_workflow_version';
const ACTIVITY = 'wf_activity';
const TRANSITION = 'wf_transition';
const CONDITION = 'wf_condition';
const STAGE = 'wf_stage';
const DEFINITION = 'wf_element_definition';
const VARIABLE_VALUE = 'sys_variable_value';

const WORKFLOW_FIELDS = 'sys_id,name,table,description';
const VERSION_FIELDS = [
  'sys_id', 'workflow', 'name', 'table', 'description', 'published', 'active',
  'checked_out', 'checked_out_by', 'checked_out_by.name', 'condition',
  'condition_type', 'start', 'full_sequences', 'sys_created_on', 'sys_updated_on',
].join(',');
const ACTIVITY_FIELDS = [
  'sys_id', 'name', 'activity_definition', 'activity_definition.name',
  'parent', 'stage', 'x', 'y', 'width', 'height', 'input',
].join(',');
const CONDITION_FIELDS = [
  'sys_id', 'activity', 'name', 'condition', 'order', 'else_flag', 'error',
  'event', 'event_name', 'short_description', 'skip_during_generate',
].join(',');
const TRANSITION_FIELDS = 'sys_id,from,to,condition';
const STAGE_FIELDS = 'sys_id,name,value,order';
const DEFINITION_FIELDS = 'sys_id,name,description,sys_class_name';

const CHUNK = 100;
const VERSIONS_LIMIT = 200;
const MAX_LIMIT = 1000;

const DESIGN_TIME_SCOPE = 'Design-time configuration of the selected workflow version. '
  + 'This is not evidence that this version executed, and runtime history is not inspected here.';

export function isSysId(value) {
  return /^[0-9a-f]{32}$/i.test(String(value ?? ''));
}

function raw(value) {
  if (value && typeof value === 'object') {
    if (value.value != null) return String(value.value);
    if (value.display_value != null) return String(value.display_value);
    return '';
  }
  return value == null ? '' : String(value);
}

function text(value) {
  if (value && typeof value === 'object') {
    if (value.display_value != null) return String(value.display_value);
    if (value.value != null) return String(value.value);
    return '';
  }
  return value == null ? '' : String(value);
}

function truthy(value) {
  return raw(value) === 'true';
}

function integer(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
}

function chunks(items, size = CHUNK) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function tableParams({ query, fields, limit, offset }) {
  const params = new URLSearchParams();
  params.set('sysparm_query', query);
  params.set('sysparm_fields', fields);
  params.set('sysparm_limit', String(limit));
  if (offset != null) params.set('sysparm_offset', String(offset));
  params.set('sysparm_display_value', 'all');
  return params;
}

function assertRows(rows, table) {
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw Object.assign(new Error(`Malformed table response for ${table}: expected a list of records`), { code: 'malformed_response' });
  }
  return rows;
}

/**
 * Read one component as an explicit status. Only authentication/authorization,
 * missing-table and malformed-body outcomes become statuses; network and
 * unexpected failures still abort so a broken read is never mistaken for an
 * empty component.
 */
async function readComponent(sdk, table, { query, fields, limit }) {
  try {
    const rows = assertRows(await sdk.listStrict(table, tableParams({ query, fields, limit })), table);
    return { state: 'ok', rows };
  } catch (error) {
    const status = Number(error?.status) || 0;
    const code = error?.code || 'api_error';
    if (status === 401 || status === 403) {
      return { state: 'inaccessible', http_status: status, code };
    }
    if (status === 400 || status === 404) {
      // A wf_* table can be missing on a platform that never enabled the
      // legacy editor; that is a layout difference, not an empty workflow.
      return { state: 'unavailable', http_status: status, code };
    }
    if (code === 'malformed_response') return { state: 'malformed', code };
    throw error;
  }
}

function normalizeWorkflow(row) {
  return {
    sys_id: raw(row.sys_id),
    name: text(row.name),
    table: text(row.table),
    description: text(row.description),
  };
}

function normalizeVersion(row) {
  return {
    sys_id: raw(row.sys_id),
    workflow_id: raw(row.workflow),
    name: text(row.name),
    table: text(row.table),
    description: text(row.description),
    published: truthy(row.published),
    active: truthy(row.active),
    checked_out: text(row.checked_out),
    checked_out_by_id: raw(row.checked_out_by),
    checked_out_by_name: text(row['checked_out_by.name']),
    condition: text(row.condition),
    condition_type: text(row.condition_type),
    start_activity_id: raw(row.start),
    full_sequences: text(row.full_sequences).split(',').map(item => item.trim()).filter(Boolean),
    created_on: text(row.sys_created_on),
    updated_on: text(row.sys_updated_on),
  };
}

function normalizeCondition(row) {
  return {
    sys_id: raw(row.sys_id),
    activity_id: raw(row.activity),
    name: text(row.name),
    condition: text(row.condition),
    order: integer(raw(row.order), 0),
    else_flag: truthy(row.else_flag),
    error: truthy(row.error),
    event: text(row.event),
    event_name: text(row.event_name),
    short_description: text(row.short_description),
    skip_during_generate: truthy(row.skip_during_generate),
  };
}

/**
 * Summarize published and checked-out versions for a page of workflows.
 * Two exact reads keep the `published=true` and `checked_outISNOTEMPTY`
 * filters scoped; the reference implementation's single OR query can let
 * another workflow's rows through.
 */
async function versionsForWorkflows(sdk, workflowIds) {
  if (workflowIds.length === 0) return { state: 'ok', rows: [] };
  const scope = `workflowIN${workflowIds.join(',')}`;
  const published = await readComponent(sdk, VERSION, {
    query: `${scope}^published=true`, fields: VERSION_FIELDS, limit: CHUNK,
  });
  const drafts = await readComponent(sdk, VERSION, {
    query: `${scope}^checked_outISNOTEMPTY`, fields: VERSION_FIELDS, limit: CHUNK,
  });
  const states = [published, drafts].filter(read => read.state !== 'ok');
  return {
    state: states.length === 0 ? 'ok' : states[0].state,
    http_status: states[0]?.http_status,
    rows: [...(published.rows || []), ...(drafts.rows || [])],
    truncated: (published.rows || []).length >= CHUNK || (drafts.rows || []).length >= CHUNK,
  };
}

export function validateListBounds({ limit, offset }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw errUsage('--limit must be from 1 to 100.');
  if (!Number.isInteger(offset) || offset < 0) throw errUsage('--offset must be a nonnegative integer.');
}

/**
 * List legacy workflows with the state of their published and checked-out
 * versions. One-row lookahead gives bounded pagination without pretending an
 * unreadable version set is empty.
 */
export async function listWorkflows(sdk, { name = '', table = '', query = '', limit = 20, offset = 0 } = {}) {
  validateListBounds({ limit, offset });
  if (table && !/^[a-z][a-z0-9_]*$/.test(table)) throw errUsage('--table must be an exact table name.');
  const parts = [];
  if (name) {
    assertSafeExactMatch(name);
    parts.push(`nameLIKE${name}`);
  }
  if (table) parts.push(`table=${table}`);
  if (query) parts.push(query);
  parts.push('ORDERBYname', 'ORDERBYsys_id');

  const rows = assertRows(await sdk.listStrict(WORKFLOW, tableParams({
    query: parts.join('^'), fields: WORKFLOW_FIELDS, limit: limit + 1, offset,
  })), WORKFLOW);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const workflows = page.map(normalizeWorkflow);
  const versionRead = await versionsForWorkflows(sdk, workflows.map(w => w.sys_id).filter(isSysId));

  const versions = (versionRead.rows || []).map(normalizeVersion);
  const records = workflows.map(workflow => {
    const own = versions.filter(version => version.workflow_id === workflow.sys_id);
    const published = own.filter(version => version.published)
      .sort((a, b) => Number(b.active) - Number(a.active) || newestFirst(a, b))[0] || null;
    const draft = own.find(version => !version.published && version.checked_out_by_id) || null;
    const record = {
      ...workflow,
      published_version: published && compactVersion(published),
      checked_out_version: draft && {
        ...compactVersion(draft),
        checked_out_by_id: draft.checked_out_by_id,
        checked_out_by_name: draft.checked_out_by_name,
        checked_out_on: draft.checked_out,
      },
      version_state: versionRead.state,
    };
    if (versionRead.http_status) record.version_http_status = versionRead.http_status;
    return record;
  });

  return {
    engine: 'legacy_workflow_editor',
    table: WORKFLOW,
    count: records.length,
    records,
    pagination: { limit, offset, has_more: hasMore },
    versions_truncated: versionRead.truncated === true,
    coverage: {
      complete: versionRead.state === 'ok' && versionRead.truncated !== true,
      components: { workflows: 'ok', versions: versionRead.state },
    },
    definition_scope: DESIGN_TIME_SCOPE,
  };
}

function compactVersion(version) {
  return {
    sys_id: version.sys_id,
    name: version.name,
    table: version.table,
    active: version.active,
    condition: version.condition,
    created_on: version.created_on,
  };
}

async function resolveWorkflow(sdk, identifier) {
  const matches = [];
  let matchedBy = 'sys_id';

  if (isSysId(identifier)) {
    const rows = assertRows(await sdk.listStrict(WORKFLOW, tableParams({
      query: `sys_id=${identifier}`, fields: WORKFLOW_FIELDS, limit: 1,
    })), WORKFLOW);
    matches.push(...rows);
    if (rows.length === 0) {
      // A version sys_id is a legitimate handle even when the caller does not
      // know which workflow owns it.
      const versions = assertRows(await sdk.listStrict(VERSION, tableParams({
        query: `sys_id=${identifier}`, fields: 'sys_id,workflow', limit: 1,
      })), VERSION);
      const workflowId = raw(versions[0]?.workflow);
      if (workflowId) {
        const owners = assertRows(await sdk.listStrict(WORKFLOW, tableParams({
          query: `sys_id=${workflowId}`, fields: WORKFLOW_FIELDS, limit: 1,
        })), WORKFLOW);
        matches.push(...owners);
        matchedBy = 'version_sys_id';
      }
    }
  } else {
    assertSafeExactMatch(identifier);
    matchedBy = 'name';
    const rows = assertRows(await sdk.listStrict(WORKFLOW, tableParams({
      query: `name=${identifier}`, fields: WORKFLOW_FIELDS, limit: 10,
    })), WORKFLOW);
    matches.push(...rows);
  }

  if (matches.length === 0) {
    throw errNotFound('Legacy workflow', identifier);
  }
  if (matches.length > 1) {
    throw errAmbiguous('legacy workflows', matches.map(row => `${raw(row.sys_id)} (${text(row.table)})`));
  }
  return { workflow: normalizeWorkflow(matches[0]), matched_by: matchedBy };
}

function newestFirst(a, b) {
  return b.created_on.localeCompare(a.created_on) || a.sys_id.localeCompare(b.sys_id);
}

function isScriptField(element) {
  return element === 'script' || element.startsWith('script_') || element.endsWith('_script');
}

// Recognize only whitespace and complete JavaScript comments. Anything else
// (including a shebang or an unterminated block) is conservatively retained.
function isCommentOnlyScript(value) {
  let rest = value;
  let sawComment = false;
  while (rest.trimStart()) {
    rest = rest.trimStart();
    if (rest.startsWith('//')) {
      sawComment = true;
      const end = rest.search(/[\r\n\u2028\u2029]/);
      rest = end < 0 ? '' : rest.slice(end);
    } else if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/', 2);
      if (end < 0) return false;
      sawComment = true;
      rest = rest.slice(end + 2);
    } else {
      return false;
    }
  }
  return sawComment;
}

export function selectVersion(versions, versionId = '') {
  if (versionId) {
    if (!isSysId(versionId)) throw errUsage('--version must be a wf_workflow_version sys_id (32 hexadecimal characters).');
    const requested = versions.find(version => version.sys_id === versionId);
    if (!requested) throw errUsage(`Version ${versionId} is not one of this workflow's versions.`);
    return { version: requested, reason: 'requested' };
  }
  const published = versions.filter(version => version.published)
    .sort((a, b) => Number(b.active) - Number(a.active) || newestFirst(a, b));
  if (published.length > 0) return { version: published[0], reason: 'latest_published' };
  if (versions.length > 0) return { version: [...versions].sort(newestFirst)[0], reason: 'newest' };
  return { version: null, reason: 'none' };
}

/**
 * Read one workflow version's design-time definition: activities, conditions,
 * transitions, stages, activity configuration and the activity-type records
 * they reference. Every link keeps its sys_id.
 */
export async function inspectWorkflow(sdk, {
  identifier, versionId = '', includeConfiguration = true, limit = 200,
} = {}) {
  if (typeof identifier !== 'string' || !identifier.trim()) {
    throw errUsage('Provide a legacy workflow name or sys_id.');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw errUsage(`--limit must be from 1 to ${MAX_LIMIT}.`);
  }

  const { workflow, matched_by } = await resolveWorkflow(sdk, identifier.trim());
  const versionRead = await readComponent(sdk, VERSION, {
    query: `workflow=${workflow.sys_id}^ORDERBYDESCsys_created_on`,
    fields: VERSION_FIELDS,
    limit: VERSIONS_LIMIT,
  });
  const versions = (versionRead.rows || []).map(normalizeVersion).sort(newestFirst);
  const versionsTruncated = versionRead.state === 'ok' && versions.length === VERSIONS_LIMIT;

  let selection = { version: null, reason: 'unavailable' };
  if (versionRead.state === 'ok') {
    selection = selectVersion(versions, versionId);
  } else if (versionId) {
    if (!isSysId(versionId)) throw errUsage('--version must be a wf_workflow_version sys_id (32 hexadecimal characters).');
    const direct = await readComponent(sdk, VERSION, {
      query: `sys_id=${versionId}`, fields: VERSION_FIELDS, limit: 1,
    });
    const version = (direct.rows || []).map(normalizeVersion)[0] || null;
    if (!version) throw errNotFound('Workflow version', versionId);
    if (version.workflow_id !== workflow.sys_id) {
      throw errUsage(`Version ${versionId} belongs to workflow ${version.workflow_id}, not ${workflow.sys_id}.`);
    }
    selection = { version, reason: 'requested' };
  }

  const version = selection.version;
  const components = {
    versions: versionRead.state,
    activities: 'not_requested',
    conditions: 'not_requested',
    transitions: 'not_requested',
    stages: 'not_requested',
    configuration: includeConfiguration ? 'not_requested' : 'skipped',
    definitions: 'not_requested',
  };
  const inaccessible = [];
  if (versionRead.state !== 'ok') {
    inaccessible.push({ component: 'versions', state: versionRead.state, http_status: versionRead.http_status ?? null, code: versionRead.code ?? null });
  }

  let activities = [];
  let conditions = [];
  let transitions = [];
  let transitionsTruncated = false;
  let stages = [];
  let activitySample = { limit, returned: 0, truncated: false };
  let definitions = new Map();
  let integrity;

  if (version) {
    const activityRead = await readComponent(sdk, ACTIVITY, {
      query: `workflow_version=${version.sys_id}^ORDERBYsys_created_on`,
      fields: ACTIVITY_FIELDS,
      limit: limit + 1,
    });
    components.activities = activityRead.state;
    if (activityRead.state !== 'ok') {
      inaccessible.push({ component: 'activities', state: activityRead.state, http_status: activityRead.http_status ?? null, code: activityRead.code ?? null });
    } else {
      activitySample = {
        limit,
        returned: Math.min(activityRead.rows.length, limit),
        truncated: activityRead.rows.length > limit,
      };
      activities = activityRead.rows.slice(0, limit).map(row => ({
        sys_id: raw(row.sys_id),
        name: text(row.name),
        definition_id: raw(row.activity_definition),
        definition_name: text(row['activity_definition.name']),
        definition_status: 'unknown',
        parent_id: raw(row.parent),
        stage_id: raw(row.stage),
        position: {
          x: integer(raw(row.x), null),
          y: integer(raw(row.y), null),
          width: integer(raw(row.width), null),
          height: integer(raw(row.height), null),
        },
        input: text(row.input),
        conditions: [],
        configuration: {},
        configuration_status: includeConfiguration ? 'not_requested' : 'skipped',
      }));
    }

    const activityIds = activities.map(activity => activity.sys_id).filter(isSysId);

    const conditionReads = [];
    for (const chunk of chunks(activityIds)) {
      conditionReads.push(await readComponent(sdk, CONDITION, {
        query: `activityIN${chunk.join(',')}^ORDERBYorder`,
        fields: CONDITION_FIELDS,
        limit: MAX_LIMIT,
      }));
    }
    const conditionState = worstState(conditionReads);
    components.conditions = activityIds.length === 0 ? 'not_applicable' : conditionState;
    if (conditionState !== 'ok' && conditionState !== 'not_applicable') {
      const failed = conditionReads.find(read => read.state !== 'ok');
      inaccessible.push({ component: 'conditions', state: failed.state, http_status: failed.http_status ?? null, code: failed.code ?? null });
    }
    conditions = conditionReads.flatMap(read => read.rows || []).map(normalizeCondition)
      .sort((a, b) => a.activity_id.localeCompare(b.activity_id) || a.order - b.order);

    const transitionReads = [];
    for (const chunk of chunks(activityIds)) {
      transitionReads.push(await readComponent(sdk, TRANSITION, {
        query: `fromIN${chunk.join(',')}`,
        fields: TRANSITION_FIELDS,
        limit: MAX_LIMIT,
      }));
    }
    // Hitting a per-query bound is conservatively incomplete; do not add a
    // count query or fetch more rows just for graph analysis.
    transitionsTruncated = transitionReads.some(read => read.state === 'ok' && read.rows.length >= MAX_LIMIT);
    const transitionState = worstState(transitionReads);
    components.transitions = activityIds.length === 0 ? 'not_applicable' : transitionState;
    if (transitionState !== 'ok' && transitionState !== 'not_applicable') {
      const failed = transitionReads.find(read => read.state !== 'ok');
      inaccessible.push({ component: 'transitions', state: failed.state, http_status: failed.http_status ?? null, code: failed.code ?? null });
    }

    const stageRead = await readComponent(sdk, STAGE, {
      query: `workflow_version=${version.sys_id}^ORDERBYorder`,
      fields: STAGE_FIELDS,
      limit: 500,
    });
    components.stages = stageRead.state;
    if (stageRead.state !== 'ok' && stageRead.state !== 'unavailable') {
      inaccessible.push({ component: 'stages', state: stageRead.state, http_status: stageRead.http_status ?? null, code: stageRead.code ?? null });
    }
    stages = (stageRead.rows || []).map(row => ({
      sys_id: raw(row.sys_id),
      name: text(row.name),
      value: text(row.value),
      order: integer(raw(row.order), 0),
    })).sort((a, b) => a.order - b.order);

    if (includeConfiguration && activityIds.length === 0) components.configuration = 'not_applicable';
    if (includeConfiguration && activityIds.length > 0) {
      const configurationReads = [];
      for (const chunk of chunks(activityIds)) {
        configurationReads.push(await readComponent(sdk, VARIABLE_VALUE, {
          query: `document=wf_activity^document_keyIN${chunk.join(',')}^ORDERBYorder`,
          fields: 'document_key,variable.element,value',
          limit: MAX_LIMIT,
        }));
      }
      const configurationState = worstState(configurationReads);
      components.configuration = configurationState;
      if (configurationState !== 'ok') {
        const failed = configurationReads.find(read => read.state !== 'ok');
        inaccessible.push({ component: 'configuration', state: failed.state, http_status: failed.http_status ?? null, code: failed.code ?? null });
      }
      const byActivity = new Map();
      for (const row of configurationReads.flatMap(read => read.rows || [])) {
        const activityId = raw(row.document_key);
        const element = raw(row['variable.element']);
        if (!activityId || !element) continue;
        if (!byActivity.has(activityId)) byActivity.set(activityId, {});
        byActivity.get(activityId)[element] = text(row.value);
      }
      for (const activity of activities) {
        activity.configuration = byActivity.get(activity.sys_id) || {};
        activity.configuration_omissions = [];
        for (const [element, value] of Object.entries(activity.configuration)) {
          if (isScriptField(element) && isCommentOnlyScript(value)) {
            delete activity.configuration[element];
            activity.configuration_omissions.push({ field: element, reason: 'comment_only_script' });
          }
        }
        activity.configuration_status = configurationState === 'ok' ? 'ok' : configurationState;
      }
    }

    const definitionIds = [...new Set(activities.map(activity => activity.definition_id).filter(isSysId))];
    const definitionReads = [];
    for (const chunk of chunks(definitionIds)) {
      definitionReads.push(await readComponent(sdk, DEFINITION, {
        query: `sys_idIN${chunk.join(',')}`,
        fields: DEFINITION_FIELDS,
        limit: CHUNK,
      }));
    }
    const definitionState = worstState(definitionReads, definitionIds.length === 0 ? 'not_applicable' : 'ok');
    components.definitions = definitionState;
    if (definitionState !== 'ok' && definitionState !== 'not_applicable') {
      const failed = definitionReads.find(read => read.state !== 'ok');
      inaccessible.push({ component: 'activity_definitions', state: failed.state, http_status: failed.http_status ?? null, code: failed.code ?? null });
    }
    definitions = new Map();
    for (const row of definitionReads.flatMap(read => read.rows || [])) {
      definitions.set(raw(row.sys_id), {
        sys_id: raw(row.sys_id),
        name: text(row.name),
        description: text(row.description),
        sys_class_name: text(row.sys_class_name),
      });
    }
    for (const activity of activities) {
      const definition = definitions.get(activity.definition_id);
      if (definition) {
        activity.definition_name = activity.definition_name || definition.name;
        activity.definition_status = 'ok';
      } else if (definitionState === 'ok') {
        activity.definition_status = activity.definition_id ? 'missing' : 'unset';
      } else {
        activity.definition_status = definitionState;
      }
    }

    const activityById = new Map(activities.map(activity => [activity.sys_id, activity]));
    for (const condition of conditions) {
      activityById.get(condition.activity_id)?.conditions.push(condition);
    }

    const conditionById = new Map(conditions.map(condition => [condition.sys_id, condition]));
    transitions = transitionReads.flatMap(read => read.rows || []).map(row => {
      const fromId = raw(row.from);
      const toId = raw(row.to);
      const conditionId = raw(row.condition);
      const missing = [fromId, toId].filter(id => id && !activityById.has(id));
      let status = 'ok';
      if (missing.length > 0) status = activitySample.truncated ? 'outside_sample' : 'dangling';
      return {
        sys_id: raw(row.sys_id),
        from_id: fromId,
        to_id: toId,
        from_name: activityById.get(fromId)?.name || '',
        to_name: activityById.get(toId)?.name || '',
        condition_id: conditionId,
        condition_name: conditionById.get(conditionId)?.name || '',
        condition_status: !conditionId ? 'none' : (conditionById.has(conditionId) ? 'ok' : 'missing'),
        status,
        missing_endpoints: missing,
      };
    }).sort((a, b) => a.from_name.localeCompare(b.from_name) || a.to_name.localeCompare(b.to_name));

    integrity = buildIntegrity({ activities, transitions, conditions, inaccessible, activitySample, version, definitions });
  } else {
    integrity = buildIntegrity({ activities, transitions, conditions, inaccessible, activitySample, version: null, definitions });
  }

  const graph = analyzeWorkflowGraph(activities, transitions);
  const loopDetectionComplete = Boolean(version) && components.activities === 'ok'
    && ['ok', 'not_applicable'].includes(components.transitions)
    && !activitySample.truncated && !transitionsTruncated
    && transitions.every(edge => graph.activity_ids.has(edge.from_id) && graph.activity_ids.has(edge.to_id));
  const componentsComplete = Object.entries(components).every(([, state]) => ['ok', 'not_applicable', 'skipped'].includes(state));
  const data = {
    engine: 'legacy_workflow_editor',
    workflow,
    matched_by,
    versions: versions.map(versionSummary),
    versions_truncated: versionsTruncated,
    selection: {
      requested_version_id: versionId || null,
      selected_version_id: version?.sys_id || null,
      reason: selection.reason,
    },
    version: version ? versionSummary(version) : null,
    activities,
    transitions,
    transitions_by_activity: graph.groups,
    loops: graph.loops,
    stages,
    integrity,
    coverage: {
      loops_found: graph.loops.length,
      loop_detection_complete: loopDetectionComplete,
      transitions_truncated: transitionsTruncated,
      complete: componentsComplete && !activitySample.truncated && !versionsTruncated && !transitionsTruncated
        && inaccessible.length === 0,
      components,
      activity_sample: activitySample,
      comment_only_scripts_omitted: activities.reduce((count, activity) => count + (activity.configuration_omissions?.length || 0), 0),
      versions_truncated: versionsTruncated,
    },
    definition_scope: DESIGN_TIME_SCOPE,
  };
  return data;
}

function versionSummary(version) {
  return {
    sys_id: version.sys_id,
    workflow_id: version.workflow_id,
    name: version.name,
    table: version.table,
    published: version.published,
    active: version.active,
    checked_out: version.checked_out,
    checked_out_by_id: version.checked_out_by_id,
    checked_out_by_name: version.checked_out_by_name,
    condition: version.condition,
    start_activity_id: version.start_activity_id,
    created_on: version.created_on,
    updated_on: version.updated_on,
  };
}

function worstState(reads, empty = 'not_applicable') {
  if (reads.length === 0) return empty;
  const failed = reads.find(read => read.state !== 'ok');
  return failed ? failed.state : 'ok';
}

function buildIntegrity({ activities, transitions, conditions, inaccessible, activitySample, version, definitions }) {
  const activityIds = new Set(activities.map(activity => activity.sys_id));
  const expectedDefinitions = activities.filter(activity => activity.definition_id && !definitions.has(activity.definition_id));
  return {
    missing_activity_definitions: expectedDefinitions.map(activity => ({
      activity_id: activity.sys_id,
      activity_name: activity.name,
      definition_id: activity.definition_id,
    })),
    unset_activity_definitions: activities.filter(activity => !activity.definition_id).map(activity => ({
      activity_id: activity.sys_id,
      activity_name: activity.name,
    })),
    dangling_transitions: transitions.filter(transition => transition.status === 'dangling').map(transition => ({
      transition_id: transition.sys_id,
      from_id: transition.from_id,
      to_id: transition.to_id,
      missing_endpoints: transition.missing_endpoints,
    })),
    unresolved_transition_conditions: transitions.filter(transition => transition.condition_status === 'missing').map(transition => ({
      transition_id: transition.sys_id,
      condition_id: transition.condition_id,
    })),
    dangling_start_activity: version?.start_activity_id && !activityIds.has(version.start_activity_id)
      ? version.start_activity_id
      : null,
    inaccessible,
    transitions_outside_sample: transitions.filter(transition => transition.status === 'outside_sample').length,
    activity_sample_truncated: activitySample.truncated,
    // A transition condition that was not read (ACL, deleted record) is
    // listed in unresolved_transition_conditions rather than rendered empty.
    condition_count: conditions.length,
  };
}

function describeSelection(reason) {
  switch (reason) {
    case 'requested': return 'requested version';
    case 'latest_published': return 'latest published version (active preferred)';
    case 'newest': return 'newest version (no published version)';
    case 'unavailable': return 'versions not readable';
    default: return 'no version';
  }
}

function describeTransition(transition) {
  const to = transition.to_name || transition.to_id || '(unknown)';
  const condition = transition.condition_id
    ? `${transition.condition_name || transition.condition_id}${transition.condition_status === 'missing' ? ' — unreadable' : ''}`
    : 'unconditional';
  const issue = transition.status === 'dangling'
    ? ` ⚠ missing ${transition.missing_endpoints.join(', ')}`
    : transition.status === 'outside_sample' ? ' (outside the activity sample)' : '';
  return `${to} [${condition}]${issue}`;
}

function truncateLines(value, max = 12) {
  const lines = String(value).split('\n');
  if (lines.length <= max) return lines.join('\n');
  return `${lines.slice(0, max).join('\n')}\n… (${lines.length - max} more lines; use --json for the full value)`;
}

/**
 * Human-readable outline. IDs stay visible so an agent or operator can follow
 * up with a focused read; the structured JSON returned by inspectWorkflow
 * remains the source of every detail.
 */
export function formatWorkflowOutline(data, instanceURL = '') {
  const lines = [];
  const workflow = data.workflow;
  lines.push('');
  lines.push(`Legacy workflow: ${workflow.name}  (table: ${workflow.table || 'unset'})`);
  lines.push('');
  lines.push(`  Workflow sys_id: ${workflow.sys_id}`);
  if (instanceURL) {
    lines.push(`  Link: ${instanceURL}/nav_to.do?uri=wf_workflow.do?sys_id=${workflow.sys_id}`);
  }
  if (workflow.description) lines.push(`  Description: ${workflow.description}`);
  if (data.coverage.components.versions === 'ok') {
    lines.push(`  Versions: ${data.versions.length}${data.versions_truncated ? '+' : ''} (${describeSelection(data.selection.reason)})`);
  } else {
    lines.push(`  Versions: not readable (${data.coverage.components.versions})`);
  }

  const version = data.version;
  if (version) {
    const flags = [version.published ? 'published' : 'not published', version.active ? 'active' : 'inactive'];
    lines.push(`  Selected version: ${version.name} — ${flags.join(', ')}`);
    lines.push(`    Version sys_id: ${version.sys_id}`);
    if (version.condition) lines.push(`    Condition: ${version.condition}`);
    if (version.checked_out_by_id) {
      lines.push(`    Checked out by: ${version.checked_out_by_name || version.checked_out_by_id} on ${version.checked_out || 'unknown date'}`);
    }
  } else {
    lines.push('  Selected version: none');
  }

  if (data.versions.length > 0) {
    lines.push('');
    lines.push('▶ VERSIONS (newest first)');
    lines.push('─'.repeat(50));
    data.versions.forEach((item, index) => {
      const flags = [item.published ? 'published' : 'draft', item.active ? 'active' : 'inactive'];
      if (item.checked_out_by_id) flags.push(`checked out by ${item.checked_out_by_name || item.checked_out_by_id}`);
      const marker = item.sys_id === version?.sys_id ? '*' : ' ';
      lines.push(` ${marker} ${index + 1}. ${item.name} [${flags.join(', ')}] ${item.created_on}`);
      lines.push(`      ${item.sys_id}`);
    });
  }

  lines.push('');
  lines.push(`⚡ ACTIVITIES (${data.activities.length}${data.coverage.activity_sample.truncated ? '+' : ''})`);
  lines.push('─'.repeat(50));
  if (data.activities.length === 0) {
    lines.push(`  (${data.coverage.components.activities === 'ok' ? 'no activities found' : `activities ${data.coverage.components.activities}`})`);
  }
  data.activities.forEach((activity, index) => {
    const definition = activity.definition_name || activity.definition_id || 'unset definition';
    const details = [];
    if (activity.parent_id) details.push(`parent ${activity.parent_id}`);
    if (activity.stage_id) details.push(`stage ${activity.stage_id}`);
    lines.push(`  ${index + 1}. ${activity.name} [${definition}]`);
    lines.push(`     activity ${activity.sys_id}`);
    if (details.length) lines.push(`     ${details.join(' | ')}`);
    for (const condition of activity.conditions) {
      const flags = [condition.else_flag ? 'else' : '', condition.error ? 'error' : ''].filter(Boolean).join(', ');
      lines.push(`     condition: ${condition.name || condition.condition || condition.sys_id}${flags ? ` (${flags})` : ''} [${condition.sys_id}]`);
      if (condition.condition && condition.name) lines.push(`       ${condition.condition}`);
    }
    if (activity.configuration_status !== 'ok' && activity.configuration_status !== 'skipped') {
      lines.push(`     configuration: ${activity.configuration_status}`);
    }
    for (const omission of activity.configuration_omissions || []) {
      lines.push(`     omitted ${omission.field}: comment-only script (no executable code)`);
    }
    const script = activity.configuration?.script;
    if (script) {
      lines.push('     script:');
      for (const line of truncateLines(script).split('\n')) lines.push(`       ${line}`);
    }
  });

  lines.push('');
  lines.push('▶ TRANSITIONS');
  lines.push('─'.repeat(50));
  const loopEdges = new Set(data.loops.flatMap(loop => loop.edges.map(edge => edge.sys_id)));
  for (const group of data.transitions_by_activity) {
    lines.push(`  ${group.name || group.sys_id || '(unknown source)'}`);
    if (group.transitions.length === 0) {
      lines.push(data.coverage.loop_detection_complete
        ? '    (no outgoing transitions)' : '    (no outgoing transitions observed; detection incomplete)');
    }
    for (const transition of group.transitions) {
      lines.push(`    ${loopEdges.has(transition.sys_id) ? '↺ ' : ''}→ ${describeTransition(transition)}`);
      lines.push(`       ${transition.sys_id}`);
    }
  }

  lines.push('', '▶ LOOPS', '─'.repeat(50));
  if (!data.coverage.loop_detection_complete) {
    lines.push('  Loop detection is incomplete: activities or transitions unreadable, truncated, or endpoints outside the sample.');
  } else if (data.loops.length === 0) {
    lines.push('  no loops detected');
  }
  data.loops.forEach((loop, index) => {
    lines.push(`  Loop ${index + 1}${data.coverage.loop_detection_complete ? '' : ' (observed; detection incomplete)'}`);
    lines.push('    Members:');
    for (const member of loop.members) lines.push(`      ${member.name || '(unnamed)'} [${member.sys_id}]`);
    lines.push('    Cycle edges (all internal SCC edges, including closing edges):');
    for (const edge of loop.edges) {
      lines.push(`      ↺ ${edge.from_name || edge.from_id} → ${describeTransition(edge)} [${edge.sys_id}]`);
    }
    lines.push(`    Entry points${data.coverage.loop_detection_complete ? '' : ' (observed)'}:`);
    if (loop.entry_points.length === 0) lines.push('      (no incoming edges from outside the loop observed)');
    for (const member of loop.entry_points) lines.push(`      ${member.name || '(unnamed)'} [${member.sys_id}]`);
  });

  if (data.stages.length > 0) {
    lines.push('');
    lines.push('▶ STAGES');
    lines.push('─'.repeat(50));
    for (const stage of data.stages) lines.push(`  • ${stage.name} = ${stage.value} (order ${stage.order})`);
  }

  const warnings = [];
  if (data.coverage.comment_only_scripts_omitted) {
    warnings.push(`${data.coverage.comment_only_scripts_omitted} comment-only script fields omitted; see per-activity notes`);
  }
  for (const item of data.integrity.inaccessible) {
    warnings.push(`${item.component}: ${item.state}${item.http_status ? ` (HTTP ${item.http_status})` : ''}`);
  }
  for (const item of data.integrity.missing_activity_definitions) {
    warnings.push(`activity definition missing for ${item.activity_name || item.activity_id} (${item.definition_id})`);
  }
  for (const item of data.integrity.dangling_transitions) {
    warnings.push(`transition ${item.transition_id} references missing activity ${item.missing_endpoints.join(', ')}`);
  }
  for (const item of data.integrity.unresolved_transition_conditions) {
    warnings.push(`transition ${item.transition_id} references unreadable condition ${item.condition_id}`);
  }
  if (data.integrity.dangling_start_activity) {
    warnings.push(`start activity ${data.integrity.dangling_start_activity} is not among this version's activities`);
  }
  if (data.integrity.activity_sample_truncated) {
    warnings.push(`activities truncated at ${data.coverage.activity_sample.limit}; links outside the sample are reported as outside_sample`);
  }
  if (warnings.length > 0) {
    lines.push('');
    lines.push('⚠ INTEGRITY / COVERAGE');
    lines.push('─'.repeat(50));
    for (const warning of warnings) lines.push(`  - ${warning}`);
  }

  lines.push('');
  lines.push(`Note: ${DESIGN_TIME_SCOPE}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export function formatWorkflowList(data) {
  const lines = ['', 'Legacy workflows (wf_workflow) — read-only inspection', ''];
  lines.push('NAME | TABLE | PUBLISHED | CHECKED OUT | SYS_ID');
  lines.push('--- | --- | --- | --- | ---');
  for (const record of data.records) {
    const published = record.published_version
      ? `${record.published_version.name}${record.published_version.active ? '' : ' (inactive)'}`
      : '—';
    const checkout = record.checked_out_version
      ? `${record.checked_out_version.checked_out_by_name || record.checked_out_version.checked_out_by_id}`
      : '—';
    lines.push(`${record.name} | ${record.table || '—'} | ${published} | ${checkout} | ${record.sys_id}`);
  }
  if (data.records.length === 0) lines.push('(no workflows on this page)');
  lines.push('');
  lines.push(`Page: limit ${data.pagination.limit}, offset ${data.pagination.offset}, more: ${data.pagination.has_more ? 'yes' : 'no'}`);
  if (data.coverage.components.versions !== 'ok') {
    lines.push(`⚠ Version state not readable: ${data.coverage.components.versions}`);
  }
  if (data.versions_truncated) {
    lines.push('⚠ Version state is a bounded sample (100 rows per state); narrow the list with --name, --table or --query.');
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/**
 * Published workflow versions configured for one table. Intended for reuse by
 * table-behavior discovery (#398). This reports only workflows whose version
 * names the table; it does not discover script-started or condition-started
 * workflows and does not claim to.
 */
export async function listPublishedWorkflowVersionsForTable(sdk, table, { limit = 50 } = {}) {
  if (!/^[a-z][a-z0-9_]*$/.test(String(table || ''))) throw errUsage('A table name is required.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw errUsage('limit must be from 1 to 200.');
  const read = await readComponent(sdk, VERSION, {
    query: `table=${table}^published=true^ORDERBYname`,
    fields: VERSION_FIELDS,
    limit,
  });
  return {
    table,
    state: read.state,
    http_status: read.http_status ?? null,
    versions: (read.rows || []).map(normalizeVersion).map(versionSummary),
    coverage: {
      complete: read.state === 'ok',
      note: 'Association by wf_workflow_version.table only. Script- and condition-started workflows are not discovered.',
    },
  };
}
