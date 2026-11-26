// Read-only ECC queue view for MID Servers (issue #663).
//
// The platform records queue direction on `ecc_queue.queue` (sys_choice:
// input/output) and the work type on `ecc_queue.topic`; both are verified on a
// live instance through sys_dictionary, sys_choice, populated rows and the
// Stats API. `agent` carries the routing value `mid.server.<name>`, matching
// what `midservers execute` writes.
import { errUsage } from './errors.js';

export const QUEUE_TABLE = 'ecc_queue';
export const AGENT_PREFIX = 'mid.server.';
export const DEFAULT_OLDER_THAN = '15m';
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 200;
export const OLDEST_FIELDS = ['sys_id', 'name', 'topic', 'state', 'priority', 'sys_created_on'];

const DURATION_RE = /^(\d{1,6})([mhd])$/;
const UNIT_MINUTES = { m: 1, h: 60, d: 1440 };

// Parsed before any instance/network setup so a typo cannot cost a request.
export function parseOlderThan(value) {
  const raw = value === undefined || value === null || value === '' ? DEFAULT_OLDER_THAN : String(value).trim().toLowerCase();
  const match = DURATION_RE.exec(raw);
  if (!match) {
    throw errUsage(`Invalid --older-than '${value}'. Use a whole number and one unit: 15m, 2h or 1d.`);
  }
  const amount = Number(match[1]);
  if (!Number.isInteger(amount) || amount < 1) {
    throw errUsage(`Invalid --older-than '${value}'. Use a positive whole number: 15m, 2h or 1d.`);
  }
  const minutes = amount * UNIT_MINUTES[match[2]];
  if (minutes > 525600) {
    throw errUsage(`Invalid --older-than '${value}'. Use at most 365d.`);
  }
  return { text: `${amount}${match[2]}`, minutes, seconds: minutes * 60 };
}

export function validateLimit(value) {
  const limit = value === undefined || value === null ? DEFAULT_LIMIT : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw errUsage(`Invalid --limit '${value}'. Use an integer between 1 and ${MAX_LIMIT}.`);
  }
  return limit;
}

export function routingAgentForName(name) {
  const value = String(name || '');
  return value.startsWith(AGENT_PREFIX) ? value : `${AGENT_PREFIX}${value}`;
}

export function midNameFromAgent(agent) {
  const value = String(agent || '');
  if (!value.startsWith(AGENT_PREFIX)) return null;
  const name = value.slice(AGENT_PREFIX.length);
  // `mid.server.*` is a broadcast routing value, not a named MID Server.
  if (!name || name === '*' || name.includes('*')) return null;
  return name;
}

function cutoffClause(older) {
  return `sys_created_on<javascript:gs.minutesAgoStart(${older.minutes})`;
}

export function buildWaitingQuery(older, agent = '') {
  const parts = ['queue=output', 'stateINready,processing', cutoffClause(older)];
  if (agent) parts.push(`agent=${agent}`);
  return parts.join('^');
}

export function buildInputErrorQuery(older, agent = '') {
  const parts = ['queue=input', 'state=error', cutoffClause(older)];
  if (agent) parts.push(`agent=${agent}`);
  return parts.join('^');
}

// Stats API groups are `{ stats: { count }, groupby_fields: [{field,value}] }`.
// A missing count is not zero: return null so callers can mark it unknown.
export function parseQueueGroups(result, fields = ['agent', 'topic']) {
  const groups = Array.isArray(result?.groups) ? result.groups : [];
  return groups.map(group => {
    const values = Object.fromEntries((group?.groupby_fields || []).map(entry => [entry.field, entry.value]));
    const raw = group?.stats?.count;
    const count = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
    return {
      agent: values.agent || '',
      topic: fields.includes('topic') ? (values.topic || '') : '',
      count: Number.isInteger(count) && count > 0 ? count : 0,
    };
  }).filter(group => group.agent && group.count > 0);
}

export function summarizeAgents(groups) {
  const byAgent = new Map();
  for (const group of groups) {
    if (!byAgent.has(group.agent)) byAgent.set(group.agent, { agent: group.agent, waiting: 0, topics: new Map() });
    const entry = byAgent.get(group.agent);
    entry.waiting += group.count;
    const topic = group.topic || '(none)';
    entry.topics.set(topic, (entry.topics.get(topic) || 0) + group.count);
  }
  return [...byAgent.values()].map(entry => ({
    agent: entry.agent,
    waiting: entry.waiting,
    topics: [...entry.topics.entries()]
      .map(([topic, count]) => ({ topic, count }))
      .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic)),
  }));
}

// Counts arrive from one provider aggregate, so this is a real total for the
// window rather than a sum inferred from a fetched page.
export function totalCounts(groups) {
  return groups.reduce((total, group) => total + group.count, 0);
}

export function sortQueueRows(rows) {
  return [...rows].sort((a, b) => {
    if (b.waiting !== a.waiting) return b.waiting - a.waiting;
    const aOldest = a.oldest?.sys_created_on || '';
    const bOldest = b.oldest?.sys_created_on || '';
    if (aOldest && bOldest && aOldest !== bOldest) return aOldest.localeCompare(bOldest);
    if (aOldest && !bOldest) return -1;
    if (!aOldest && bOldest) return 1;
    return a.agent.localeCompare(b.agent);
  });
}

function pad(text, width) {
  const value = String(text ?? '');
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function midLine(row) {
  if (row.mid_error) return `  MID: unknown (${row.mid_error})`;
  if (!row.mid_server) return '  MID: unknown (no ecc_agent row for this routing value)';
  const parts = [`  MID: ${row.mid_server}`];
  parts.push(`status ${row.status || 'unknown'}`);
  if (row.validated) parts.push(`validated ${row.validated}`);
  if (row.host_name) parts.push(`host ${row.host_name}`);
  return parts.join('  ');
}

export function formatQueueReport(data) {
  const older = data.older_than;
  const lines = [`ECC output queue older than ${older} (state ready or processing)`];
  if (data.agent_filter) lines.push(`Agent filter: ${data.agent_filter}`);
  lines.push('');
  if (!data.agents.length) {
    lines.push('No waiting output rows matched this window.');
    lines.push('');
    lines.push('Queue counts only: zero waiting rows is not a MID Server health verdict.');
    return `${lines.join('\n')}\n`;
  }
  const agentWidth = Math.max(5, ...data.agents.map(row => row.agent.length), 'AGENT'.length);
  lines.push(`${pad('AGENT', agentWidth)}  WAIT  ERR  ${pad('OLDEST', 19)}  TOPIC`);
  for (const row of data.agents) {
    const errors = row.input_errors === null ? '?' : String(row.input_errors);
    const oldest = row.oldest?.sys_created_on || (row.oldest_error ? '?' : '-');
    const topic = row.oldest?.topic || (row.oldest_error ? '?' : '-');
    lines.push(`${pad(row.agent, agentWidth)}  ${pad(row.waiting, 4)}  ${pad(errors, 3)}  ${pad(oldest, 19)}  ${topic}`);
    lines.push(midLine(row));
    if (row.topics.length > 1) {
      lines.push(`  topics: ${row.topics.map(topicRow => `${topicRow.topic} ${topicRow.count}`).join(', ')}`);
    }
    lines.push('');
  }
  const errorTotal = data.agents.every(row => row.input_errors === null)
    ? 'unknown'
    : data.totals.input_errors;
  if (data.complete?.waiting === false) {
    lines.push(`Warning: provider count ${data.totals.waiting_total} does not match the grouped count ${data.totals.waiting_grouped}; this breakdown may be incomplete.`);
  } else if (data.complete?.waiting === null) {
    lines.push('Provider total was unavailable; waiting counts come from the grouped aggregate only.');
  }
  lines.push(`${data.totals.agents_shown} agent(s), ${data.totals.waiting_shown} waiting output row(s), ${errorTotal} input row(s) in error.`);
  if (data.totals.agents_total > data.totals.agents_shown) {
    lines.push(`${data.totals.agents_total - data.totals.agents_shown} further agent(s) with waiting rows were not shown (--limit ${data.pagination.limit}).`);
  }
  lines.push('Counts come from the ECC Queue aggregate API for this window; zero waiting rows is not a MID Server health verdict.');
  return `${lines.join('\n')}\n`;
}
