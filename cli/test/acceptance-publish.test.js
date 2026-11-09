import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateProjection, publishResults } from '../scripts/acceptance/publish.mjs';
import { loadCatalogRecipe } from '../scripts/acceptance/run.mjs';
import { parseArgs } from '../scripts/acceptance/support.mjs';

const SHA = 'a'.repeat(40);
const BINARY = 'b'.repeat(64);
const projection = (overrides = {}) => ({
  schemaVersion: 1,
  runKey: `acceptance_${'c'.repeat(32)}`,
  mode: 'readonly',
  provenance: { sourceSHA: SHA, version: '3.2.1', node: 'v22.11.0', binarySHA256: BINARY, sourceDirty: false },
  platform: 'linux',
  environment: { domainSeparation: 'UNKNOWN' },
  selection: { full: true, selected: ['readonly.records'] },
  summary: { total: 2, counts: { passed: 1, failed: 1 }, complete: false, missingCount: 2 },
  performance: null,
  results: [
    { id: 'readonly.records', status: 'passed', durationMs: 12 },
    { id: 'readonly.tables', status: 'failed', durationMs: 8 },
  ],
  ...overrides,
});

test('accepts the closed public projection', () => {
  assert.equal(validateProjection(projection()).runKey.length, 43);
});

test('rejects unknown or unsafe projection content', () => {
  assert.throws(() => validateProjection({ ...projection(), expectedHost: 'dev366743.service-now.com' }), /Unknown projection field/);
  assert.throws(() => validateProjection(projection({ provenance: { ...projection().provenance, version: 'dev366743.service-now.com' } })), /Invalid CLI version/);
  assert.throws(() => validateProjection(projection({ results: [{ id: 'readonly.records', status: 'passed', durationMs: 1, error: 'secret' }] })), /Unknown result field/);
});

test('rejects counts or completeness that disagree with results', () => {
  const bad = projection();
  bad.summary.counts = { passed: 2 };
  assert.throws(() => validateProjection(bad), /Counts/);
  const complete = projection();
  complete.summary.complete = true;
  assert.throws(() => validateProjection(complete), /Complete flag/);
});

test('publishes accepted and duplicate outcomes without exposing the token', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-publish-'));
  const file = path.join(dir, 'public-summary.json');
  fs.writeFileSync(file, JSON.stringify(projection()));
  let request;
  const accepted = await publishResults({ file, url: 'https://jsn.jace.dev', token: 'x'.repeat(40), fetchImpl: async (url, init) => {
    request = { url, init };
    return { status: 201, json: async () => ({ status: 'accepted' }) };
  } });
  assert.deepEqual(accepted, { ok: true, httpStatus: 201, result: 'accepted' });
  assert.equal(request.init.headers.Authorization, `Bearer ${'x'.repeat(40)}`);
  assert.ok(!JSON.stringify(request.init).includes('dev366743'));
  const duplicate = await publishResults({ file, url: 'https://jsn.jace.dev', token: 'x'.repeat(40), fetchImpl: async () => ({ status: 200, json: async () => ({ status: 'duplicate' }) }) });
  assert.equal(duplicate.result, 'duplicate');
  const conflict = await publishResults({ file, url: 'https://jsn.jace.dev', token: 'x'.repeat(40), fetchImpl: async () => ({ status: 409, json: async () => ({ error: 'run key conflict' }) }) });
  assert.equal(conflict.result, 'conflict');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('refuses missing token, insecure non-loopback URLs and unknown flags', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-publish-'));
  const file = path.join(dir, 'public-summary.json');
  fs.writeFileSync(file, JSON.stringify(projection()));
  await assert.rejects(() => publishResults({ file, url: 'https://jsn.jace.dev', token: '' }), /token/i);
  await assert.rejects(() => publishResults({ file, url: 'http://jsn.jace.dev', token: 'x'.repeat(40) }), /HTTPS/);
  assert.throws(() => parseArgs(['--profile', 'pdi', '--expected-host', 'dev.invalid', '--unknown']), /Unknown argument/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('accepts retained-flow and catalog-recipe options only as explicit inputs', () => {
  const parsed = parseArgs(['--profile', 'pdi', '--expected-host', 'dev.invalid', '--mode', 'pdi', '--allow-writes', '--allow-retained-flows', '--catalog-recipe', '/tmp/recipe.json']);
  assert.equal(parsed.allowRetainedFlows, true);
  assert.equal(parsed.catalogRecipe, '/tmp/recipe.json');
});

test('catalog recipe requires a private bounded file and known fields', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-recipe-'));
  const good = path.join(dir, 'recipe.json');
  fs.writeFileSync(good, JSON.stringify({ actionTypeId: 'd'.repeat(32), inputs: { short_description: '$RUN_NAME' } }), { mode: 0o600 });
  const state = new Map();
  await loadCatalogRecipe({ state }, good);
  assert.equal(state.get('workflows.catalogRecipe').actionTypeId, 'd'.repeat(32));
  const open = path.join(dir, 'open.json');
  fs.writeFileSync(open, JSON.stringify({ actionTypeId: 'd'.repeat(32), inputs: {} }), { mode: 0o644 });
  await assert.rejects(() => loadCatalogRecipe({ state: new Map() }, open), /0600/);
  const unknown = path.join(dir, 'unknown.json');
  fs.writeFileSync(unknown, JSON.stringify({ actionTypeId: 'd'.repeat(32), inputs: {}, host: 'dev366743' }), { mode: 0o600 });
  await assert.rejects(() => loadCatalogRecipe({ state: new Map() }, unknown), /Unknown catalog recipe field/);
  fs.rmSync(dir, { recursive: true, force: true });
});
