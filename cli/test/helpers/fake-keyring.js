// Task-owned synthetic backend for subprocess/PTY tests. Never use a host keyring.
import fs from 'node:fs';
import path from 'node:path';

export function fakeKeyringEnv(directory) {
  const bin = path.join(directory, 'fake-keyring-bin');
  const store = path.join(directory, 'fake-keyring.json');
  fs.mkdirSync(bin, { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'secret-tool'), `#!${process.execPath}
const fs = require('node:fs');
const file = process.env.JSN_TEST_KEYRING_FILE;
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
  return { HOME: directory, PATH: bin, JSN_TEST_KEYRING_FILE: store, JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE: '0' };
}

export const PLAINTEXT_WARNING = 'Warning: plaintext credential storage explicitly enabled for this process; credentials are portable and backups can expose them.\n';
