import { errAPI, errUsage } from './errors.js';

// The 'Active Transactions (All Nodes)' module: loading_transactions.do refreshes
// v_cluster_transaction for this session from every node, then the list is read in
// the same session (the rows are visible only there).
export const ACTIVE_TABLE = 'v_cluster_transaction';
export const ACTIVE_FIELDS = 'session_id,transaction_id,node_id,user,url,type,age,business_rule,query,query_count,db_time,br_time,acl_time,uncancelable';
// glide.cluster_transaction.query.timeout default: how long the module waits for other nodes.
const SETTLE_POLLS = 35;
const PENDING = new Set(['0', '1']);
const UNITS = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };

const raw = value => value && typeof value === 'object' ? String(value.value ?? '') : String(value ?? '');
const text = value => value && typeof value === 'object' ? String(value.display_value ?? value.value ?? '') : String(value ?? '');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function rowsOf(rows, table) {
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw Object.assign(new Error(`Malformed table response for ${table}`), { code: 'malformed_response' });
  return rows;
}

export function parseOlderThan(input) {
  const match = /^(\d+)([smhd]?)$/.exec(String(input ?? '').trim());
  const seconds = match ? Number(match[1]) * UNITS[match[2]] : NaN;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 30 * 86400) throw errUsage('--older-than takes seconds or a number with s, m, h or d, such as 90, 5m or 2h, up to 30d.');
  return seconds;
}

export function activeOptions(argv = {}) {
  const limit = argv.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw errUsage('--limit must be an integer from 1 to 100.');
  const options = { limit };
  if (argv['older-than'] != null) options.olderThan = parseOlderThan(argv['older-than']);
  if (argv.user != null) {
    if (!/^[\w.@+-]{1,100}$/.test(String(argv.user))) throw errUsage('--user takes a user name (user_name), such as admin or system.');
    options.user = String(argv.user);
  }
  if (argv.type != null) {
    options.type = String(argv.type).toLowerCase();
    if (!/^[a-z_]{1,40}$/.test(options.type)) throw errUsage('--type takes a transaction type value, such as rest, form, list or scheduler.');
  }
  return options;
}

export function activeQuery({ olderThan, user, type } = {}) {
  // The refreshing request is itself listed with session_id equal to snapshot_id; leave it out.
  const parts = ['session_idNSAMEASsnapshot_id'];
  if (olderThan) parts.push(`age>=${new Date(olderThan * 1000).toISOString().slice(0, 19).replace('T', ' ')}`);
  if (user) parts.push(`user=${user}`);
  if (type) parts.push(`type=${type}`);
  parts.push('ORDERBYDESCage');
  return parts.join('^');
}

export async function refreshActiveTransactions(sdk, { sleep = wait } = {}) {
  const cookies = await sdk._warmSession();
  let html;
  try {
    html = await sdk.rawRequest(`${sdk.baseURL}/loading_transactions.do`, { method: 'GET', headers: cookies ? { Cookie: cookies } : {} });
  } catch (error) {
    if (error?.cause?.message === 'unexpected redirect') throw errAPI(302, 'The instance redirected the Active Transactions refresh, usually to its login page. Retry; it needs an admin session.');
    throw error;
  }
  const id = /var executionID = '([^']*)'/.exec(String(html))?.[1];
  if (id === undefined) throw errAPI(200, 'The instance did not return the Active Transactions (All Nodes) refresh page. It needs the admin role.');
  if (!/^[0-9a-f]{32}$/.test(id)) return { execution_id: null, complete: false, nodes: [], warning: 'The instance could not ask the other nodes for their transactions (it reports a permissions problem), so only this node is listed.' };
  for (let poll = 0; ; poll++) {
    const params = new URLSearchParams({ sysparm_query: `parent=${id}`, sysparm_fields: 'name,state,parent', sysparm_display_value: 'all', sysparm_limit: '100' });
    const trackers = rowsOf(await sdk.listStrict('sys_execution_tracker', params), 'sys_execution_tracker').filter(row => raw(row.parent) === id);
    const pending = trackers.filter(row => PENDING.has(raw(row.state)));
    if (trackers.length && pending.length && poll < SETTLE_POLLS) { await sleep(1000); continue; }
    const nodes = trackers.map(row => ({ name: text(row.name), state: text(row.state) }));
    if (!trackers.length) return { execution_id: id, complete: false, nodes, warning: 'The refresh progress was not readable, so some nodes may be missing.' };
    if (pending.length) return { execution_id: id, complete: false, nodes, warning: `${pending.length} node(s) did not report in time and may be missing.` };
    return { execution_id: id, complete: true, nodes };
  }
}

export async function listActiveTransactions(sdk, argv = {}, opts = {}) {
  const options = activeOptions(argv);
  const query = activeQuery(options);
  const refresh = await refreshActiveTransactions(sdk, opts);
  const params = new URLSearchParams({ sysparm_query: query, sysparm_fields: ACTIVE_FIELDS, sysparm_display_value: 'all', sysparm_limit: String(options.limit + 1) });
  const rows = rowsOf(await sdk.listStrict(ACTIVE_TABLE, params, { stateful: true }), ACTIVE_TABLE);
  const records = rows.slice(0, options.limit);
  return { table: ACTIVE_TABLE, query, refresh, records, count: records.length, pagination: { limit: options.limit, has_more: rows.length > options.limit } };
}

const seconds = value => {
  const ms = Date.parse(`${raw(value).replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? Math.round(ms / 1000) : null;
};
const short = value => {
  const s = seconds(value);
  if (s == null) return '-';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}m`;
};
const cell = (value, width) => value.length > width ? `${value.slice(0, width - 1)}~` : value.padEnd(width);

export function formatActiveTransactions(result) {
  const lines = [];
  if (result.refresh.warning) lines.push(`Warning: ${result.refresh.warning}`);
  lines.push('AGE     USER          TYPE        NODE              SQLS  DB      BR      ACL     SESSION                           URL');
  for (const row of result.records) {
    const node = raw(row.node_id).split(':').pop();
    lines.push(`${cell(short(row.age), 6)}  ${cell(text(row.user), 12)}  ${cell(text(row.type), 10)}  ${cell(node, 16)}  ${raw(row.query_count).padStart(4)}  ${cell(short(row.db_time), 6)}  ${cell(short(row.br_time), 6)}  ${cell(short(row.acl_time), 6)}  ${cell(raw(row.session_id), 32)}  ${text(row.url)}${raw(row.uncancelable) === 'true' ? '  (uncancelable)' : ''}`);
    if (text(row.business_rule)) lines.push(`        business rule: ${text(row.business_rule)}`);
    if (text(row.query)) lines.push(`        sql: ${cell(text(row.query).replace(/\s+/g, ' '), 160).trimEnd()}`);
  }
  if (!result.records.length) lines.push('(no active transactions)');
  if (result.pagination.has_more) lines.push(`(oldest ${result.count} shown; raise --limit for more)`);
  return `${lines.join('\n')}\n`;
}
