import { recordProfiles } from '../../src/record-profiles.js';
import { classifyCommand, ScenarioError } from '../../scripts/acceptance/support.mjs';

// Reviewed registration sites: _simple.js, the four ticket modules and uipolicies.js.
// Deliberate allowlist: new profiles require review, not automatic acceptance credit.
const verified = new Set(`includes rules clientscripts uiactions sppages spwidgets uipages appmenu acls roles properties relationships appmodules listcontrols views privileges uxscripts catalogscripts scriptactions scheduledjobs asyncrules triggers assignments email uimacros uxlists uxapplicability cataloguipolicies incidents changes requests tasks uipolicies tables`.split(' '));
const fields = ['sys_id', 'sys_updated_on'];
const commonSources = ['cli/src/record-profiles.js', 'cli/src/record-command-profiles.js', 'cli/src/records-engine.js', 'cli/src/resolve-record.js'];
const common = { modes: ['readonly', 'pdi'], mutates: false };
function check(condition, label) {
  // Do not include actual/expected payloads in assertion messages or reports.
  if (!condition) throw new ScenarioError('failed', `Read-only catalog: ${label}`);
}
const raw = value => value && typeof value === 'object' ? value.value : value;
function resultData(result) {
  classifyCommand(result);
  check(result.exitCode === 0 && result.json?.ok === true, 'invalid CLI success envelope');
  return result.json.data;
}
function rows(data) {
  check(data && Array.isArray(data.records), 'record array missing');
  check(data.records.length <= 1, 'list exceeded requested bound');
  check(data.count === data.records.length, 'visible count inconsistent');
  return data.records;
}
function identity(record) {
  const id = raw(record?.sys_id);
  check(typeof id === 'string' && /^[a-f0-9]{32}$/.test(id), 'readable exact identity missing');
  return id;
}
function compare(record, independent) {
  check(independent && !Array.isArray(independent) && typeof independent === 'object', 'independent record missing');
  for (const field of fields) {
    check(Object.hasOwn(record, field) && Object.hasOwn(independent, field), 'projected comparison field missing');
    check(typeof raw(record[field]) === 'string' && raw(record[field]).length > 0 && raw(record[field]) === raw(independent[field]), 'independent field mismatch');
  }
}
async function human(ctx, args) {
  const result = classifyCommand(await ctx.command([...args, '--format', 'markdown']));
  check(result.exitCode === 0 && typeof result.stdout === 'string' && result.stdout.trim().length > 0, 'human output missing');
  return result.stdout;
}
export const catalog = recordProfiles().filter(profile => verified.has(profile.name)).map(profile => ({
  name: profile.name, table: profile.table, kind: profile.kind || 'dev', extraQuery: profile.options.extraQuery || '',
  essential: profile.relationships.essential.length > 0,
  // These show handlers perform counts or unbounded related-record fanout.
  show: !['tables', 'requests'].includes(profile.name),
  sources: [...commonSources, profile.kind === 'ticket' ? `cli/src/commands/${profile.name}.js` : 'cli/src/commands/_simple.js',
    profile.kind === 'ticket' ? 'cli/src/commands/_ticket.js' : 'cli/src/commands/_generic.js',
    ...(profile.name === 'uipolicies' ? ['cli/src/commands/uipolicies.js'] : [])],
}));
export const exclusions = {
  'tables show': 'Aggregate count and ancestor traversal are outside bounded no-count sampling.',
  'requests show': 'Custom show fetches attachments and catalog variables without this sampler controlling their bounds.',
  'actions, aliases, b4rules, columns, import, restmessage, soapmessages': 'Custom factories/hooks require separate bounded request contracts; no profile equivalence inferred.',
  'other non-profile families': 'Bespoke filters, hierarchy, endpoints or local contracts are not covered by this resource-only catalog.',
  store: 'Excluded from live acceptance by user policy.',
};
function binding(path, options) {
  return { [path]: { requirements: ['scripted-success', 'human-and-json-output'], options } };
}
export const scenarios = catalog.flatMap(family => {
  const listId = `readonly.catalog.${family.name}.list`;
  const stateKey = `readonly.catalog.${family.name}.sample`;
  const listPath = `${family.name} list`, showPath = `${family.name} show`;
  const listArgs = query => [family.name, 'list', '--query', query, '--columns', fields.join(','), '--limit', '1', '--display-values', 'raw'];
  const list = { ...common, id: listId, title: `Bounded ${family.name} list and independent projected readback`,
    commandPaths: [listPath], sources: family.sources, requires: [],
    coverageBindings: binding(listPath, [`${listPath} --query`, `${listPath} --columns`, `${listPath} --limit`, `${listPath} --display-values`, '$root --json', '$root --format']),
    async run(ctx) {
      ctx.state.delete(stateKey);
      const data = resultData(await ctx.command([...listArgs('sys_idISNOTEMPTY'), '--json']));
      check(data.table === family.table, 'list table binding mismatch');
      const records = rows(data);
      if (!records.length) {
        // This only verifies the visible empty-list response. It does not prove absence.
        await human(ctx, listArgs('sys_idISNOTEMPTY'));
        ctx.state.set(stateKey, { empty: true });
        return;
      }
      const record = records[0], id = identity(record);
      const independent = await ctx.read(family.table, { id, fields, limit: 1 });
      compare(record, Array.isArray(independent) && independent.length === 1 ? independent[0] : independent);
      const text = await human(ctx, listArgs(`sys_id=${id}`));
      check(text.includes(id) && text.includes(raw(record.sys_updated_on)), 'human list omitted projected metadata');
      // Only projected metadata is retained, never names, descriptions or record bodies.
      ctx.state.set(stateKey, { id });
    } };
  if (!family.show) return [list];
  const showArgs = id => [family.name, 'show', id, '--identifier-field', 'sys_id', '--display-values', 'raw', ...(family.essential ? ['--no-essential'] : [])];
  const show = { ...common, id: `readonly.catalog.${family.name}.show`, title: `Exact ${family.name} show and independent identity/metadata check`,
    commandPaths: [showPath], sources: family.sources, requires: [listId],
    coverageBindings: binding(showPath, [`${showPath} --identifier-field`, `${showPath} --display-values`, '$root --json', '$root --format', ...(family.essential ? [`${showPath} --essential`] : [])]),
    async run(ctx) {
      const sample = ctx.state.get(stateKey);
      if (!sample?.id) throw new ScenarioError('blocked-prerequisite', 'No visible list fixture for exact show; empty data is not show coverage');
      const record = resultData(await ctx.command([...showArgs(sample.id), '--json']));
      check(identity(record) === sample.id, 'show identity mismatch');
      const independent = await ctx.read(family.table, { id: sample.id, fields, limit: 1 });
      compare(record, Array.isArray(independent) && independent.length === 1 ? independent[0] : independent);
      const text = await human(ctx, showArgs(sample.id));
      check(text.includes(sample.id) && text.includes(raw(record.sys_updated_on)), 'human show omitted comparison metadata');
    } };
  return [list, show];
});

// Shared read-only option factory for the four ticket profiles. The list
// assertions exercise the registered query/columns/limit/offset path; the
// extracted value is the same exact identity used by the independent GET.
const ticketFamilies = ['incidents', 'changes', 'tasks'];
const ticketOptions = {
  ...common,
  id: 'readonly.catalog.ticket-options',
  title: 'Ticket list offset and extracted identity across the shared profile factory',
  commandPaths: ticketFamilies.flatMap(name => [`${name} list`, `${name} show`]),
  sources: commonSources,
  requires: [],
  coverageBindings: Object.fromEntries(ticketFamilies.flatMap(name => [
    [`${name} list`, { requirements: ['scripted-success'], options: {
      [`${name} list --query`]: ['explicit-value'],
      [`${name} list --columns`]: ['explicit-value'],
      [`${name} list --limit`]: ['explicit-value'],
      [`${name} list --offset`]: ['explicit-value', 'omitted-default'],
      '$root --get': ['explicit-value']
    } }],
    [`${name} show`, { requirements: ['scripted-success'], options: { '$root --get': ['explicit-value'] } }]
  ])),
  async run(ctx) {
    for (const family of ticketFamilies) {
      const base = [family, 'list', '--query', 'sys_idISNOTEMPTY', '--columns', 'sys_id,sys_updated_on', '--limit', '1', '--display-values', 'raw'];
      const explicit = await ctx.command([...base, '--offset', '1', '--json']);
      const explicitData = resultData(explicit);
      check(Array.isArray(explicitData.records) && explicitData.records.length <= 1, 'explicit offset list was not bounded');
      const omitted = await ctx.command([...base, '--get', 'data.records.0.sys_id']);
      check(omitted.exitCode === 0 && typeof omitted.stdout === 'string', 'omitted offset list did not return an extracted identity');
      const id = JSON.parse(omitted.stdout);
      check(typeof id === 'string' && /^[a-f0-9]{32}$/.test(id), 'omitted offset extracted identity invalid');
      const independent = await ctx.read(family === 'requests' ? 'sc_request' : family === 'tasks' ? 'sc_task' : family === 'changes' ? 'change_request' : 'incident', { id, fields, limit: 1 });
      check(identity(Array.isArray(independent) ? independent[0] : independent) === id, 'independent list identity mismatch');
      const show = await ctx.command([family, 'show', id, '--identifier-field', 'sys_id', '--display-values', 'raw', '--get', 'data.sys_id']);
      check(show.exitCode === 0 && JSON.parse(show.stdout) === id, 'show extracted identity mismatch');
    }
  }
};
scenarios.push(ticketOptions);
