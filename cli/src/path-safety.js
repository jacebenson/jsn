/**
 * Path-alias policy shared by the guards that must reject aliases.
 *
 * macOS ships `/var -> /private/var`, so every ordinary temporary path
 * (`/var/folders/...`) and many install roots traverse an Apple-owned symlink.
 * Rejecting every symlinked component made those paths unusable; accepting
 * every symlinked component would let a user-created alias redirect a secret or
 * an install root.
 *
 * The rule here is narrow: an *ancestor* alias is acceptable only when it
 * resolves to a directory owned by root and not writable by group or others.
 * Apple's `/var` qualifies; a link in someone's home does not. Leaf components
 * (the secret directory, the credential file, the docs root, the install
 * destination) are still checked strictly by their callers.
 */
import fs from 'node:fs';

export function isSafeAncestorAlias(component) {
  let real;
  try { real = fs.realpathSync(component); } catch { return false; }
  let stat;
  try { stat = fs.statSync(real); } catch { return false; }
  if (!stat.isDirectory()) return false;
  if (process.platform === 'win32') return false;
  if (typeof process.getuid === 'function' && stat.uid !== 0) return false;
  return (stat.mode & 0o022) === 0;
}

/** The canonical path after resolving only the ancestor aliases allowed above. */
export function canonicalizeSafeAliases(absolute) {
  const parts = absolute.split(/[\\/]+/).filter(Boolean);
  let current = absolute.startsWith('/') ? '/' : '';
  for (const part of parts) {
    current = current === '/' ? `/${part}` : (current ? `${current}/${part}` : part);
    let stat;
    try { stat = fs.lstatSync(current); } catch { return absolute; }
    if (!stat.isSymbolicLink()) continue;
    if (!isSafeAncestorAlias(current)) return absolute;
    current = fs.realpathSync(current);
  }
  return current;
}
