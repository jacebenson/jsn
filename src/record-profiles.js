// Declarative command metadata is consumed by the actual command factories.
// Hooks stay executable code; JSON owns aliases/table/defaults/relationship policy.
import definitions from './record-command-profiles.js';
import { buildDevCmd } from './commands/_generic.js';
import { buildTicketCommands } from './commands/_ticket.js';

const namePattern = /^[a-z][a-z0-9_-]*$/i;
const fieldPattern = /^[a-z_][a-z0-9_]*$/i;
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}
export function validateRecordProfiles(profiles) {
  if (!Array.isArray(profiles)) throw new Error('Record profiles must be an array.');
  const names = new Set();
  return profiles.map(definition => {
    for (const key of ['options', 'output', 'relationships']) {
      if (definition[key] !== undefined && (!definition[key] || typeof definition[key] !== 'object' || Array.isArray(definition[key]))) throw new Error(`Invalid ${key} for ${definition.name}.`);
    }
    const profile = { ...definition,
      identifierField: definition.identifierField ?? (definition.kind === 'ticket' ? 'number' : 'name'),
      options: { ...definition.options },
      output: { references: 'both', listProjection: 'display', ...definition.output },
      relationships: { essential: [], supplementary: [], ...definition.relationships },
    };
    if (!namePattern.test(profile.name || '') || names.has(profile.name)) throw new Error('Invalid or duplicate record profile name.');
    names.add(profile.name);
    if (!fieldPattern.test(profile.table || '') || !fieldPattern.test(profile.identifierField || '')) throw new Error(`Invalid table/identifier field for ${profile.name}.`);
    if (!Array.isArray(profile.aliases) || !profile.aliases.every(alias => namePattern.test(alias))) throw new Error(`Invalid aliases for ${profile.name}.`);
    if (!Array.isArray(profile.columns) || !profile.columns.length || !profile.columns.every(field => fieldPattern.test(field))) throw new Error(`Invalid columns for ${profile.name}.`);
    if (!['dev', 'ticket'].includes(profile.kind || 'dev')) throw new Error(`Invalid factory kind for ${profile.name}.`);
    if (!['raw', 'display', 'both'].includes(profile.output?.references) || !['display', 'full'].includes(profile.output?.listProjection)) throw new Error(`Invalid output preferences for ${profile.name}.`);
    if (!profile.options || typeof profile.options !== 'object' || Array.isArray(profile.options)) throw new Error(`Invalid factory options for ${profile.name}.`);
    for (const kind of ['essential', 'supplementary']) {
      if (!Array.isArray(profile.relationships?.[kind])) throw new Error(`Missing ${kind} relationship policy for ${profile.name}.`);
      for (const relationship of profile.relationships[kind]) {
        if (!namePattern.test(relationship.name || '') || !fieldPattern.test(relationship.table || '') || !fieldPattern.test(relationship.foreignKey || '')) throw new Error(`Invalid relationship for ${profile.name}.`);
      }
    }
    return freeze(structuredClone(profile));
  });
}
const profiles = freeze(validateRecordProfiles(Object.entries(definitions).map(([name, profile]) => ({ name, ...profile }))));
const index = new Map(profiles.map(profile => [profile.name, profile]));
export const recordProfiles = () => profiles;
export function getRecordProfile(name) {
  const profile = index.get(name);
  if (!profile) throw new Error(`Unknown record command profile: ${name}`);
  return profile;
}
export function buildProfileCommand(name, wrap, hooks = {}) {
  return buildRecordProfile(getRecordProfile(name), wrap, hooks);
}

export function buildRecordProfile(definition, wrap, hooks = {}) {
  const [profile] = validateRecordProfiles([definition]);
  const options = { ...profile.options, identifierField: profile.identifierField,
    referenceMode: profile.output.references, listProjection: profile.output.listProjection,
    relationships: profile.relationships, ...hooks };
  const command = profile.kind === 'ticket'
    ? buildTicketCommands(profile.table, profile.name, profile.aliases.find(alias => alias !== profile.table), profile.columns, {}, null, wrap, options)
    : buildDevCmd(profile.name, profile.table, profile.aliases, profile.columns, wrap, options);
  command.aliases = [...profile.aliases];
  command.recordProfile = profile;
  return command;
}
