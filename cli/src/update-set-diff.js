import { resolveSession } from './session.js';
import { errUsage } from './errors.js';

const idPattern = /^[a-f0-9]{32}$/i;
const raw = value => String(value?.value ?? value ?? '');
const fields = 'sys_id,name,state,parent,sys_updated_on';
const caveat = 'Window selects currently complete source sets by sys_updated_on, not completion-transition history. Context members are not readiness claims. Captured updates only: this does not compare current record values or establish deployment readiness. Exact payload comparison is conservative (no XML normalization).';

export function parseDiffWindow(value = '2w', now = new Date()) {
  if (/^\d+[dw]$/.test(value)) {
    const amount = Number(value.slice(0, -1));
    if (!amount || amount > 36500) throw errUsage('Invalid --from window');
    return new Date(now.getTime() - amount * (value.endsWith('w') ? 7 : 1) * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value) return `${value} 00:00:00`;
  }
  throw errUsage('--from must be a date (YYYY-MM-DD) or relative window (2w, 14d)');
}

// Strict envelopes and counts: SDK.list/aggregateCount intentionally have forgiving
// defaults unsuitable for proving absence. Use the same authenticated GET transport.
export async function readDiffTable(sdk, table, query, required, coverage, label) {
  const entry = { source: label, table, query, status: 'error', fetched: 0, total: null };
  coverage.push(entry);
  const rows = [];
  try {
    const countParams = new URLSearchParams({ sysparm_count: 'true', sysparm_query: query });
    const count = await sdk.request(`${sdk.baseURL}/api/now/stats/${table}?${countParams}`, { method: 'GET' });
    const value = count?.result?.stats?.count;
    if (value == null || !/^\d+$/.test(String(value))) throw new Error('Unreadable provider count');
    entry.total = Number(value);
    const seen = new Set();
    for (let page = 0; rows.length < entry.total && page < 20; page++) {
      const params = new URLSearchParams({ sysparm_query: `${query}${query ? '^' : ''}ORDERBYsys_id`, sysparm_fields: required.join(','), sysparm_display_value: 'false', sysparm_limit: '200', sysparm_offset: String(rows.length) });
      const response = await sdk.request(`${sdk.baseURL}/api/now/table/${table}?${params}`, { method: 'GET' });
      if (!Array.isArray(response?.result)) throw new Error('Unreadable record array');
      if (!response.result.length) throw new Error('Pagination ended before provider count');
      for (const row of response.result) {
        if (required.some(key => !Object.hasOwn(row, key))) throw new Error('Required fields omitted (schema or ACL)');
        if (!idPattern.test(raw(row.sys_id)) || seen.has(raw(row.sys_id))) throw new Error('Invalid or repeated record identity');
        seen.add(raw(row.sys_id));
        rows.push(row);
      }
    }
    entry.fetched = rows.length;
    if (rows.length !== entry.total) throw new Error('Page budget/count mismatch');
    const after = await sdk.request(`${sdk.baseURL}/api/now/stats/${table}?${countParams}`, { method: 'GET' });
    if (String(after?.result?.stats?.count) !== String(value)) throw new Error('Provider count changed during pagination');
    entry.status = 'complete';
  } catch (error) {
    entry.fetched = rows.length;
    entry.error = error.message;
    entry.status = rows.length ? 'partial' : 'error';
  }
  return { rows, complete: entry.status === 'complete' };
}

function profileSDK(app, name) {
  const session = resolveSession({ profile: name }, app.config);
  if (session.unknownProfile || !session.profile || !session.instance) throw errUsage(`Unknown or unconfigured profile: ${name}`);
  return app.getSDKForProfile(session.instance, { profileName: name, profile: session.profile, username: session.username, authMethod: session.profile.auth_method, domain: session.domain });
}

async function contents(sdk, field, id, coverage, label) {
  return readDiffTable(sdk, 'sys_update_xml', `${field}=${id}`, ['sys_id', 'name', 'action', 'payload', field], coverage, label);
}
function captureMap(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = raw(row.name);
    if (!key || map.has(key) || !raw(row.payload)) return null;
    // name is the stable customer-update artifact identity; sys_id, set refs,
    // capture timestamps and updater belong to this instance's envelope.
    map.set(key, JSON.stringify([raw(row.action), raw(row.payload)]));
  }
  return map;
}

export async function diffUpdateSets(argv, app) {
  const from = parseDiffWindow(argv.from);
  const source = profileSDK(app, argv.source);
  const target = profileSDK(app, argv.target);
  const coverage = [];
  const selected = await readDiffTable(source, 'sys_update_set', `state=complete^sys_updated_on>=${from}`, fields.split(','), coverage, 'source selection');
  const inventory = await readDiffTable(source, 'sys_update_set', '', fields.split(','), coverage, 'source hierarchy');
  const remote = await readDiffTable(target, 'sys_remote_update_set', '', ['sys_id', 'name', 'state', 'remote_sys_id', 'update_set'], coverage, 'target all dates');
  const all = new Map([...inventory.rows, ...selected.rows].map(row => [raw(row.sys_id), row]));
  const selectedIDs = new Set(selected.rows.map(row => raw(row.sys_id)));
  const included = new Set(selectedIDs);
  const cycles = [];
  for (const id of selectedIDs) {
    let current = id;
    const path = new Set();
    while (current && all.has(current)) {
      if (path.has(current)) { cycles.push(current); break; }
      path.add(current); included.add(current);
      current = raw(all.get(current).parent);
    }
  }
  // Include every member sharing an observed ancestor, including older and
  // incomplete members; fixed point handles nested children without recursion.
  for (let pass = 0; pass < all.size; pass++) {
    let changed = false;
    for (const [id, row] of all) if (!included.has(id) && included.has(raw(row.parent))) { included.add(id); changed = true; }
    if (!changed) break;
  }
  const sets = [];
  for (const id of included) {
    const row = all.get(id);
    let base = id;
    const ancestors = new Set();
    while (all.has(base) && raw(all.get(base).parent)) {
      if (ancestors.has(base)) { base = '(cycle)'; break; }
      ancestors.add(base);
      base = raw(all.get(base).parent);
    }
    if (!all.has(base) && base !== '(cycle)') base = `(unreadable ${base})`;
    const result = { sys_id: id, name: raw(row.name), state: raw(row.state), parent: raw(row.parent), base, context: !selectedIDs.has(id), status: 'Unknown', evidence: [] };
    result.base_name = all.has(base) ? raw(all.get(base).name) : null;
    result.parent_name = all.has(result.parent) ? raw(all.get(result.parent).name) : null;
    result.group = !result.parent && ![...all.values()].some(member => raw(member.parent) === id) ? 'standalone' : 'batch';
    result.capture_counts = { source: null, target: null };
    sets.push(result);
    if (result.context) { result.evidence.push('Hierarchy context only; not selected for comparison'); continue; }
    if (!selected.complete || !remote.complete) { result.evidence.push('Incomplete source selection or target inventory'); continue; }
    const a = await contents(source, 'update_set', id, coverage, `source contents ${id}`);
    result.capture_counts.source = a.complete ? a.rows.length : null;
    const left = captureMap(a.rows);
    if (!a.complete || !left) { result.evidence.push('Incomplete or ambiguous source captured contents'); continue; }
    const candidates = remote.rows.filter(candidate => raw(candidate.remote_sys_id) === id);
    result.candidates = candidates.map(candidate => ({ sys_id: raw(candidate.sys_id), state: raw(candidate.state), update_set: raw(candidate.update_set) }));
    if (!candidates.length) { result.status = 'Missing'; result.evidence.push('Complete target inventory: no remote_sys_id matches source sys_id'); continue; }
    if (candidates.length !== 1) { result.evidence.push('Ambiguous origin identity'); continue; }
    const candidate = candidates[0];
    if (raw(candidate.state) !== 'committed') { result.status = 'Retrieved not committed'; result.evidence.push(`Target retrieved state: ${raw(candidate.state) || '(empty)'}`); continue; }
    const b = await contents(target, 'remote_update_set', raw(candidate.sys_id), coverage, `target contents ${raw(candidate.sys_id)}`);
    result.capture_counts.target = b.complete ? b.rows.length : null;
    const right = captureMap(b.rows);
    if (!a.complete || !b.complete || !left || !right) { result.evidence.push('Incomplete or ambiguous captured contents'); continue; }
    result.changes = [...new Set([...left.keys(), ...right.keys()])].filter(key => left.get(key) !== right.get(key)).map(name => ({ name, source: left.has(name), target: right.has(name) }));
    result.status = result.changes.length ? 'Different' : 'Matching';
    result.evidence.push('Origin remote_sys_id equals source sys_id; committed retrieved state; count-verified captured name/action/payload comparison');
  }
  const report = { source: argv.source, target: argv.target, from, date_basis: 'sys_updated_on (UTC)', caveat, coverage, hierarchy_cycles: [...new Set(cycles)], sets };
  const formatted = formatUpdateSetDiff(report, argv);
  Object.defineProperty(report, '_formatted', { value: formatted, enumerable: false });
  app.ok(report, { summary: 'Captured update-set comparison' });
  return report;
}

// Pure production renderer also supports replaying a saved report without instance reads.
export function formatUpdateSetDiff(report, { verbose = false } = {}) {
  const { sets, coverage } = report;
  if (verbose) {
    const lines = [`Update sets: ${report.source} → ${report.target} (since ${report.from} UTC)`, report.caveat];
    if (!sets.filter(set => !set.context).length) lines.push(report.coverage.find(entry => entry.source === 'source selection')?.status === 'complete' ? 'No selected sets: no currently complete source sets in this window.' : 'Source selection unreadable or incomplete; absence of selected sets is not established.');
    const grouped = [...sets].sort((a, b) => a.group.localeCompare(b.group) || a.base.localeCompare(b.base) || a.parent.localeCompare(b.parent) || a.sys_id.localeCompare(b.sys_id));
    let heading;
    for (const set of grouped) {
      const group = set.group === 'standalone' ? 'Standalone update sets' : `Batch: ${set.base_name || set.base} [${set.base}]`;
      if (heading !== group) { lines.push('', group); heading = group; }
      lines.push(`  ${set.name} — ${set.status}${set.context ? ' (context only)' : ''}`, `    Source state: ${set.state}; parent: ${set.parent ? (set.parent_name || `unreadable ${set.parent}`) : '(none)'}`, `    Captures: source ${set.capture_counts.source ?? 'unknown'} / target ${set.capture_counts.target ?? 'unknown'}`, `    ${set.evidence.join('; ')}`);
      lines.push(`    Source ID: ${set.sys_id}; parent ID: ${set.parent || '(none)'}`);
      for (const candidate of set.candidates || []) lines.push(`    Target candidate: ${candidate.sys_id}; state: ${candidate.state}; update set: ${candidate.update_set || '(none)'}`);
      for (const change of set.changes || []) lines.push(`    ${change.name}: ${!change.target ? 'missing-in-target' : !change.source ? 'target-only' : 'content differs'}`);
    }
    for (const entry of coverage) lines.push(`Coverage ${entry.source}: ${entry.status} — ${entry.fetched}/${entry.total ?? '?'}${entry.error ? ` — ${entry.error}` : ''}`);
    if (report.hierarchy_cycles.length) lines.push(`Hierarchy cycles: ${report.hierarchy_cycles.join(', ')}`);
    return lines.join('\n');
  }
  const lines = [`Update sets: ${report.source} → ${report.target} (since ${report.from} UTC)`, report.caveat];
  if (!sets.some(set => !set.context)) lines.push(coverage.find(entry => entry.source === 'source selection')?.status === 'complete'
    ? 'No selected sets: no currently complete source sets in this window.'
    : 'Source selection unreadable or incomplete; absence of selected sets is not established.');
  const groups = new Map();
  for (const set of sets) {
    const key = set.group === 'standalone' ? 'standalone' : set.base;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(set);
  }
  for (const members of groups.values()) {
    const first = members[0];
    lines.push('', first.group === 'standalone' ? 'Standalone update sets' : `Batch: ${first.base_name || '(unreadable batch)'}`);
    const rows = members.map(set => [set.name, set.parent ? (set.parent_name || '(unreadable)') : '—', set.state, set.context ? 'Context only' : set.status, `${set.capture_counts.source ?? '?'} / ${set.capture_counts.target ?? '?'}`]);
    const header = ['Update set', 'Parent', 'Source state', 'Target status', 'Captures S/T'];
    const widths = header.map((title, i) => Math.max(title.length, ...rows.map(row => row[i].length)));
    for (const row of [header, ...rows]) lines.push('  ' + row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd());
    for (const set of members.filter(set => !set.context && ['Different', 'Unknown'].includes(set.status))) {
      lines.push(`  ${set.name} — ${set.status}: ${set.evidence.join('; ')}`);
      for (const change of set.changes || []) lines.push(`    ${change.name}: ${!change.target ? 'missing-in-target' : !change.source ? 'target-only' : 'content differs'}`);
    }
  }
  if (coverage.some(entry => entry.status !== 'complete')) lines.push('Coverage incomplete: classifications may be Unknown; use --verbose or --json for evidence.');
  if (report.hierarchy_cycles.length) lines.push('Hierarchy cycles detected; see --verbose or --json.');
  lines.push('', 'Captures S/T = source / target; ? = not compared or unreadable. Context only = hierarchy member outside selection.', 'Use --verbose for IDs and full evidence; --json retains coverage and identities.');
  return lines.join('\n');
}
