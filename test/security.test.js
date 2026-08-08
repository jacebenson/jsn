import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('sanitizeKeyPart', () => {
  let sanitizeKeyPart;

  it('preserves existing keyring key format (backward compat)', async () => {
    ({ sanitizeKeyPart } = await import('../src/auth.js'));
    // The exact encoding the Go version uses — must NOT change, or stored
    // credentials become unreachable.
    assert.strictEqual(
      sanitizeKeyPart('https://dev437538.service-now.com'),
      'https_dev437538.service-now.com'
    );
  });

  it('strips shell metacharacters (issue #143 finding #2)', async () => {
    ({ sanitizeKeyPart } = await import('../src/auth.js'));
    const out = sanitizeKeyPart('https://foo.com"; touch /tmp/pwned #');
    // The whitelist only keeps [a-zA-Z0-9._-]; shell-active chars and
    // spaces must all be gone, so the value can't break out of a shell arg.
    assert.ok(!/["'$`;()\s]/.test(out), `still contains shell metachars: ${out}`);
  });

  it('strips backslashes (issue #143 finding #3 — Windows path traversal)', async () => {
    ({ sanitizeKeyPart } = await import('../src/auth.js'));
    const out = sanitizeKeyPart('https://foo.com\\..\\..\\..\\evil');
    // No path separators (forward OR backslash) survive, so `..` can
    // never act as a traversal component in path.join on any platform.
    assert.ok(!/[\\/]/.test(out), `path separator survived: ${out}`);
  });

  it('keeps dots and dashes for real instance hosts', async () => {
    ({ sanitizeKeyPart } = await import('../src/auth.js'));
    assert.strictEqual(
      sanitizeKeyPart('https://dev-437538.service-now.com'),
      'https_dev-437538.service-now.com'
    );
  });
});

describe('assertSafeExactMatch', () => {
  let assertSafeExactMatch;

  it('allows normal identifiers', async () => {
    ({ assertSafeExactMatch } = await import('../src/helpers.js'));
    assert.doesNotThrow(() => assertSafeExactMatch('INC0010001'));
    assert.doesNotThrow(() => assertSafeExactMatch('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e'));
    assert.doesNotThrow(() => assertSafeExactMatch('My_Script-Include.v2'));
  });

  it('rejects ^ (ServiceNow query AND separator)', async () => {
    ({ assertSafeExactMatch } = await import('../src/helpers.js'));
    assert.throws(() => assertSafeExactMatch('INC001^state=1'), /Unsafe identifier/);
    assert.throws(() => assertSafeExactMatch('INC001^ORnumber=INC002'), /Unsafe identifier/);
  });

  it('rejects other query operators and IN-list commas', async () => {
    ({ assertSafeExactMatch } = await import('../src/helpers.js'));
    assert.throws(() => assertSafeExactMatch('x=1'), /Unsafe identifier/);
    assert.throws(() => assertSafeExactMatch('a<b'), /Unsafe identifier/);
    assert.throws(() => assertSafeExactMatch('a>b'), /Unsafe identifier/);
    assert.throws(() => assertSafeExactMatch('a~b'), /Unsafe identifier/);
    assert.throws(() => assertSafeExactMatch('a!b'), /Unsafe identifier/);
    assert.throws(() => assertSafeExactMatch('a,b'), /Unsafe identifier/);
  });

  it('allows empty/undefined values (callers decide what empty means)', async () => {
    ({ assertSafeExactMatch } = await import('../src/helpers.js'));
    assert.doesNotThrow(() => assertSafeExactMatch(''));
    assert.doesNotThrow(() => assertSafeExactMatch(undefined));
  });
});
