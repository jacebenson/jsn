// Presentation policy only. ServiceNow ACLs still authorize every request.
// Explicit command paths and --all-commands remain available to every account.
const BASIC_COMMANDS = new Set([
  'incidents', 'changes', 'requests', 'tasks', 'tickets', 'approvals', 'records',
  'groups', 'groupmembers', 'grouproles', 'users', 'setup', 'auth', 'skill',
  'version', 'docs', 'history', 'discover', 'completion',
  'catalogitems',
]);

export async function detectCommandAudience(sdk, username, instanceURL = sdk?.baseURL) {
  if (!username || typeof sdk?.listStrict !== 'function') return undefined;
  try {
    const roles = await sdk.listStrict('sys_user_has_role', {
      sysparm_query: 'user=javascript:gs.getUserID()^role.name=admin',
      sysparm_fields: 'sys_id', sysparm_limit: '1',
    }, { touchLastSeen: false });
    return { username, instance_url: instanceURL, mode: roles.length ? 'admin' : 'basic', role_check: 'verified' };
  } catch {
    // Missing role access must not expand help. This is a presentation fallback,
    // not a claim that the role query succeeded or an authorization boundary.
    return { username, instance_url: instanceURL, mode: 'basic', role_check: 'unavailable' };
  }
}

export function commandAudience(config, { instance, allCommands = false } = {}) {
  if (allCommands || instance) return 'all';
  const name = config?.activeProfile || config?.defaultProfile;
  const profile = config?.profiles?.[name];
  const cached = profile?.command_audience;
  return cached?.username === profile?.username && cached?.instance_url === profile?.instance_url && cached?.mode === 'basic' ? 'basic' : 'all';
}

export function visibleCommandRegistry(registry, config, options = {}) {
  if (commandAudience(config, options) !== 'basic') return registry;
  return { ...registry, commands: registry.commands.filter(command => BASIC_COMMANDS.has(command.name)) };
}
