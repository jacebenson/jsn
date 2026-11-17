import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { savePKCEState, loadPKCEState } from '../src/auth/oauth.js';

// Config accepts relative XDG paths; they must not bypass leaf-mode checks.
test('relative config paths enforce the same private PKCE directory contract', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jsn-relative-storage-'));
  const cwd = process.cwd();
  const previous = process.env.XDG_CONFIG_HOME;
  try {
    process.chdir(root);
    process.env.XDG_CONFIG_HOME = 'relative-config';
    savePKCEState('https://synthetic.invalid', { state: 'synthetic-private-state' }, 'fixture');
    const directory = path.join(root, 'relative-config/servicenow/pkce');
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    const filename = path.join(directory, fs.readdirSync(directory)[0]);
    const original = fs.readFileSync(filename);
    fs.chmodSync(directory, 0o755);
    assert.throws(() => loadPKCEState('https://synthetic.invalid', 'fixture'), /Unsafe credential\/PKCE path/);
    assert.throws(() => savePKCEState('https://synthetic.invalid', { state: 'replacement' }, 'fixture'), /Unsafe credential\/PKCE path/);
    assert.deepEqual(fs.readFileSync(filename), original);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o755);
  } finally {
    process.chdir(cwd);
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
