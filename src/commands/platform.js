import { declareCapabilities } from '../capabilities.js';

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

export const XMLSTATS_MAX_BYTES = 4 * 1024 * 1024;

function metric(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { value: null, availability: 'unavailable' };
  }
  return { value: numberOrString(String(value).trim()), availability: 'available' };
}

function firstNestedText(xml, parent, child) {
  const parentMatch = xml.match(new RegExp(`<${parent}\\b[^>]*>([\\s\\S]*?)</${parent}>`));
  return parentMatch ? tagText(parentMatch[1], child) : undefined;
}

function allowlistedStats(xml) {
  const unavailable = [];
  const add = (path, value) => {
    const result = metric(value);
    if (result.availability === 'unavailable') unavailable.push(path);
    return result;
  };

  const cluster = xml.match(/<cluster\.status\b[^>]*>([\s\S]*?)<\/cluster\.status>/);
  const nodeXml = cluster?.[1]?.match(/<node\b[^>]*>([\s\S]*?)<\/node>/)?.[1] || '';
  const daily = statsForWindow(xml, 'all_transactions', 'daily') || {};
  const semaphores = [];
  for (const match of xml.matchAll(/<semaphores([^>]*)\/>/g)) {
    const attrs = {};
    for (const [, key, value] of match[1].matchAll(/([\w.-]+)="([^"]*)"/g)) attrs[key] = value;
    if (!attrs.name && !attrs.available && !attrs.borrowed && !attrs.maximum_concurrency && !attrs.queue_depth) continue;
    semaphores.push({
      name: attrs.name || 'unnamed',
      available: add(`semaphores[${attrs.name || 'unnamed'}].available`, attrs.available),
      borrowed: add(`semaphores[${attrs.name || 'unnamed'}].borrowed`, attrs.borrowed),
      maximum: add(`semaphores[${attrs.name || 'unnamed'}].maximum`, attrs.maximum_concurrency),
      queue_depth: add(`semaphores[${attrs.name || 'unnamed'}].queue_depth`, attrs.queue_depth),
    });
  }
  if (semaphores.length === 0) unavailable.push('semaphores');

  return {
    node: {
      status: add('node.status', tagText(nodeXml, 'status')),
      type: add('node.type', firstNestedText(nodeXml, 'node_type', 'name')),
    },
    queue: {
      length: add('queue.length', tagText(xml, 'queue.length')),
      age: add('queue.age', tagText(xml, 'queue.age')),
    },
    active_sessions: add('active_sessions', tagText(xml, 'servlet.active.sessions')),
    memory_pressure: add('memory_pressure', tagText(xml, 'memory_pressure')),
    semaphores,
    transactions: {
      daily: {
        count: add('transactions.daily.count', daily.count),
        mean: add('transactions.daily.mean', daily.mean),
        median: add('transactions.daily.median', daily.median),
        ninetypercent: add('transactions.daily.ninetypercent', daily.ninetypercent),
        max: add('transactions.daily.max', daily.max),
      },
    },
    unavailable,
  };
}

export function parsePlatformStatsXml(xml) {
  const source = String(xml || '');
  if (Buffer.byteLength(source) > XMLSTATS_MAX_BYTES) throw new Error('xmlstats response exceeds the bounded size limit');
  if (!/^\s*(?:<\?xml[\s\S]*?\?>\s*)?<xmlstats\b[^>]*>/i.test(source)
    || !/<\/xmlstats>\s*$/i.test(source)) {
    throw new Error('Malformed XML: expected an xmlstats document');
  }
  const stack = [];
  for (const match of source.matchAll(/<\/?([A-Za-z][\w.:-]*)(?:\s[^>]*)?>/g)) {
    const token = match[0];
    const name = match[1];
    if (/^<\//.test(token)) {
      if (stack.pop() !== name) throw new Error('Malformed XML: mismatched tags');
    } else if (!/\/\s*>$/.test(token)) {
      stack.push(name);
    }
  }
  if (stack.length !== 0) throw new Error('Malformed XML: unclosed tags');
  return allowlistedStats(source);
}

async function readBoundedResponse(response, maxBytes = XMLSTATS_MAX_BYTES) {
  if (!response.body?.getReader) {
    const text = await response.text();
    return Buffer.byteLength(text) > maxBytes ? { tooLarge: true, bytes: Buffer.byteLength(text) } : { text, bytes: Buffer.byteLength(text) };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      return { tooLarge: true, bytes };
    }
    chunks.push(value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(body), bytes };
}

function looksLikeLoginHtml(response, body) {
  const contentType = response.headers?.get?.('content-type') || '';
  return /text\/html/i.test(contentType) || /^\s*<(?:!doctype\s+html|html\b)/i.test(body);
}

export async function collectPlatformStats(sdk, instance) {
  let response;
  try {
    response = await sdk.fetchResponse(`${instance}/xmlstats.do`, {
      method: 'GET',
      headers: { Accept: 'application/xml,text/xml' },
    });
  } catch (error) {
    const message = String(error?.message || '').toLowerCase();
    return { status: /timeout|timed out/.test(message) ? 'timeout' : 'unavailable', reason: /timeout|timed out/.test(message) ? 'request timed out' : 'request failed' };
  }

  if (response.status === 401 || response.status === 403) return { status: 'permission_denied', reason: `HTTP ${response.status}` };
  if (response.status === 404 || response.status === 405) return { status: 'unsupported', reason: `HTTP ${response.status}` };
  if (!response.ok) return { status: 'unavailable', reason: `HTTP ${response.status}` };

  const body = await readBoundedResponse(response);
  if (body.tooLarge) return { status: 'too_large', reason: `response exceeded ${XMLSTATS_MAX_BYTES} bytes`, bytes: body.bytes };
  if (looksLikeLoginHtml(response, body.text)) return { status: 'login_redirect', reason: 'received HTML instead of xmlstats XML', bytes: body.bytes };

  try {
    const metrics = parsePlatformStatsXml(body.text);
    const status = metrics.unavailable.length > 0 ? 'partial' : 'success';
    return {
      status,
      reason: status === 'partial' ? 'some allowlisted metrics were unavailable' : null,
      bytes: body.bytes,
      metrics,
    };
  } catch {
    return { status: 'malformed_xml', reason: 'response was not a valid xmlstats document', bytes: body.bytes };
  }
}

function metricText(item) {
  return item?.availability === 'available' ? String(item.value) : 'unavailable';
}

export function formatPlatformStats(result) {
  const lines = [`STATUS: ${result.status}`];
  if (result.reason) lines.push(`REASON: ${result.reason}`);
  const m = result.metrics;
  if (!m) return `${lines.join('\\n')}\\n`;
  lines.push(`NODE: ${metricText(m.node.status)} / ${metricText(m.node.type)}`);
  lines.push(`QUEUE: ${metricText(m.queue.length)} length, ${metricText(m.queue.age)} age`);
  lines.push(`SESSIONS: ${metricText(m.active_sessions)}`);
  lines.push(`MEMORY PRESSURE: ${metricText(m.memory_pressure)}`);
  lines.push(`TRANSACTIONS DAILY: ${metricText(m.transactions.daily.count)} count, ${metricText(m.transactions.daily.mean)} mean, ${metricText(m.transactions.daily.ninetypercent)} p90, ${metricText(m.transactions.daily.max)} max`);
  if (m.semaphores.length === 0) lines.push('SEMAPHORES: unavailable');
  else for (const semaphore of m.semaphores) {
    lines.push(`SEMAPHORE ${semaphore.name}: ${metricText(semaphore.available)} available, ${metricText(semaphore.borrowed)} borrowed, ${metricText(semaphore.maximum)} maximum, ${metricText(semaphore.queue_depth)} queue`);
  }
  return `${lines.join('\\n')}\\n`;
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
  declareCapabilities('platform', { mutationSubcommands: [] });
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
    }).command({
      command: 'stats',
      describe: 'Show bounded, read-only platform statistics from xmlstats.do',
      handler: wrap(async (argv, app) => {
        app.requireInstance();
        const result = await collectPlatformStats(app.sdk, app.getEffectiveInstance());
        result._formatted = formatPlatformStats(result);
        app.ok(result, { summary: `Platform stats: ${result.status}` });
      }),
    }),
  };
}
