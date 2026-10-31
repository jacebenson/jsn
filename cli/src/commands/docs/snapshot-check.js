// Detached read-only freshness worker. Never replaces the installed index.
import fs from 'node:fs';
import { fetchManifest } from './snapshot.js';
const dbPath = process.argv[2];
try {
  const receipt = JSON.parse(fs.readFileSync(`${dbPath}.snapshot.json`, 'utf8'));
  const manifest = await fetchManifest(receipt.manifestURL, { fetchFn: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(5000) }) });
  const filename = `${dbPath}.available.json`;
  fs.writeFileSync(`${filename}.${process.pid}.tmp`, JSON.stringify({ revision: manifest.revision, installed: receipt.revision, checkedAt: Date.now() }));
  fs.renameSync(`${filename}.${process.pid}.tmp`, filename);
} catch { /* Offline and interrupted freshness checks leave the local index intact. */ }
