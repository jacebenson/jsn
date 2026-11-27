// Root identity and capability policy for the record-profile command families.
//
// `record-command-profiles.js` is the data those families are configured from.
// Deriving their signature, aliases, description, summary and mutation policy
// here keeps one authoritative declaration: the registration table in
// `command-families.js` and the CRUD factories in `commands/_generic.js` and
// `commands/_ticket.js` both use these functions instead of restating values.
import profiles from './record-command-profiles.js';

const kindOf = profile => profile.kind || 'dev';
const readOnly = profile => profile.options?.readOnly === true;

/**
 * Root identity for a profile-backed command. The describe text keeps the
 * factory defaults: tickets prompt with an incident-shaped priority query,
 * developer records with a name query.
 */
export function profileCommandDefinition(name, profile = profiles[name]) {
  if (!profile) throw new Error(`Unknown record command profile: ${name}`);
  const example = kindOf(profile) === 'ticket' ? 'priority=1' : 'nameLIKEincident';
  return {
    command: `${name} [subcommand]`,
    aliases: [...(profile.aliases || [])],
    describe: `Manage ${name} (e.g. "${name} list --query ${example}")`,
    ...(profile.summary ? { summary: profile.summary } : {}),
  };
}

/**
 * Capability declaration for a profile-backed command. Tickets keep their
 * operational mutation context; developer records follow the table, and a
 * read-only profile publishes no mutating verbs.
 */
export function profileCommandCapabilities(profile) {
  return kindOf(profile) === 'ticket'
    ? { queryTable: profile.table, mutationContext: 'operational', mutationSubcommands: ['create', 'update', 'delete'] }
    : { mutationContext: 'table', table: profile.table, mutationSubcommands: readOnly(profile) ? [] : ['create', 'update', 'delete'] };
}
