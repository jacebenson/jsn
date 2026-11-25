import { errNotFound, errUsage } from './errors.js';

// Every slow pattern table extends sys_pattern; the second entry is what `show` adds for that class.
const TYPES = {
  queries: ['sys_query_pattern', 'example,executable_sql,placeholders,db_name,pool_name'],
  scripts: ['sys_script_pattern', 'script_source_table,script_source,script_scope'],
  transactions: ['sys_transaction_pattern', 'table,type,view,action,processor,average_sql_time,average_business_rule_time,average_acl_time,average_cpu_time'],
  events: ['sysevent_pattern', 'event_name,queue,event_scope,average_cpu_time'],
  mutex: ['sys_mutex_pattern', 'mutex_name,fast_lock'],
  cache: ['sys_cache_build_pattern', 'cache_name'],
};
export const SLOW_PATTERN_TYPES = Object.keys(TYPES);
export const SLOW_PATTERN_ORDERS = ['total', 'count', 'average'];
const SHARED = 'sys_id,sys_class_name,label,url,count,total,average,first,last';

const raw = value => value && typeof value === 'object' ? String(value.value ?? '') : String(value ?? '');
const text = value => value && typeof value === 'object' ? String(value.display_value ?? value.value ?? '') : String(value ?? '');

async function read(sdk, table, query, fields, limit, offset = 0) {
  const params = new URLSearchParams({ sysparm_query: query, sysparm_fields: fields, sysparm_limit: String(limit), sysparm_offset: String(offset), sysparm_display_value: 'all' });
  const rows = await sdk.listStrict(table, params);
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw Object.assign(new Error(`Malformed table response for ${table}`), { code: 'malformed_response' });
  }
  return rows;
}
async function one(sdk, table, id, fields) {
  const rows = await read(sdk, table, `sys_id=${id}`, fields, 1);
  if (!rows.length) throw errNotFound('Slow pattern', `${id} (not found or is not readable)`);
  if (raw(rows[0].sys_id) !== id) throw new Error('Slow pattern read returned a different record.');
  return rows[0];
}

export async function listSlowPatterns(sdk, { type = 'queries', orderBy = 'total', since, limit = 20, offset = 0 } = {}) {
  if (!Object.hasOwn(TYPES, type)) throw errUsage(`--type must be one of: ${SLOW_PATTERN_TYPES.join(', ')}.`);
  if (!SLOW_PATTERN_ORDERS.includes(orderBy)) throw errUsage(`--order-by must be one of: ${SLOW_PATTERN_ORDERS.join(', ')}.`);
  if (since != null && !/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/.test(since)) throw errUsage('--since must be YYYY-MM-DD or "YYYY-MM-DD HH:MM:SS".');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw errUsage('--limit must be an integer from 1 to 200.');
  if (!Number.isSafeInteger(offset) || offset < 0) throw errUsage('--offset must be a nonnegative safe integer.');
  const table = TYPES[type][0];
  const query = `${since ? `last>=${since}^` : ''}ORDERBYDESC${orderBy}^ORDERBYsys_id`;
  const rows = await read(sdk, table, query, SHARED, limit + 1, offset);
  const hasMore = rows.length > limit;
  const records = rows.slice(0, limit);
  return { type, table, order_by: orderBy, query, records, count: records.length, pagination: { limit, offset, has_more: hasMore, next_offset: hasMore ? offset + limit : null } };
}

export async function showSlowPattern(sdk, id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/i.test(id)) throw errUsage('Provide a 32-character hexadecimal sys_id.');
  const table = raw((await one(sdk, 'sys_pattern', id, 'sys_id,sys_class_name')).sys_class_name);
  if (!/^[a-z0-9_]+$/.test(table)) throw new Error(`Slow pattern ${id} has an unexpected class: ${table}`);
  const type = SLOW_PATTERN_TYPES.find(name => TYPES[name][0] === table) ?? null;
  const record = await one(sdk, table, id, `${SHARED},stack_trace${type ? `,${TYPES[type][1]}` : ''}`);
  return { type, table, record };
}

// Times print as the stored UTC value, which is what --since compares with; the display value is in the user's zone.
const utc = value => raw(value) ? `${raw(value)} UTC` : '-';
function summary(row) {
  return `total ${text(row.total) || '-'} | count ${text(row.count) || '-'} | avg ${text(row.average) || '-'} ms | last ${utc(row.last)}`;
}
export function formatSlowPatterns(data, mode) {
  if (mode === 'show') {
    const { record } = data;
    const lines = [`Slow pattern ${raw(record.sys_id)} (${data.table}, read-only)`, `Label: ${text(record.label)}`, `URL: ${text(record.url)}`, `${summary(record)} | first ${utc(record.first)}`];
    for (const name of data.type ? TYPES[data.type][1].split(',') : []) if (text(record[name])) lines.push(`${name}: ${text(record[name])}`);
    lines.push('Stack trace:', text(record.stack_trace) || '(empty)');
    return lines.join('\n');
  }
  const lines = [`Slow ${data.type} by ${data.order_by} (read-only, ${data.table})`];
  for (const row of data.records) lines.push(`${raw(row.sys_id)} | ${summary(row)}`, `  ${text(row.url).split('\n')[0]}: ${text(row.label)}`);
  if (!data.count) lines.push('No readable rows on this page. An empty slow pattern log does not prove nothing is slow.');
  lines.push(`Page: ${data.count} rows, offset ${data.pagination.offset}${data.pagination.has_more ? `; more available, next offset ${data.pagination.next_offset}` : '; no further readable rows'}.`);
  return lines.join('\n');
}
