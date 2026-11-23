// Five-minute metadata cache, isolated by instance + profile + authenticated
// principal + table. Only fully observed metadata is persisted; denied,
// unavailable and incomplete reads are never cached as fact.
//
// The cache is a latency tradeoff, not authorization: an ACL or schema change
// inside the TTL is not reflected, so every diagnostic says so.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cacheDir } from './config.js';

export const DEFAULT_TTL_MS = 300_000;
const VERSION = 1;
const TABLE = /^[a-zA-Z0-9_]+$/;

const digest = value => crypto.createHash('sha256').update(value).digest('hex');

export function identityKey(identity = {}, table = '') {
  return digest([identity.instance || '', identity.profile || '', identity.principal || '', table].join('\n'));
}

function validIdentity(identity) {
  return Boolean(identity && identity.instance && identity.principal && identity.principal !== 'guest');
}

function validPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.state !== 'observed') return false;
  if (!Array.isArray(payload.hierarchy) || !payload.hierarchy.length || !payload.hierarchy.every(name => TABLE.test(name))) return false;
  if (!payload.fields || typeof payload.fields !== 'object') return false;
  for (const [owner, fields] of Object.entries(payload.fields)) {
    if (!TABLE.test(owner) || !fields || typeof fields !== 'object') return false;
    for (const [element, definition] of Object.entries(fields)) {
      if (!TABLE.test(element) || !definition || typeof definition !== 'object') return false;
      if (typeof definition.type !== 'string') return false;
      if (typeof definition.reference !== 'string') return false;
    }
  }
  return true;
}

/**
 * @param {{identity:{instance:string,profile:string,principal:string},
 *   ttlMs?:number, dir?:string}} options
 */
export function createQueryMetadataCache({ identity = {}, ttlMs = DEFAULT_TTL_MS, dir = '' } = {}) {
  const memory = new Map();
  const persist = validIdentity(identity);
  const root = dir || path.join(cacheDir(), 'query-metadata');
  const keyFor = table => identityKey(identity, table);
  const fileFor = key => path.join(root, `${key}.json`);

  function readFile(table) {
    if (!persist) return null;
    const key = keyFor(table);
    const file = fileFor(key);
    try {
      const stat = fs.statSync(file);
      if ((stat.mode & 0o077) !== 0) return null; // foreign permissions: refuse
      const entry = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (!entry || entry.version !== VERSION || entry.key !== key) return null;
      if (entry.instance !== identity.instance || entry.profile !== (identity.profile || '')
        || entry.principal !== identity.principal || entry.table !== table) return null;
      if (!Number.isSafeInteger(entry.fetched_at) || Date.now() - entry.fetched_at > ttlMs) return null;
      if (!validPayload(entry.payload)) return null;
      return { payload: entry.payload, fetched_at: entry.fetched_at };
    } catch {
      return null;
    }
  }

  function writeFile(table, payload) {
    if (!persist || !validPayload(payload)) return;
    const key = keyFor(table);
    const file = fileFor(key);
    const temp = path.join(root, `.${key}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    try {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      const body = JSON.stringify({
        version: VERSION, key,
        instance: identity.instance, profile: identity.profile || '',
        principal: identity.principal, table, fetched_at: Date.now(), payload,
      });
      fs.writeFileSync(temp, body, { mode: 0o600 });
      fs.renameSync(temp, file);
    } catch {
      try { fs.unlinkSync(temp); } catch { /* best effort */ }
    }
  }

  return {
    identity,
    persistent: persist,
    get(table) {
      const hit = memory.get(table);
      if (hit && Date.now() - hit.fetched_at <= ttlMs) return hit;
      if (hit) memory.delete(table);
      const disk = readFile(table);
      if (disk) memory.set(table, disk);
      return disk;
    },
    set(table, payload) {
      const entry = { payload, fetched_at: Date.now() };
      memory.set(table, entry);
      writeFile(table, payload);
      return entry;
    },
    /** Explicit refresh: forget this table before the next read. */
    refresh(table) { memory.delete(table); if (persist) { try { fs.unlinkSync(fileFor(keyFor(table))); } catch { /* absent */ } } },
    /**
     * Invalidate entries affected by a table/field mutation. When the affected
     * scope is uncertain, clearing this identity's cache is the safe choice.
     */
    invalidate({ tables = [], all = false } = {}) {
      const affected = new Set(tables.filter(Boolean));
      memory.clear();
      if (!persist) return { removed: 0 };
      let removed = 0;
      let entries = [];
      try { entries = fs.readdirSync(root); } catch { return { removed: 0 }; }
      for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(root, name);
        let entry;
        try { entry = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { continue; }
        const related = entry?.hierarchy || [];
        const references = Object.values(entry?.payload?.fields || {}).flatMap(fields =>
          Object.values(fields || {}).map(definition => definition?.reference).filter(Boolean));
        const touch = all || !affected.size
          || affected.has(entry.table) || related.some(name => affected.has(name))
          || references.some(name => affected.has(name));
        if (!touch) continue;
        try { fs.unlinkSync(file); removed++; } catch { /* best effort */ }
      }
      return { removed };
    },
  };
}

export { digest as queryCacheDigest };
