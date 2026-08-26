function numberOrString(value) {
  const n = Number(value);
  return value !== '' && Number.isFinite(n) ? n : value;
}

function tagText(xml, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = xml.match(new RegExp(`<${escaped}>([^<]*)</${escaped}>`));
  return match ? match[1].trim() : undefined;
}

function tagAttributes(xml, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = xml.match(new RegExp(`<${escaped}\\b([^>]*)\\/>`));
  if (!match) return undefined;
  const attrs = {};
  for (const [, key, value] of match[1].matchAll(/([\w.-]+)="([^"]*)"/g)) attrs[key] = numberOrString(value);
  return attrs;
}

function statsForWindow(xml, parent, window) {
  const parentMatch = xml.match(new RegExp(`<${parent}>([\\s\\S]*?)</${parent}>`));
  if (!parentMatch) return undefined;
  return tagAttributes(parentMatch[1], window);
}

export function parseNodeStatsXml(xml) {
  const source = String(xml || '');
  const result = {};
  const root = source.match(/<xmlstats\b([^>]*)>/);
  const rootAttrs = {};
  for (const [, key, value] of (root?.[1] || '').matchAll(/([\w.-]+)="([^"]*)"/g)) rootAttrs[key] = value;
  if (rootAttrs.created) result.created = rootAttrs.created;

  const queueLength = tagText(source, 'queue.length');
  const queueAge = tagText(source, 'queue.age');
  if (queueLength !== undefined || queueAge !== undefined) {
    result.queue = {};
    if (queueLength !== undefined) result.queue.length = numberOrString(queueLength);
    if (queueAge !== undefined) result.queue.age = numberOrString(queueAge);
  }

  const activeSessions = tagText(source, 'servlet.active.sessions');
  if (activeSessions !== undefined) result.active_sessions = numberOrString(activeSessions);
  const memoryPressure = tagText(source, 'memory_pressure');
  if (memoryPressure !== undefined) result.memory_pressure = memoryPressure;

  result.semaphores = [];
  for (const match of source.matchAll(/<semaphores\b([^>]*)\/>/g)) {
    const attrs = {};
    for (const [, key, value] of match[1].matchAll(/([\w.-]+)="([^"]*)"/g)) {
      if (['name', 'available', 'borrowed', 'queue_depth', 'queue_depth_limit', 'maximum_concurrency'].includes(key)) attrs[key] = numberOrString(value);
    }
    if (attrs.name) result.semaphores.push(attrs);
  }

  const daily = statsForWindow(source, 'all_transactions', 'daily');
  if (daily) {
    result.transactions = { daily: {} };
    for (const key of ['count', 'mean', 'median', 'ninetypercent', 'max']) {
      if (daily[key] !== undefined) result.transactions.daily[key] = daily[key];
    }
  }
  return result;
}

function displayValue(value) {
  if (value && typeof value === 'object') return value.display_value ?? value.value ?? '';
  return value ?? '';
}

function valueOf(value) {
  return value && typeof value === 'object' ? value.value : value;
}

export function selectClusterRows(rows, nodeId, allNodes) {
  if (!nodeId || allNodes) return rows;
  return rows.filter(row => valueOf(row.sys_id) === nodeId);
}

function formatHealth(nodes) {
  const lines = ['NODE STATUS  TYPE             QUEUE  AGE  SESSIONS  DEFAULT SEM  DB'];
  lines.push('-----------  ---------------  -----  ---  --------  -----------  --');
  for (const node of nodes) {
    const sem = node.stats.semaphores.find(s => s.name === 'Default');
    const db = node.stats.transactions?.daily;
    lines.push(`${String(displayValue(node.status) || '?').padEnd(11)}  ${String(displayValue(node.node_type) || '?').padEnd(15)}  ${String(node.stats.queue?.length ?? '-').padStart(5)}  ${String(node.stats.queue?.age ?? '-').padStart(3)}  ${String(node.stats.active_sessions ?? '-').padStart(8)}  ${sem ? `${sem.borrowed}/${sem.maximum_concurrency}`.padStart(11) : '-'.padStart(11)}  ${db ? `${db.mean} ms` : '-'}`);
  }
  if (nodes.length === 0) lines.push('(no nodes)');
  return `${lines.join('\n')}\n`;
}

export function platformCmd(wrap) {
  return {
    command: 'platform',
    describe: 'Inspect read-only platform health and node statistics',
    builder: (y) => y.command({
      command: 'health',
      describe: 'Show cluster, queue, semaphore, and node health',
      builder: (y) => y
        .option('node', {
          type: 'string',
          describe: 'Inspect one sys_cluster_state record by sys_id',
        })
        .option('all-nodes', {
          type: 'boolean',
          default: false,
          describe: 'Explicitly inspect every cluster node (the default)',
        }),
      handler: wrap(async (argv, app) => {
        app.requireInstance();
        const cluster = await app.sdk.list('sys_cluster_state', {
          sysparm_fields: 'sys_id,status,node_type,node_stats',
          sysparm_limit: '100',
        });
        const nodes = [];
        for (const row of selectClusterRows(cluster, argv.node, argv.allNodes)) {
          const id = typeof row.node_stats === 'object' ? row.node_stats.value : row.node_stats;
          if (!id) continue;
          const stats = await app.sdk.get('sys_cluster_node_stats', id);
          nodes.push({ sys_id: valueOf(row.sys_id), status: row.status, node_type: row.node_type, stats: parseNodeStatsXml(stats?.stats || '') });
        }
        app.ok({ table: 'sys_cluster_state', node_count: nodes.length, nodes, _formatted: formatHealth(nodes), security: { raw_xml: 'excluded', sensitive_fields: 'excluded' }, context: { instance_url: app.getEffectiveInstance() } }, { summary: `Platform health: ${nodes.length} node(s)` });
      }),
    }),
  };
}
