/**
 * Flow publishing and health checks.
 *
 * A flow is two things: design-time records (sys_hub_flow and its instance
 * tables) and a compiled runtime snapshot. Writing design-time records alone
 * produces a flow that renders correctly in the Flow Designer UI and never
 * executes -- publishing is what compiles the snapshot, expands actions into
 * steps, and registers the trigger in sys_flow_record_trigger.
 *
 * Publishing goes through the platform's Workflow Automation Fluent API. When
 * that endpoint is absent (older instances, or the ServiceNow IDE plugins are
 * not active) we fall back to calling FlowDesignerUtils directly through a
 * background script, which is what the endpoint does internally anyway.
 */

import { decodeGzipJson } from './sdk.js';

const ACTIVATE_PATH = '/api/now/wfa_fluent/activate_flows';

// The endpoint returns 200 (all published), 207 (partial) or 422 (all failed).
// 422 is NOT an error case -- it carries a per-flow result body that is the
// most useful output this command produces, so it must not be thrown away.
const RESULT_STATUSES = new Set([200, 207, 422]);

// Instances without the endpoint answer 400 with this in the message.
const MISSING_ENDPOINT = 'does not represent any resource';

/**
 * Publish (activate) one or more flows.
 *
 * @param {object} sdk        SDKClient
 * @param {string[]} flowIDs  sys_ids of flows/subflows to publish
 * @param {string[]} actionIDs sys_ids of custom actions to publish
 * @returns {Promise<{summary: object, results: object[], via: string}>}
 */
export async function publishFlows(sdk, flowIDs = [], actionIDs = []) {
  if (flowIDs.length === 0 && actionIDs.length === 0) {
    throw new Error('Nothing to publish: provide at least one flow or action sys_id.');
  }

  const body = JSON.stringify({
    flows: flowIDs.map(sys_id => ({ sys_id, active: 'true', state: '' })),
    actions: actionIDs.map(sys_id => ({ sys_id, active: 'true', state: '' })),
  });

  // _fetchWithAuth rather than request(): request() throws on any non-2xx, which
  // would discard the 422 body we specifically want to report.
  const resp = await sdk._fetchWithAuth(`${sdk.baseURL}${ACTIVATE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body,
  });

  const text = await resp.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }

  if (RESULT_STATUSES.has(resp.status) && parsed?.result) {
    const { summary, results } = parsed.result;
    return { summary, results: results ?? [], via: 'wfa_fluent' };
  }

  const message = parsed?.result?.error?.message
    ?? parsed?.error?.message
    ?? parsed?.message
    ?? resp.statusText;

  if (message && message.includes(MISSING_ENDPOINT)) {
    return publishViaScript(sdk, flowIDs, actionIDs);
  }

  throw new Error(`Publish failed (HTTP ${resp.status}): ${message}`);
}

/**
 * Fallback: call FlowDesignerUtils.publishAll() through a background script.
 * Same code path the REST endpoint uses internally.
 */
export async function publishViaScript(sdk, flowIDs = [], actionIDs = []) {
  const script = `
var helper = new FlowDesignerUtils();
var result = helper.publishAll({
  flows: ${JSON.stringify(flowIDs.map(sys_id => ({ sys_id, active: 'true', state: '' })))},
  actions: ${JSON.stringify(actionIDs.map(sys_id => ({ sys_id, active: 'true', state: '' })))}
});
gs.print('JSN_PUBLISH_RESULT:' + JSON.stringify(result));
`.trim();

  const out = await sdk.executeScript(script, 'global');
  const text = typeof out === 'string' ? out : (out?.output ?? '');
  const match = text.match(/JSN_PUBLISH_RESULT:(\{.*\})/);
  if (!match) {
    throw new Error(
      'Publish fallback ran but returned no parseable result.\n'
      + 'The wfa_fluent endpoint is missing on this instance -- check that the '
      + 'ServiceNow IDE Platform and IDE Runtime Services plugins are active.',
    );
  }

  const result = JSON.parse(match[1]);
  const items = result.items ?? [];
  const succeeded = result.successCount ?? 0;
  return {
    summary: { total: items.length, succeeded, failed: items.length - succeeded },
    results: items,
    via: 'FlowDesignerUtils',
  };
}

/**
 * Preflight: can this instance publish flows at all?
 *
 * The Now SDK swallows a missing endpoint at debug level, so an install can
 * report success while every flow it deployed stays inert. This surfaces it.
 */
export async function publishDoctor(sdk) {
  const checks = [];

  const defs = await sdk.list('sys_ws_definition', qs({
    sysparm_query: 'service_id=wfa_fluent',
    sysparm_fields: 'sys_id,name,base_uri,active',
    sysparm_limit: '5',
  }));
  const def = defs[0];
  checks.push({
    name: 'wfa_fluent REST API',
    ok: Boolean(def) && str(def, 'active') === 'true',
    detail: def ? `${str(def, 'name')} at ${str(def, 'base_uri')}` : 'not found',
  });

  const ops = await sdk.list('sys_ws_operation', qs({
    sysparm_query: 'relative_path=/activate_flows',
    sysparm_fields: 'sys_id,name,http_method,relative_path,active',
    sysparm_limit: '5',
  }));
  const op = ops[0];
  checks.push({
    name: 'POST /activate_flows operation',
    ok: Boolean(op) && str(op, 'active') === 'true',
    detail: op ? `${str(op, 'http_method')} ${str(op, 'relative_path')}` : 'not found',
  });

  // sys_plugins is commonly blocked by an API-level ACL even for admins, so
  // treat this as supporting evidence: report it when readable, skip it when
  // not. The endpoint checks above are the load-bearing ones -- if they pass,
  // publishing works regardless of what we can see here.
  let plugins = null;
  try {
    plugins = await sdk.list('sys_plugins', qs({
      sysparm_query: 'nameSTARTSWITHServiceNow IDE',
      sysparm_fields: 'name,active',
      sysparm_limit: '20',
    }));
  } catch {
    checks.push({
      name: 'ServiceNow IDE plugins',
      ok: true,
      skipped: true,
      detail: 'not checked — no read access to sys_plugins',
    });
  }

  if (plugins) {
    for (const wanted of ['ServiceNow IDE Platform', 'ServiceNow IDE Runtime Services']) {
      const p = plugins.find(x => str(x, 'name') === wanted);
      checks.push({
        name: wanted,
        ok: Boolean(p) && str(p, 'active') === 'true',
        detail: p ? (str(p, 'active') === 'true' ? 'active' : 'inactive') : 'not found',
      });
    }
  }

  return { ok: checks.every(c => c.ok), checks };
}

/**
 * Is this flow actually going to run?
 *
 * Every check here corresponds to a way a flow can look completely healthy in
 * the UI and still never execute.
 */
export async function flowStatus(sdk, sysID) {
  const flow = await sdk.get('sys_hub_flow', sysID);
  if (!flow) throw new Error(`No flow found with sys_id ${sysID}`);

  const name = str(flow, 'name');
  const type = str(flow, 'type');
  const checks = [];

  const snapshot = str(flow, 'master_snapshot');
  checks.push({
    name: 'Published',
    ok: Boolean(snapshot),
    detail: snapshot ? `snapshot ${snapshot}` : 'never published -- the flow is inert',
  });

  // version selects which generation of instance tables the publisher reads.
  // At 1 it looks in the (empty) v1 tables and publish fails with the very
  // misleading "No Trigger instance found in the flow definition".
  const version = str(flow, 'version');
  checks.push({
    name: 'Engine version',
    ok: version === '2',
    detail: version === '2' ? 'version 2' : `version ${version || 'unset'} -- publish will fail misleadingly; expected 2`,
  });

  // The flow record is the liveness gate, NOT the trigger registration row --
  // deactivating a flow leaves sys_flow_record_trigger.active = 1 behind.
  const active = str(flow, 'active') === 'true';
  checks.push({
    name: 'Active',
    ok: active,
    detail: active ? 'active' : 'inactive -- will not run',
  });

  if (type === 'subflow') {
    checks.push({ name: 'Trigger', ok: true, detail: 'subflow -- invoked, no trigger expected' });
    return { flow: { sysID, name, type }, ok: checks.every(c => c.ok), checks };
  }

  const trig = await triggerInfo(sdk, sysID);
  if (!trig) {
    checks.push({ name: 'Trigger', ok: false, detail: 'no trigger instance found — a flow needs exactly one' });
    return { flow: { sysID, name, type }, ok: false, checks };
  }

  // Only record triggers register a row in sys_flow_record_trigger. Scheduled
  // and application triggers (service_catalog, inbound_email, sla_task,
  // knowledge_management, ...) are dispatched elsewhere, so the registration
  // and condition checks below simply do not apply to them.
  if (!trig.type.startsWith('record_')) {
    checks.push({
      name: 'Trigger',
      ok: true,
      detail: `${trig.type} — not a record trigger, no sys_flow_record_trigger registration expected`,
    });
    return { flow: { sysID, name, type, triggerType: trig.type }, ok: checks.every(c => c.ok), checks };
  }

  const table = trig.table;
  if (!table) {
    checks.push({ name: 'Trigger', ok: false, detail: `${trig.type} trigger has no table set` });
    return { flow: { sysID, name, type, triggerType: trig.type }, ok: false, checks };
  }

  const regs = await sdk.list('sys_flow_record_trigger', qs({
    sysparm_query: `table=${table}`,
    sysparm_fields: 'sys_id,table,condition,active,on_insert,on_update,on_delete',
    sysparm_limit: '100',
  }));

  // NOTE: sys_flow_record_trigger has no column linking a row back to its
  // flow, so these two checks are necessarily table-level, not flow-level.
  // Say so rather than implying per-flow precision.
  const scope = `${table} (table-wide — registrations cannot be attributed to a single flow)`;

  checks.push({
    name: 'Trigger registered',
    ok: regs.length > 0,
    detail: regs.length
      ? `${regs.length} registration(s) on ${scope}`
      : `no registration on ${table} — nothing on this table is registered, so this flow is inert`,
  });

  // An empty/null condition is never matched -- it does not mean "always".
  // Flow Designer writes "^EQ" for "no condition"; tools that write "" produce
  // a flow that reports published + active and silently never fires.
  const nullCondition = regs.filter(r => !str(r, 'condition'));
  if (regs.length) {
    checks.push({
      name: 'Trigger condition',
      ok: nullCondition.length === 0,
      detail: nullCondition.length === 0
        ? `all ${regs.length} registration(s) on ${table} have a condition set`
        : `${nullCondition.length} of ${regs.length} registration(s) on ${scope} have an empty condition — those never fire (expected "^EQ" for "no condition")`,
    });
  }

  return { flow: { sysID, name, type, table }, ok: checks.every(c => c.ok), checks };
}

/**
 * The flow's trigger type, and its table when it is a record trigger.
 * Returns null when the flow has no trigger instance at all.
 */
async function triggerInfo(sdk, flowSysID) {
  for (const tbl of ['sys_hub_trigger_instance_v2', 'sys_hub_trigger_instance']) {
    let rows;
    try {
      rows = await sdk.list(tbl, qs({
        sysparm_query: `flow=${flowSysID}`,
        sysparm_fields: 'sys_id,trigger_type,trigger_inputs',
        sysparm_limit: '5',
      }));
    } catch { continue; } // table may not exist on this release
    for (const row of rows) {
      const type = str(row, 'trigger_type');
      if (!type) continue;
      // trigger_inputs is gzip+base64 JSON: the full denormalized input list
      // for the trigger type, of which we only want the "table" entry.
      const inputs = decodeGzipJson(row?.trigger_inputs);
      const t = Array.isArray(inputs) ? inputs.find(i => i?.name === 'table') : null;
      return { type, table: t?.value ? String(t.value) : null };
    }
  }
  return null;
}

function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) p.set(k, v);
  return p;
}

function str(record, field) {
  const v = record?.[field];
  if (v && typeof v === 'object') return String(v.value ?? v.display_value ?? '');
  return v == null ? '' : String(v);
}
