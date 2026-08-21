// Catalog item enrichment — pure async data-shaping for `catalogitems show`.
//
// Given an sdk handle, an instance URL and an item sys_id, return the
// enriched item: core fields resolved to display values, flow name resolved
// through the sys_hub_flow fallback chain, workflow/delivery-plan fallback,
// and variables grouped by variable set. No yargs, no output formatting —
// callers own the envelope and rendering.

import { getStringField } from '../../helpers.js';

/**
 * Fetch a catalog item and assemble the full show envelope.
 *
 * @param {object} deps
 * @param {object} deps.sdk - SDK handle (list/get).
 * @param {string} deps.instanceUrl - Effective instance URL (for the item link).
 * @param {string} deps.sysID - sc_cat_item sys_id.
 * @returns {Promise<{data: object, standalone: Array, setVars: Array, totalVars: number}>}
 *   data is the envelope payload (no _formatted — the caller attaches it);
 *   standalone/setVars/totalVars are the raw groupings needed by
 *   buildCatalogFormatted.
 */
export async function enrichCatalogItem({ sdk, instanceUrl, sysID }) {
  // Use list + display_value=all so reference fields (category, flow) resolve
  // to readable display values instead of raw sys_ids.
  const p = new URLSearchParams();
  p.set('sysparm_query', `sys_id=${sysID}`);
  p.set('sysparm_limit', '1');
  p.set('sysparm_display_value', 'all');
  const items = await sdk.list('sc_cat_item', p);
  const item = items[0] || null;
  if (!item) throw new Error(`Not found: ${sysID}`);

  const vp = new URLSearchParams();
  vp.set('sysparm_query', `cat_item=${sysID}^active=true`);
  vp.set('sysparm_limit', '100');
  vp.set('sysparm_display_value', 'all');
  vp.set('sysparm_fields', 'sys_id,name,question_text,type,order,mandatory,variable_set');
  const variables = await sdk.list('item_option_new', vp);

  const standalone = [];
  const setVars = new Map();
  for (const v of variables) {
    const vs = getStringField(v, 'variable_set');
    const entry = {
      name: getStringField(v, 'name'),
      question_text: getStringField(v, 'question_text'),
      type: getStringField(v, 'type'),
      mandatory: getStringField(v, 'mandatory'),
    };
    if (vs) {
      if (!setVars.has(vs)) setVars.set(vs, { name: vs, variables: [] });
      setVars.get(vs).variables.push(entry);
    } else {
      standalone.push(entry);
    }
  }
  const totalVars = standalone.length + Array.from(setVars.values()).reduce((a, s) => a + s.variables.length, 0);

  // Resolve flow name
  let flowName = '', flowCmd = '';
  const flowVal = item.flow_designer_flow;
  if (flowVal?.value) {
    const fn = getStringField(item, 'flow_designer_flow');
    if (fn === flowVal.value) {
      try { const fr = await sdk.get('sys_hub_flow', flowVal.value); flowName = getStringField(fr, 'name') || ''; } catch { flowName = fn; }
    } else { flowName = fn; }
    flowCmd = `jsn flows show ${flowVal.value}`;
  }
  const wfName = getStringField(item, 'workflow') || '';
  const wfID = item.workflow?.value || '';
  const planName = getStringField(item, 'delivery_plan') || getStringField(item, 'execution_plan') || '';

  const data = {
    name: getStringField(item, 'name'),
    short_description: getStringField(item, 'short_description'),
    category: getStringField(item, 'category'),
    active: getStringField(item, 'active'),
    url: `${instanceUrl}/sc_cat_item.do?sys_id=${sysID}`,
    flow: flowName || undefined,
    flow_cmd: flowCmd || undefined,
    workflow: wfName || undefined,
    workflow_cmd: (wfName && wfID) ? `jsn workflows show ${wfID}` : undefined,
    execution_plan: planName || undefined,
    variables: totalVars > 0 ? {
      count: totalVars,
      standalone: standalone.map(v => ({ label: v.question_text || v.name, type: v.type, mandatory: String(v.mandatory) === 'true' })),
      sets: Array.from(setVars.values()).map(s => ({ name: s.name, variables: s.variables.map(v => ({ label: v.question_text || v.name, type: v.type, mandatory: String(v.mandatory) === 'true' })) })),
    } : undefined,
  };

  return { data, standalone, setVars: Array.from(setVars.values()), totalVars };
}

/**
 * Styled-mode rendering of an enriched catalog item. Kept verbatim from the
 * original catalog.js — the output layer is being reworked elsewhere, so this
 * stays byte-identical for now.
 */
export function buildCatalogFormatted(data, standalone, setVars, totalVars) {
  const lines = [];
  lines.push(`${data.name} (sc_cat_item)`);
  lines.push('');
  lines.push('─ Details ─');
  if (data.short_description) lines.push(`  short_description:  ${data.short_description}`);
  if (data.category) lines.push(`  category:  ${data.category}`);
  lines.push(`  active:  ${data.active}`);
  if (data.url) lines.push(`  url:  ${data.url}`);
  if (data.execution_plan) lines.push(`  execution_plan:  ${data.execution_plan}`);
  lines.push('');
  if (data.flow) {
    lines.push('─ Flow ─');
    lines.push(`  ${data.flow}`);
    if (data.flow_cmd) lines.push(`  → ${data.flow_cmd}`);
    lines.push('');
  }
  if (data.workflow) {
    lines.push('─ Workflow ─');
    lines.push(`  ${data.workflow}`);
    if (data.workflow_cmd) lines.push(`  → ${data.workflow_cmd}`);
    lines.push('');
  }
  if (totalVars > 0) {
    lines.push('─ Catalog Variables ─');
    for (const v of standalone) {
      const label = v.question_text || v.name;
      lines.push(`  ${label}:  ${v.type}${String(v.mandatory) === 'true' ? ' (mandatory)' : ''}`);
    }
    for (const s of setVars) {
      lines.push(`  [${s.name}]`);
      for (const v of s.variables) {
        const label = v.question_text || v.name;
        lines.push(`    ${label}:  ${v.type}${String(v.mandatory) === 'true' ? ' (mandatory)' : ''}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}
