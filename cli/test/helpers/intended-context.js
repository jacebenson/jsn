// Shared independent fixture for CLI tests whose subject is not context policy.
export const contextScope = 'd'.repeat(32);
export const contextSet = 'b'.repeat(32);
export const contextArgs = ['--expect-scope', contextScope, '--expect-update-set', contextSet];
export function contextResponse(url, { set = contextSet, user = 'e'.repeat(32), name = 'Fixture' } = {}) {
  const p = url.pathname;
  if (p.endsWith('/table/sys_user')) return { result: [{ sys_id: user, user_name: 'fixture' }] };
  if (p.endsWith('/table/sys_user_preference')) return { result: [{ value: url.searchParams.get('sysparm_query')?.includes('apps.current_app') ? contextScope : set }] };
  if (p.includes('/table/sys_scope')) return { result: p.endsWith('/sys_scope') ? [{ sys_id: contextScope, scope: 'global' }] : { sys_id: contextScope, scope: 'global' } };
  if (p.includes('/table/sys_update_set')) {
    const record = { sys_id: set, name, application: contextScope, state: 'in progress' };
    return { result: p.endsWith('/sys_update_set') ? [record] : record };
  }
  if (p.endsWith('/concoursepicker/application')) return { result: { current: contextScope } };
  if (p.endsWith('/concoursepicker/updateset')) return { result: { current: { sysId: set, name } } };
  return null;
}
