// Synthetic Windows Credential Manager backend for tests. Never touches a real
// keyring, PowerShell host, or the operator's Credential Manager.
//
// Two uses:
//   1. `node --import <this file> ...` with JSN_TEST_WIN32_FIXTURE=1 — installs
//      the win32 platform branch and the native fixture in that child process.
//   2. `installWin32CredentialFixture()` from an in-process test (after the
//      test sets process.platform itself).
//
// The store is a 0600 JSON file named by JSN_TEST_SECURE_STORE, keyed by the
// full `servicenow-cli:<key>` target windows-credential-store.js builds.
// JSN_TEST_SECURE_FAIL selects a failure mode:
//   fail-read | fail-write        -> synthetic native failure (throws)
//   readback-mismatch             -> writes succeed, reads return '{}'
//   malformed                     -> reads return a non-JSON secure value
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { resetWindowsCredentialCache } from '../../src/auth/windows-credential-store.js';

const original = childProcess.execFileSync;

function storePath() {
  const file = process.env.JSN_TEST_SECURE_STORE;
  if (!file) throw new Error('JSN_TEST_SECURE_STORE is required for the win32 credential fixture');
  return file;
}

function readEntries() {
  const file = storePath();
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

function writeEntries(entries) {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(entries), { mode: 0o600 });
}

export function seedSecureEntry(key, credentials) {
  const entries = readEntries();
  entries[`servicenow-cli:${key}`] = typeof credentials === 'string' ? credentials : JSON.stringify(credentials);
  writeEntries(entries);
}

export function readSecureEntries() {
  return readEntries();
}

export function installWin32CredentialFixture() {
  resetWindowsCredentialCache();
  childProcess.execFileSync = function fixture(command, args, options = {}) {
    const name = String(command).split(/[\\/]/).at(-1).toLowerCase();
    if (name !== 'powershell.exe' && name !== 'pwsh.exe') return original.call(this, command, args, options);
    const request = JSON.parse(options.input);
    const mode = process.env.JSN_TEST_SECURE_FAIL || '';
    if (mode === 'fail-read' && ['read', 'read_many'].includes(request.operation)) throw new Error('synthetic win32 read failure');
    if (mode === 'fail-write' && request.operation === 'write') throw new Error('synthetic win32 write failure');
    const entries = readEntries();
    if (mode === 'legacy-unreadable' && (request.operation === 'read_many'
      || request.operation === 'read' && !Object.hasOwn(entries, request.target))) {
      throw new Error('synthetic unreadable legacy target');
    }
    if (request.operation === 'read_many') {
      return JSON.stringify({ status: 'ok', values: request.targets.map(target => ({
        target, value: !Object.hasOwn(entries, target) ? null
          : mode === 'malformed' ? '{not-json'
            : mode === 'readback-mismatch' ? '{}' : entries[target],
      })) });
    }
    if (request.operation === 'read') {
      if (!Object.hasOwn(entries, request.target)) return JSON.stringify({ status: 'missing' });
      if (mode === 'malformed') return JSON.stringify({ status: 'ok', value: '{not-json' });
      const value = mode === 'readback-mismatch' ? '{}' : entries[request.target];
      return JSON.stringify({ status: 'ok', value });
    }
    if (request.operation === 'write') {
      entries[request.target] = request.value;
      writeEntries(entries);
      return JSON.stringify({ status: 'ok' });
    }
    if (request.operation === 'delete') {
      delete entries[request.target];
      writeEntries(entries);
      return JSON.stringify({ status: 'ok' });
    }
    return JSON.stringify({ status: 'error', reason: 'native' });
  };
  syncBuiltinESMExports();
}

export function restoreWin32CredentialFixture() {
  childProcess.execFileSync = original;
  syncBuiltinESMExports();
}

// Preload behaviour: opt-in so importing this helper from an in-process test
// never changes the host platform behind the test's back.
if (process.env.JSN_TEST_WIN32_FIXTURE === '1') {
  if (process.platform !== 'win32') {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  }
  installWin32CredentialFixture();
  if (process.env.JSN_TEST_HTTP_COUNT) {
    const counter = process.env.JSN_TEST_HTTP_COUNT;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (...fetchArgs) => {
      const target = fetchArgs[0] instanceof URL ? fetchArgs[0].href : fetchArgs[0]?.url || String(fetchArgs[0]);
      fs.appendFileSync(counter, `${target}\n`);
      return realFetch(...fetchArgs);
    };
  }
}
