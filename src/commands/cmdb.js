// CMDB commands — read-only CI lookup and relationship traversal.
//
// relationship BFS walk modeled on @onlyflows/servicenow-mcp
// relationships.ts (hand-rolled, zero extra deps — jsn's sdk already does
// Table API GETs). Direction semantics: parent=current → other is child →
// downstream; child=current → other is parent → upstream.

import {
  assertSafeExactMatch,
  buildQuerySuffix,
  formatRecordForDisplay,
  getStringField,
  interactiveList,
  resolveFieldsParam,
} from '../helpers.js';
import { errNotFound, errUsage } from '../errors.js';

const SYS_ID_RE = /^[0-9a-f]{32}$/i;
const MAX_DEPTH = 5;
const MAX_HOP_LIMIT = 1000;
const SHOW_GROUP_CAP = 4;
const DEFAULT_CI_COLUMNS = ['name', 'operational_status', 'ip_address'];

// Curated field set for the cmdb show card — the facts that matter when
// you look at a CI. Empty values are skipped.
const SHOW_FIELDS = [
  'operational_status',
  'install_status',
  'ip_address',
  'fqdn',
  'category',
  'environment',
  'life_cycle_stage',
  'monitored',
  'serial_number',
  'asset_tag',
  'os',
  'os_version',
  'sys_updated_on',
  'sys_updated_by',
];

/**
 * Extract the raw sys_id from a field that may be a string or a
 * {display_value, link, value} object (sysparm_display_value=all shape).
 */
function extractValue(field) {
  if (!field) return '';
  if (typeof field === 'string') return field;
  if (typeof field === 'object') {
    if (field.value && typeof field.value === 'string') return field.value;
    if (field.link && typeof field.link === 'string') {
      const parts = field.link.split('/');
      return parts[parts.length - 1];
    }
  }
  return '';
}

/**
 * Extract the display name from a field, ignoring bare 32-hex sys_ids.
 */
function extractDisplay(field) {
  if (!field) return '';
  if (typeof field === 'string') {
    if (/^[a-f0-9]{32}$/.test(field)) return '';
    return field;
  }
  if (typeof field === 'object' && field.display_value != null) {
    return String(field.display_value);
  }
  return '';
}

/**
 * Resolve a CI identifier (sys_id or name) to {sys_id, name, class}.
 * Throws not_found when nothing matches.
 */
async function resolveCI(app, identifier) {
  const ciParam = String(identifier || '').trim();
  if (!ciParam) throw errUsage('A CI name or sys_id is required');

  // Identifier safety: refuse query metacharacters that could turn the
  // name lookup into a compound query matching more than one CI.
  assertSafeExactMatch(ciParam);

  const bySysId = SYS_ID_RE.test(ciParam);
  const params = new URLSearchParams();
  params.set('sysparm_fields', 'sys_id,name,sys_class_name');
  params.set('sysparm_display_value', 'true');
  params.set('sysparm_query', bySysId ? `sys_id=${ciParam}` : `name=${ciParam}`);
  params.set('sysparm_limit', bySysId ? '1' : '5');
  const rows = await app.sdk.list('cmdb_ci', params);
  if (!rows[0]) throw errNotFound('CMDB CI', ciParam);

  return {
    sys_id: getStringField(rows[0], 'sys_id'),
    name: getStringField(rows[0], 'name'),
    class: getStringField(rows[0], 'sys_class_name') || 'unknown',
  };
}

/**
 * Breadcrumbs that lead out of a CI record into the traversal commands.
 */
function relationshipsBreadcrumbs(sysId, ciClass) {
  return [
    {
      action: 'relationships',
      cmd: `jsn cmdb relationships --ci ${sysId}`,
      description: 'Traverse relationships (BFS graph walk)',
    },
    {
      action: 'impact',
      cmd: `jsn cmdb relationships --ci ${sysId} --impact`,
      description: 'Impact analysis: upstream only',
    },
    {
      action: 'list',
      cmd: ciClass ? `jsn cmdb list --query "sys_class_name=${ciClass}"` : 'jsn cmdb list',
      description: 'Other CIs of the same class',
    },
  ];
}

/**
 * Fetch one hop of relationships for a CI and map them to row shape
 * {name, class, type, direction, sys_id} (depth assigned by the caller).
 * Applies direction/type filters at the walk level; the class filter is
 * display-only and stays with the caller so traversal can recurse through
 * filtered nodes.
 */
async function fetchRelRows(app, currentId, { direction = 'both', type, hopLimit = 100, classCache = new Map() } = {}) {
  let records;
  try {
    const params = new URLSearchParams();
    params.set('sysparm_query', `parent=${currentId}^ORchild=${currentId}`);
    params.set('sysparm_fields', 'parent,child,type');
    params.set('sysparm_display_value', 'all');
    params.set('sysparm_limit', String(hopLimit));
    records = await app.sdk.list('cmdb_rel_ci', params);
  } catch {
    return []; // hop fetch failed — report what we have
  }

  const getClass = async (id) => {
    if (classCache.has(id)) return classCache.get(id);
    try {
      const params = new URLSearchParams();
      params.set('sysparm_fields', 'sys_class_name');
      params.set('sysparm_display_value', 'true');
      params.set('sysparm_query', `sys_id=${id}`);
      params.set('sysparm_limit', '1');
      const rows = await app.sdk.list('cmdb_ci', params);
      classCache.set(id, rows[0] ? getStringField(rows[0], 'sys_class_name') : 'unknown');
    } catch {
      classCache.set(id, 'unknown');
    }
    return classCache.get(id);
  };

  const rows = [];
  const seen = new Set();
  for (const rec of records) {
    const parentId = extractValue(rec.parent);
    const childId = extractValue(rec.child);
    const parentName = extractDisplay(rec.parent);
    const childName = extractDisplay(rec.child);
    const typeName = extractDisplay(rec.type) || 'Related to';

    let otherId;
    let otherName;
    let relDir;
    if (parentId === currentId) {
      otherId = childId;
      otherName = childName;
      relDir = 'downstream';
    } else if (childId === currentId) {
      otherId = parentId;
      otherName = parentName;
      relDir = 'upstream';
    } else {
      continue;
    }

    if (otherId === currentId) continue;
    if (direction !== 'both' && relDir !== direction) continue;
    if (type && !typeName.toLowerCase().includes(type.toLowerCase())) continue;

    const pairKey = `${otherId}:${relDir}`;
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);

    rows.push({
      name: otherName || otherId,
      class: await getClass(otherId),
      type: typeName,
      direction: relDir,
      sys_id: otherId,
      parent: currentId,
    });
  }
  return rows;
}

/**
 * Hourglass layout for a relationship walk (styled "flow-like" UI):
 *
 *   ▶ PARENTS            ← ancestor chain, growing upward
 *   **YOU ARE HERE**     ← the CI the walk started from
 *   ▶ CHILDREN           ← descendant chain, growing downward
 *
 * Built from flat rows carrying `parent` (the CI each row was discovered
 * from). Each CI renders once per section — repeats (cycles) collapse to a
 * ↺ marker instead of re-expanding.
 */
export function formatCMDBGraph(root, rows) {
  const lines = [];
  lines.push('');
  lines.push(`CMDB: ${root.name} (${root.class})`);
  lines.push(`Sys ID: ${root.sys_id}`);
  lines.push('─'.repeat(56));

  if (rows.length === 0) {
    lines.push('▶ RELATIONSHIPS (0)');
    lines.push('─'.repeat(56));
    lines.push('  (no relationships found)');
    lines.push('');
    return lines.join('\n') + '\n';
  }

  const edges = new Map();
  for (const r of rows) {
    if (!edges.has(r.parent)) edges.set(r.parent, []);
    edges.get(r.parent).push(r);
  }
  const ancestorsOf = (id) => (edges.get(id) || []).filter((r) => r.direction === 'upstream');
  const descendantsOf = (id) => (edges.get(id) || []).filter((r) => r.direction === 'downstream');

  lines.push(`▶ RELATIONSHIPS (${rows.length})`);
  lines.push('─'.repeat(56));

  // ── Parents: the ancestor chain, nested upward ──
  lines.push('▶ PARENTS');
  const parents = ancestorsOf(root.sys_id);
  if (parents.length === 0) {
    lines.push('  (none)');
  } else {
    const seen = new Set([root.sys_id]);
    const renderAncestors = (id, prefix) => {
      ancestorsOf(id).forEach((p, i) => {
        const last = i === ancestorsOf(id).length - 1;
        const dup = seen.has(p.sys_id);
        lines.push(`${prefix}${last ? '└─ ' : '├─ '}↑ ${p.name} (${p.class}) — ${p.type}${dup ? '  ↺' : ''}`);
        if (!dup) {
          seen.add(p.sys_id);
          renderAncestors(p.sys_id, prefix + (last ? '   ' : '│  '));
        }
      });
    };
    renderAncestors(root.sys_id, '');
  }

  // ── The CI itself ──
  lines.push('');
  lines.push(`**YOU ARE HERE** ${root.name} (${root.class})`);
  lines.push('');

  // ── Children: the descendant chain, nested downward ──
  lines.push('▶ CHILDREN');
  const kids = descendantsOf(root.sys_id);
  if (kids.length === 0) {
    lines.push('  (none)');
  } else {
    const seen = new Set([root.sys_id]);
    const renderDescendants = (id, prefix) => {
      descendantsOf(id).forEach((k, i) => {
        const last = i === descendantsOf(id).length - 1;
        const dup = seen.has(k.sys_id);
        lines.push(`${prefix}${last ? '└─ ' : '├─ '}↓ ${k.name} (${k.class}) — ${k.type}${dup ? '  ↺' : ''}`);
        if (!dup) {
          seen.add(k.sys_id);
          renderDescendants(k.sys_id, prefix + (last ? '   ' : '│  '));
        }
      });
    };
    renderDescendants(root.sys_id, '');
  }

  lines.push('');
  return lines.join('\n') + '\n';
}

/**
 * Curated styled card for `cmdb show`: header + key fields + relationship
 * groups (parents / siblings / children), each capped at SHOW_GROUP_CAP with
 * the true total. Replaces the raw field dump in styled mode.
 */
export function formatCMDBShow(root, groups, { instanceURL = '', record } = {}) {
  const { parents = [], siblings = [], children = [], counts = {} } = groups;
  const lines = [];
  lines.push('');
  lines.push(`${root.name} (${root.class})`);
  lines.push(`Sys ID: ${root.sys_id}`);
  if (instanceURL && root.sys_id) {
    lines.push(`Link: ${instanceURL}/cmdb_ci.do?sys_id=${root.sys_id}`);
  }
  lines.push('─'.repeat(56));

  // Key fields — only populated values, aligned label column
  if (record && typeof record === 'object') {
    const fieldLines = SHOW_FIELDS
      .map((f) => [f, getStringField(record, f)])
      .filter(([, v]) => v !== '');
    if (fieldLines.length > 0) {
      const labelWidth = Math.max(...fieldLines.map(([k]) => k.length));
      lines.push('▶ Fields');
      for (const [k, v] of fieldLines) {
        lines.push(`  ${k.padEnd(labelWidth)}  ${v}`);
      }
      lines.push('');
    }
  }

  const renderGroup = (label, rows, total, arrow, viaKey) => {
    const totalN = total ?? rows.length;
    lines.push(`▶ ${label} (${totalN})`);
    if (rows.length === 0) {
      lines.push('  (none)');
    } else {
      for (const r of rows) {
        const via = viaKey && r[viaKey] ? ` (via ${r[viaKey]})` : '';
        lines.push(`  ${arrow} ${r.name} (${r.class}) — ${r.type}${via}`);
      }
      if (totalN > rows.length) {
        lines.push(`  … ${totalN - rows.length} more — run: jsn cmdb relationships --ci ${root.sys_id}`);
      }
    }
    lines.push('');
  };

  renderGroup('Parents', parents, counts.parents, '↑');
  renderGroup('Siblings', siblings, counts.siblings, '↔', 'via');
  renderGroup('Children', children, counts.children, '↓');

  if (lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n') + '\n';
}

export function cmdbCmd(wrap) {
  return {
    command: 'cmdb [subcommand]',
    describe: 'Query the Configuration Management Database (CMDB) — CIs and relationship traversal (read-only)',
    builder: (yargs) => {
      return yargs
        .command({
          command: 'list',
          describe: 'List CIs from the CMDB (cmdb_ci)',
          builder: (y) => y
            .option('query', { type: 'string', describe: 'Encoded query (e.g. "sys_class_name=cmdb_ci_server" or "nameLIKEweb")' })
            .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns (e.g. "name,operational_status,ip_address")' })
            .option('limit', { type: 'number', default: 20, describe: 'Max CIs' })
            .option('offset', { type: 'number', default: 0, describe: 'Offset' })
            .option('count', { type: 'boolean', default: true, describe: 'Include the total-matching count (use --no-count to opt out)' }),
          handler: wrap(async (argv, app) => {
            const columns = argv.columns ? argv.columns.split(',') : DEFAULT_CI_COLUMNS;

            // Interactive picker in TTY with auto format and no explicit query/offset
            if (!argv.query && argv.offset === 0) {
              const picked = await interactiveList({
                app, table: 'cmdb_ci', singular: 'CI', columns, limit: argv.limit, labelField: 'name',
                formatLabel: (r) => {
                  const name = getStringField(r, 'name');
                  const op = getStringField(r, 'operational_status');
                  const ip = getStringField(r, 'ip_address');
                  return `${name || '?'}${op ? ` | ${op}` : ''}${ip ? ` | ${ip}` : ''}`;
                },
              });
              if (picked) {
                picked._context = { instance_url: app.getEffectiveInstance(), table: 'cmdb_ci' };
                const sysId = getStringField(picked, 'sys_id');
                const ciClass = getStringField(picked, 'sys_class_name');
                return app.ok(picked, {
                  summary: `${getStringField(picked, 'name') || sysId}${ciClass ? ` (${ciClass})` : ''}`,
                  breadcrumbs: relationshipsBreadcrumbs(sysId, ciClass),
                });
              }
            }

            const params = new URLSearchParams();
            params.set('sysparm_limit', String(argv.limit));
            params.set('sysparm_offset', String(argv.offset));
            params.set('sysparm_display_value', 'all');
            const fields = resolveFieldsParam(columns);
            if (fields) params.set('sysparm_fields', fields);
            if (argv.query) params.set('sysparm_query', argv.query);
            const records = await app.sdk.list('cmdb_ci', params);
            const displayRecords = fields ? records.map((r) => formatRecordForDisplay(r, columns)) : records;

            let total;
            if (argv.count !== false) {
              try { total = await app.sdk.aggregateCount('cmdb_ci', argv.query); } catch { total = undefined; }
            }

            const breadcrumbs = [
              {
                action: 'show',
                cmd: 'jsn cmdb show <name-or-sys-id>',
                description: 'Get full details for a CI',
              },
              {
                action: 'relationships',
                cmd: 'jsn cmdb relationships --ci <sys-id>',
                description: 'Traverse relationships from a CI',
              },
            ];
            if (records.length === argv.limit) {
              breadcrumbs.push({
                action: 'next',
                cmd: `jsn cmdb list --limit ${argv.limit} --offset ${argv.offset + argv.limit}${buildQuerySuffix(argv.query)}`,
                description: 'Next page',
              });
            }
            if (argv.offset > 0) {
              breadcrumbs.push({
                action: 'prev',
                cmd: `jsn cmdb list --limit ${argv.limit} --offset ${Math.max(0, argv.offset - argv.limit)}${buildQuerySuffix(argv.query)}`,
                description: 'Previous page',
              });
            }

            app.ok({
              table: 'cmdb_ci',
              count: records.length,
              columns,
              records: displayRecords,
              pagination: { limit: argv.limit, offset: argv.offset, ...(total != null ? { total } : {}) },
              context: { instance_url: app.getEffectiveInstance() },
            }, {
              summary: `${records.length} CI(s) from cmdb_ci${total != null ? ` of ${total}` : ''}`,
              breadcrumbs,
            });
          }),
        })
        .command({
          command: 'show <ci>',
          describe: 'Show a CI by name or sys_id',
          builder: (y) => y
            .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns (e.g. "name,sys_class_name,ip_address") or "*" for all' }),
          handler: wrap(async (argv, app) => {
            const root = await resolveCI(app, argv.ci);
            const params = new URLSearchParams();
            params.set('sysparm_query', `sys_id=${root.sys_id}`);
            params.set('sysparm_limit', '1');
            params.set('sysparm_display_value', 'true');
            if (argv.columns && argv.columns !== '*') params.set('sysparm_fields', `sys_id,${argv.columns}`);
            const records = await app.sdk.list('cmdb_ci', params);
            if (records.length === 0) throw errNotFound('CMDB CI', argv.ci);
            const record = records[0];
            record._context = { instance_url: app.getEffectiveInstance(), table: 'cmdb_ci' };

            // Viewing a CI should answer "what does this connect to" without a
            // second command: parents (upstream), children (downstream), and
            // siblings (other children of this CI's parents). Each group is
            // capped at 4 — the relationships command shows everything.
            const parents = await fetchRelRows(app, root.sys_id, { direction: 'upstream' });
            const children = await fetchRelRows(app, root.sys_id, { direction: 'downstream' });
            const siblings = [];
            const seenSib = new Set();
            for (const p of parents) {
              if (siblings.length >= SHOW_GROUP_CAP) break;
              const kids = await fetchRelRows(app, p.sys_id, { direction: 'downstream' });
              for (const k of kids) {
                if (k.sys_id === root.sys_id || seenSib.has(k.sys_id)) continue;
                seenSib.add(k.sys_id);
                siblings.push({ ...k, via: p.name });
                if (siblings.length >= SHOW_GROUP_CAP) break;
              }
            }

            record.relationships = {
              parents: parents.slice(0, SHOW_GROUP_CAP).map((r) => ({ ...r, depth: 1 })),
              siblings: siblings.slice(0, SHOW_GROUP_CAP).map((r) => ({ ...r, depth: 1 })),
              children: children.slice(0, SHOW_GROUP_CAP).map((r) => ({ ...r, depth: 1 })),
              counts: { parents: parents.length, siblings: siblings.length, children: children.length },
            };
            record._formatted = formatCMDBShow(
              { name: getStringField(record, 'name') || root.name, class: getStringField(record, 'sys_class_name') || root.class, sys_id: root.sys_id },
              record.relationships,
              { instanceURL: app.getEffectiveInstance(), record }
            );

            const breadcrumbs = [
              {
                action: 'relationships',
                cmd: `jsn cmdb relationships --ci ${root.sys_id}`,
                description: 'Show ALL relationships (parents, children, deep traversal)',
              },
              {
                action: 'impact',
                cmd: `jsn cmdb relationships --ci ${root.sys_id} --impact`,
                description: 'Impact analysis: upstream only',
              },
              {
                action: 'list',
                cmd: `jsn cmdb list --query "sys_class_name=${root.class}"`,
                description: 'Other CIs of the same class',
              },
            ];

            app.ok(record, {
              summary: `${record.name || record.sys_id} (${record.sys_class_name || 'unknown class'}) — `
                + `${parents.length} parent(s), ${siblings.length} sibling(s), ${children.length} child(ren)`,
              breadcrumbs,
            });
          }),
        })
        .command({
          command: 'relationships',
          describe: 'Traverse CMDB CI relationships (BFS graph walk) — impact analysis and dependency mapping',
          builder: (y) => y
            .option('ci', { type: 'string', demandOption: true, describe: 'Root CI: sys_id or name' })
            .option('direction', { type: 'string', choices: ['upstream', 'downstream', 'both'], default: 'both', describe: 'Traversal direction' })
            .option('depth', { type: 'number', default: 3, describe: 'How many levels deep to traverse (1-5)' })
            .option('type', { type: 'string', describe: 'Filter by relationship type name (substring match)' })
            .option('class', { type: 'string', describe: 'Filter CIs by class name (substring match)' })
            .option('impact', { type: 'boolean', default: false, describe: 'Impact analysis mode — walks upstream only' })
            .option('limit', { type: 'number', default: 100, describe: 'Max relationships to fetch per hop' }),
          handler: wrap(async (argv, app) => {
            const ciParam = String(argv.ci || '').trim();
            if (!ciParam) throw errUsage('--ci is required (sys_id or name of the root CI)');

            const depth = argv.depth == null ? 3 : Math.floor(argv.depth);
            if (depth < 1 || depth > MAX_DEPTH) {
              throw errUsage(`--depth must be between 1 and ${MAX_DEPTH} (got ${argv.depth})`);
            }
            let direction = argv.direction;
            if (argv.impact) direction = 'upstream';
            const hopLimit = Math.max(1, Math.min(Math.floor(argv.limit) || 100, MAX_HOP_LIMIT));

            // ── Resolve root CI (by sys_id or by name) ──
            const root = await resolveCI(app, ciParam);
            const rootId = root.sys_id;
            const rootName = root.name;
            const rootClass = root.class;

            // ── Traverse ──
            const visited = new Set([rootId]);
            const classCache = new Map([[rootId, rootClass]]);
            const relationships = [];

            const traverse = async (currentId, currentDepth) => {
              if (currentDepth > depth) return;

              const rows = await fetchRelRows(app, currentId, { direction, type: argv.type, hopLimit, classCache });

              for (const row of rows) {
                // Class filter applies to the displayed rows; traversal still
                // recurses through the CI (matches the reference behavior).
                if (!argv.class || row.class.toLowerCase().includes(argv.class.toLowerCase())) {
                  relationships.push({ ...row, depth: currentDepth });
                }

                if (currentDepth < depth && !visited.has(row.sys_id)) {
                  visited.add(row.sys_id);
                  await traverse(row.sys_id, currentDepth + 1);
                }
              }
            };

            await traverse(rootId, 1);

            const breadcrumbs = [
              {
                action: 'show',
                cmd: `jsn cmdb show ${rootId}`,
                description: 'Full record for the root CI',
              },
              {
                action: 'impact',
                cmd: `jsn cmdb relationships --ci ${rootId} --impact`,
                description: 'Impact analysis: upstream only',
              },
              {
                action: 'deeper',
                cmd: `jsn cmdb relationships --ci ${rootId} --depth ${MAX_DEPTH}`,
                description: `Traverse deeper (max depth ${MAX_DEPTH})`,
              },
              {
                action: 'filter',
                cmd: `jsn cmdb relationships --ci ${rootId} --type "<rel type>" --class "<ci class>"`,
                description: 'Filter by relationship type or CI class',
              },
            ];

            app.ok({
              root: { name: rootName, class: rootClass, sys_id: rootId },
              records: relationships,
              meta: { depth, direction, total: relationships.length },
              table: 'cmdb_rel_ci',
              count: relationships.length,
              columns: ['name', 'class', 'type', 'direction', 'sys_id', 'depth'],
              context: { instance_url: app.getEffectiveInstance() },
              _formatted: formatCMDBGraph({ name: rootName, class: rootClass, sys_id: rootId }, relationships),
            }, {
              summary: `${relationships.length} relationship(s) for ${rootName} (${rootClass}) — depth ${depth}, ${direction}`,
              breadcrumbs,
            });
          }),
        });
    },
  };
}
