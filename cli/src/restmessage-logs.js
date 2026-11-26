// `restmessage logs`: the calls a REST message made, read from
// sys_outbound_http_log. A log row names the script that made the call
// (source_table, source_record), never the REST message, so calls are matched
// by URL: a call's URL starts with the host of one of the message's endpoints
// and contains the directory of one of them. The directory, not the whole
// endpoint, is what a script's setEndpoint() to a sibling resource still shares.
// Bodies are never read, and credential headers and query values are redacted
// before anything is returned.

import { errUsage, errUsageHint } from './errors.js';
import { resolveRecord } from './resolve-record.js';

const METHOD_FIELDS = 'sys_id,function_name,http_method,rest_endpoint,rest_message';
const LOG_FIELDS = 'sys_id,sys_created_on,method,url,request_query,response_status,response_time,request_length,response_length,log_level,source_table,source_record,mid_server,transaction_name,user_name,app_scope,system_id,request_headers,response_headers';
const MAX_METHODS = 100;
const SENSITIVE = /authorization|cookie|token|secret|password|passwd|pwd|key$|signature|^sig$|session/i;
// name, separator, value; the value ends where the next pair, line, map or query field starts.
const PAIR = /("?)([\w.-]+)("?\s*[:=]\s*)([^\r\n]*?)(?=[,&]\s*"?[\w.-]+"?\s*[:=]|[\r\n}&]|$)/g;

const raw = value => value && typeof value === 'object' ? String(value.value ?? '') : String(value ?? '');
const text = value => value && typeof value === 'object' ? String(value.display_value ?? value.value ?? '') : String(value ?? '');
const number = value => raw(value) === '' || !Number.isFinite(Number(raw(value))) ? null : Number(raw(value));

// Headers arrive as lines (Name: value), a Java map ({Name=value, ...}) or JSON;
// the query string as a=1&b=2. A credential's value is replaced, its name kept.
export const redactPairs = value => String(value ?? '').replace(PAIR, (pair, quote, name, separator) => SENSITIVE.test(name) ? `${quote}${name}${separator}[redacted]` : pair);
const redactUrl = url => url.replace(/^([a-z][\w+.-]*:\/\/)[^/?#@]*@/i, '$1[redacted]@').replace(/\?[^#]*/, query => `?${redactPairs(query.slice(1))}`);

// Host and path directory of the endpoint's fixed part, before its first ${variable}, query or fragment.
export function endpointScope(endpoint) {
  const value = String(endpoint ?? '').trim();
  if (!value) return null;
  const url = value.match(/^(https?):\/\/([^/?#]*)/i);
  if (!url) return { endpoint: value, reason: 'not an http or https URL' };
  if (!url[2] || url[2].includes('${')) return { endpoint: value, reason: 'the host is a variable' };
  const path = value.slice(url[0].length).split(/\$\{|[?#]/)[0];
  // A one-segment path (/v1.0, /graphql) is the API's root, so it stays whole; a deeper path keeps its directory.
  const directory = path.slice(0, path.lastIndexOf('/') + 1);
  const scope = { endpoint: value, host: `${url[1]}://${url[2]}/`, directory: directory.length > 1 ? directory : path || '/' };
  return /[\^\r\n]/.test(scope.host + scope.directory) ? { endpoint: value, reason: 'holds characters an encoded query cannot match' } : scope;
}

function statusQuery(status) {
  if (/^[1-5]\d\d$/.test(status)) return `response_status=${status}`;
  if (/^[1-5]xx$/i.test(status)) return `response_status>=${status[0]}00^response_status<${Number(status[0]) + 1}00`;
  throw errUsage('--status must be a status code (404) or a class (4xx).');
}

async function read(sdk, table, params) {
  const rows = await sdk.listStrict(table, new URLSearchParams(params));
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw Object.assign(new Error(`Malformed table response for ${table}`), { code: 'malformed_response' });
  }
  return rows;
}

// A directory of / matches every path, so it drops the directory condition.
function scopes(endpoints) {
  const all = endpoints.map(endpointScope).filter(Boolean);
  const matched = all.filter(scope => scope.host);
  const unique = values => [...new Set(values)];
  const directories = unique(matched.map(scope => scope.directory));
  return { hosts: unique(matched.map(scope => scope.host)), directories: directories.includes('/') ? [] : directories,
    unmatched: all.filter(scope => scope.reason).map(({ endpoint, reason }) => ({ endpoint: redactUrl(endpoint), reason })) };
}

function call(row) {
  return {
    sys_id: raw(row.sys_id), created_on: text(row.sys_created_on), method: raw(row.method), url: redactUrl(raw(row.url)),
    request_query: redactPairs(raw(row.request_query)), status: number(row.response_status), response_time_ms: number(row.response_time),
    request_length: number(row.request_length), response_length: number(row.response_length), log_level: text(row.log_level),
    source: { table: raw(row.source_table), sys_id: raw(row.source_record) }, mid_server: text(row.mid_server),
    transaction_name: raw(row.transaction_name), user_name: raw(row.user_name), app_scope: text(row.app_scope), system_id: raw(row.system_id),
    request_headers: redactPairs(raw(row.request_headers)), response_headers: redactPairs(raw(row.response_headers)),
  };
}

export async function readRestMessageLogs(sdk, identifier, { status, endpoint, limit = 20, offset = 0 } = {}) {
  if (typeof identifier !== 'string' || !identifier.trim()) throw errUsage('Name the REST message by name or sys_id.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw errUsage('--limit must be an integer from 1 to 200.');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > Number.MAX_SAFE_INTEGER - 201) throw errUsage('--offset must be a nonnegative safe integer.');
  const filters = status === undefined ? [] : [statusQuery(String(status))];
  if (endpoint !== undefined) {
    if (typeof endpoint !== 'string' || !endpoint || /[\^\r\n]/.test(endpoint)) throw errUsage('--endpoint must be non-empty text without ^ or line breaks.');
    filters.push(`urlLIKE${endpoint}`);
  }

  const message = await resolveRecord(sdk, { table: 'sys_rest_message', identifier, matchField: 'name', resource: 'REST message', fields: ['name', 'rest_endpoint'] });
  const id = raw(message.sys_id);
  const name = raw(message.name) || id;
  if (!id) throw errUsage('The matched REST message has no readable sys_id; check field ACLs before retrying.');
  const methods = await read(sdk, 'sys_rest_message_fn', { sysparm_query: `rest_message=${id}^ORDERBYfunction_name`, sysparm_fields: METHOD_FIELDS, sysparm_limit: String(MAX_METHODS + 1), sysparm_display_value: 'all' });
  if (methods.length > MAX_METHODS) throw new Error(`More than ${MAX_METHODS} methods on REST message ${name}; read sys_outbound_http_log by URL with jsn records list instead.`);
  if (methods.some(row => raw(row.rest_message) !== id)) throw new Error('sys_rest_message_fn returned a method of a different REST message.');

  // A method's own endpoint replaces the message's, so the message's counts only while a method has none.
  const own = methods.map(row => raw(row.rest_endpoint).trim()).filter(Boolean);
  const { hosts, directories, unmatched } = scopes(own.length && own.length === methods.length ? own : [raw(message.rest_endpoint), ...own]);
  if (!hosts.length) {
    throw errUsageHint(`No endpoint of REST message ${name} has a fixed http or https host to match log URLs against.`,
      'Read the log by URL instead: jsn records list --table sys_outbound_http_log --query "urlSTARTSWITH<url>^ORDERBYDESCsys_created_on" --limit 20');
  }
  // a^ORb^c^ORd reads (a or b) and (c or d).
  // shortcut: hosts and directories are two OR groups, so a message whose endpoints span hosts also matches one host with another's directory; pair them with ^NQ if that turns up.
  const where = [hosts.map(host => `urlSTARTSWITH${host}`).join('^OR'), ...(directories.length ? [directories.map(directory => `urlLIKE${directory}`).join('^OR')] : [])];
  const query = [...where, ...filters, 'ORDERBYDESCsys_created_on^ORDERBYDESCsequence'].join('^');
  const rows = await read(sdk, 'sys_outbound_http_log', { sysparm_query: query, sysparm_fields: LOG_FIELDS, sysparm_limit: String(limit + 1), sysparm_offset: String(offset), sysparm_display_value: 'all' });
  const hasMore = rows.length > limit;
  const calls = rows.slice(0, limit).map(call);
  return {
    message: { sys_id: id, name }, match: { hosts: hosts.map(redactUrl), directories }, unmatched_endpoints: unmatched, calls, count: calls.length,
    ...(calls.length ? {} : { note: `No logged call of REST message ${name} matched. That is not proof it was not called: log rows age out, ACLs can hide sys_outbound_http_log rows from this identity, and a call setEndpoint() sent elsewhere is not matched.` }),
    mid_servers: [...new Set(calls.map(c => c.mid_server).filter(Boolean))], redacted: true,
    pagination: { limit, offset, has_more: hasMore, next_offset: hasMore ? offset + limit : null },
  };
}

export function formatRestMessageLogs(data) {
  const lines = [`REST message: ${data.message.name} (${data.message.sys_id})`, `Matched: URLs starting ${data.match.hosts.join(' or ')}${data.match.directories.length ? ` and containing ${data.match.directories.join(' or ')}` : ''}`];
  for (const miss of data.unmatched_endpoints) lines.push(`Not matched: ${miss.endpoint} (${miss.reason})`);
  lines.push('');
  if (data.note) lines.push(data.note);
  for (const c of data.calls) {
    lines.push(`${c.created_on}  ${c.status ?? '---'}  ${c.method.padEnd(6)} ${c.url}  ${c.response_time_ms ?? '?'} ms  ${c.log_level}${c.mid_server ? `  MID ${c.mid_server}` : ''}`);
    lines.push(`    from ${c.source.table || '?'} ${c.source.sys_id || '?'}${c.user_name ? ` as ${c.user_name}` : ''}`);
    if (c.request_query) lines.push(`    query ${c.request_query}`);
  }
  if (data.pagination.has_more) lines.push(`More with --offset ${data.pagination.next_offset}`);
  lines.push('', 'Credential headers and query values are redacted; bodies are never read.');
  return lines.join('\n');
}
