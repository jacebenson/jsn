// Offline CLI fixture preload. Never use this module for a live instance.
// It replaces auth and fetch, restricts the destination to example.invalid,
// and supplies synthetic rows through the same CLI/SDK path as the tests.
import { SDKClient } from '../../src/sdk.js';

export const fixtureOrigin = 'https://example.invalid';

SDKClient.prototype._setAuth = async () => {};
const definitions = {
  subscription_entitlement: { quantity: 'integer', product_name: 'string', sys_updated_on: 'glide_date_time' },
  subscription_detail: { quantity: 'integer', status: 'string', is_latest: 'boolean', sys_updated_on: 'glide_date_time' },
  itom_lu_ci_counts: { count: 'integer', sample_date: 'glide_date' },
  sys_store_app: { sys_id: 'GUID', scope: 'string', name: 'string', version: 'string', active: 'boolean', install_date: 'glide_date_time' },
  v_plugin: { sys_id: 'GUID', id: 'string', name: 'string', version: 'string', active: 'string' },
};
const records = {
  subscription_entitlement: [{ quantity: '12', product_name: 'Example Product', sys_updated_on: '2026-01-02 03:04:05' }],
  subscription_detail: [{ quantity: '4', status: 'allocated', is_latest: 'true', sys_updated_on: '2026-01-02 03:04:05' }],
  itom_lu_ci_counts: [{ count: '9', sample_date: '2026-01-02' }],
  v_plugin: [{ sys_id: 'b'.repeat(32), id: 'example.plugin', name: 'Example Plugin', version: '1.0', active: 'active' }],
};

globalThis.fetch = async request => {
  const url = new URL(request.url), query = url.searchParams.get('sysparm_query') || '';
  if (url.origin !== fixtureOrigin) throw new Error('Fixture refused destination');
  if (url.pathname === '/api/sn_appclient/appmanager/apps') {
    if (request.method !== 'POST' || await request.text() !== '{}'
      || url.search !== '?tab_context=installed&sysparm_limit=200&sysparm_offset=0') throw new Error('Fixture refused discovery request');
    return Response.json({ result: { apps: [{ sys_id: 'c'.repeat(32), scope: 'example_app', name: 'Example Store App', version: '1.0', isInstalled: true }] } });
  }
  if (request.method !== 'GET') throw new Error('Fixture refused write');
  const table = url.pathname.split('/').at(-1);
  if (table === 'sys_db_object') {
    const name = query.replace(/^name=/, '');
    if (name === 'license_details') return new Response('forbidden', { status: 403 });
    return Response.json({ result: definitions[name] ? [{ sys_id: 'a'.repeat(32), name, super_class: '' }] : [] });
  }
  if (table === 'sys_dictionary') {
    const name = query.split('^')[0].replace(/^name=/, '');
    return Response.json({ result: Object.entries(definitions[name] || {}).map(([element, internal_type]) => ({ name, element, internal_type, reference: '' })) });
  }
  if (url.pathname.startsWith('/api/now/stats/')) {
    if (!['sys_store_app', 'v_plugin'].includes(table)) throw new Error('Fixture refused stats source');
    return Response.json({ result: { stats: { count: '1' } } });
  }
  if (url.pathname === '/api/now/table/sys_store_app') return new Response('forbidden', { status: 403 });
  if (!Object.hasOwn(records, table) || !url.pathname.startsWith('/api/now/table/')) throw new Error('Fixture refused source');
  return Response.json({ result: records[table] });
};
