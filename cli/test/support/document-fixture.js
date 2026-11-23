// Synthetic metadata only. No saved instance evidence or native credentials.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './loopback-credential-fixture.mjs';

const exec = promisify(execFile);
export const id = n => n.toString(16).padStart(32, '0');
const stamp = '2026-01-02 03:04:05';
const owned = (n, fields, scope = id(1), pack = scope) => ({ sys_id: id(n), sys_scope: scope, sys_package: pack, sys_updated_on: stamp, ...fields });
const data = {
  sys_scope: [
    { sys_id: 'global', name: 'Global', scope: 'global', sys_class_name: 'sys_scope' },
    { sys_id: id(1), name: 'Synthetic Dispatch', scope: 'acme_dispatch', sys_class_name: 'sys_app' },
    { sys_id: id(2), name: 'Synthetic Shared Tools', scope: 'global', sys_class_name: 'sys_app' },
    { sys_id: id(3), name: 'Synthetic Other Identity', scope: 'acme_dispatch', sys_class_name: 'sys_app' },
  ].map(row => ({ ...row, sys_updated_on: stamp })),
  sys_db_object: [
    { sys_id: id(501), name: 'sys_app', super_class: id(502) },
    { sys_id: id(502), name: 'sys_scope', super_class: id(503) },
    { sys_id: id(503), name: 'sys_package', super_class: '' },
    owned(10, { name: 'acme_request', label: 'Dispatch requests' }),
    owned(11, { name: 'u_shared_tools', label: 'Packaged Global table' }, 'global', id(2)),
    owned(12, { name: 'u_local_lead', label: 'Unassigned lead' }, 'global', 'global'),
    owned(13, { name: 'u_conflict', label: 'Conflicting owner' }, id(1), id(3)),
    owned(14, { name: 'u_unknown', label: 'Unresolved package' }, 'global', id(999)),
  ],
  sys_script: [owned(20, { name: 'Validate dispatch', collection: 'acme_request', active: 'true', when: 'before', order: '100', action_insert: 'true' }), owned(21, { name: 'Global lead rule', collection: 'u_local_lead', active: 'true' }, 'global', 'global')],
  sys_script_client: [owned(22, { name: 'Synthetic client', table: 'acme_request', type: 'onChange', active: 'true', field: 'priority' })],
  sys_ui_action: [owned(23, { name: '<script>alert(1)</script> [click](https://bad.invalid) " ] --> injected', table: 'acme_request', active: 'true', client: 'true', form_button: 'true' })],
  sys_ui_policy: [owned(24, { short_description: 'Require dispatch details', table: 'acme_request', active: 'true', on_load: 'true' })],
  sys_script_include: [owned(25, { name: 'DispatchTools', api_name: 'acme_dispatch.Tools', active: 'true', access: 'package_private', client_callable: 'false' })],
  sys_hub_flow: [owned(26, { name: 'Synthetic dispatch flow', active: 'true' })],
  sp_page: [owned(30, { id: 'dispatch', title: 'Synthetic dispatch portal' })],
  sp_widget: [owned(31, { id: 'dispatch-widget', name: 'Synthetic request widget' })],
  sp_container: [owned(32, { name: 'Main', sp_page: id(30), order: '1' }, 'global', 'global')],
  sp_row: [owned(33, { sp_container: id(32), order: '1' }, 'global', 'global')],
  sp_column: [owned(34, { sp_row: id(33), order: '1' }, 'global', 'global')],
  sp_instance: [owned(35, { title: 'Dispatch entry', sp_column: id(34), sp_widget: id(31), order: '1' }, 'global', 'global')],
  sys_rest_message: [owned(40, { name: 'Synthetic REST connector', active: 'true' })],
  sys_soap_message: [owned(41, { name: 'Synthetic SOAP connector', active: 'false' })],
  sysauto_script: [owned(42, { name: 'Synthetic nightly task', active: 'true', run_type: 'daily' })],
};
const refs = { sys_metadata: { sys_scope: 'sys_scope', sys_package: 'sys_package' }, sp_container: { sp_page: 'sp_page' }, sp_row: { sp_container: 'sp_container' }, sp_column: { sp_row: 'sp_row' }, sp_instance: { sp_column: 'sp_column', sp_widget: 'sp_widget' } };
// Independent provider allowlist. Product cannot silently expand data collection.
const commonFields = ['sys_id', 'sys_scope', 'sys_package', 'sys_updated_on'];
const allowedFields = {
  sys_scope: ['sys_id', 'name', 'scope', 'sys_class_name', 'sys_updated_on'],
  sys_db_object: [...commonFields, 'name', 'label', 'super_class'],
  sys_dictionary: [...commonFields, 'name', 'element', 'column_label', 'internal_type', 'reference', 'mandatory', 'read_only'],
  sys_script: [...commonFields, 'name', 'collection', 'active', 'when', 'order', 'action_insert', 'action_update', 'action_delete', 'action_query'],
  sys_script_client: [...commonFields, 'name', 'table', 'active', 'type', 'field', 'applies_extended'],
  sys_ui_policy: [...commonFields, 'short_description', 'table', 'active', 'on_load', 'reverse_if_false'],
  sys_ui_action: [...commonFields, 'name', 'table', 'active', 'action_name', 'client', 'form_button', 'list_button'],
  sys_script_include: [...commonFields, 'name', 'api_name', 'access', 'active', 'client_callable'],
  sys_hub_flow: [...commonFields, 'name', 'active'],
  sp_page: [...commonFields, 'id', 'title'], sp_widget: [...commonFields, 'id', 'name'],
  sp_container: [...commonFields, 'name', 'sp_page', 'order'], sp_row: [...commonFields, 'sp_container', 'order'],
  sp_column: [...commonFields, 'sp_row', 'order'], sp_instance: [...commonFields, 'title', 'sp_column', 'sp_widget', 'order'],
  sys_rest_message: [...commonFields, 'name', 'active'], sys_soap_message: [...commonFields, 'name', 'active'],
  sysauto_script: [...commonFields, 'name', 'active', 'run_type'],
};
function matches(row, query) {
  return query.split('^OR').some(branch => branch.split('^').every(term => {
    if (!term || term.startsWith('ORDERBY')) return true;
    let m = /^(\w+)STARTSWITH(.*)$/.exec(term);
    if (m) return String(row[m[1]] || '').startsWith(m[2]);
    m = /^(\w+)IN(.*)$/.exec(term);
    if (m) return m[2].split(',').includes(String(row[m[1]] || ''));
    m = /^(\w+)=(.*)$/.exec(term);
    return m ? String(row[m[1]] || '') === m[2] : false;
  }));
}
export async function documentFixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-document-synthetic-'));
  const requests = [], violations = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://synthetic.invalid');
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/angular.do' && req.method === 'POST') {
      res.setHeader('Set-Cookie', 'JSESSIONID=synthetic; Path=/');
      res.setHeader('X-UserToken-Response', 'synthetic'); res.end('{}'); return;
    }
    const table = /^\/api\/now\/table\/([a-z_]+)$/.exec(url.pathname)?.[1];
    const fields = (url.searchParams.get('sysparm_fields') || '').split(',');
    if (req.method !== 'GET' || !table || !(table in data || table === 'sys_dictionary') || fields.some(f => !allowedFields[table]?.includes(f))) {
      violations.push(requests.at(-1)); res.writeHead(405); res.end('{}'); return;
    }
    if (table === 'sp_widget' && options.widgetFollowupStatus && url.searchParams.get('sysparm_query')?.startsWith('sys_idIN')) {
      res.writeHead(options.widgetFollowupStatus); res.end('{}'); return;
    }
    if (options.fail === table) { res.writeHead(options.status || 403); res.end('{"error":{"message":"synthetic refusal"}}'); return; }
    if (options.malformed === table) { res.end('{}'); return; }
    if (options.disconnect === table) { req.destroy(); return; }
    let rows = structuredClone(options.rows?.[table] || data[table] || []);
    if (table === 'sys_dictionary') {
      rows = Object.entries(refs).flatMap(([name, elements]) => Object.entries(elements).map(([element, reference]) => ({ name, element, reference }))).map((row, index) => ({ sys_id: id(600 + index), ...row }));
      rows.push(owned(70, { name: 'acme_request', element: 'priority', column_label: 'Priority', internal_type: 'integer', reference: '', mandatory: 'true', read_only: 'false' }));
      if (options.badPortalReference) rows = rows.map(row => row.name === 'sp_instance' && row.element === 'sp_widget' ? { ...row, reference: 'sys_user' } : row);
      if (options.noSchema) rows = [];
    }
    rows = rows.filter(row => matches(row, url.searchParams.get('sysparm_query') || ''));
    rows.sort((a, b) => a.sys_id.localeCompare(b.sys_id));
    const offset = options.repeatDiscoveryPage && table === 'sys_scope' ? 0 : Number(url.searchParams.get('sysparm_offset') || 0), limit = Number(url.searchParams.get('sysparm_limit'));
    // ACL redaction happens after provider-side selection, not before the query.
    rows = rows.slice(offset, offset + limit).map(row => ({ ...row, ...options.redactOwnership?.[row.sys_id] }))
      .map(row => Object.fromEntries(fields.filter(f => Object.hasOwn(row, f) && f !== options.omitField).map(f => [f, row[f]])));
    // Deliberate provider over-return. Product must project again client-side.
    rows = rows.map(row => ({ ...row, script: 'SENSITIVE_SCRIPT_CANARY', endpoint: 'https://SENSITIVE_ENDPOINT_CANARY.invalid', unexpected: { token: 'SENSITIVE_TOKEN_CANARY' } }));
    res.end(JSON.stringify({ result: rows }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const instance = `http://127.0.0.1:${server.address().port}`;
  fs.mkdirSync(path.join(dir, 'config', 'servicenow'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'servicenow', 'config.json'), JSON.stringify({ profiles: { synthetic: { instance_url: instance, username: 'fixture', read_only: true } } }));
  const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_CACHE_HOME: path.join(dir, 'cache'), JSN_DATA_HOME: path.join(dir, 'data'), JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1', JSN_NO_HEADER: '1', SN_USERNAME: 'fixture', SN_PASSWORD: 'synthetic-fixture-only' });
  const binary = fileURLToPath(new URL('../../bin/jsn.js', import.meta.url));
  return { dir, requests, violations, instance,
    run: args => exec(process.execPath, [...loopbackCredentialArgs, binary, ...args], { cwd: dir, env, timeout: 20000, maxBuffer: 8 * 1024 * 1024 }),
    close: async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
