// Tests for safety-guard error formatting (mutation middleware in cli.js)
// guardError is a pure function; guardExit writes + exits.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { guardError, renderAppError, CodeUsage } from '../src/errors.js';

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

  it('prefers app.output.effectiveFormat() over argv.format when an App is present', () => {
    // The unified resolution: an App on argv wins (wrap() used
    // effectiveFormat; guardError used argv.format — they diverged).
    const fakeApp = { output: { effectiveFormat: () => 'json' } };
    const r = guardError(
      { app: fakeApp, format: 'styled' },
      { code: 'read_only', message: 'blocked', hint: '' }
    );
    assert.strictEqual(r.stream, 'stdout');
    assert.strictEqual(JSON.parse(r.text).code, 'read_only');
  });
});

describe('renderAppError (unified renderer)', () => {
  const usageErr = { code: CodeUsage, message: 'bad args' };

  it('usage class exits 2 on stderr with the (usage) tag — for both spellings', () => {
    const a = renderAppError(usageErr);
    assert.strictEqual(a.stream, 'stderr');
    assert.strictEqual(a.exitCode, 2);
    assert.strictEqual(a.text, 'Error (usage): bad args\n');
    // legacy literal 'usage' renders identically
    const b = renderAppError({ code: 'usage', message: 'bad args' });
    assert.deepStrictEqual(b, a);
  });

  it('not_found exits 1 with identifier hint when provided', () => {
    const r = renderAppError(
      { code: 'not_found', message: 'incident not found: INC999' },
      { identifier: 'INC999' }
    );
    assert.strictEqual(r.stream, 'stderr');
    assert.strictEqual(r.exitCode, 1);
    assert.ok(r.text.includes('Error (not_found): incident not found: INC999'));
    assert.ok(r.text.includes('The identifier "INC999" was not found'));
  });

  it('not_found omits the hint when no identifier is available', () => {
    const r = renderAppError({ code: 'not_found', message: 'nope' });
    assert.strictEqual(r.text, 'Error (not_found): nope\n');
  });

  it('system_error exits 3', () => {
    const r = renderAppError({ code: 'system_error', message: 'boom' });
    assert.strictEqual(r.exitCode, 3);
    assert.strictEqual(r.text, 'Error (system): boom\n');
  });

  it('confirmation_required renders the JSON envelope via app.err in json mode', () => {
    const fakeApp = { output: { effectiveFormat: () => 'json' }, err: () => {} };
    const r = renderAppError(
      { code: 'confirmation_required', message: 'confirm?', hint: 're-run with --force' },
      { app: fakeApp }
    );
    assert.strictEqual(r.appErr, true);
    assert.strictEqual(r.stream, 'stdout');
    assert.strictEqual(r.exitCode, 1);
  });

  it('confirmation_required renders human text + hint to stderr otherwise', () => {
    const r = renderAppError(
      { code: 'confirmation_required', message: 'confirm?', hint: 're-run with --force' },
      {}
    );
    assert.strictEqual(r.stream, 'stderr');
    assert.strictEqual(r.exitCode, 1);
    assert.strictEqual(r.text, 'Error: confirm?\n\nre-run with --force\n');
  });

  it('unknown codes exit 1 with a plain Error line', () => {
    const r = renderAppError({ code: 'weird', message: 'wat' });
    assert.deepStrictEqual(r, { stream: 'stderr', text: 'Error: wat\n', exitCode: 1 });
  });

  it('codeless errors render as the default class', () => {
    const r = renderAppError(new Error('plain'));
    assert.deepStrictEqual(r, { stream: 'stderr', text: 'Error: plain\n', exitCode: 1 });
  });
});
