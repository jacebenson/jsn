import { AppError, errUsage } from './errors.js';
import { inventorySources, readInventory } from './instance-inventory.js';
import { MAX_SESSION_REPLAYS } from './session-recovery.js';

const candidates = {
  entitlements: ['license_details', 'subscription_entitlement'],
  allocation: ['subscription_detail', 'account_subscription_entitlement', 'instance_subscription_entitlement'],
  consumption: ['itom_lu_ci_counts', 'usageanalytics_count', 'itom_lu_licensable_cis'],
};
const limits = { metadata_requests: 96, data_requests: 16, inheritance_depth: 16, dictionary_rows: 200 };
const namePattern = /^[a-zA-Z0-9_]+$/;
const idPattern = /^[a-f0-9]{32}$/i;
const raw = value => value && typeof value === 'object' ? value.value : value;
const text = value => typeof raw(value) === 'string' ? raw(value) : '';
const fail = reason => { throw new AppError(reason, 'Evidence source unavailable.'); };
const numeric = ['integer', 'longint', 'decimal', 'float', 'numeric'];
const strings = ['string', 'choice'];
const dates = ['glide_date', 'glide_date_time'];
// Field names are a conservative projection vocabulary, not a product meter or
// a claim that any particular subscription table implements these fields.
const fields = {
  product_name: strings, product_code: strings, sku: strings,
  license_type: strings, subscription_type: strings, unit: strings,
  status: [...strings, 'integer'], state: [...strings, 'integer'],
  active: ['boolean'], is_latest: ['boolean'],
  quantity: numeric, purchased_quantity: numeric, allocated_quantity: numeric,
  allocated: numeric, used: numeric, consumption: numeric, count: numeric,
  ci_count: numeric, licensable_count: numeric,
  sample_date: dates, start_date: dates, end_date: dates, effective_date: dates,
  sys_updated_on: dates,
};

export function evidenceLimit(value = 50) {
  if (!Number.isInteger(value) || value < 1 || value > 200) throw errUsage('--limit must be an integer from 1 to 200.');
  return value;
}

function reason(error) {
  if (error?.status === 401 || error?.code === 'auth_error') throw new AppError('auth_error', 'Authentication failed while reading subscription evidence.');
  if (error?.status === 403 || error?.code === 'forbidden') return 'forbidden';
  if (error?.status === 404) return 'missing-or-hidden';
  return ['malformed', 'schema-unavailable', 'metadata-cap', 'inheritance-limit', 'request-budget', 'ambiguous-schema'].includes(error?.code) ? error.code : 'unavailable';
}

function safeValue(value, type) {
  value = raw(value);
  if (value === null || value === undefined || value === '') return null;
  if (numeric.includes(type)) return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(String(value)) && Number.isFinite(Number(value)) ? String(value) : null;
  if (type === 'boolean') return value === true || value === 'true' || value === '1' ? true : value === false || value === 'false' || value === '0' ? false : null;
  if (dates.includes(type)) return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z?)?$/.test(value) ? value : null;
  // Do not emit reference display values, URLs, emails, sys_ids, free-form
  // descriptions, or control characters. Product/status labels remain observations.
  return typeof value === 'string' && /^[\w ()+.,:/-]{1,120}$/.test(value)
    && !/https?:|www\.|[a-f0-9]{32}/i.test(value) ? value : null;
}

// The inventory's single installed-tab page is a known read-only POST, not a
// general exception to GET-only evidence reads. Match its exact URL and payload
// before bypassing the SDK's method-based readOnly guard; retain no-touch auth.
export async function requestSubscriptionEvidence(sdk, endpoint, options = {}) {
  const method = options.method || 'GET';
  const installedURL = `${sdk.baseURL}/api/sn_appclient/appmanager/apps?${new URLSearchParams({ tab_context: 'installed', sysparm_limit: '200', sysparm_offset: '0' })}`;
  const installedDiscovery = method === 'POST' && endpoint === installedURL && options.body === '{}'
    && Object.keys(options).every(key => key === 'method' || key === 'body');
  const url = new URL(endpoint);
  const tableRead = method === 'GET' && url.origin === new URL(sdk.baseURL).origin
    && !url.username && !url.password && !url.hash && /^\/api\/now\/(table|stats)\/[a-zA-Z0-9_]+$/.test(url.pathname);
  if (!tableRead && !installedDiscovery) fail('unsafe-evidence-request');
  return sdk.request(endpoint, { ...options, method, readOnly: !installedDiscovery, touchLastSeen: false, timeout: 10000 });
}

export async function subscriptionEvidence(sdk, { limit = 50 } = {}) {
  evidenceLimit(limit);
  const requests = { metadata: 0, data: 0 };
  const cache = new Map();
  async function request(kind, endpoint, options = {}) {
    const cap = limits[`${kind}_requests`];
    if (requests[kind] >= cap) fail('request-budget');
    requests[kind]++;
    try { return await requestSubscriptionEvidence(sdk, endpoint, options); }
    catch (error) {
      const code = reason(error);
      throw new AppError(code, 'Evidence source unavailable.', '', code === 'forbidden' ? 403 : code === 'missing-or-hidden' ? 404 : 0);
    }
  }
  async function rows(kind, table, query, projection, cap) {
    const params = new URLSearchParams({ sysparm_query: query, sysparm_fields: projection.join(','), sysparm_limit: String(cap), sysparm_display_value: 'false', sysparm_exclude_reference_link: 'true' });
    const response = await request(kind, `${sdk.baseURL}/api/now/table/${table}?${params}`);
    if (!Array.isArray(response?.result) || response.result.length > cap || response.result.some(r => !r || typeof r !== 'object' || Array.isArray(r))) fail('malformed');
    return response.result;
  }
  function metadata(table, query, projection, cap) {
    const key = `${table}:${query}`;
    if (!cache.has(key)) cache.set(key, rows('metadata', table, query, projection, cap));
    return cache.get(key);
  }
  async function schema(table) {
    const selected = new Map(), references = [], visited = new Set();
    let query = `name=${table}`;
    for (let depth = 0; depth < limits.inheritance_depth; depth++) {
      const definitions = await metadata('sys_db_object', query, ['sys_id', 'name', 'super_class'], 2);
      if (!definitions.length) fail('schema-unavailable');
      if (definitions.length !== 1) fail('ambiguous-schema');
      const definition = definitions[0], name = text(definition.name), parent = text(definition.super_class);
      if (!namePattern.test(name) || (depth === 0 && name !== table) || visited.has(name)
        || !idPattern.test(text(definition.sys_id)) || typeof raw(definition.super_class) !== 'string') fail('malformed');
      visited.add(name);
      const dictionary = await metadata('sys_dictionary', `name=${name}^elementISNOTEMPTY^ORDERBYelement`, ['name', 'element', 'internal_type', 'reference'], limits.dictionary_rows + 1);
      if (dictionary.length > limits.dictionary_rows) fail('metadata-cap');
      const local = new Set();
      for (const row of dictionary) {
        const element = text(row.element), type = text(row.internal_type), target = text(row.reference);
        if (text(row.name) !== name || !namePattern.test(element) || !namePattern.test(type) || local.has(element)
          || !Object.hasOwn(row, 'reference') || typeof raw(row.reference) !== 'string') fail('malformed');
        local.add(element);
        if (selected.has(element)) continue;
        if (target && !namePattern.test(target)) fail('malformed');
        selected.set(element, { type, reference: target });
        if (target) references.push({ table: name, field: element, target });
      }
      if (!parent) return { fields: selected, references, hierarchy: [...visited] };
      if (!idPattern.test(parent)) fail('malformed');
      query = `sys_id=${parent}`;
    }
    fail('inheritance-limit');
  }
  const capturedAt = new Date().toISOString();
  const report = {
    captured_at: capturedAt, authoritative: false,
    limitations: [
      'Provider-visible instance evidence only; not purchased rights, contract validity, compliance, billable seats or bills.',
      'Installed apps/plugins are possibilities and hints only. Nonproduction installs do not prove production deployment or bills. Environment and production status are not detected.',
      'No subscription-to-app joins, cross-source totals, SKU applicability, meters or 90-day averages are inferred. Source field labels do not establish charging semantics.',
      'Missing/forbidden sources are unavailable, not zero. Successful empty results mean no visible rows, not absence of rights or use. ACL visibility and snapshot consistency are unknown.',
    ],
    entitlements: [], allocation: [], consumption: [],
    access: { source: 'sys_user_has_role', status: 'unavailable', reason: 'SDK aggregate supports count and groupBy, not a bounded distinct-user aggregate; role assignments are not allocated or billable seats. No user-role rows were fetched.' },
    installed_hints: [],
    request_budget: {
      limits: { ...limits }, used: requests,
      http_attempt_ceiling: { metadata: limits.metadata_requests * (1 + MAX_SESSION_REPLAYS), data: limits.data_requests * (1 + MAX_SESSION_REPLAYS) },
      scope: 'Collector SDK dispatch caps and API HTTP attempt ceilings including bounded SDK session replay; authentication bootstrap/refresh is separate. Each API attempt has a 10-second timeout.',
    },
  };
  function source(table) {
    return { source: table, observed_at: capturedAt, status: 'unavailable', reason: null, observations: null,
      freshness: { collection: capturedAt, source_updated_on: 'unknown; collection time is not source freshness' },
      coverage: { complete: false, limit, truncated: null, visibility: 'provider-visible only; no completeness claim' } };
  }
  for (const [section, tables] of Object.entries(candidates)) for (const table of tables) {
    const result = source(table);
    report[section].push(result);
    try {
      const info = await schema(table);
      const projection = [...info.fields].filter(([name, field]) => fields[name]?.includes(field.type) && !field.reference).map(([name]) => name);
      result.schema = { status: 'verified-visible', hierarchy: info.hierarchy, fields: projection.map(name => ({ name, type: info.fields.get(name).type })), references: info.references };
      if (!projection.length) fail('schema-unavailable');
      const latest = table === 'subscription_detail' && projection.includes('is_latest');
      result.query = `${latest ? 'is_latest=true^' : ''}ORDERBYsys_id`;
      if (table === 'subscription_detail') result.latest_filter = latest ? 'verified boolean is_latest=true' : 'unavailable; current/latest allocation is not established';
      const page = await rows('data', table, result.query, projection, limit + 1);
      result.observations = page.slice(0, limit).map(row => Object.fromEntries(projection.map(name => [name, safeValue(row[name], info.fields.get(name).type)])));
      result.status = page.length ? 'observed' : 'no-visible-rows';
      result.coverage.truncated = page.length > limit;
      result.coverage.returned = result.observations.length;
      result.freshness.source_updated_on = projection.includes('sys_updated_on') ? 'Per-row sys_updated_on where visible and valid; not a source-wide freshness guarantee' : 'unavailable; no verified update timestamp';
    } catch (error) { result.reason = reason(error); }
  }
  // Existing inventory readers preserve installation evidence and provider count
  // uncertainty. The same schema gate applies before their known projections.
  const verifiedInventoryFields = new Map();
  const inventorySDK = {
    baseURL: sdk.baseURL,
    request: (endpoint, options) => request('data', endpoint, options),
    listStrict: async (table, params, options) => {
      const safeParams = new URLSearchParams(params);
      safeParams.set('sysparm_fields', safeParams.get('sysparm_fields').split(',').filter(name => verifiedInventoryFields.get(table)?.has(name)).join(','));
      const response = await request('data', `${sdk.baseURL}/api/now/table/${table}?${safeParams}`, options);
      if (!Array.isArray(response?.result)) fail('malformed');
      return response.result;
    },
  };
  for (const kind of ['store', 'plugins']) {
    const descriptor = inventorySources[kind], result = source(descriptor.table);
    result.kind = kind;
    report.installed_hints.push(result);
    try {
      const info = await schema(descriptor.table);
      if (descriptor.fields.some(name => !info.fields.has(name) || info.fields.get(name).reference)) fail('schema-unavailable');
      verifiedInventoryFields.set(descriptor.table, new Set([...info.fields].filter(([, field]) => !field.reference).map(([name]) => name)));
      result.schema = { status: 'verified-visible', hierarchy: info.hierarchy, fields: descriptor.fields.map(name => ({ name, type: info.fields.get(name).type })) };
      const inventory = await readInventory(inventorySDK, kind, 1);
      if (inventory.coverage.reason === 'auth_error') fail('auth_error');
      result.provider_coverage = inventory.coverage;
      result.coverage.returned = Math.min(inventory.items.size, limit);
      result.coverage.truncated = inventory.items.size > limit || inventory.coverage.status !== 'complete';
      result.status = inventory.items.size ? 'observed' : inventory.coverage.status === 'complete' ? 'no-visible-rows' : 'unavailable';
      result.reason = inventory.coverage.reason;
      result.observations = result.status === 'unavailable' ? null : [...inventory.items.values()].slice(0, limit).map(item => ({
        name: safeValue(item.name, 'string'), version: safeValue(item.version, 'string'), active: item.active,
        ...(kind === 'store' ? { installed: item.installed, installation_evidence: item.installation_evidence } : { installation_evidence: 'platform plugin state; activation is not purchased entitlement' }),
      }));
      result.freshness.source_updated_on = 'unavailable; observed inventory state, not deployment history';
    } catch (error) { result.reason = reason(error); }
  }
  return report;
}

const sourceTitles = {
  license_details: 'Subscription forms', subscription_entitlement: 'Subscription entitlements',
  subscription_detail: 'Allocation observations', account_subscription_entitlement: 'Account allocation',
  instance_subscription_entitlement: 'Instance allocation', itom_lu_ci_counts: 'ITOM CI counts',
  usageanalytics_count: 'Usage analytics', itom_lu_licensable_cis: 'ITOM licensable CI observations',
  sys_store_app: 'Store applications', v_plugin: 'Platform plugins',
};
const fieldLabels = {
  product_name: 'Product', name: 'Name',
  product_code: 'Product code', sku: 'SKU', license_type: 'License type', subscription_type: 'Subscription type',
  unit: 'Unit', status: 'Status', state: 'State', active: 'Active', is_latest: 'Latest',
  quantity: 'Quantity', purchased_quantity: 'Purchased quantity', allocated_quantity: 'Allocated quantity',
  allocated: 'Allocated', used: 'Used', consumption: 'Consumption', count: 'Count', ci_count: 'CI count',
  licensable_count: 'Licensable count', sample_date: 'Sample date', start_date: 'Start date',
  end_date: 'End date', effective_date: 'Effective date', sys_updated_on: 'Updated', version: 'Version',
  installed: 'Installed', installation_evidence: 'Install evidence',
};
const humanReasons = {
  forbidden: 'access denied', 'missing-or-hidden': 'missing or hidden', 'schema-unavailable': 'schema unavailable',
  malformed: 'incomplete or invalid response', 'metadata-cap': 'metadata limit reached',
  'inheritance-limit': 'schema ancestry limit reached', 'request-budget': 'request limit reached',
  'ambiguous-schema': 'ambiguous schema', page_limit_no_provider_total: 'no provider total; bounded page only',
};
const humanValue = value => value === null || value === undefined ? 'Unavailable'
  : value === true ? 'Yes' : value === false ? 'No'
    : value === 'appclient_installed_tab' ? 'Observed in installed Store tab'
      : value === 'local_version_and_install_date' ? 'Local version and install date'
        : value === 'platform plugin state; activation is not purchased entitlement' ? 'Plugin state, not purchased entitlement'
          : String(value);

export function formatSubscriptionEvidence(report) {
  const lines = ['Subscription evidence', `Observed: ${report.captured_at}`,
    'Source observations only. Not a contract, compliance verdict, billable seats or bills.',
    'Installed apps/plugins are possibilities, not proof of purchased rights.',
    'Nonproduction installs do not prove production deployment or bills.',
    'No environment detection, cross-source totals, licensing meters or 90-day averages.',
    'Missing data is unavailable, not zero. Empty reads mean no visible rows.'];
  for (const [section, title] of [
    ['entitlements', 'Entitlement evidence'], ['allocation', 'Allocation evidence'],
    ['consumption', 'Consumption evidence'], ['installed_hints', 'Installed app and plugin hints'],
  ]) {
    lines.push('', title, '-'.repeat(title.length));
    for (const source of report[section]) {
      lines.push('', sourceTitles[source.source] || source.source);
      if (source.status === 'unavailable') lines.push(`  Unavailable: ${humanReasons[source.reason] || 'source could not be read'}.`);
      else if (source.status === 'no-visible-rows') lines.push('  No visible rows.');
      else if (source.reason) lines.push(`  Note: ${humanReasons[source.reason] || source.reason.replaceAll('_', ' ')}.`);
      for (const [index, row] of (source.observations || []).entries()) {
        lines.push(`  ${row.product_name || row.name || `Observation ${index + 1}`}`);
        for (const [key, value] of Object.entries(row)) {
          if ((key === 'product_name' || key === 'name') && value) continue;
          const label = fieldLabels[key] || key.replaceAll('_', ' ');
          lines.push(`    ${label.padEnd(19)} ${humanValue(value)}`);
        }
      }
      lines.push(`  Source: ${source.source}`);
      const shown = source.coverage.returned === undefined ? 'not established' : `${source.coverage.returned} shown`;
      const more = source.coverage.truncated === true ? '; more rows may exist' : '';
      lines.push(`  Coverage: ${shown}, limit ${source.coverage.limit}${more}; completeness unknown.`);
      lines.push(`  Freshness: ${source.freshness.source_updated_on.startsWith('Per-row') ? 'See Updated values; source-wide freshness unknown.' : 'Not established.'}`);
      if (source.latest_filter) lines.push(`  Latest allocation: ${source.latest_filter.startsWith('verified') ? 'latest rows only (is_latest=true).' : 'not established.'}`);
    }
  }
  lines.push('', 'Access evidence', '---------------', 'Unavailable: bounded distinct-user aggregation is not supported by this SDK.',
    'No user-role rows fetched. Role assignments are not allocated or billable seats.',
    `Source: ${report.access.source} (not queried).`);
  return lines.join('\n');
}
