// Path-alias policy: macOS ships /var -> /private/var, so ordinary temporary and
// install paths traverse an Apple-owned symlink. The guards must keep rejecting
// user-created aliases while accepting that layout, or `jsn docs`, MID installs
// and credential storage stop working on a Mac.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalizeSafeAliases, isSafeAncestorAlias } from '../src/path-safety.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-path-safety-'));
const link = path.join(dir, 'alias');
const userOwned = path.join(dir, 'own-dir');
fs.mkdirSync(userOwned, { mode: 0o755 });
fs.symlinkSync(userOwned, link);
const posix = process.platform !== 'win32';

test('a root-owned, non-writable directory alias is safe', { skip: !posix }, () => {
  // /private/var exists only on macOS; /usr is root-owned and 0755 everywhere.
  const target = fs.existsSync('/usr') ? '/usr' : null;
  if (!target) return;
  const stat = fs.statSync(target);
  const alias = path.join(dir, 'root-owned-alias');
  fs.symlinkSync(target, alias);
  const safe = stat.uid === 0 && (stat.mode & 0o022) === 0;
  assert.equal(isSafeAncestorAlias(alias), safe);
});

test('a user-created alias is not safe', { skip: !posix }, () => {
  assert.equal(isSafeAncestorAlias(link), false, 'a link into a user directory must keep failing');
});

test('the helper answers about aliases, not about plain directories', { skip: !posix }, () => {
  // Callers only ask when the component IS a symlink; a plain user-owned
  // directory is not an alias, so the answer is false rather than "safe".
  assert.equal(isSafeAncestorAlias(userOwned), false);
});

test('canonicalizeSafeAliases resolves only allowed ancestors', { skip: !posix }, () => {
  if (!fs.existsSync('/usr')) return;
  const stat = fs.statSync('/usr');
  if (!(stat.uid === 0 && (stat.mode & 0o022) === 0)) return; // not a root-owned /usr
  const alias = path.join(dir, 'root-owned-alias-2');
  fs.symlinkSync('/usr', alias);
  assert.equal(canonicalizeSafeAliases(`${alias}/local`), fs.realpathSync('/usr') + '/local');
  // A user alias stays untouched, so the caller's strict comparison still fails.
  assert.equal(canonicalizeSafeAliases(`${link}/nested`), `${link}/nested`);
});

test('missing components leave the path unchanged', { skip: !posix }, () => {
  const missing = path.join(dir, 'does-not-exist', 'nested');
  assert.equal(canonicalizeSafeAliases(missing), missing);
});
