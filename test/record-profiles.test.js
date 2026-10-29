import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getRecordProfile, recordProfiles, validateRecordProfiles, buildProfileCommand, buildRecordProfile } from '../src/record-profiles.js';
import { captureCommands, findHandler } from './support/command-test-helpers.js';

function commands(command) { return captureCommands(command).map(c => c.command.split(' ')[0]); }
test('bundled keyed profiles drive actual aliases, tables, columns, identifier and output defaults', async () => {
  assert.ok(recordProfiles().some(profile => profile.name === 'tables'));
  assert.ok(recordProfiles().every(profile => Object.isFrozen(profile)));
  const cases = [
    ['incidents', 'incident', ['incident', 'inc'], 'number'],
    ['changes', 'change_request', ['change_request', 'chg'], 'number'],
    ['tasks', 'sc_task', ['sc_task', 'task'], 'number'],
    ['includes', 'sys_script_include', ['include', 'si'], 'name'],
    ['asyncrules', 'sys_script', ['asyncrule'], 'name'],
  ];
  for (const [name, table, aliases, field] of cases) {
    const profile = getRecordProfile(name), command = buildProfileCommand(name, fn => fn);
    assert.deepEqual(command.aliases, aliases); assert.equal(command.recordProfile.table, table);
    assert.equal(profile.identifierField, field); assert.equal(profile.output.references, 'both');
    const calls = [], result = [];
    const app = { sdk: { list: async (target, params) => { calls.push([target, Object.fromEntries(params)]); return []; } },
      output: { getFormat: () => 'json' }, config: { profiles: {} }, getEffectiveInstance: () => 'https://fixture.invalid',
      ok: data => result.push(data) };
    await findHandler(command, 'list')({ limit: 7, offset: 0 }, app);
    assert.equal(calls[0][0], table); assert.equal(calls[0][1].sysparm_display_value, 'all');
    assert.deepEqual(result[0].columns, profile.columns);
  }
  assert.ok(!commands(buildProfileCommand('sppages', fn => fn)).includes('delete'));
  assert.ok(commands(buildProfileCommand('includes', fn => fn)).includes('delete'));
});
test('profiles validate ambiguity, relationship policy and immutable ownership', () => {
  const definition = structuredClone(getRecordProfile('includes'));
  for (const change of [p => { p.table = 'bad^OR'; }, p => { p.columns = ['bad^OR']; }, p => { p.aliases = ['bad alias']; },
    p => { p.output.references = 'invalid'; }, p => { p.relationships.essential = [{ name: 'actions', table: 'x^OR', foreignKey: 'parent' }]; }]) {
    const invalid = structuredClone(definition); change(invalid);
    assert.throws(() => validateRecordProfiles([invalid]));
  }
  assert.throws(() => validateRecordProfiles([definition, definition]), /duplicate/);
  const [validated] = validateRecordProfiles([definition]);
  definition.columns.push('extra');
  assert.notDeepEqual(validated.columns, definition.columns);
  assert.throws(() => validated.aliases.push('extra'), TypeError);
});
test('a new declarative profile extends the real factory and executable show hooks', async () => {
  const profile = { name: 'fixturecustom', table: 'x_fixture_custom', kind: 'dev', aliases: ['fixturealias'],
    columns: ['name'], identifierField: 'code', output: { references: 'raw', listProjection: 'full' },
    options: { singular: 'custom artifact', readOnly: true }, relationships: { essential: [], supplementary: [] } };
  let selected, data;
  const command = buildRecordProfile(profile, fn => fn, { onShow: async record => { record._hook = true; } });
  assert.deepEqual(command.aliases, ['fixturealias']); assert.ok(!commands(command).includes('update'));
  await findHandler(command, 'show')({ identifier: 'CODE1' }, {
    sdk: { list: async (table, params) => { selected = [table, Object.fromEntries(params)]; return [{ sys_id: 'legacy', code: 'CODE1' }]; } },
    getEffectiveInstance: () => 'https://fixture.invalid', ok: result => { data = result; },
  });
  assert.equal(selected[0], 'x_fixture_custom'); assert.equal(selected[1].sysparm_query, 'code=CODE1');
  assert.equal(selected[1].sysparm_display_value, 'false'); assert.equal(data._hook, true);
  assert.equal(command.recordProfile.output.references, 'raw');
});

test('minimal declarations inherit defaults and only override the preferences they change', () => {
  const [profile] = validateRecordProfiles([{ name: 'minimal', table: 'x_minimal', aliases: [], columns: ['name'], output: { references: 'raw' } }]);
  assert.equal(profile.identifierField, 'name');
  assert.deepEqual(profile.output, { references: 'raw', listProjection: 'display' });
  assert.deepEqual(profile.relationships, { essential: [], supplementary: [] });
  assert.deepEqual(profile.options, {});
  const [ticket] = validateRecordProfiles([{ name: 'minimal_ticket', kind: 'ticket', table: 'x_ticket', aliases: [], columns: ['number'] }]);
  assert.equal(ticket.identifierField, 'number');
});
