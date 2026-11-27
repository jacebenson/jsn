// Task-owned synthetic backend for subprocess/PTY tests. Never use a host keyring.
import fs from 'node:fs';
import path from 'node:path';

// Explicit Node preload, not a PATH-dependent executable. Works for both
// secret-tool and the static PowerShell stdin protocol in CLI subprocesses.
export const credentialFixtureArgs = Object.freeze(['--import', new URL('./credential-process-fixture.js', import.meta.url).href]);

export function fakeKeyringEnv(directory) {
  const bin = path.join(directory, 'fake-keyring-bin');
  const store = path.join(directory, 'fake-keyring.json');
  fs.mkdirSync(bin, { mode: 0o700 });
  // The fixture may live inside a clone whose root declares type: module.
  fs.writeFileSync(path.join(bin, 'package.json'), '{"type":"commonjs"}', { mode: 0o600 });
  fs.writeFileSync(path.join(bin, 'secret-tool'), `#!${process.execPath}
const fs = require('node:fs');
const file = ${JSON.stringify(store)};
const command = process.argv[2];
const key = process.argv.at(-1);
const entries = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
if (command === 'lookup') {
  if (!Object.hasOwn(entries, key)) process.exit(1);
  process.stdout.write(JSON.stringify(entries[key]));
} else if (command === 'store') {
  entries[key] = JSON.parse(fs.readFileSync(0, 'utf8'));
  fs.writeFileSync(file, JSON.stringify(entries), { mode: 0o600 });
} else if (command === 'clear') {
  delete entries[key];
  fs.writeFileSync(file, JSON.stringify(entries), { mode: 0o600 });
} else process.exit(1);
`, { mode: 0o700 });
  // macOS Keychain stand-in: same JSON file, the arguments /usr/bin/security
  // takes. Production resolves the real binary by absolute path, so the suite
  // points the documented override at this shim instead of PATH.
  fs.writeFileSync(path.join(bin, 'security'), `#!${process.execPath}
const fs = require('node:fs');
const file = ${JSON.stringify(store)};
const entries = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const command = process.argv[2];
const flag = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
};
const account = flag('-a');
if (command === 'add-generic-password') {
  entries[account] = flag('-w');
  fs.writeFileSync(file, JSON.stringify(entries), { mode: 0o600 });
} else if (command === 'find-generic-password') {
  if (!Object.hasOwn(entries, account)) process.exit(44);
  process.stdout.write(entries[account]);
} else if (command === 'delete-generic-password') {
  if (!Object.hasOwn(entries, account)) process.exit(44);
  delete entries[account];
  fs.writeFileSync(file, JSON.stringify(entries), { mode: 0o600 });
} else process.exit(1);
`, { mode: 0o700 });
  return { HOME: directory, PATH: bin, JSN_TEST_KEYRING_FILE: store, JSN_SECURITY_BIN: path.join(bin, 'security'),
    JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE: '0' };
}

export const PLAINTEXT_WARNING = 'Warning: plaintext credential storage explicitly enabled for this process; credentials are portable and backups can expose them.\n';
