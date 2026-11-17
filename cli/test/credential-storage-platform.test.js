import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { privateStateDirectories } from '../src/auth/credential-store.js';
import { savePKCEState, loadPKCEState, removePKCEState } from '../src/auth/oauth.js';

for (const [dir, expected] of [
  ['C:\\Users\\fixture\\config\\pkce', ['C:\\Users', 'C:\\Users\\fixture', 'C:\\Users\\fixture\\config', 'C:\\Users\\fixture\\config\\pkce']],
  ['\\\\server\\share\\config\\pkce', ['\\\\server\\share\\config', '\\\\server\\share\\config\\pkce']],
  ['\\\\?\\C:\\config\\pkce', ['\\\\?\\C:\\config', '\\\\?\\C:\\config\\pkce']],
]) test(`Windows storage traversal excludes the parsed root: ${dir}`, () => {
  assert.deepEqual(privateStateDirectories(dir, path.win32), expected);
});
test('POSIX traversal excludes root without losing a component', () => {
  assert.deepEqual(privateStateDirectories('/home/fixture/pkce', path.posix), ['/home', '/home/fixture', '/home/fixture/pkce']);
});

test('Windows policy preserves PKCE IO without pretending mode bits validate ACLs', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jsn-platform-storage-'));
  const previous = process.env.XDG_CONFIG_HOME;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    process.env.XDG_CONFIG_HOME = root;
    // Execute the policy branch on POSIX too; actual Win32 IO still needs CI.
    Object.defineProperty(process, 'platform', { value: 'win32' });
    savePKCEState('https://synthetic.invalid', { state: 'synthetic-state' }, 'fixture');
    const dir = path.join(root, 'servicenow/pkce');
    const file = path.join(dir, fs.readdirSync(dir)[0]);
    if (platform.value !== 'win32') { fs.chmodSync(dir, 0o755); fs.chmodSync(file, 0o644); }
    assert.equal(loadPKCEState('https://synthetic.invalid', 'fixture').state, 'synthetic-state');
    savePKCEState('https://synthetic.invalid', { state: 'replacement' }, 'fixture');
    fs.linkSync(file, path.join(root, 'hardlink'));
    assert.throws(() => loadPKCEState('https://synthetic.invalid', 'fixture'), /Unsafe credential\/PKCE path/);
    fs.unlinkSync(path.join(root, 'hardlink'));
    removePKCEState('https://synthetic.invalid', 'fixture');
    assert.equal(loadPKCEState('https://synthetic.invalid', 'fixture'), null);
    fs.rmdirSync(dir);
    fs.symlinkSync(root, dir, process.platform === 'win32' && platform.value === 'win32' ? 'junction' : 'dir');
    assert.throws(() => savePKCEState('https://synthetic.invalid', {}, 'fixture'), /Unsafe credential\/PKCE path/);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
