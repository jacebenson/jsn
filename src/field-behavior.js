// Schema-backed investigation paths; no universal priority order is assumed.
export const fieldBehaviorHelp = [
  'Investigate the observed symptom; there is no fixed priority order for every field problem.',
  'Query filtering: jsn b4rules list --query "collection=incident^active=true" --json',
  'Before-query rules use sys_script.when=before and the Boolean action_query=true.',
  'Dictionary entry: jsn records list --table sys_dictionary --query "name=incident^element=caller_id" --json',
  'Inherited dictionary overrides: jsn records list --table sys_dictionary_override --query "name=incident^element=caller_id" --json',
  'Inspect base_table and inherited tables as needed; the dictionary entry is separate from its overrides.',
  'Access controls: jsn acls list --query "nameINincident,incident.*,incident.caller_id,*.caller_id,*,*.*" --json',
  'Also inspect inherited-table and wildcard ACLs. Exact name=incident alone omits field/wildcard rules.',
  'ACL rows are evidence, not proof of effective access: operation, roles, conditions and scripts matter.',
  'Form behavior: jsn clientscripts list --query "table=incident^active=true" --json',
  'Form policies: jsn uipolicies list --query "table=incident^active=true" --json',
  'Use the command help and show output to inspect the relevant records. Never bypass a business rule, ACL or other protection to make a symptom disappear.',
].join('\n');
