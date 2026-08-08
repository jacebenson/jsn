// Tests for safety-guard error formatting (mutation middleware in cli.js)
// guardError is a pure function; guardExit writes + exits.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { guardError } from '../src/errors.js';

describe('guardError', () => {
  it('writes the structured error envelope to stdout in json mode', () => {
    const r = guardError(
      { format: 'json' },
      {
        code: 'read_only',
        message: 'Profile "dev198473" is read-only. Mutations are blocked.',
        hint: 'Switch to a write-enabled profile first:\n  jsn auth switch <name>',
      }
    );
    assert.strictEqual(r.stream, 'stdout');
    const parsed = JSON.parse(r.text);
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.code, 'read_only');
    assert.strictEqual(parsed.error, 'Profile "dev198473" is read-only. Mutations are blocked.');
    assert.ok(parsed.hint.includes('jsn auth switch'));
  });

  it('writes human text to stderr by default (non-JSON)', () => {
    const r = guardError(
      {},
      { code: 'read_only', message: 'Profile "dev198473" is read-only. Mutations are blocked.', hint: 'Switch first' }
    );
    assert.strictEqual(r.stream, 'stderr');
    assert.ok(r.text.startsWith('Error: Profile "dev198473" is read-only.'));
    assert.ok(r.text.includes('Switch first'));
  });

  it('omits the hint line when hint is empty', () => {
    const r = guardError({}, { code: 'usage', message: 'No instance configured.' });
    assert.strictEqual(r.stream, 'stderr');
    assert.strictEqual(r.text, 'Error: No instance configured.\n');
  });
});
