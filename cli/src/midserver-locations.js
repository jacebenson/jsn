import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { validateMidInstallDirectory } from './midserver-setup.js';
import { midInstallDirectory, normalizeMidName } from './midserver-install.js';

function identity(instanceURL, name, target = '') {
  return { instanceURL: new URL(instanceURL).origin, name: normalizeMidName(name), target };
}
function locationFile(key, homeDirectory) {
  const hash = createHash('sha256').update(JSON.stringify(key)).digest('hex');
  return path.join(homeDirectory, '.servicenow', 'mid-locations', `${hash}.json`);
}
function privatePath(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid()))) throw new Error('MID location registry must be private, owned and not a symlink');
  return stat;
}
// Discovery only: callers MUST still run runtime-specific ownership verification.
export function resolveMidInstallationDirectory(instanceURL, name, { directory, target = '', homeDirectory = os.homedir() } = {}) {
  if (directory) return directory;
  const key = identity(instanceURL, name, target), file = locationFile(key, homeDirectory);
  try { fs.lstatSync(file); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return midInstallDirectory(instanceURL, name, homeDirectory);
  }
  validateMidInstallDirectory(path.join(path.dirname(file), 'read-entry'));
  privatePath(path.dirname(file));
  if (!privatePath(file).isFile()) throw new Error('Invalid MID location registry file');
  const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (entry.version !== 1 || Object.keys(key).some(k => entry[k] !== key[k]) || !path.isAbsolute(entry.directory)) throw new Error('MID location registry identity mismatch');
  return entry.directory;
}
export function assertMidInstallationLocationAvailable(instanceURL, name, directory, { target = '', homeDirectory = os.homedir() } = {}) {
  const key = identity(instanceURL, name, target), file = locationFile(key, homeDirectory);
  validateMidInstallDirectory(path.join(path.dirname(file), 'new-entry'));
  try { fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const existing = resolveMidInstallationDirectory(instanceURL, name, { target, homeDirectory });
  if (existing !== directory) throw new Error('MID location already registered elsewhere; inspect the owned installation before changing its location');
}
export function registerMidInstallationDirectory(instanceURL, name, directory, { target = '', homeDirectory = os.homedir() } = {}) {
  if (!path.isAbsolute(directory)) throw new Error('MID registry requires an absolute directory');
  assertMidInstallationLocationAvailable(instanceURL, name, directory, { target, homeDirectory });
  const key = identity(instanceURL, name, target), file = locationFile(key, homeDirectory);
  const parent = path.dirname(file);
  validateMidInstallDirectory(path.join(parent, 'new-entry'));
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  privatePath(parent);
  const entry = { version: 1, ...key, directory };
  if (fs.existsSync(file)) return entry; // Existing identical mapping was verified above.
  // Exclusive creation prevents concurrent setup from replacing another location.
  fs.writeFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600, flag: 'wx' });
  return entry;
}
export function forgetMidInstallationDirectory(instanceURL, name, { target = '', homeDirectory = os.homedir() } = {}) {
  const key = identity(instanceURL, name, target), file = locationFile(key, homeDirectory);
  // Read and validate identity and permissions before unlinking; never removes runtime files.
  const resolved = resolveMidInstallationDirectory(instanceURL, name, { target, homeDirectory });
  if (resolved === midInstallDirectory(instanceURL, name, homeDirectory) && !fs.existsSync(file)) return;
  fs.unlinkSync(file);
}
