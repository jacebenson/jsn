import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config.js';
import { defaultCredentialStore } from '../../src/auth/credential-store.js';

const preload = new URL(import.meta.url);
preload.search = '?loopback-credential-fixture=1';
export const loopbackCredentialArgs = Object.freeze(['--import', preload.href]);

// Opt in only in the explicitly constructed child environment. Never install
// this through suite-wide NODE_OPTIONS, including native credential tests.
export function loopbackFixtureEnv(overrides) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(SN_|SERVICENOW_|JSN_)/i.test(key) && key.toUpperCase() !== 'NODE_OPTIONS'));
  return { ...env, ...overrides, JSN_LOOPBACK_CREDENTIAL_FIXTURE: '1' };
}

function refuse() {
  // SDK intentionally catches bookkeeping exceptions. Preserve a failed child
  // outcome even if a later store call is accidentally aimed outside loopback.
  process.exitCode = 1;
  throw new Error('Refusing unscoped loopback credential fixture');
}
function assertLoopback(instance) {
  let url;
  try { url = new URL(instance); } catch { refuse(); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) refuse();
}

if (new URL(import.meta.url).searchParams.get('loopback-credential-fixture') === '1') {
  const binary = fileURLToPath(new URL('../../bin/jsn.js', import.meta.url));
  if (!process.argv[1] || path.resolve(process.argv[1]) !== binary ||
      process.env.JSN_LOOPBACK_CREDENTIAL_FIXTURE !== '1' || process.env.SN_USERNAME !== 'fixture' ||
      !['fixture-secret', 'synthetic-fixture-only', 'fixture'].includes(process.env.SN_PASSWORD)) refuse();
  // Validate isolated paths BEFORE loadConfig could consult personal settings.
  const home = process.env.HOME;
  // macOS reports cwd as /private/var/... while HOME keeps the /var/... spelling,
  // so compare the resolved paths rather than the strings.
  const real = (value) => { try { return fs.realpathSync(value); } catch { return path.resolve(value); } };
  if (!home || real(home) !== real(process.cwd())) refuse();
  for (const key of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'JSN_DATA_HOME']) {
    const relative = path.relative(home, process.env[key] || '');
    if (!process.env[key] || relative.startsWith('..') || path.isAbsolute(relative)) refuse();
  }
  const config = loadConfig();
  if (config.instanceURL) assertLoopback(config.instanceURL);
  for (const profile of Object.values(config.profiles || {})) if (profile.instance_url) assertLoopback(profile.instance_url);
  for (let index = 2; index < process.argv.length; index++) {
    const arg = process.argv[index];
    if (arg === '--instance' || arg === '-i') assertLoopback(process.argv[++index]);
    else if (arg.startsWith('--instance=')) assertLoopback(arg.slice('--instance='.length));
  }
  // Safety boundary, not a simulated HTTP transport. Allowed Requests and
  // responses, including real Basic/session bootstrap, pass through unchanged.
  const fetch = globalThis.fetch;
  globalThis.fetch = (input, ...options) => {
    assertLoopback(typeof input === 'string' || input instanceof URL ? input : input.url);
    return fetch(input, ...options);
  };
  defaultCredentialStore.load = instance => { assertLoopback(instance); return null; };
  defaultCredentialStore.save = defaultCredentialStore.delete = refuse;
}
