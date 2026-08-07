import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { decodeGzipJson, hydrateFlowBlocks } from '../src/sdk.js';

function gzipB64(obj) {
  return gzipSync(Buffer.from(JSON.stringify(obj), 'utf-8')).toString('base64');
}

test('decodeGzipJson decodes base64-gzip JSON with surrounding whitespace', () => {
  const payload = { inputs: [{ name: 'condition', value: '{{x}}ISNOTEMPTY' }], variables: [] };
  const raw = `\n\t\t\t${gzipB64(payload)}`;
  const result = decodeGzipJson(raw);
  assert.deepEqual(result, payload);
});

test('decodeGzipJson handles display_value/value object form', () => {
  const payload = { inputs: [] };
  const result = decodeGzipJson({ display_value: gzipB64(payload), value: gzipB64(payload) });
  assert.deepEqual(result, payload);
});

test('decodeGzipJson returns null for empty input', () => {
  assert.equal(decodeGzipJson(''), null);
  assert.equal(decodeGzipJson(null), null);
  assert.equal(decodeGzipJson(undefined), null);
  assert.equal(decodeGzipJson('   '), null);
});

test('decodeGzipJson returns null for non-gzip strings', () => {
  assert.equal(decodeGzipJson('plain json {"a":1}'), null);
  assert.equal(decodeGzipJson('H4sI not-valid-base64'), null);
});

test('decodeGzipJson returns null for corrupt gzip', () => {
  assert.equal(decodeGzipJson('H4sIAAAAAAAA/w=='), null);
});

test('hydrateFlowBlocks builds flowBlock nesting from flat parent links', () => {
  const payload = {
    flowLogicInstances: [
      { uiUniqueIdentifier: 'if-1', flowLogicDefinition: { name: 'If' }, order: '1' },
      { uiUniqueIdentifier: 'if-2', flowLogicDefinition: { name: 'If' }, order: '3', parent: 'if-1' },
    ],
    actionInstances: [
      { name: 'Update Record', order: '2', parent: 'if-1' },
      { name: 'Log', order: '4', parent: 'if-2' },
    ],
  };
  hydrateFlowBlocks(payload);
  const if1 = payload.flowLogicInstances[0];
  const if2 = payload.flowLogicInstances[1];
  assert.ok(Array.isArray(if1.flowBlock), 'If-1 should have a flowBlock');
  assert.equal(if1.flowBlock.length, 2, 'If-1 should contain action + nested If');
  assert.deepEqual(if1.flowBlock.map(x => x.name ?? x.uiUniqueIdentifier), ['Update Record', 'if-2']);
  assert.ok(Array.isArray(if2.flowBlock), 'If-2 should have a flowBlock');
  assert.deepEqual(if2.flowBlock.map(x => x.name), ['Log']);
});

test('hydrateFlowBlocks leaves existing flowBlock arrays alone (version-payload shape)', () => {
  const payload = {
    flowLogicInstances: [
      { uiUniqueIdentifier: 'if-1', flowLogicDefinition: { name: 'If' }, flowBlock: [{ name: 'Update Record' }] },
    ],
    actionInstances: [{ name: 'Update Record', parent: 'if-1' }],
  };
  hydrateFlowBlocks(payload);
  assert.deepEqual(payload.flowLogicInstances[0].flowBlock.map(x => x.name), ['Update Record']);
});

test('hydrateFlowBlocks handles empty input', () => {
  const payload = {};
  hydrateFlowBlocks(payload);
  assert.deepEqual(payload, {});
});
