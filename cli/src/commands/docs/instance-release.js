// Which documentation family a docs command searches when none is named:
// the connected instance's (from glide.war), else the newest the docs have.
import fs from 'node:fs';
import path from 'node:path';
import { cacheDir } from '../../config.js';
import { CodeNetwork } from '../../errors.js';
import { listHostedReleases, configuredDocsService } from './client.js';
import { DEFAULT_DOCS_RELEASE, resolveDocsRelease } from './db.js';
import { listDocsReleases } from './releases.js';

const DAY = 24 * 3600_000;
const FAMILY = /^[a-z0-9-]{1,40}$/;

// glide-brazil-08-25-2026__patch2-...zip names the brazil family.
export function familyFromWar(war) {
  return /^glide-([a-z]+)-/.exec(typeof war === 'string' ? war : '')?.[1] ?? null;
}

// Families come round in letter order (zurich, australia, brazil), so the
// newest is the one just before the widest gap in that circle.
export function newestFamily(families) {
  const sorted = [...new Set(families)].sort();
  const letter = family => family.charCodeAt(0) - 97;
  let newest = sorted[0] ?? null, widest = -1;
  sorted.forEach((family, i) => {
    const gap = (letter(sorted[(i + 1) % sorted.length]) - letter(family) + 26) % 26;
    if (gap > widest) [newest, widest] = [family, gap];
  });
  return newest;
}

// shortcut: a timeout or lost connection is not kept, so an unreachable instance is asked again
// on the next search (each try bounded by 5 s); keep those too if that proves slow.
async function daily(key, now, load) {
  const file = path.join(cacheDir(), 'docs-release-v1.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; } };
  const hit = read()[key];
  if (hit && now - Date.parse(hit.checkedAt) < DAY) return hit.value;
  const value = await load();
  if (value == null) return null;
  // Read again: the other lookup in this search may have written while this one waited.
  const cache = { ...read(), [key]: { value, checkedAt: new Date(now).toISOString() } };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(cache) + '\n', { mode: 0o600 });
    fs.renameSync(`${file}.${process.pid}.tmp`, file);
  } catch { /* an unwritable cache only means asking again next time */ }
  return value;
}

async function availableFamilies(config, now) {
  if (!process.env.JSN_DOCS_URL && config.docs?.source === 'local') return listDocsReleases().map(row => row.release);
  const serviceUrl = configuredDocsService(config);
  const families = await daily(`service ${serviceUrl}`, now, () => listHostedReleases({ serviceUrl }).then(list => list.length ? list : null, () => null));
  return Array.isArray(families) ? families : [DEFAULT_DOCS_RELEASE];
}

async function instanceFamily(app, now) {
  const { instance, username, profile } = app.session || {};
  if (!instance) return null;
  // Kept per profile, so an account that cannot read glide.war is not asked again all day.
  const family = await daily(`instance ${instance} ${username || ''}`, now, async () => {
    // No auth recovery, no prompt (sign-in or MFA code), and 5 s for each step including a login.
    const sdk = Object.assign(app.getSDKForProfile(instance, { username, authMethod: profile?.auth_method, profile }), { canInteract: () => false, timeout: 5000 });
    const rows = await sdk.listStrict('sys_properties', { sysparm_query: 'name=glide.war', sysparm_fields: 'value', sysparm_limit: '1' })
      // fetch reports a refused, unresolved or redirected connection as a bare TypeError.
      .catch(error => error?.code === CodeNetwork || error instanceof TypeError ? null : []);
    // '' keeps an answer with no family (refused, empty or unrecognised) for the day.
    return rows && (familyFromWar(rows[0]?.value) ?? '');
  });
  return typeof family === 'string' && FAMILY.test(family) ? family : null;
}

export async function chooseDocsRelease(argv, app, { now = Date.now() } = {}) {
  const config = app.config || {};
  if (argv.release != null) return { release: resolveDocsRelease(argv.release, config), source: 'flag' };
  if (config.docs?.release != null) return { release: resolveDocsRelease(undefined, config), source: 'config' };
  const [family, families] = await Promise.all([instanceFamily(app, now), availableFamilies(config, now)]);
  const served = families.filter(value => typeof value === 'string' && FAMILY.test(value));
  if (family && served.includes(family)) return { release: family, source: 'instance', note: "the instance's release" };
  const why = family ? `the instance runs ${family}` : app.session?.instance ? "could not read the instance's release" : 'no instance profile';
  return { release: newestFamily(served) ?? DEFAULT_DOCS_RELEASE, source: 'fallback', note: `${why}; newest available` };
}
