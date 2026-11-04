// Catalog item enrichment — one place that reads a catalog item and shapes it
// for output. `catalogitems show` owns the user-facing view (and the
// describe/inputs aliases); `catalogitems order` reuses the same request-side
// read, so both agree on what a question is.
//
// Two calls, one answer:
//   1. the Table API (sc_cat_item + item_option_new) — the definition, always
//      readable, and the fallback when the catalog API cannot answer;
//   2. /api/sn_sc/servicecatalog/items/{id} — what this account can actually
//      request, with the variables a submission must answer.
// The catalog API wins when it answers; the definition list keeps the command
// useful when it does not (a producer whose server script throws, an item that
// is not in the catalog).

import { getStringField } from '../../helpers.js';

export const CATALOG_API = '/api/sn_sc/servicecatalog/items';

// Layout entries draw the form; they are not values a caller can send.
// Codes are item_option_new.type on a live instance (11 label, 14 macro,
// 17 macro with label, 19/20/24 containers, 23 html, 32 rich text label).
const LAYOUT_CODES = new Set([11, 14, 17, 19, 20, 23, 24, 32]);
const LAYOUT_TYPES = new Set([
  'container_start', 'container_end', 'container_split',
  'label', 'rich_text_label', 'html', 'break', 'formatter',
  'macro', 'macro_with_abel', 'ui_macro',
]);
// "Requested for" (type 31) is mandatory in the API payload but is not a value
// the caller builds: the instance fills it from the session and --requested-for
// overrides it. It is reported separately so it never blocks an order.
export const REQUESTED_FOR = 31;
// item_option_new.type code → the same friendly word the catalog API uses, so
// the definition fallback and the API payload render identically. Codes taken
// from this instance's type choices; unknown codes fall back to null.
const TYPE_NAMES = {
  1: 'yes_no', 2: 'multi_line_text', 3: 'multiple_choice', 4: 'numeric_scale',
  5: 'select_box', 6: 'single_line_text', 7: 'check_box', 8: 'reference',
  9: 'date', 10: 'date_time', 11: 'label', 14: 'macro', 16: 'wide_single_line_text',
  17: 'macro_with_abel', 18: 'lookup_select_box', 19: 'container_start',
  20: 'container_end', 21: 'list_collector', 23: 'html', 24: 'container_split',
  25: 'masked', 26: 'email', 28: 'ip', 29: 'duration', 31: 'requested_for',
  32: 'rich_text_label', 33: 'attachment', 40: 'table_name',
};

/** Raw value of a field: list rows come back as {value, display_value}. */
function rawValue(row, field) {
  const v = row?.[field];
  return v && typeof v === 'object' ? v.value : v;
}

export const isInstanceSupplied = v => v?.friendly_type === 'requested_for' || Number(v?.type) === REQUESTED_FOR;
const object = v => v && typeof v === 'object' && !Array.isArray(v);

/** Read the item from the catalog API. Throws when the instance refuses. */
export async function readCatalogApiItem(sdk, sysID) {
  const response = await sdk.request(`${sdk.baseURL}${CATALOG_API}/${sysID}`, { method: 'GET' });
  if (!object(response?.result) || response.result.sys_id !== sysID) {
    const error = new Error('Catalog API returned no readable item with the requested identity.');
    error.code = 'api_error';
    throw error;
  }
  return response.result;
}

/**
 * Flatten a catalog API `variables` tree into the questions a caller can
 * answer. Containers are walked for their children; every other layout entry
 * is dropped. A name is reported once — the API can repeat a variable inside a
 * container.
 */
export function shapeVariables(list, out = [], seen = new Set()) {
  if (!Array.isArray(list)) return out;
  for (const entry of list) {
    if (!object(entry)) continue;
    const friendly = typeof entry.friendly_type === 'string' ? entry.friendly_type : '';
    const name = typeof entry.name === 'string' ? entry.name : '';
    if (name && !LAYOUT_TYPES.has(friendly) && !seen.has(name)) {
      seen.add(name);
      out.push({
        name,
        label: entry.label || entry.question_text || name,
        type: entry.type ?? null,
        friendly_type: friendly || null,
        mandatory: entry.mandatory === true || entry.mandatory === 'true',
        instance_supplied: isInstanceSupplied(entry),
      });
    }
    if (Array.isArray(entry.children)) shapeVariables(entry.children, out, seen);
  }
  return out;
}

/** Shape one item_option_new row into the same question shape. */
function questionFromRow(row) {
  const code = Number(rawValue(row, 'type'));
  const name = getStringField(row, 'name');
  if (!name || LAYOUT_CODES.has(code)) return null;
  return {
    name,
    label: getStringField(row, 'question_text') || name,
    type: Number.isFinite(code) ? code : null,
    friendly_type: TYPE_NAMES[code] ?? null,
    mandatory: String(rawValue(row, 'mandatory')) === 'true',
    instance_supplied: code === REQUESTED_FOR,
  };
}

/** Required / instance-supplied names for a question list. */
export function requestDetails(variables) {
  return {
    required: variables.filter(v => v.mandatory && !v.instance_supplied).map(v => v.name),
    instanceSupplied: variables.filter(v => v.instance_supplied).map(v => v.name),
  };
}

/**
 * Fetch a catalog item and assemble the full show envelope.
 *
 * @returns {Promise<{data: object, variables: Array, totalVars: number, source: string}>}
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
  const rows = await sdk.list('item_option_new', vp);

  let apiItem = null;
  let apiError = '';
  if (typeof sdk.request === 'function' && typeof sdk.baseURL === 'string') {
    try {
      apiItem = await readCatalogApiItem(sdk, sysID);
    } catch (error) {
      apiError = error?.message || 'catalog API read failed';
    }
  }

  const fromApi = Array.isArray(apiItem?.variables);
  const variables = fromApi
    ? shapeVariables(apiItem.variables)
    : rows.map(questionFromRow).filter(Boolean);
  const source = fromApi ? 'catalog_api' : 'item_option_new';

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
  const planName = getStringField(item, 'delivery_plan') || getStringField(item, 'execution_plan') || '';
  const details = requestDetails(variables);

  const data = {
    name: getStringField(item, 'name'),
    short_description: getStringField(item, 'short_description'),
    category: getStringField(item, 'category'),
    active: getStringField(item, 'active'),
    url: `${instanceUrl}/sc_cat_item.do?sys_id=${sysID}`,
    flow: flowName || undefined,
    flow_cmd: flowCmd || undefined,
    workflow: wfName || undefined,
    execution_plan: planName || undefined,
    variables,
    variables_source: source,
    variables_reported: fromApi,
    required_variables: details.required,
    instance_supplied_variables: details.instanceSupplied,
    ...(apiError ? { variables_api_error: apiError } : {}),
  };

  return { data, variables, totalVars: variables.length, source };
}

/**
 * Styled-mode rendering of an enriched catalog item.
 */
export function buildCatalogFormatted(data, variables = data.variables || [], source = data.variables_source) {
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
    lines.push('');
  }
  if (variables.length) {
    lines.push(`─ Catalog Questions (${source === 'catalog_api' ? 'catalog API' : 'item_option_new'}) ─`);
    for (const v of variables) {
      const type = v.friendly_type || (v.type === null ? '?' : String(v.type));
      const flags = [v.mandatory ? 'required' : '', v.instance_supplied ? 'instance-supplied' : ''].filter(Boolean);
      lines.push(`  ${v.name}  ${v.label}  [${type}]${flags.length ? `  (${flags.join(', ')})` : ''}`);
    }
    if (data.required_variables?.length) lines.push(`  required:  ${data.required_variables.join(', ')}`);
    if (data.instance_supplied_variables?.length) lines.push(`  instance-supplied:  ${data.instance_supplied_variables.join(', ')}`);
    lines.push('');
  }
  if (data.variables_api_error) {
    lines.push('─ Catalog API ─');
    lines.push(`  unavailable:  ${data.variables_api_error}`);
    lines.push('');
  }
  return lines.join('\n');
}
