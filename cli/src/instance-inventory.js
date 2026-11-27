import { resolveSession } from './session.js';
import { errUsage } from './errors.js';
import { listApplications } from './store.js';
import { readDependencyTree } from './plugins.js';

export async function readObservedStoreApps(sdk, maxPages, tableFailure) {
  const items = new Map(), localIds = new Set();
  const coverage = { table: 'sn_appclient/appmanager/apps', tab: 'installed', status: 'unknown', fetched: 0, total: null, reason: 'no_provider_total', table_failure: tableFailure, observed_items_usable: true, exhaustion: 'not_reached' };
  try {
    for (let page = 0; page < maxPages; page++) {
      // Reuse the production Store discovery transport. Its page_full is a
      // client heuristic, NOT provider has_more or an exhaustiveness guarantee.
      const result = await listApplications(sdk, { tab: 'installed', limit: 200, offset: coverage.fetched });
      if (!result.apps.length) { coverage.exhaustion = 'empty_page_observed'; return { items, coverage }; }
      if (result.apps.length > 200) throw Object.assign(new Error(), { code: 'invalid_page_size' });
      for (const row of result.apps) {
        if (!row.scope?.trim() || !row.sys_id?.trim() || !row.name?.trim() || !row.version?.trim()) throw Object.assign(new Error(), { code: 'missing_fields' });
        if (items.has(row.scope) || localIds.has(row.sys_id)) throw Object.assign(new Error(), { code: 'duplicate_or_invalid_identity' });
        localIds.add(row.sys_id);
        items.set(row.scope, { id: row.scope, name: row.name, version: row.version, available_version: row.latest_version, active: null, installed: true, installation_evidence: 'appclient_installed_tab', observation_verified: true });
        coverage.fetched++;
      }
    }
    coverage.reason = 'page_limit_no_provider_total';
  } catch (error) {
    coverage.reason = error.status === 403 ? 'forbidden' : error.code || 'unreadable_source';
    coverage.observed_items_usable = false;
  }
  return { items, coverage };
}


// Separate inventories: a Store application may also expose platform plugins.
// Neither inventory is a substitute for the other; custom sys_app rows are excluded.
export const inventorySources = {
  plugins: { table: 'v_plugin', key: 'id', fields: ['sys_id', 'id', 'name', 'version', 'active'] },
  store: { table: 'sys_store_app', key: 'scope', fields: ['sys_id', 'scope', 'name', 'version', 'active', 'install_date'] },
};
const text = value => {
  const raw = value && typeof value === 'object' ? value.value : value;
  return typeof raw === 'string' ? raw : typeof raw === 'boolean' ? String(raw) : null;
};

const checkMaxPages = maxPages => {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw errUsage('--max-pages must be an integer from 1 to 100');
  return maxPages;
};

export async function readInventory(sdk, kind, maxPages = 30) {
  const source = inventorySources[kind];
  if (!source) throw errUsage('Unknown inventory kind');
  checkMaxPages(maxPages);
  const coverage = { table: source.table, status: 'unknown', fetched: 0, total: null, reason: null };
  const items = new Map();
  const seen = new Set();
  const countParams = new URLSearchParams({ sysparm_count: 'true' });
  const count = async () => {
    const response = await sdk.request(`${sdk.baseURL}/api/now/stats/${source.table}?${countParams}`, { method: 'GET', ...(kind === 'store' ? { stateful: true } : {}) });
    const value = response?.result?.stats?.count;
    if (value == null || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw Object.assign(new Error(), { code: 'unreadable_count' });
    return Number(value);
  };
  try {
    coverage.total = await count();
    for (let page = 0; coverage.fetched < coverage.total && page < maxPages; page++) {
      const rows = await sdk.listStrict(source.table, {
        sysparm_fields: [...source.fields, ...(kind === 'store' ? ['latest_version'] : [])].join(','), sysparm_query: 'ORDERBYsys_id',
        sysparm_display_value: 'false', sysparm_exclude_reference_link: 'true',
        sysparm_limit: 200, sysparm_offset: coverage.fetched,
      }, kind === 'store' ? { stateful: true } : {});
      if (!Array.isArray(rows) || !rows.length || rows.length > 200) throw Object.assign(new Error(), { code: 'unstable_pagination' });
      for (const row of rows) {
        if (!row || source.fields.some(field => !Object.hasOwn(row, field) || text(row[field]) === null)) throw Object.assign(new Error(), { code: 'missing_fields' });
        const key = text(row[source.key]);
        const id = text(row.sys_id);
        if (!key?.trim() || !id?.trim() || seen.has(id) || items.has(key)) throw Object.assign(new Error(), { code: 'duplicate_or_invalid_identity' });
        seen.add(id);
        const active = text(row.active);
        const allowed = kind === 'plugins' ? ['active', 'inactive'] : ['true', 'false'];
        if (!allowed.includes(active)) throw Object.assign(new Error(), { code: 'unknown_state' });
        items.set(key, { id: key, name: text(row.name), version: text(row.version) || null, active: kind === 'plugins' ? active === 'active' : active === 'true', ...(kind === 'store' ? { installed: text(row.version) && text(row.install_date) ? true : null, installation_evidence: text(row.version) && text(row.install_date) ? 'local_version_and_install_date' : 'unknown', available_version: text(row.latest_version) || null } : {}) });
        coverage.fetched++;
      }
    }
    if (coverage.fetched !== coverage.total) throw Object.assign(new Error(), { code: 'page_limit_or_count_mismatch' });
    if (await count() !== coverage.total) throw Object.assign(new Error(), { code: 'count_changed' });
    coverage.status = 'complete';
  } catch (error) {
    // Never include provider text, hostnames or credentials in a comparison report.
    coverage.reason = error.status === 403 ? 'forbidden' : error.status === 401 ? 'auth_error' : error.code || 'unreadable_source';
  }
  if (kind === 'store' && coverage.reason === 'forbidden') return readObservedStoreApps(sdk, maxPages, coverage.reason);
  return { items, coverage };
}

export function recommendAlignment(before, after, reliable, kind) {
  if (!reliable) return [{ action: 'investigate_access', message: 'Investigate source/target access and incomplete coverage before planning changes.' }];
  if (!before) return [{ action: 'review_target_only', message: 'Review or retain target-only item; no automatic removal recommended.' }];
  if (!after) {
    if (kind === 'store' && before.installed === true) return [{ action: 'install', message: `Install Store application on target at source installed version ${before.version}; verify entitlement and compatibility first.` }];
    if (kind === 'plugins' && before.active === true) return [{ action: 'activate', message: `Locate and activate plugin on target to match source; verify availability and dependencies first (source version ${before.version ?? 'unknown'}).` }];
    return [{ action: 'review_presence', message: 'Review source-only item and its installation/activation evidence before planning changes.' }];
  }
  if (kind === 'store' && (before.installed == null || after.installed == null)) return [{ action: 'investigate_installation', message: `Investigate installation evidence before alignment (source local version ${before.version ?? 'unknown'}; target local version ${after.version ?? 'unknown'}). An empty version or install date does not prove not installed.` }];
  const actions = [];
  if (kind === 'store' && before.installed === true && after.installed === false) actions.push({ action: 'install', message: `Install Store application on target at source version ${before.version}; verify entitlement and compatibility first.` });
  if (before.active === true && after.active === false) actions.push({ action: kind === 'plugins' ? 'activate' : 'review_activation', message: kind === 'plugins' ? 'Activate plugin on target to match active source; verify prerequisites first.' : 'Review application activation on target to match active source.' });
  if (before.active === false && after.active === true) actions.push({ action: 'review_activation', message: 'Target is active while source is inactive; review impact rather than automatically deactivating.' });
  if (before.version !== after.version) {
    const parse = value => typeof value === 'string' && /^\d+(?:\.\d+)*$/.test(value) ? value.split('.').map(BigInt) : null;
    const a = parse(before.version), b = parse(after.version);
    let order = 0;
    if (a && b) for (let i = 0; i < Math.max(a.length, b.length); i++) { if ((b[i] ?? 0n) !== (a[i] ?? 0n)) { order = (b[i] ?? 0n) > (a[i] ?? 0n) ? 1 : -1; break; } }
    const versions = `target ${after.version ?? 'unknown'}; source ${before.version ?? 'unknown'}`;
    actions.push({ action: !a || !b || order >= 0 ? 'review_version' : 'align_version', message: !a || !b ? `Review version alignment (${versions}); provider version order is unknown, do not assume downgrade support.` : order > 0 ? `Review newer target version (${versions}); no downgrade recommended.` : order === 0 ? `Review equivalent numeric versions with different provider labels (${versions}).` : `Align target to source version after verifying supported upgrade availability (${versions}).` });
  }
  if (kind === 'store' && before.installed === false && after.installed === true) actions.push({ action: 'review_installation', message: 'Review or retain target installation; no automatic uninstall recommended.' });
  if (!actions.length && (!before.version || !after.version)) actions.push({ action: 'investigate_version', message: 'Investigate missing installed-version evidence.' });
  return actions.length ? actions : [{ action: 'none', message: kind === 'store' && (before.active == null || after.active == null) ? 'Observed installed versions match; no version action needed. Activation is unreported.' : 'No action needed; observed versions and states match.' }];
}

export function compareInventories(source, destination, kind = 'plugins') {
  return [...new Set([...source.items.keys(), ...destination.items.keys()])].sort().map(id => {
    const before = source.items.get(id) || null;
    const after = destination.items.get(id) || null;
    const inventoriesComplete = source.coverage.status === 'complete' && destination.coverage.status === 'complete';
    const observedPair = kind === 'store' && before && after && (source.coverage.status === 'complete' || before.observation_verified === true && source.coverage.observed_items_usable) && (destination.coverage.status === 'complete' || after.observation_verified === true && destination.coverage.observed_items_usable);
    const reliable = inventoriesComplete || observedPair;
    let status = 'unknown';
    const changes = [];
    if (reliable) {
      if (!before) status = 'target_only';
      else if (!after) status = 'source_only';
      else {
        for (const field of ['version', 'active', 'installed']) {
          if (field === 'active' && (before.active == null || after.active == null)) continue;
          if (before[field] !== after[field]) changes.push(field);
        }
        status = kind === 'store' && (before.installed == null || after.installed == null) || before.version === null || after.version === null ? 'unknown' : changes.length ? 'different' : 'matching';
      }
    }
    return { id, name: before?.name || after?.name || id, status, evidence: inventoriesComplete ? 'complete_inventory' : observedPair ? 'observed_pair' : 'incomplete_inventory', changes, before, after, recommendations: recommendAlignment(before, after, reliable, kind) };
  });
}

export function formatInventoryComparison(data, verbose = false) {
  const lines = [`${data.kind}: ${data.source} -> ${data.target} (align TARGET ${data.target} to SOURCE ${data.source})`,
    ...(data.tree ? [`Narrowed to ${data.tree.plugin} and the ${data.tree.count} plugins it requires on ${data.source}${data.tree.complete ? '' : ' (INCOMPLETE tree)'}; ${data.tree.unlisted.length} not listed in v_plugin there are not compared`] : []), Object.values(data.coverage).every(c => c.status === 'complete') ? 'Complete visible inventories' : 'INCOMPLETE inventory: absences unknown; verified observed pairs can still be compared',
    ...Object.entries(data.coverage).map(([side, c]) => `${side}: ${c.status}, ${c.fetched}/${c.total ?? '?'} rows${c.reason ? ` (${c.reason})` : ''}`),
    `${data.records.length} identities; ${Object.entries(data.counts).map(([key, value]) => `${value} ${key}`).join(', ')}`,
    'ID | STATUS | SOURCE -> TARGET | WHAT TO DO ON TARGET'];
  const value = item => item ? `${item.version ?? 'version unknown'}, ${item.active === null ? 'activation unknown' : item.active ? 'active' : 'inactive'}${Object.hasOwn(item, 'installed') ? `, ${item.installed == null ? 'installation unknown' : item.installed ? 'installed' : 'not installed'}, available ${item.available_version ?? 'unknown'}` : ''}` : 'not observed';
  const differences = data.records.filter(row => row.status !== 'matching');
  const shown = verbose ? differences : differences.slice(0, 50);
  for (const row of shown) lines.push(`${row.name || row.id} [${row.id}] | ${row.status} | ${value(row.before)} -> ${value(row.after)} | ${row.recommendations.map(item => item.message).join(' ')}`);
  if (shown.length < differences.length) lines.push(`${differences.length - shown.length} additional rows omitted; --verbose shows all differences.`);
  lines.push('Matching rows need no action and are omitted; --json includes all rows. Read-only visible inventory, not entitlement or Store connectivity.');
  return lines.join('\n');
}

export async function compareInstanceInventory(argv, app, kind, emit = true) {
  const targetName = argv.target || argv.destination;
  if (!argv.source || !targetName) throw errUsage('Provide --source and --target profile names');
  const sdk = name => {
    const s = resolveSession({ profile: name }, app.config);
    if (s.unknownProfile || !s.profile || !s.instance) throw errUsage(`Unknown or unconfigured profile: ${name}`);
    return app.getSDKForProfile(s.instance, { profileName: name, profile: s.profile, username: s.username, authMethod: s.profile.auth_method, domain: s.domain });
  };
  // Resolve both profiles before making any request. Sequential bounded reads.
  const sourceSDK = sdk(argv.source), destinationSDK = sdk(targetName);
  // One plugin's tree, read from the source, narrows the full comparison; coverage rules are unchanged.
  const maxPages = checkMaxPages(argv.maxPages ?? 30);
  const tree = kind === 'plugins' && argv.id !== undefined ? await readDependencyTree(sourceSDK, argv.id) : null;
  const source = await readInventory(sourceSDK, kind, maxPages);
  const destination = await readInventory(destinationSDK, kind, maxPages);
  // Ids the source does not list are named, never compared: a target row for one would read as an absence on the source.
  const ids = tree && new Set([tree.plugin.id, ...tree.dependencies.filter(dep => dep.listed).map(dep => dep.id)]);
  const records = compareInventories(source, destination, kind).filter(row => !ids || ids.has(row.id));
  const counts = Object.fromEntries(['matching', 'different', 'source_only', 'target_only', 'unknown'].map(status => [status, records.filter(row => row.status === status).length]));
  const data = { kind, source: argv.source, target: targetName, ...(tree ? { tree: { plugin: tree.plugin.id, count: tree.count, complete: tree.complete, unlisted: tree.unlisted } } : {}), complete: source.coverage.status === 'complete' && destination.coverage.status === 'complete' && (!tree || tree.complete), coverage: { source: source.coverage, target: destination.coverage }, counts, records };
  Object.defineProperty(data, '_formatted', { value: formatInventoryComparison(data, argv.verbose), enumerable: false });
  if (emit) {
    app.ok(data, { summary: `${kind} comparison${data.complete ? '' : ' (incomplete)'}` });
    if (!data.complete) process.exitCode = 1;
  }
  return data;
}

export const inventoryCompareCommand = (wrap, kind) => ({
  command: kind === 'plugins' ? 'compare [id]' : 'compare', describe: `Compare ${kind === 'store' ? 'Store application' : 'plugin'} inventories across explicit profiles (read-only)`,
  builder: p => (kind === 'plugins' ? p.positional('id', { type: 'string', describe: 'Compare only this plugin and every plugin it requires on --source' }) : p).strict().option('source', { type: 'string', demandOption: true, describe: 'Source profile alias, desired baseline for --target' })
    .option('target', { alias: 'destination', type: 'string', demandOption: true, describe: 'Target profile to align to the desired --source baseline' })
    .option('max-pages', { type: 'number', default: 30, describe: 'Per-side page budget, 200 rows/page (1–100); limits remain incomplete' })
    .epilogue(`Align target to source without changing either instance:\njsn compare --source pdi --target vendor\n${kind === 'plugins' ? 'jsn plugins compare com.snc.pa.premium --source pdi --target vendor\n' : ''}jsn compare --source pdi --target vendor --json\njsn compare --source pdi --target vendor --get data.inventories.store.coverage\nIncomplete coverage exits 1 and recommends investigating access, not installing or removing. Numeric versions are ordered conservatively; newer target versions require review, never automatic downgrade.`),
  handler: wrap((argv, app) => compareInstanceInventory(argv, app, kind)),
});
