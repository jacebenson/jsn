// Shared capability boundary for tests that need a real POSIX pseudo-terminal.
//
// cli/test/pty/pty_driver.py imports Python's `pty`/`fcntl`, which do not exist
// on Windows, so POSIX PTY integration is unsupported on win32 by definition.
// Windows keeps the cross-platform Node prompt/unit/non-TTY coverage; only the
// 23 real-PTY cases are gated, and they are reported as explicit skips rather
// than passing Windows PTY coverage. Windows hosted behavior is UNVERIFIED.
//
// The platform and Python status are injectable so the boundary itself is
// testable on any host (see test/pty-capability.test.js).

import { spawnSync } from 'node:child_process';

let pythonStatusCache;

/** Exit status of `python3 --version`, or a non-zero value when absent. */
export function pythonAvailable() {
  if (pythonStatusCache === undefined) {
    const result = spawnSync('python3', ['--version'], { encoding: 'utf8' });
    pythonStatusCache = result.error ? 1 : (result.status ?? 1);
  }
  return pythonStatusCache;
}

/**
 * Can this host run the POSIX PTY integration suite?
 *
 * @param {object} [options]
 * @param {string} [options.platform] — process.platform value to evaluate
 * @param {number} [options.pythonStatus] — exit status of `python3 --version`
 * @returns {{supported: boolean, reason: string|false}}
 */
export function ptyCapability({ platform = process.platform, pythonStatus = pythonAvailable() } = {}) {
  if (platform === 'win32') {
    return {
      supported: false,
      reason: 'POSIX PTY integration is unsupported on win32: python3 cannot import pty/fcntl; '
        + 'Node prompt/unit/non-TTY coverage still runs',
    };
  }
  if (pythonStatus !== 0) {
    return { supported: false, reason: 'POSIX PTY tests need python3 on PATH' };
  }
  return { supported: true, reason: false };
}

/**
 * Value for a node:test `{ skip }` option: `false` runs the case, a string
 * records an explicit skip. Returns `false`, never null/undefined, because
 * node:test treats the mere presence of the key as "skip".
 *
 * @param {string} [platform]
 * @param {number} [pythonStatus]
 * @returns {string|false}
 */
export function ptySkipReason(platform = process.platform, pythonStatus = pythonAvailable()) {
  return ptyCapability({ platform, pythonStatus }).reason;
}
