import { readFileSync } from 'node:fs';
import { cachedSchedules } from './schedule-cache.js';
import { AppError } from './errors.js';

export function scheduleSnapshot({ bundled = false } = {}) {
  const cached = !bundled && cachedSchedules();
  if (cached) return cached;
  const current = JSON.parse(readFileSync(new URL('./schedules/itom-2026-04-09.json', import.meta.url), 'utf8'));
  const inventory = JSON.parse(readFileSync(new URL('./schedules/public-inventory.json', import.meta.url), 'utf8'));
  return {
    schedules: [{ ...current, product: 'ITOM', measurement: 'illustrative-population', normalization_status: 'normalized', skus: [] }, ...inventory],
    provenance: { source: 'bundled', stale: true, freshness: 'bundled fallback; no network freshness check' },
  };
}
export function scheduleCatalog({ product, sku, id, bundled = false, snapshot } = {}) {
  return (snapshot || scheduleSnapshot({ bundled })).schedules
    .filter(s => (!product || s.product.toUpperCase() === product.toUpperCase()) && (!sku || (s.skus || []).includes(sku)) && (!id || s.id === id));
}
export function formatSchedule(schedule) {
  const lines = [];
  const label = key => key.replaceAll('_', ' ');
  const render = (value, indent = '') => {
    if (Array.isArray(value)) return value.flatMap(item => typeof item === 'object' && item !== null ? [`${indent}-`, ...render(item, `${indent}  `)] : [`${indent}- ${item}`]);
    if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => item && typeof item === 'object' ? [`${indent}${label(key)}:`, ...render(item, `${indent}  `)] : [`${indent}${label(key)}: ${item ?? 'not specified'}`]);
    return [`${indent}${value ?? 'not specified'}`];
  };
  for (const [key, value] of Object.entries(schedule)) {
    if (key === 'definitions' && Array.isArray(value)) {
      lines.push('DEFINITIONS', ...value.map(d => `- ${d.term}: ${d.definition} [${d.source_sections?.join('; ') || schedule.source_sections?.join('; ') || 'see source'}]`));
    } else if (key === 'meter') {
      lines.push('METER', ...render(Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'rules'))));
      if (value.rules) lines.push('USAGE RULES', ...value.rules.map(rule => {
        const name = rule.skill || rule.capability;
        const action = rule.action || rule.usage;
        const rate = rule.assists !== undefined ? (rule.assists === null ? rule.rate_reference || 'conditional; see conditions' : `${rule.assists} Assist`) : `${rule.credits} Credit`;
        const detail = Object.fromEntries(Object.entries(rule).filter(([k]) => !['skill', 'capability', 'action', 'usage', 'assists', 'credits'].includes(k)));
        return `- ${name}: ${action} — ${rate}${Object.keys(detail).length ? `; ${render(detail).join('; ')}` : ''}`;
      }));
    } else {
      lines.push(label(key).toUpperCase(), ...render(value));
    }
  }
  return lines.join('\n');
}

export function loadSchedule(id = 'itom-2026-04-09') {
  const selected = scheduleCatalog({ id, bundled: true });
  if (selected.length !== 1) throw new AppError('unsupported_schedule', 'No bundled schedule for this selection.', 'Run jsn subscriptions schedules for exact IDs.');
  return selected[0];
}
const malformed = () => new AppError('malformed', 'Source response is incomplete or malformed.');
async function read(sdk, kind, table, params) {
  return sdk.request(`${sdk.baseURL}/api/now/${kind}/${table}?${new URLSearchParams(params)}`, { method: 'GET', readOnly: true });
}
async function count(sdk, table, query) {
  const body = await read(sdk, 'stats', table, { sysparm_count: 'true', sysparm_query: query });
  const value = body?.result?.stats?.count;
  if (!/^(0|[1-9]\d*)$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw malformed();
  return Number(value);
}
async function rows(sdk, table, query, fields, cap, offset = 0) {
  const body = await read(sdk, 'table', table, { sysparm_query: query, sysparm_fields: fields, sysparm_limit: String(cap), sysparm_offset: String(offset), sysparm_display_value: 'false', sysparm_exclude_reference_link: 'true' });
  if (!Array.isArray(body?.result)) throw malformed();
  return body.result;
}
function status(error) {
  if (error.status === 403 || error.code === 'forbidden') return 'forbidden';
  if (error.status === 404) return 'missing-or-hidden';
  return ['malformed', 'schema_unavailable'].includes(error.code) ? error.code : 'unavailable';
}

export async function estimateSubscription(sdk, product, { schedule, assumeEligible = false } = {}) {
  if (String(product).toUpperCase() !== 'ITOM') {
    if (scheduleCatalog({ product }).length) throw new AppError('measurement_unavailable', 'Known catalog product; measurement is unimplemented.', 'Inspect subscriptions schedules --product with this product. No role or CI population is substituted.');
    throw new AppError('unsupported_product', 'No verified product meter is bundled for this selection.', 'Run jsn subscriptions schedules. HRSD eligible population and contractual meter remain unverified; role counts are not billable seats.');
  }
  const selected = loadSchedule(schedule);
  if (selected.product !== 'ITOM' || selected.measurement !== 'illustrative-population') throw new AppError('measurement_unavailable', 'This exact schedule is catalog-only; its measurement adapter is unimplemented.', 'Inspect subscriptions schedules --id with this schedule ID. No current ITOM ratios are substituted.');
  const report = {
    product: 'ITOM', captured_at: new Date().toISOString(), schedule: selected,
    applicability: schedule ? 'explicit schedule selection; contractual SKU applicability unverified' : 'provisional April 9, 2026 schedule assumption; product name does not prove SKU applicability',
    eligibility_assumption: assumeEligible ? 'Hypothetically all visible mapped populations are ITOM-managed and meet component/product requirements; exclusions remain unevaluated.' : 'No eligibility assumed; units withheld. Use --assume-eligible only for an illustrative activation scenario.',
    status: 'incomplete', total_units: null, authoritative: false, categories: [],
  };
  let definitions, byId, byName;
  report.coverage = { metadata_status: 'unavailable', visible_definitions: null, provider_count: null, skipped_ancestries: 0, semantics: 'Provider-visible exact-class aggregate counts only; ACL-hidden rows and concurrent changes remain unknown.' };
  try {
    // Include scoped/custom descendants, whose names need not start with cmdb_ci.
    const available = await count(sdk, 'sys_db_object', '');
    report.coverage.provider_count = available;
    definitions = [];
    const ids = new Set();
    let ordered = true;
    let previous;
    let pages = 0;
    let offset = 0;
    // Offset addresses provider windows, including rows omitted by visibility.
    // Short pages are not exhaustion; stable counts and unique rows are required.
    while (offset < available && offset < 20000 && pages < 200) {
      const limit = Math.min(1000, available - offset, 20000 - offset);
      const page = await rows(sdk, 'sys_db_object', 'ORDERBYsys_id', 'sys_id,name,super_class', limit, offset);
      offset += limit;
      pages++;
      if (page.length > limit) throw malformed();
      if (!page.length) break;
      for (const d of page) {
        if (!d || typeof d.sys_id !== 'string' || !d.sys_id.trim() || ids.has(d.sys_id)) throw malformed();
        if (previous !== undefined && d.sys_id <= previous) ordered = false;
        previous = d.sys_id;
        ids.add(d.sys_id);
      }
      definitions.push(...page);
    }
    const after = await count(sdk, 'sys_db_object', '');
    report.coverage.provider_count_after = after;
    report.coverage.metadata_pages = pages;
    report.coverage.visible_definitions = definitions.length;
    report.coverage.metadata_status = ordered && available === after && definitions.length === available ? 'provider-count-matched' : 'partial';
    byId = new Map(definitions.map(d => [d.sys_id, d]));
    byName = new Map(definitions.map(d => [d.name, d]));
    if (byId.size !== definitions.length || byName.size !== definitions.length || !byName.has('cmdb_ci') || definitions.some(d => typeof d.name !== 'string' || typeof d.super_class !== 'string')) throw malformed();
    const dictionary = await rows(sdk, 'sys_dictionary', 'name=cmdb_ci^element=sys_class_name', 'name,element,internal_type', 2);
    if (dictionary.length !== 1 || dictionary[0].name !== 'cmdb_ci' || dictionary[0].element !== 'sys_class_name' || !['sys_class_name', 'string'].includes(dictionary[0].internal_type)) throw new AppError('schema_unavailable', 'Class discriminator schema unavailable.');
  } catch (error) {
    report.categories = selected.categories.map(c => ({ category: c.id, resources_per_su: c.resources_per_su, status: status(error), population: null, illustrative_units: null }));
    return report;
  }
  const assigned = new Map(selected.categories.map(c => [c.id, []]));
  const ambiguous = new Set();
  for (const definition of definitions) {
    const ancestry = new Set();
    let current = definition;
    while (current) {
      if (ancestry.has(current.name)) throw malformed();
      ancestry.add(current.name);
      if (!current.super_class) break;
      current = byId.get(current.super_class);
      if (!current) { report.coverage.skipped_ancestries++; break; }
    }
    if (!current || !ancestry.has('cmdb_ci') || !/^[a-zA-Z0-9_]+$/.test(definition.name)) continue;
    let matches = selected.categories.filter(c => c.classes.some(name => ancestry.has(name)));
    if (matches.length > 1) matches = matches.filter(c => c.id !== 'end_user_device');
    if (matches.length > 1) { matches.forEach(c => ambiguous.add(c.id)); continue; }
    if (matches.length === 1) assigned.get(matches[0].id).push(definition.name);
  }
  for (const category of selected.categories) {
    const item = { category: category.id, resources_per_su: category.resources_per_su, population: null, illustrative_units: null, status: 'unsupported', missing_classes: category.classes.filter(n => !byName.has(n)), mapping_complete: false };
    const classes = assigned.get(category.id);
    item.mapping_complete = report.coverage.metadata_status === 'provider-count-matched' && report.coverage.skipped_ancestries === 0 && !item.missing_classes.length && category.id !== 'paas' && category.id !== 'unresolved_object' && !ambiguous.has(category.id);
    if (ambiguous.has(category.id)) item.status = 'ambiguous-overlap';
    else if (classes.length) {
      try {
        item.population = await count(sdk, 'cmdb_ci', `sys_class_nameIN${classes.sort().join(',')}`);
        item.status = item.mapping_complete ? 'visible-population' : 'partial-mapping';
        if (assumeEligible) item.illustrative_units = item.population / category.resources_per_su;
      } catch (error) { item.status = status(error); }
    } else item.status = category.id === 'unresolved_object' ? 'unsupported-source-schema' : 'missing-or-hidden';
    report.categories.push(item);
  }
  return report;
}

export function formatEstimate(report) {
  return [
    'ITOM illustrative population comparison: INCOMPLETE, no authoritative total',
    `Schedule: ${report.schedule.id}. ${report.applicability}`,
    `Source: ${report.schedule.source_url}`,
    `Metadata: ${report.coverage.metadata_status}, ${report.coverage.visible_definitions ?? '?'} definitions / ${report.coverage.provider_count ?? '?'} provider count; ${report.coverage.skipped_ancestries} unresolved ancestries`,
    report.coverage.semantics,
    report.eligibility_assumption,
    'CATEGORY | VISIBLE POPULATION | RESOURCES/SU | ILLUSTRATIVE SU | COVERAGE',
    ...report.categories.map(c => `${c.category} | ${c.population ?? '?'} | ${c.resources_per_su} | ${c.illustrative_units ?? '?'} | ${c.status}`),
    report.schedule.unresolved_mapping,
    ...report.schedule.limitations,
  ].join('\n');
}
