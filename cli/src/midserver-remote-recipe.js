import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMidRecipeUrl } from './midserver-install.js';
import { inspectMidZip, extractMidZip } from './midserver-zip.js';

const LIMIT = 64 * 1024 * 1024;
export function recipeTar(directory) {
  const chunks = [];
  let total = 0;
  function add(folder, prefix = '') {
    for (const name of fs.readdirSync(folder).sort()) {
      const filename = path.join(folder, name), relative = prefix + name, stat = fs.lstatSync(filename);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('Recipe contains a link or special file');
      if (stat.isDirectory()) { add(filename, `${relative}/`); continue; }
      const split = relative.lastIndexOf('/');
      const leaf = Buffer.byteLength(relative) <= 100 ? relative : relative.slice(split + 1);
      const parent = Buffer.byteLength(relative) <= 100 ? '' : relative.slice(0, split);
      if (Buffer.byteLength(leaf) > 100 || Buffer.byteLength(parent) > 155 || split < 0 && Buffer.byteLength(relative) > 100) throw new Error('Recipe path exceeds tar limits');
      total += stat.size; if (total > LIMIT) throw new Error('MID recipe exceeds 64 MiB');
      const header = Buffer.alloc(512);
      const write = (value, offset, length) => header.write(String(value), offset, length, 'utf8');
      const octal = (value, offset, length) => write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
      write(leaf, 0, 100); octal(stat.mode & 0o111 ? 0o755 : 0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
      octal(stat.size, 124, 12); octal(0, 136, 12); header.fill(32, 148, 156); write('0', 156, 1); write('ustar\0', 257, 6); write('00', 263, 2); write(parent, 345, 155);
      const checksum = header.reduce((sum, byte) => sum + byte, 0); write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
      chunks.push(header, fs.readFileSync(filename), Buffer.alloc((512 - stat.size % 512) % 512));
    }
  }
  add(directory); chunks.push(Buffer.alloc(1024)); return Buffer.concat(chunks);
}

export async function downloadRemoteMidRecipe(releaseName, { fetchImpl = fetch } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-mid-recipe-'));
  try {
    const response = await fetchImpl(buildMidRecipeUrl(releaseName), { redirect: 'error', signal: AbortSignal.timeout(300000) });
    if (!response.ok || !response.body) throw new Error(`MID recipe download failed (HTTP ${response.status})`);
    const archive = path.join(directory, 'recipe.zip'), fd = fs.openSync(archive, 'wx', 0o600); let bytes = 0;
    try { for await (const chunk of response.body) { bytes += chunk.length; if (bytes > LIMIT) throw new Error('MID recipe download exceeds 64 MiB'); fs.writeSync(fd, chunk); } } finally { fs.closeSync(fd); }
    const entries = inspectMidZip(archive, { allowedRoots: null });
    if (entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0) > LIMIT) throw new Error('Expanded MID recipe exceeds 64 MiB');
    const recipe = path.join(directory, 'recipe'); await extractMidZip(archive, recipe, entries);
    // Distribution archives can wrap the Dockerfile in one enclosing directory.
    const candidates = [];
    function find(folder) { for (const name of fs.readdirSync(folder)) { const file = path.join(folder, name); if (fs.statSync(file).isDirectory()) find(file); else if (name === 'Dockerfile') candidates.push(path.dirname(file)); } }
    find(recipe); if (candidates.length !== 1) throw new Error('Official recipe must contain exactly one Dockerfile');
    return recipeTar(candidates[0]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
