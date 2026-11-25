import { errAPI, errNotFound, errUsage } from './errors.js';

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
    // Only Successful (2) means the node's transactions are in the list; pending, failed, cancelled or blank may be missing.
    const missing = trackers.filter(row => raw(row.state) !== '2');
    if (missing.length) return { execution_id: id, complete: false, nodes, warning: `${missing.length} node(s) did not report and may be missing (${missing.map(row => `${text(row.name)}: ${text(row.state) || 'no state'}`).join('; ')}).` };
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
  return { table: ACTIVE_TABLE, query, refresh: await checkVisible(sdk, refresh, rows), records, count: records.length, pagination: { limit: options.limit, has_more: rows.length > options.limit } };
}

// The refreshed rows are visible only in the refreshing session. An empty read proves nothing unless that
// session can see its own refresh request, which the list always holds.
export async function checkVisible(sdk, refresh, rows) {
  if (rows.length) return refresh;
  const params = new URLSearchParams({ sysparm_query: 'session_idSAMEASsnapshot_id', sysparm_fields: 'session_id', sysparm_limit: '1' });
  if (rowsOf(await sdk.listStrict(ACTIVE_TABLE, params, { stateful: true }), ACTIVE_TABLE).length) return refresh;
  return { ...refresh, complete: false, warning: 'The refreshed list was not visible to this session (it did not even hold this request), so an empty result proves nothing. Retry.' };
}

const SESSION = /^[\w.:-]{1,128}$/;
// Kill takes effect at the transaction's next cancellation check, so re-read a few times, two seconds apart.
const KILL_POLLS = 5;
const withoutSnapshot = ({ snapshot_id: _snapshot, ...row }) => row;

export function killOptions(argv = {}) {
  const session = String(argv.session ?? '').trim();
  if (!SESSION.test(session)) throw errUsage('kill takes a session_id from jsn transactions active, such as glide.scheduler.worker.3.');
  const transaction = argv['expect-transaction'] == null ? null : String(argv['expect-transaction']).trim();
  if (transaction !== null && !SESSION.test(transaction)) throw errUsage('--expect-transaction takes the transaction_id the preview showed.');
  // Worker sessions are reused by the next job and repeat on every node, so a kill names the transaction it saw.
  if (argv.yes === true && !transaction) throw errUsage('--yes needs --expect-transaction <transaction_id> from the preview, so the kill reaches the transaction you saw and nothing else.');
  return { session, transaction, yes: argv.yes === true, force: argv.force === true };
}

async function sessionTransactions(sdk, session, opts) {
  const refresh = await refreshActiveTransactions(sdk, opts);
  const params = new URLSearchParams({ sysparm_query: `session_id=${session}`, sysparm_fields: `${ACTIVE_FIELDS},snapshot_id`, sysparm_display_value: 'all', sysparm_limit: '20' });
  const rows = rowsOf(await sdk.listStrict(ACTIVE_TABLE, params, { stateful: true }), ACTIVE_TABLE).filter(row => raw(row.session_id) === session);
  return { refresh: await checkVisible(sdk, refresh, rows), rows };
}

// The Kill UI action on v_cluster_transaction and TransactionKillAjax.forceKillCluster (Force Kill):
// the transaction's own node kills it directly, any other node is sent the same call as a cluster message.
export const killScript = (session, nodes, method) => `(function() {
  if (!gs.hasRole('admin')) throw new Error('Admin role required');
  var session = '${session}', nodes = ${JSON.stringify(nodes)}, here = String(GlideClusterSynchronizer.getSystemID());
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i] == here) GlideTransactionManager.${method}(session);
    else GlideClusterMessage.postScript("GlideTransactionManager.${method}('" + session + "');", nodes[i]);
  }
  gs.print('JSN_TRANSACTION_KILL:sent');
})();`;

export async function killTransaction(sdk, argv = {}, { sleep = wait, ...opts } = {}) {
  const { session, transaction, yes, force } = killOptions(argv);
  const { refresh, rows: listed } = await sessionTransactions(sdk, session, { sleep, ...opts });
  if (!listed.length) throw refresh.complete ? errNotFound('Active transaction for session', session) : errAPI(200, `Session ${session} was not listed, but the list may be incomplete: ${refresh.warning}`);
  // The listing request runs in jsn's own session, which v_cluster_transaction names as snapshot_id.
  if (listed.some(row => raw(row.snapshot_id) === session)) throw errUsage('That is the session jsn is using to list transactions. It will not kill its own request.');
  const rows = transaction ? listed.filter(row => raw(row.transaction_id) === transaction) : listed;
  if (!rows.length) throw errNotFound(`Transaction in session ${session} (it may have finished; preview again)`, transaction);
  const nodes = [...new Set(rows.map(row => raw(row.node_id)))];
  if (nodes.some(node => !/^[\w.:-]{1,255}$/.test(node))) throw Object.assign(new Error('Malformed node_id in v_cluster_transaction'), { code: 'malformed_response' });
  const uncancelable = rows.some(row => raw(row.uncancelable) === 'true');
  if (uncancelable && !force) throw errUsage('This is an uncancelable system transaction, so Kill refuses it. --force sends Force Kill, which can stop system work part way through.');
  const method = uncancelable ? 'forceKill' : 'kill';
  const target = { session, method, nodes, refresh, transactions: rows.map(withoutSnapshot) };
  if (!yes) return { ...target, dry_run: true, rerun: rows.map(row => `jsn transactions kill ${session} --yes --expect-transaction ${raw(row.transaction_id)}${raw(row.uncancelable) === 'true' ? ' --force' : ''}`) };
  const output = await sdk.executeScript(killScript(session, nodes, method), 'global');
  if (!String(output).includes('JSN_TRANSACTION_KILL:sent')) throw errAPI(200, 'The kill script returned no confirmation that it ran. Check jsn transactions active before retrying.');
  const key = row => raw(row.transaction_id) || raw(row.session_id);
  const ids = new Set(rows.map(key));
  let running = rows, check = refresh;
  for (let poll = 0; poll < KILL_POLLS && (running.length || !check.complete); poll++) {
    await sleep(2000);
    const next = await sessionTransactions(sdk, session, { sleep, ...opts });
    check = next.refresh;
    running = next.rows.filter(row => ids.has(key(row)));
  }
  // Absent from a partial refresh proves nothing: the node that runs it may not have answered.
  const result = { ...target, dry_run: false, sent: true, ended: !running.length && check.complete === true, check, still_running: running.map(withoutSnapshot), cancellations: [] };
  const txIds = [...ids].filter(id => /^[0-9a-f]{32}$/i.test(id));
  if (txIds.length) {
    try {
      const params = new URLSearchParams({ sysparm_query: `transaction_idIN${txIds.join(',')}`, sysparm_fields: 'cancel_reason,cancel_requested_time,node_id,session,transaction_id,url', sysparm_limit: '20' });
      result.cancellations = rowsOf(await sdk.listStrict('syslog_cancellation', params), 'syslog_cancellation');
    } catch (error) {
      result.cancellations = null;
      result.cancellation_error = error.message;
    }
  }
  return result;
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
  if (result.pagination.has_more) lines.push(`(oldest ${result.count} shown; ${result.pagination.limit < 100 ? 'raise --limit for more' : 'narrow with --older-than, --user or --type'})`);
  return `${lines.join('\n')}\n`;
}

export function formatKillTransaction(result) {
  const node = result.nodes.map(id => id.split(':').pop()).join(', ');
  const verb = result.method === 'forceKill' ? 'Force Kill' : 'Kill';
  const rows = list => formatActiveTransactions({ refresh: {}, records: list, count: list.length, pagination: {} });
  if (result.dry_run) return `Would send ${verb} to session ${result.session} on ${node}:\n${rows(result.transactions)}To send it, run:\n${result.rerun.map(cmd => `  ${cmd}\n`).join('')}`;
  const lines = [`${verb} sent to session ${result.session} on ${node}.`];
  if (result.ended) lines.push('Ended: the transaction is no longer running.');
  else if (result.still_running.length) lines.push(`Still running after ${KILL_POLLS} re-reads, 2 seconds apart. It stops at its next cancellation check, which some work never reaches; check with jsn transactions active.`, rows(result.still_running).trimEnd());
  else lines.push(`Not confirmed: ${result.check.warning || 'the last refresh was incomplete.'}`);
  if (result.cancellations === null) lines.push(`Cancellation log not readable: ${result.cancellation_error}`);
  for (const row of result.cancellations || []) lines.push(`Cancellation logged: ${text(row.cancel_reason) || '(no reason)'} at ${text(row.cancel_requested_time)} on ${text(row.node_id).split(':').pop()}`);
  if (result.cancellations?.length === 0) lines.push('No cancellation logged (the platform does not log every cancellation).');
  return `${lines.join('\n')}\n`;
}
