// Setup and login used to ask every question and finish the network login
// before finding out the host cannot store a credential. These tests pin the
// two halves of the fix: a real store/readback probe, and one decision made
// before the first question.

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const storePath = path.join(root, 'src/auth/credential-store.js');
const linux = process.platform === 'linux';
// The libsecret/secret-tool expectations are Linux-only: Windows has Credential
// Manager and macOS has the Keychain, each with their own probe and guidance.
const posix = linux;

/** Run a snippet in a child so PATH/env experiments cannot leak into the suite. */
function inChild(source, env = {}) {
  const script = `const m = await import(${JSON.stringify(new URL(`file://${storePath}`).href)});\n${source}`;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 30000,
  });
}

// Minimal secret-tool stand-in: a JSON file keyed by the last argument (the
// credential key), which is what the real store writes, looks up and clears.
const SHIM = `#!/usr/bin/env python3
import json, sys
DB = __DB__
cmd, args = sys.argv[1], sys.argv[2:]
key = args[-1] if args else ''
data = json.load(open(DB))
if cmd == 'store':
    data[key] = sys.stdin.read()
    json.dump(data, open(DB, 'w'))
elif cmd == 'lookup':
    sys.stdout.write(data.get(key, ''))
elif cmd == 'clear':
    data.pop(key, None)
    json.dump(data, open(DB, 'w'))
`;

function shimDirectory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-secret-tool-'));
  const store = path.join(dir, 'store.json');
  fs.writeFileSync(store, '{}');
  fs.writeFileSync(path.join(dir, 'secret-tool'), SHIM.replace('__DB__', JSON.stringify(store)), { mode: 0o755 });
  return { dir, store };
}

it('reports a missing secret-tool with the platform repair command', { skip: !posix }, () => {
  const out = inChild('console.log(JSON.stringify(m.credentialStorageStatus()));',
    { PATH: '/nonexistent', JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE: '' });
  const status = JSON.parse(out);
  assert.equal(status.available, false);
  assert.equal(status.reason, 'secret_tool_missing');
  assert.match(status.repair.install, /libsecret|secret/i);
  assert.ok(status.repair.notes.some(note => /headless/i.test(note)));
});

it('proves a working keyring with a store/readback round trip and clears the probe', { skip: !posix }, () => {
  const { dir, store } = shimDirectory();
  const out = inChild('console.log(JSON.stringify(m.credentialStorageStatus()));',
    { PATH: `${dir}:/usr/bin:/bin` });
  const status = JSON.parse(out);
  assert.equal(status.available, true, out);
  assert.equal(status.repair, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(store, 'utf8')), {}, 'the probe key must be removed');
  fs.rmSync(dir, { recursive: true, force: true });
});

it('reports plaintext as explicitly allowed only when the environment says so', { skip: !posix }, () => {
  const allowed = JSON.parse(inChild('console.log(JSON.stringify(m.credentialStorageStatus()));',
    { PATH: '/nonexistent', JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE: '1' }));
  assert.equal(allowed.plaintext_allowed, true);
});

describe('ensureCredentialStorage', () => {
  // Registered once: node:test cannot re-mock an already-mocked module.
  mock.module('../src/helpers.js', { namedExports: { canUsePicker: app => !!app.interactive } });
  const loaded = import('../src/auth/credential-storage-setup.js');
  const ensure = async () => (await loaded).ensureCredentialStorage;

  const unavailable = () => ({ available: false, platform: 'linux', reason: 'secret_tool_missing', plaintext_allowed: false,
    repair: { install: 'sudo apt-get install -y libsecret-tools gnome-keyring', notes: ['secret-tool is not on PATH.'], distro: 'debian' } });

  it('fails before any question or request when it cannot prompt', async () => {
    let asked = false;
    await assert.rejects(
      (await ensure())({ interactive: false }, {}, {
        status: unavailable,
        ask: async () => { asked = true; return 'cancel'; },
      }),
      error => {
        assert.equal(error.code, 'auth_error');
        assert.match(error.hint, /sudo apt-get install -y libsecret-tools gnome-keyring/);
        assert.match(error.hint, /JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE to 1/);
        return true;
      },
    );
    assert.equal(asked, false, 'a non-interactive host must not be prompted');
  });

  it('cancelling stores nothing', async () => {
    await assert.rejects(
      (await ensure())({ interactive: true }, {}, { interactive: true, status: unavailable, ask: async () => 'cancel' }),
      { name: 'PromptCancelled' },
    );
  });

  it('repairs the store and re-checks before continuing', async () => {
    let checks = 0;
    const ran = [];
    const result = await (await ensure())({ interactive: true }, {}, { interactive: true,
      status: () => (++checks === 1 ? unavailable() : { available: true, platform: 'linux', plaintext_allowed: false }),
      run: (command, args) => { ran.push([command, ...args].join(' ')); return { status: 0 }; },
      ask: async () => 'install',
      out: { write: () => {} },
    });
    assert.equal(result.available, true);
    assert.deepEqual(ran, ['sudo apt-get install -y libsecret-tools gnome-keyring']);
    assert.equal(checks, 2);
  });

  it('offers the plaintext export and only edits the shell profile when confirmed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-rc-'));
    const profilePath = path.join(dir, '.bashrc');
    const env = {};
    const printed = [];
    const base = { status: unavailable, ask: async () => 'plaintext', out: { write: text => printed.push(text) }, env, profilePath };

    const declined = await (await ensure())({ interactive: true }, {}, { interactive: true, ...base, askConfirm: async () => false });
    assert.equal(env.JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE, '1');
    assert.equal(declined.plaintext_allowed, true);
    assert.equal(fs.existsSync(profilePath), false, 'declining must not touch the shell profile');
    assert.ok(printed.join('').includes('export JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE=1'));

    const accepted = await (await ensure())({ interactive: true }, {}, { interactive: true, ...base, askConfirm: async () => true });
    assert.equal(accepted.plaintext_allowed, true);
    const written = fs.readFileSync(profilePath, 'utf8');
    assert.match(written, /# jsn: plaintext credential storage for this account/);
    assert.match(written, /export JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE=1/);
    // Idempotent: a second run must not append a duplicate block.
    await (await ensure())({ interactive: true }, {}, { interactive: true, ...base, askConfirm: async () => true });
    assert.equal(fs.readFileSync(profilePath, 'utf8').match(/jsn: plaintext/g).length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
