import { AppError, CodeNetwork, errAPI, errNotFoundHint, errUsage } from './errors.js';
import { isSysId } from './resolve-record.js';
import { boundedLimit, waitForOperation } from './store.js';

// v_plugin's sys_id is not the plugin id on every row, so every read and every join uses id.
const TABLE = 'v_plugin';
const FIELDS = 'id,name,version,available_version,active,state,requires,scope,entitled,block_install,supports_rollback,has_demo_data,licensable,provider';
const ID = /^[A-Za-z0-9_.-]{1,100}$/;
const CHUNK = 100;
// dev485581 (Nov 2026): 1422 plugins, deepest tree 13 levels, largest 304 plugins.
export const TREE_LIMITS = { depth: 50, nodes: 2000 };
const raw = value => value && typeof value === 'object' ? String(value.value ?? '') : value == null ? '' : String(value);
const flag = value => ({ true: true, false: false })[raw(value)] ?? null;
const malformed = message => Object.assign(new Error(`Malformed v_plugin response: ${message}`), { code: 'malformed_response' });

export function validatePluginId(id) {
  if (typeof id !== 'string' || !ID.test(id)) throw errUsage('Provide a plugin id such as com.snc.incident: letters, digits, dots, dashes or underscores, up to 100 characters.');
  return id;
}

function plugin(row) {
  const id = raw(row?.id), active = raw(row?.active);
  if (active !== 'active' && active !== 'inactive') throw malformed(`${id || 'a row'} has an unknown active value`);
  // An empty requires is a leaf; a missing one was not read, so the tree would look complete when it is not.
  if (!Object.hasOwn(row, 'requires')) throw malformed(`${id || 'a row'} has no requires field`);
  const requires = raw(row.requires).split(',').map(dep => dep.trim()).filter(Boolean);
  if (requires.some(dep => !ID.test(dep))) throw malformed(`${id} requires an id jsn cannot read`);
  const value = field => raw(row[field]) || null;
  return { id, name: value('name'), version: value('version'), available_version: value('available_version'), active: active === 'active', state: value('state'), scope: value('scope'), entitled: value('entitled'), block_install: flag(row.block_install), supports_rollback: flag(row.supports_rollback), has_demo_data: flag(row.has_demo_data), licensable: flag(row.licensable), provider: value('provider'), requires: [...new Set(requires)], listed: true };
}

// Exact ids only. An id v_plugin does not list is absent from the map, never an error.
export async function readPlugins(sdk, ids) {
  const found = new Map();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = await sdk.listStrict(TABLE, new URLSearchParams({ sysparm_query: `idIN${chunk.join(',')}`, sysparm_fields: FIELDS, sysparm_limit: String(chunk.length), sysparm_display_value: 'false', sysparm_exclude_reference_link: 'true' }));
    for (const row of rows.map(plugin)) {
      if (!chunk.includes(row.id) || found.has(row.id)) throw malformed(`returned ${row.id}, which was not asked for or came twice`);
      found.set(row.id, row);
    }
  }
  return found;
}

// One query per level of the tree. A plugin already read is never read again, so cycles end.
export async function readDependencyTree(sdk, id) {
  validatePluginId(id);
  const root = (await readPlugins(sdk, [id])).get(id);
  if (!root) throw errNotFoundHint('Plugin', id, 'v_plugin does not list this id. Some plugins that others require are never listed there, so this does not show it is absent or inactive; check the id and that this profile can read v_plugin.');
  const nodes = new Map([[id, { ...root, depth: 0 }]]);
  let level = root.requires, depth = 0, limit = null;
  while (level.length) {
    const next = [...new Set(level)].filter(dep => !nodes.has(dep));
    if (!next.length) break;
    if (++depth > TREE_LIMITS.depth) { limit = 'depth'; break; }
    if (nodes.size + next.length > TREE_LIMITS.nodes) { limit = 'nodes'; break; }
    const found = await readPlugins(sdk, next);
    for (const dep of next) nodes.set(dep, found.has(dep) ? { ...found.get(dep), depth } : { id: dep, listed: false, active: null, requires: [], depth });
    level = next.flatMap(dep => nodes.get(dep).requires);
  }
  const cycles = [], state = new Map();
  const visit = from => {
    state.set(from, 'open');
    for (const to of nodes.get(from).requires) {
      if (!nodes.has(to)) continue;
      if (state.get(to) === 'open') cycles.push([from, to]);
      else if (!state.has(to)) visit(to);
    }
    state.set(from, 'done');
  };
  visit(id);
  const dependencies = [...nodes.values()].slice(1);
  return { plugin: nodes.get(id), dependencies, count: dependencies.length, inactive: dependencies.filter(dep => dep.active === false).map(dep => dep.id), unlisted: dependencies.filter(dep => !dep.listed).map(dep => dep.id), cycles, complete: !limit, limit_reached: limit };
}

const describe = node => !node ? 'not read: tree limit reached' : !node.listed ? 'not listed in v_plugin, state unknown' : `${node.name ?? 'unnamed'} ${node.version ?? 'version unknown'}, ${node.active ? 'active' : 'INACTIVE'}${node.block_install ? ', install blocked' : ''}`;

export function formatPluginTree(data) {
  const p = data.plugin;
  const yes = (value, word, on, off) => value === true ? on : value === false ? off : `${word} unknown`;
  const lines = [`${p.name ?? p.id} [${p.id}] ${p.version ?? 'version unknown'}, ${p.active ? 'active' : 'inactive'} (available ${p.available_version ?? 'unknown'})`,
    `Scope ${p.scope ?? 'unknown'}, provider ${p.provider ?? 'unknown'}, state ${p.state ?? 'unknown'}, entitled ${p.entitled ?? 'unknown'}; ${yes(p.supports_rollback, 'rollback', 'rollback supported', 'no rollback')}, ${yes(p.has_demo_data, 'demo data', 'has demo data', 'no demo data')}, ${yes(p.licensable, 'licensable', 'licensable', 'not licensable')}${p.block_install ? ', install blocked' : ''}`,
    `${data.count} dependencies: ${data.inactive.length} inactive, ${data.unlisted.length} not listed in v_plugin, ${data.cycles.length} cycle(s)${data.complete ? '' : `; INCOMPLETE, the ${data.limit_reached} limit (${TREE_LIMITS[data.limit_reached]}) was reached`}`, p.id];
  const nodes = new Map([[p.id, p], ...data.dependencies.map(dep => [dep.id, dep])]);
  const shown = new Set([p.id]);
  const render = (id, prefix, path) => nodes.get(id).requires.forEach((dep, i, all) => {
    const last = i === all.length - 1, branch = `${prefix}${last ? '└─ ' : '├─ '}${dep}`;
    if (path.has(dep)) return lines.push(`${branch} (cycle)`);
    if (shown.has(dep)) return lines.push(`${branch} (shown above)`);
    lines.push(`${branch}  ${describe(nodes.get(dep))}`);
    if (!nodes.has(dep)) return;
    shown.add(dep);
    render(dep, prefix + (last ? '   ' : '│  '), new Set([...path, dep]));
  });
  render(p.id, '', new Set([p.id]));
  if (!p.requires.length) lines.push('(no dependencies)');
  return lines.join('\n');
}

// Preview of what activating these plugins would do. Reads only; nothing is sent.
export async function planActivation(sdk, ids) {
  if (!Array.isArray(ids) || !ids.length) throw errUsage('Name at least one plugin id to install.');
  ids.forEach(validatePluginId);
  const requested = [...new Set(ids)], nodes = new Map(), refusals = [], cycles = [];
  let unlisted = [];
  for (const id of requested) {
    const tree = await readDependencyTree(sdk, id);
    for (const node of [tree.plugin, ...tree.dependencies]) if (!nodes.has(node.id)) nodes.set(node.id, node);
    unlisted = [...new Set([...unlisted, ...tree.unlisted])];
    cycles.push(...tree.cycles.filter(([a, b]) => !cycles.some(([x, y]) => x === a && y === b)));
    if (tree.plugin.active) refusals.push({ id, reason: 'already active' });
    if (!tree.complete) refusals.push({ id, reason: `its dependency tree is incomplete (the ${tree.limit_reached} limit was reached)` });
  }
  // Required plugins first. A plugin already on the path is a cycle, named above and not followed.
  const order = [], seen = new Set();
  const visit = id => {
    if (seen.has(id) || !nodes.has(id)) return;
    seen.add(id);
    nodes.get(id).requires.forEach(visit);
    order.push(id);
  };
  requested.forEach(visit);
  const plugins = order.map(id => nodes.get(id)).filter(node => node.active === false);
  for (const node of plugins) if (node.block_install !== false) refusals.push({ id: node.id, reason: node.block_install === null ? 'its install block could not be read' : requested.includes(node.id) ? 'install is blocked' : 'it is required, inactive and its install is blocked' });
  return { requested, plugins: plugins.map(({ id, name, version, depth }) => ({ id, name, version, required_by_request: !requested.includes(id), depth })), unlisted, cycles, refusals };
}

// One plugin through the CI/CD API, then the tracker, then v_plugin. A tracker alone is never success.
export async function activatePlugin(sdk, plan, { pollIntervalMs, timeoutMs, rerun = tokens => ['jsn', ...tokens].join(' ') } = {}) {
  const [id] = plan.requested, show = rerun(['plugins', 'show', id]);
  let response;
  try {
    response = await sdk.request(`${sdk.baseURL}/api/sn_cicd/plugin/${encodeURIComponent(id)}/activate`, { method: 'POST' });
  } catch (error) {
    // A 4xx is the instance's answer; a timeout, dropped connection or 5xx may follow a request it accepted.
    if (error instanceof AppError && error.code !== CodeNetwork && !(error.status >= 500)) throw error;
    throw new AppError('plugin_activation_unknown', `Activation of ${id} may have started, but the request failed (${error.message}), so its state is unknown.`,
      `Read ${show} before any retry; jsn never resends an activation.`);
  }
  const result = response?.result;
  if (!result || typeof result !== 'object') throw errAPI(200, `The activation request for ${id} returned no result, so its state is unknown. Read ${show} before retrying.`);
  const tracker = result.links?.progress?.id;
  // A tracker means the activation was queued, even beside error text (a license warning on a PDI).
  if (!isSysId(String(tracker ?? '')) && result.error) {
    throw new AppError('plugin_activation_rejected', `Activation of ${id} was not started: ${raw(result.error)}.`,
      `Read ${show} before retrying; jsn never resends an activation.`);
  }
  // No tracker does not prove a rejection: the activation may be running.
  if (!isSysId(String(tracker ?? ''))) {
    throw new AppError('plugin_activation_unknown', `Activation of ${id} may have started, but no progress tracker came back, so its state is unknown.`,
      `Read ${show} before any retry; jsn never resends an activation.`);
  }
  let progress;
  try { progress = await waitForOperation(sdk, tracker, { pollIntervalMs, timeoutMs }); }
  catch (error) {
    throw new AppError('plugin_progress_unavailable', `Activation of ${id} was started (tracker ${tracker}) but its progress could not be read: ${error.message}. It may still be running.`,
      `Read ${rerun(['store', 'status', tracker])} and ${show}; do not resend.`);
  }
  const data = { ...plan, tracker_id: tracker, activation_warning: result.error ? raw(result.error) : null, ...progress, still_inactive: null, verified: false };
  if (progress.wait_timed_out || !progress.succeeded) return data;
  const ids = plan.plugins.map(plugin => plugin.id);
  let found;
  try { found = await readPlugins(sdk, ids); }
  catch (error) {
    throw new AppError('plugin_readback_unavailable', `Tracker ${tracker} reported success, but v_plugin could not be read back: ${error.message}.`,
      `Read ${show}; a reported success is not a completed activation.`);
  }
  data.still_inactive = ids.filter(dep => found.get(dep)?.active !== true);
  data.verified = !data.still_inactive.length;
  return data;
}

export function formatActivation(data) {
  const lines = [data.tracker_id ? `Activation of ${data.requested[0]}: tracker ${data.tracker_id}, ${data.status_label ?? data.status ?? 'status unknown'}${data.wait_timed_out ? ' (still running when the wait ended)' : ''}` : `Install ${data.requested.join(', ')}: preview, nothing sent`];
  lines.push(data.plugins.length ? `Plugins ${data.refusals.length ? 'activation would need' : 'to activate'}, required plugins first:` : 'No inactive plugin to activate.');
  data.plugins.forEach((plugin, i) => lines.push(`  ${i + 1}. ${plugin.id}  ${plugin.name ?? 'unnamed'} ${plugin.version ?? 'version unknown'}${plugin.required_by_request ? ', required' : ''}`));
  if (data.unlisted.length) lines.push(`Not listed in v_plugin, state unknown: ${data.unlisted.join(', ')}`);
  if (data.cycles.length) lines.push(`Cycles, not followed: ${data.cycles.map(([a, b]) => `${a} -> ${b}`).join(', ')}`);
  for (const refusal of data.refusals) lines.push(`Refused: ${refusal.id}: ${refusal.reason}`);
  if (data.activation_warning) lines.push(`Instance warning: ${data.activation_warning}`);
  if (data.status_message || data.error) lines.push(`Tracker says: ${data.status_message || data.error}`);
  if (data.still_inactive?.length) lines.push(`Still inactive after activation: ${data.still_inactive.join(', ')}`);
  if (data.verified) lines.push(`Verified: v_plugin shows all ${data.plugins.length} active.`);
  return lines.join('\n');
}

const PLAN_FIELDS = 'sys_id,name,state,notes,rollback_context,sys_updated_on';
const ITEM_FIELDS = 'sys_id,batch_install_plan,id,name,type,version,state,reason,status_message,demo_data';
const ITEM_LIMIT = 1000;
const SYS_ID = /^[0-9a-f]{32}$/;
const label = value => value && typeof value === 'object' ? String(value.display_value ?? value.value ?? '') : raw(value);
const malformedPlan = message => Object.assign(new Error(`Malformed batch install plan response: ${message}`), { code: 'malformed_response' });
const planRow = row => {
  if (!SYS_ID.test(raw(row?.sys_id))) throw malformedPlan('a plan row has no sys_id');
  return { sys_id: raw(row.sys_id), name: raw(row.name) || null, state: raw(row.state) || null, notes: raw(row.notes) || null, rollback_context: raw(row.rollback_context) || null, rollback_context_name: label(row.rollback_context) || null, updated: raw(row.sys_updated_on) || null };
};
const read = (sdk, table, query, fields, limit) => sdk.listStrict(table, new URLSearchParams({ sysparm_query: query, sysparm_fields: fields, sysparm_limit: String(limit), sysparm_display_value: 'all', sysparm_exclude_reference_link: 'true' }));

export async function listPlans(sdk, { limit = 20 } = {}) {
  boundedLimit(limit);
  const rows = await read(sdk, 'sys_batch_install_plan', 'ORDERBYDESCsys_updated_on', PLAN_FIELDS, limit + 1);
  const records = rows.slice(0, limit).map(planRow);
  return { records, count: records.length, pagination: { limit, hasMore: rows.length > limit } };
}

// A plan by sys_id or exact name, and its items joined on the plan's raw sys_id.
export async function showPlan(sdk, identifier) {
  const id = String(identifier ?? '');
  if (!id || id.length > 100 || /[\^\n\r]/.test(id)) throw errUsage('Provide a batch install plan name or sys_id, up to 100 characters, without ^ or line breaks.');
  const rows = await read(sdk, 'sys_batch_install_plan', SYS_ID.test(id) ? `sys_id=${id}` : `name=${id}`, PLAN_FIELDS, 2);
  if (!rows.length) throw errNotFoundHint('Batch install plan', id, 'Check the name or sys_id, and that this profile can read sys_batch_install_plan; ACLs hide rows, so this does not prove the plan is absent. List plans with jsn plugins plans.');
  if (rows.length > 1) throw errUsage(`More than one batch install plan is named ${id}; name it by sys_id: ${rows.map(row => raw(row?.sys_id)).join(', ')}.`);
  const plan = planRow(rows[0]);
  if (SYS_ID.test(id) ? plan.sys_id !== id : plan.name?.toLowerCase() !== id.toLowerCase()) throw malformedPlan(`asked for ${id}, got ${plan.name ?? plan.sys_id}`);
  const itemRows = await read(sdk, 'sys_batch_install_item', `batch_install_plan=${plan.sys_id}^ORDERBYname`, ITEM_FIELDS, ITEM_LIMIT + 1);
  const items = itemRows.slice(0, ITEM_LIMIT).map(row => {
    if (!SYS_ID.test(raw(row?.sys_id))) throw malformedPlan('an item row has no sys_id');
    if (raw(row.batch_install_plan) !== plan.sys_id) throw malformedPlan(`item ${raw(row.sys_id)} belongs to another plan`);
    const value = field => raw(row[field]) || null;
    return { sys_id: raw(row.sys_id), id: value('id'), name: value('name'), type: value('type'), version: value('version'), state: value('state'), reason: value('reason'), status_message: value('status_message'), demo_data: flag(row.demo_data) };
  });
  return { plan, items, count: items.length, complete: itemRows.length <= ITEM_LIMIT, failed: items.filter(item => item.state === 'failed' || item.state === 'invalid').map(item => item.id ?? item.sys_id) };
}

export function formatPlans(data) {
  if (!data.records.length) return 'No batch install plans this profile can read. ACLs can hide rows, so this does not prove there are none.';
  return data.records.map(plan => `${plan.updated ?? 'never updated'}  ${plan.state ?? 'state unknown'}  ${plan.name ?? plan.sys_id}  ${plan.sys_id}${plan.notes ? `  ${plan.notes}` : ''}`).join('\n') + (data.pagination.hasMore ? `\nMore plans exist; raise --limit (now ${data.pagination.limit}).` : '');
}

export function formatPlan(data) {
  const p = data.plan;
  const lines = [`${p.name ?? p.sys_id} [${p.sys_id}] ${p.state ?? 'state unknown'}, updated ${p.updated ?? 'unknown'}`, `Rollback context ${p.rollback_context_name ?? 'none'}${p.notes ? `; ${p.notes}` : ''}`, `${data.count ? `${data.count} item(s)` : 'No items this profile can read (ACLs can hide rows)'}, ${data.failed.length} failed or invalid${data.complete ? '' : `; INCOMPLETE, only the first ${ITEM_LIMIT} were read`}`];
  for (const item of data.items) lines.push(`  ${item.state ?? 'state unknown'}  ${item.type ?? 'type unknown'}  ${item.name ?? 'unnamed'} [${item.id ?? 'no id'}] ${item.version ?? ''}${item.reason ? `  ${item.reason}` : ''}${item.status_message ? `: ${item.status_message}` : ''}`.trimEnd());
  return lines.join('\n');
}
