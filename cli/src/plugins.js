import { errNotFound, errUsage } from './errors.js';

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
  if (!root) throw errNotFound('Plugin', id);
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
