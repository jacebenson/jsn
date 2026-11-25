import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowsCredentialRead, windowsCredentialOperation } from '../src/auth/windows-credential-store.js';

test('case-variant mutations invalidate previously cached target spellings', () => {
  let value = 'initial';
  const run = (_exe, _args, options) => {
    const request = JSON.parse(options.input);
    if (request.operation === 'write') value = request.value;
    if (request.operation === 'delete') value = null;
    return JSON.stringify(request.operation === 'read'
      ? value === null ? { status: 'missing' } : { status: 'ok', value }
      : { status: 'ok' });
  };
  assert.equal(windowsCredentialOperation('read', 'Case-Identity', undefined, run), 'initial');
  windowsCredentialOperation('write', 'case-identity', 'updated', run);
  assert.equal(windowsCredentialOperation('read', 'Case-Identity', undefined, run), 'updated');
  windowsCredentialOperation('delete', 'CASE-IDENTITY', undefined, run);
  assert.equal(windowsCredentialOperation('read', 'Case-Identity', undefined, run), null);
});

test('ok with null is not a confirmed singleton miss and publishes no earlier chunk', () => {
  const keys = Array.from({ length: 65 }, (_, i) => `synthetic-null-${i}`);
  const calls = [];
  const valid = transport(calls);
  let invalid = true;
  const run = (exe, args, options) => {
    const response = JSON.parse(valid(exe, args, options));
    if (invalid && !response.values) response.value = null;
    return JSON.stringify(response);
  };
  assert.throws(() => windowsCredentialRead(keys, run), { code: 'credential_storage_error' });
  invalid = false;
  const before = calls.length;
  assert.equal(windowsCredentialOperation('read', keys[0], undefined, run), `servicenow-cli:${keys[0]}`);
  assert.equal(calls.length, before + 1);
});

function transport(calls) {
  return (_exe, _args, options) => {
    const request = JSON.parse(options.input);
    calls.push(request);
    if (request.operation === 'read') return JSON.stringify({ status: 'ok', value: request.target });
    return JSON.stringify({ status: 'ok', values: request.targets.map(target => ({ target, value: target })) });
  };
}

for (const size of [65, 129, 300]) {
  test(`batch read returns all ${size} identities across chunk and cache boundaries`, () => {
    const calls = [];
    const keys = Array.from({ length: size }, (_, i) => `synthetic-chunk-${i}`);
    const values = windowsCredentialRead(keys, transport(calls));
    assert.deepEqual([...values.keys()], keys);
    for (const key of keys) assert.equal(values.get(key), `servicenow-cli:${key}`);
    assert.equal(calls.length, Math.ceil(size / 64));
    if (size % 64 === 1) assert.equal(calls.at(-1).operation, 'read');
  });
}

test('a malformed later batch entry or later chunk publishes no partial cache', () => {
  for (const size of [2, 65]) {
    const keys = Array.from({ length: size }, (_, i) => `synthetic-atomic-${i}`);
    let malformed = true;
    const calls = [];
    const valid = transport(calls);
    const run = (exe, args, options) => {
      const response = JSON.parse(valid(exe, args, options));
      if (malformed && response.values && size === 2) response.values[1].value = {};
      if (malformed && !response.values) response.value = {};
      return JSON.stringify(response);
    };
    assert.throws(() => windowsCredentialRead(keys, run), { code: 'credential_storage_error' });
    malformed = false;
    const before = calls.length;
    assert.equal(windowsCredentialOperation('read', keys[0], undefined, run), `servicenow-cli:${keys[0]}`);
    assert.equal(calls.length, before + 1, 'invalid response must not cache the first valid entry');
  }
});

test('cache observations are scoped to their injected process transport', () => {
  const key = 'synthetic-independent-transport';
  const first = () => '{"status":"ok","value":"first"}';
  const second = () => '{"status":"ok","value":"second"}';
  assert.equal(windowsCredentialOperation('read', key, undefined, first), 'first');
  assert.equal(windowsCredentialOperation('read', key, undefined, second), 'second');
  assert.equal(windowsCredentialRead([key], second).get(key), 'second');
});
