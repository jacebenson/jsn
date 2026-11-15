// Closed configuration contract shared by readiness and execution.
export const TARGETS = ['pdi', 'vendor-1', 'vendor-2'];
export function selectTargets(manual = 'both') {
  if (manual === 'both' || !manual) return ['vendor-1', 'vendor-2'];
  return [selectTarget(manual)];
}
export function selectTarget(manual) {
  const target = manual || 'vendor-1';
  if (!TARGETS.includes(target)) throw new Error('Invalid acceptance target');
  return target;
}
export function authorizeMode({ target, mode = 'readonly', approved, reviewers }) {
  if (!TARGETS.includes(target) || !['readonly', 'pdi'].includes(mode)) throw new Error('Invalid acceptance selection');
  if (mode === 'pdi' && (target !== 'pdi' || approved !== 'true' || reviewers !== 'true')) {
    throw new Error('PDI mutations require explicit approval and verified required reviewers');
  }
}
export function instanceConfiguration(env) {
  const target = selectTarget(env.ACCEPTANCE_TARGET);
  const mode = env.ACCEPTANCE_MODE || 'readonly';
  authorizeMode({ target, mode, approved: env.ACCEPTANCE_DISPOSABLE_APPROVED, reviewers: env.ACCEPTANCE_REVIEWERS_VERIFIED });
  if (env.JSN_VERIFY_ENABLED !== 'true' || !env.SERVICENOW_INSTANCE_URL || !env.SERVICENOW_OAUTH_TOKEN) throw new Error('Acceptance NOT CONFIGURED');
  const host = new URL(env.SERVICENOW_INSTANCE_URL);
  if (host.protocol !== 'https:' || host.username || host.password || host.pathname !== '/' || host.search || host.hash || host.port) throw new Error('Invalid target origin');
  return { target, mode, host, profile: { instance_url: host.origin, read_only: mode === 'readonly' }, credentials: { auth_method: 'oauth', access_token: env.SERVICENOW_OAUTH_TOKEN } };
}
export function producerEnvironment(env, privateRoot, configHome) {
  // No provider, GitHub, publication, proxy or Node-injection credentials inherited.
  return { PATH: env.PATH || '', HOME: privateRoot, XDG_CONFIG_HOME: configHome,
    XDG_CACHE_HOME: privateRoot, TMPDIR: privateRoot, CI: 'true',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent-jsn-acceptance-bus',
    JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_DOCS_CHECK: '1' };
}
