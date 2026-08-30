import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenize, encodeText, phasesToBytes, bytesToPhases, similarity,
} from '../src/commands/docs/hrr.js';

describe('HRR helpers', () => {
  it('should tokenize text', () => {
    assert.deepEqual(tokenize('Hello, world!'), ['hello', 'world']);
  });

  it('should encode text to a vector', () => {
    const vec = encodeText('hello world', 64);
    assert.strictEqual(vec.length, 64);
  });

  it('should round-trip packed phases', () => {
    const original = encodeText('test phrase', 128);
    const bytes = phasesToBytes(original);
    const restored = bytesToPhases(bytes);
    assert.strictEqual(restored.length, 128);
    const sim = similarity(original, restored);
    assert.ok(sim > 0.99, `round-trip similarity ${sim} should be > 0.99`);
  });
});
