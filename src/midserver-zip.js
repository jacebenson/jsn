import fs from 'node:fs';
import path from 'node:path';
import { createInflateRaw } from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAX_EXPANDED = 2 * 1024 * 1024 * 1024;
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function read(fd, size, offset) {
  const result = Buffer.alloc(size);
  if (fs.readSync(fd, result, 0, size, offset) !== size) throw new Error('Truncated ZIP');
  return result;
}

// Inspect every entry before extracting anything. ZIP64, split ZIPs, links and
// Windows aliases are deliberately unsupported, not delegated to a shell tool.
export function inspectMidZip(archive) {
  const fd = fs.openSync(archive, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 22) throw new Error('Invalid ZIP');
    const tail = read(fd, Math.min(size, 65557), size - Math.min(size, 65557));
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
    }
    if (end < 0) throw new Error('Missing ZIP directory');
    const count = tail.readUInt16LE(end + 10), directorySize = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
    if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || tail.readUInt16LE(end + 8) !== count || count === 65535 || count > 20000 || directorySize > 16 * 1024 * 1024 || offset + directorySize > size - (tail.length - end)) throw new Error('Unsupported ZIP directory');
    const directory = read(fd, directorySize, offset);
    const entries = [], names = new Map();
    let pos = 0, expanded = 0;
    for (let i = 0; i < count; i++) {
      if (pos + 46 > directory.length || directory.readUInt32LE(pos) !== 0x02014b50) throw new Error('Invalid ZIP entry');
      const flags = directory.readUInt16LE(pos + 8), method = directory.readUInt16LE(pos + 10);
      const compressedSize = directory.readUInt32LE(pos + 20), uncompressedSize = directory.readUInt32LE(pos + 24);
      const nameLength = directory.readUInt16LE(pos + 28), extraLength = directory.readUInt16LE(pos + 30), commentLength = directory.readUInt16LE(pos + 32);
      if (pos + 46 + nameLength + extraLength + commentLength > directory.length) throw new Error('Truncated ZIP entry');
      const name = directory.subarray(pos + 46, pos + 46 + nameLength).toString('utf8');
      const mode = directory.readUInt32LE(pos + 38) >>> 16;
      const localOffset = directory.readUInt32LE(pos + 42);
      const folder = name.endsWith('/');
      const parts = name.replace(/\/$/, '').split('/');
      if (!['agent', 'META-INF'].includes(parts[0]) || parts.some(part => !part || part === '.' || part === '..' || /[\\:<>"|?*]/.test(part) || [...part].some(char => char.codePointAt(0) < 32) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Unsafe ZIP path');
      const type = mode & 0o170000;
      if (type && type !== 0o100000 && type !== 0o040000) throw new Error('ZIP links and special files are forbidden');
      if ((flags & 1) || ![0, 8].includes(method) || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error('Unsupported ZIP encoding');
      expanded += uncompressedSize;
      if (expanded > MAX_EXPANDED) throw new Error('ZIP exceeds 2 GiB expanded limit');
      const key = parts.join('/').toLowerCase();
      if (names.has(key)) throw new Error('Duplicate ZIP path');
      names.set(key, folder);
      const header = read(fd, 30, localOffset);
      if (header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(8) !== method || header.readUInt16LE(6) !== flags) throw new Error('ZIP header mismatch');
      const localName = read(fd, header.readUInt16LE(26), localOffset + 30).toString('utf8');
      if (localName !== name) throw new Error('ZIP path mismatch');
      const dataOffset = localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      if (dataOffset + compressedSize > offset) throw new Error('Invalid ZIP data range');
      entries.push({ name, folder, mode, method, compressedSize, uncompressedSize, dataOffset, crc: directory.readUInt32LE(pos + 16) });
      pos += 46 + nameLength + extraLength + commentLength;
    }
    if (pos !== directory.length) throw new Error('Unexpected ZIP directory data');
    for (const entry of entries) {
      const parts = entry.name.replace(/\/$/, '').toLowerCase().split('/');
      for (let i = 1; i < parts.length; i++) if (names.get(parts.slice(0, i).join('/')) === false) throw new Error('ZIP file/directory collision');
    }
    return entries;
  } finally { fs.closeSync(fd); }
}

function privateDirectory(directory) {
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const st = fs.lstatSync(directory);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Unsafe ZIP destination directory');
}

export async function extractMidZip(archive, destination, entries = inspectMidZip(archive)) {
  privateDirectory(destination);
  for (const entry of entries) {
    const parts = entry.name.replace(/\/$/, '').split('/');
    let parent = destination;
    for (const part of parts.slice(0, entry.folder ? parts.length : -1)) {
      parent = path.join(parent, part);
      privateDirectory(parent);
    }
    const filename = path.join(destination, ...parts);
    if (entry.folder) continue;
    let size = 0, crc = 0xffffffff;
    const verify = new Transform({ transform(chunk, _, callback) {
      size += chunk.length;
      if (size > entry.uncompressedSize) return callback(new Error('ZIP expanded size mismatch'));
      for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
      callback(null, chunk);
    } });
    const output = fs.createWriteStream(filename, { flags: 'wx', mode: entry.mode & 0o111 ? 0o700 : 0o600 });
    if (!entry.compressedSize) { output.end(); await new Promise((resolve, reject) => { output.on('close', resolve); output.on('error', reject); }); }
    else {
      const input = fs.createReadStream(archive, { start: entry.dataOffset, end: entry.dataOffset + entry.compressedSize - 1 });
      if (entry.method === 8) await pipeline(input, createInflateRaw(), verify, output);
      else await pipeline(input, verify, output);
    }
    if (size !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) throw new Error('ZIP integrity check failed');
  }
}
