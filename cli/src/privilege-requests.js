import { errAPI, errNotFound, errUsage, errUsageHint } from './errors.js';
import { assertSafeExactMatch } from './helpers.js';
import { isSysId } from './resolve-record.js';
import { assertMutationScope } from './intended-context.js';

// Restricted Caller Access requests. A blocked call from another scope files one row here, separate from the
// cross-scope privileges in sys_scope_privilege; approving a privilege leaves the request at Requested.
const TABLE = 'sys_restricted_caller_access';
const STATUSES = ['requested', 'denied', 'allowed', 'invalidated']; // index is the stored status value
const OPEN = ['requested', 'denied', 'invalidated'];
const FIELDS = 'sys_id,status,operation,source_scope,source_table,source,target_scope,target_table,target,rca_type,sys_updated_on';
const OPERATIONS = { read: 'Read', write: 'Write', create: 'Create', delete: 'Delete', execute: 'Execute API' };
const raw = value => value && typeof value === 'object' ? String(value.value ?? '') : String(value ?? '');
const shown = value => value && typeof value === 'object' ? String(value.display_value ?? '') : String(value ?? '');
const malformed = (table, detail) => Object.assign(new Error(`Malformed ${table} response: ${detail}`), { code: 'malformed_response' });

function statusNames(value) {
  if (value === undefined) return OPEN;
  const list = [value].flat().flatMap(v => String(v ?? '').split(',')).map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) throw errUsage('--status needs requested, denied, allowed, invalidated or all.');
  if (list.includes('all')) return STATUSES;
  const bad = list.filter(s => !STATUSES.includes(s));
  if (bad.length) throw errUsage(`Unknown --status ${bad.join(', ')}; use requested, denied, allowed, invalidated or all.`);
  return STATUSES.filter(s => list.includes(s));
}

function scopeName(value, flag) {
  if (value === undefined) return undefined;
  const v = String(value).trim();
  if (!v) throw errUsage(`${flag} needs a scope (x_acme_app), an application name or a sys_id.`);
  try { assertSafeExactMatch(v); } catch (error) { throw errUsage(`${flag}: ${error.message}`); }
  return v;
}

async function readScope(sdk, v) {
  const rows = await sdk.listStrict('sys_scope', new URLSearchParams({ sysparm_query: `scope=${v}^ORname=${v}${isSysId(v) ? `^ORsys_id=${v}` : ''}`, sysparm_fields: 'sys_id,scope,name', sysparm_limit: '2' }));
  if (rows.length > 1) throw errUsage(`${v} names more than one application; pass its scope or sys_id.`);
  if (!rows.length) throw errNotFound('Application scope', v);
  const row = rows[0], out = { sys_id: raw(row?.sys_id), scope: raw(row?.scope), name: raw(row?.name) };
  if (!out.sys_id || ![out.sys_id, out.scope, out.name].some(f => f.toLowerCase() === v.toLowerCase())) throw malformed('sys_scope', `the reply is not the application ${v}`);
  return out;
}

const toRequest = row => ({
  sys_id: raw(row.sys_id), status: STATUSES[Number(raw(row.status))], operation: raw(row.operation),
  source_scope: { sys_id: raw(row.source_scope), name: shown(row.source_scope) },
  source: { table: raw(row.source_table), sys_id: raw(row.source), name: shown(row.source) },
  target_scope: { sys_id: raw(row.target_scope), name: shown(row.target_scope) },
  target: { table: raw(row.target_table), sys_id: raw(row.target), name: shown(row.target) },
  rca_type: raw(row.rca_type), updated: raw(row.sys_updated_on),
});

export async function readPrivilegeRequests(sdk, { status, sourceScope, targetScope, limit = 20 } = {}) {
  const names = statusNames(status);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw errUsage('--limit must be an integer from 1 to 1000.');
  const src = scopeName(sourceScope, '--source-scope'), tgt = scopeName(targetScope, '--target-scope');
  const source = src === undefined ? null : await readScope(sdk, src);
  const target = tgt === undefined ? null : await readScope(sdk, tgt);
  const codes = names.map(n => String(STATUSES.indexOf(n)));
  const query = [`statusIN${codes.join(',')}`, source && `source_scope=${source.sys_id}`, target && `target_scope=${target.sys_id}`, 'ORDERBYDESCsys_updated_on'].filter(Boolean).join('^');
  const rows = await sdk.listStrict(TABLE, new URLSearchParams({ sysparm_query: query, sysparm_fields: FIELDS, sysparm_limit: String(limit + 1), sysparm_display_value: 'all' }));
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !raw(row.sys_id) || !codes.includes(raw(row.status))
      || (source && raw(row.source_scope) !== source.sys_id) || (target && raw(row.target_scope) !== target.sys_id)) {
      throw malformed(TABLE, 'a row does not match the status or scopes asked for');
    }
  }
  const requests = rows.slice(0, limit).map(toRequest);
  return { statuses: names, source_scope: source, target_scope: target, count: requests.length, requests, pagination: { limit, has_more: rows.length > limit } };
}

const either = list => list.length > 1 ? `${list.slice(0, -1).join(', ')} or ${list.at(-1)}` : list[0];
const label = s => s[0].toUpperCase() + s.slice(1);
const end = (scope, rec) => [scope.name || scope.sys_id, rec.name || [rec.table, rec.sys_id].filter(Boolean).join(' ')].filter(Boolean).join(': ');

export function formatPrivilegeRequests(data) {
  // A copy packaged in the source app (rca_type other than real_rca) can repeat a real row's source and target, so it is marked.
  const rows = data.requests.map(r => `${label(r.status).padEnd(11)}  ${(OPERATIONS[r.operation] || r.operation).padEnd(11)}  ${end(r.source_scope, r.source)}  ->  ${end(r.target_scope, r.target)}  ${r.sys_id}${r.rca_type && r.rca_type !== 'real_rca' ? `  (${r.rca_type})` : ''}`);
  const head = rows.length ? `${rows.length} restricted caller access request(s), newest first:` : `No readable ${either(data.statuses)} requests. ACLs can hide rows, so an empty list does not prove none exist.`;
  return [head, ...rows, '',
    ...(data.pagination.has_more ? [`More match: ${data.pagination.limit < 1000 ? 'raise --limit (up to 1000) or ' : ''}narrow with --status, --source-scope or --target-scope.`] : []),
    'Cross-scope privileges (sys_scope_privilege) are separate records: jsn privileges list'].join('\n');
}

export function privilegeRequestsSummary(data) {
  return `${data.count}${data.pagination.has_more ? '+' : ''} readable ${either(data.statuses)} restricted caller access request(s)`;
}

async function readRequest(sdk, id) {
  const rows = await sdk.listStrict(TABLE, new URLSearchParams({ sysparm_query: `sys_id=${id}`, sysparm_fields: `${FIELDS},sys_scope,target_scope.scoped_administration`, sysparm_limit: '2', sysparm_display_value: 'all' }));
  if (!rows.length) throw errNotFound('Restricted caller access request', id);
  const row = rows[0];
  if (rows.length > 1 || !row || typeof row !== 'object' || raw(row.sys_id) !== id || !/^[0-3]$/.test(raw(row.status))) throw malformed(TABLE, `the reply is not request ${id}`);
  return { ...toRequest(row), application_administration: raw(row['target_scope.scoped_administration']) === 'true', sys_scope: raw(row.sys_scope) };
}

// Allowing writes status 2 on one row and nothing else; with application administration on, only the target app's admins may.
export async function allowPrivilegeRequest(sdk, { request, yes = false } = {}) {
  const id = String(request ?? '').trim();
  if (!isSysId(id)) throw errUsage('allow needs the request sys_id (32 hex characters); jsn privileges requests lists them.');
  const { application_administration, sys_scope, ...before } = await readRequest(sdk, id);
  if (before.status === 'allowed') throw errUsageHint(`Request ${id} is already Allowed, so there is nothing to allow.`, 'jsn privileges requests --status allowed lists the allowed requests.');
  const base = { request: before, change: { status: { from: before.status, to: 'allowed' } }, application_administration };
  if (!yes) return { ...base, dry_run: true, rerun: ['privileges', 'allow', id, '--yes'] };
  // The capture guard checks a record's scope only on its context table (sys_scope_privilege), so this row is checked here.
  assertMutationScope(sdk.mutationContext, sys_scope, 'Restricted caller access request');
  try { await sdk.update(TABLE, id, { status: '2' }); }
  catch (error) {
    if (error?.status === 403 && application_administration) error.hint = `${adminNote(before)} ${error.hint || ''}`.trim();
    throw error;
  }
  const { application_administration: _, sys_scope: __, ...after } = await readRequest(sdk, id);
  if (after.status !== 'allowed') throw Object.assign(errAPI(200, `Allow of request ${id} not confirmed: it reads ${label(after.status)} after the write.`), { hint: application_administration ? adminNote(before) : 'A field ACL or business rule can drop a write without an error; jsn privileges requests --status all shows its status now.' });
  return { ...base, request: after, dry_run: false, allowed: true };
}

const adminNote = r => `${r.target_scope.name || r.target_scope.sys_id} has application administration on: only its application admins can allow this request.`;

export function formatPrivilegeAllow(data) {
  const r = data.request, c = data.change.status;
  const line = `  ${label(c.from)} -> ${label(c.to)}  ${OPERATIONS[r.operation] || r.operation}  ${end(r.source_scope, r.source)}  ->  ${end(r.target_scope, r.target)}`;
  if (!data.dry_run) return [`Allowed request ${r.sys_id}:`, line].join('\n');
  return [`Would allow request ${r.sys_id}:`, line, ...(data.application_administration ? [adminNote(r)] : []), '', `Run: ${data.rerun}`].join('\n');
}

export function privilegeAllowSummary(data) {
  const c = data.change.status;
  return data.dry_run ? `Dry run: would allow request ${data.request.sys_id} (${label(c.from)} -> ${label(c.to)}); nothing written` : `Allowed request ${data.request.sys_id}`;
}
