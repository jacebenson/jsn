// Owned-fixture mutations only. Provider writes always go through the real CLI.
import assert from 'node:assert/strict';
import profiles from '../../src/record-command-profiles.js';

export const raw = value => value && typeof value === 'object' ? value.value ?? value.sys_id ?? '' : value;
export const rows = value => value == null ? [] : Array.isArray(value) ? value : [value];
export function blocked(message) {
  const error = new Error(message);
  error.code = 'prerequisite_missing';
  error.status = 'blocked';
  throw error;
}
export function runName(ctx, suffix = '') {
  assert.match(ctx.runKey, /^[A-Za-z0-9_]{8,80}$/, 'runKey must be query-safe and unique');
  return `jsn_acceptance_${ctx.runKey}${suffix ? `_${suffix}` : ''}`;
}
export function requirePdi(ctx) {
  assert.equal(ctx.mode, 'pdi', 'owned mutations require pdi mode');
  runName(ctx);
}
export async function command(ctx, args, options) {
  const result = await ctx.command(args, options);
  assert.equal(result.exitCode, 0, `${args.slice(0, 2).join(' ')} failed; reconcile provider state before retry`);
  assert.equal(result.json?.ok, true, 'CLI did not confirm success in JSON envelope');
  return result.json.data;
}
export async function readOne(ctx, table, id, fields) {
  const found = rows(await ctx.read(table, { id, fields, limit: 1 }));
  assert.equal(found.length, 1, `${table} exact-ID readback missing or ambiguous`);
  assert.equal(raw(found[0].sys_id), id, `${table} readback identity differs`);
  return found[0];
}
export function equalFields(record, expected) {
  for (const [field, value] of Object.entries(expected)) assert.ok(String(raw(record[field])) === String(value), `${field} provider readback differs`);
}
export async function register(ctx, table, id, kind, dependsOn = [], cleanupArgs = null) {
  assert.ok(typeof id === 'string' && /^[a-f0-9]{32}$/i.test(id), 'mutation returned no exact owned sys_id; reconcile, never retry');
  await ctx.registerArtifact({ table, id, kind, dependsOn, cleanupArgs });
}
export async function dictionary(ctx, table, fields) {
  // Include all own-table metadata, not only fixture fields, so an unfilled mandatory
  // field blocks rather than inviting an unsafe guessed default. Inherited fields
  // remain a provider validation responsibility (documented limitation).
  const metadata = rows(await ctx.read('sys_dictionary', { query: `name=${table}^elementISNOTEMPTY`, fields: ['element', 'mandatory', 'read_only', 'default_value', 'internal_type', 'reference'], limit: 500 }));
  if (!metadata.length || metadata.length >= 500) blocked(`${table}: dictionary unavailable or truncated`);
  const byName = new Map(metadata.map(field => [String(raw(field.element)), field]));
  for (const field of Object.keys(fields)) {
    if (!byName.has(field)) blocked(`${table}.${field}: no live dictionary evidence`);
    if (String(raw(byName.get(field).read_only)) === 'true') blocked(`${table}.${field}: provider marks field read-only`);
  }
  for (const [name, field] of byName) {
    if (String(raw(field.mandatory)) === 'true' && !name.startsWith('sys_') && !(name in fields) && !raw(field.default_value)) blocked(`${table}.${name}: mandatory field has no safe fixture value`);
  }
  return byName;
}
export async function assertCapture(ctx) {
  requirePdi(ctx);
  const context = ctx.state.get('workflows.context');
  if (!context?.captureId) blocked('workflows.context must establish a dedicated capture set');
  const capture = await readOne(ctx, 'sys_update_set', context.captureId, ['sys_id', 'name', 'state']);
  assert.notEqual(String(raw(capture.name)).toLowerCase(), 'default', 'Default capture prohibited');
  assert.equal(String(raw(capture.state)), 'in progress', 'capture set must be in progress');
  const effective = await command(ctx, ['rest', '/api/now/ui/concoursepicker/updateset', '--method', 'GET', '--json']);
  assert.equal(effective?.result?.current?.sysId, context.captureId, 'effective session capture drifted');
  return context;
}
export async function denied(ctx, args, pattern) {
  const result = await ctx.command(args, { expectedDenial: result =>
    result.json?.ok === false && ['confirmation_required', 'usage_error', 'validation_error'].includes(result.json?.error?.code) &&
    pattern.test(JSON.stringify(result.json ?? {}) + result.stderr) });
  assert.notEqual(result.exitCode, 0, 'negative command unexpectedly succeeded');
  assert.ok(pattern.test(JSON.stringify(result.json ?? {}) + result.stderr), 'negative failed for unrelated reason');
}

// One implementation exercises each meaningful generic-factory binding with its
// own inert schema. No active script, outbound email, customer or host fixture.
export const fixtures = [
  { command: 'properties', create: name => ({ name, value: 'initial', description: name }), update: { value: 'updated' } },
  { command: 'views', create: name => ({ name, title: name }), update: { title: 'Acceptance updated' } },
  { command: 'includes', create: name => ({ name, active: false, script: '// inert acceptance fixture' }), update: { script: '// inert updated fixture' } },
  { command: 'rules', create: name => ({ name, collection: 'sys_user', active: false, script: '// inert acceptance fixture' }), update: { script: '// inert updated fixture' } },
  { command: 'clientscripts', create: name => ({ name, table: 'sys_user', type: 'onLoad', active: false, script: 'function onLoad() {}' }), update: { script: 'function onLoad() { /* updated */ }' } },
  { command: 'uiactions', create: name => ({ name, table: 'sys_user', active: false, script: '// inert acceptance fixture' }), update: { script: '// inert updated fixture' } },
  { command: 'scheduledjobs', create: name => ({ name, active: false, run_type: 'on_demand', script: '// inert acceptance fixture' }), update: { script: '// inert updated fixture' } },
  { command: 'uipolicies', create: name => ({ short_description: name, table: 'sys_user', active: false }), update: { short_description: 'Acceptance updated' } },
].map(fixture => ({ ...fixture, table: profiles[fixture.command].table }));

export const scenarios = fixtures.map(fixture => ({
  id: `resources.${fixture.command}`,
  title: `Owned ${fixture.command}: create/show/update/confirmation/delete and provider readback`,
  commandPaths: ['create', 'show', 'update', 'delete'].map(action => `${fixture.command} ${action}`),
  sources: ['cli/src/record-command-profiles.js', 'cli/src/commands/_generic.js', 'cli/src/records-engine.js', 'cli/src/helpers.js'],
  modes: ['pdi'], mutates: true, requires: ['workflows.context'],
  async run(ctx) {
    const { captureId } = await assertCapture(ctx);
    const data = fixture.create(runName(ctx, fixture.command));
    await dictionary(ctx, fixture.table, data);
    const created = await command(ctx, [fixture.command, 'create', '--data', JSON.stringify(data), '--json']);
    const id = raw(created?.sys_id);
    await register(ctx, fixture.table, id, `resource:${fixture.command}`, [captureId], [fixture.command, 'delete', id, '--force', '--json']);
    equalFields(await readOne(ctx, fixture.table, id, ['sys_id', ...Object.keys(data)]), data);
    await command(ctx, [fixture.command, 'show', id, '--json']);
    await command(ctx, [fixture.command, 'update', id, '--data', JSON.stringify(fixture.update), '--json']);
    equalFields(await readOne(ctx, fixture.table, id, ['sys_id', ...Object.keys(fixture.update)]), fixture.update);
    await denied(ctx, [fixture.command, 'delete', id, '--json'], /confirmation_required|confirmation required/i);
    await readOne(ctx, fixture.table, id, ['sys_id']);
    await command(ctx, [fixture.command, 'delete', id, '--force', '--json']);
    assert.equal(rows(await ctx.read(fixture.table, { query: `sys_id=${id}`, fields: ['sys_id'], limit: 1 })).length, 0, 'owned deletion not confirmed');
    return { verified: ['create', 'show', 'update', 'confirmation-denial', 'delete'], table: fixture.table };
  },
}));
