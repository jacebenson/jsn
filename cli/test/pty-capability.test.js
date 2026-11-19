// The POSIX PTY boundary is declared once (test/support/pty-capability.js) and
// proven here on every platform, including Windows where the boundary matters.
// These assertions run with an injected platform, so they never need a PTY.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ptyCapability, ptySkipReason } from './support/pty-capability.js';

test('win32 declares POSIX PTY unsupported and explains the skip', () => {
  const capability = ptyCapability({ platform: 'win32', pythonStatus: 0 });
  assert.equal(capability.supported, false);
  assert.match(capability.reason, /POSIX/);
  assert.match(capability.reason, /win32/);
  assert.equal(ptySkipReason('win32', 0), capability.reason);
});

test('linux with python3 keeps the full POSIX PTY suite active', () => {
  assert.deepEqual(ptyCapability({ platform: 'linux', pythonStatus: 0 }), { supported: true, reason: false });
  assert.equal(ptySkipReason('linux', 0), false);
});

test('linux without python3 reports the missing prerequisite', () => {
  const capability = ptyCapability({ platform: 'linux', pythonStatus: 127 });
  assert.equal(capability.supported, false);
  assert.match(capability.reason, /python3/);
  assert.equal(typeof ptySkipReason('linux', 127), 'string');
});
