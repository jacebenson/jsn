// A minimal, deterministic ZIP writer (no dependency).
//
// Only what the app package backend needs: deflated entries, no encryption, no
// ZIP64, no data descriptors. Sizes and CRCs are known before the header is
// written, so nothing is back-patched and the byte layout is fixed.
//
// Determinism is a contract, not a convenience: every field is a pure function
// of the entry list and the injected clock (`now`). Two builds of an unchanged
// project with the same clock produce identical bytes, so an artifact can be
// compared, cached or signed by its hash. The clock reaches only the DOS
// modification timestamp — no "current time" is read inside this module.
//
// Names are written exactly as given. The app package backend deliberately
// uses absolute-looking entry names ("/scope/sys_app_<id>.xml"), matching the
// archives now-sdk produces, so this writer must never normalize a name.
//
// ZIP64 is refused rather than silently truncated: a >4 GiB entry or >65535
// entries is a scale problem this writer does not claim to solve.

import { deflateRawSync } from 'node:zlib';
import { AppError } from './errors.js';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const END_OF_CENTRAL_SIZE = 22;
const VERSION_NEEDED = 20; // 2.0: deflate is understood by every reader we target
const VERSION_MADE_BY = 20; // MS-DOS host, spec 2.0 — a fixed, portable value
const DEFLATE = 8;
const UTF8_NAME_FLAG = 0x0800;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;

/** The POSIX `crc32` polynomial, table-driven. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/**
 * The CRC-32 of a byte sequence, as an unsigned 32-bit integer.
 *
 * @param {Buffer|Uint8Array|string} input
 * @returns {number}
 */
export function crc32(input) {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A DOS date/time pair, in UTC, derived from the injected clock.
 *
 * The format can only represent 1980–2107, so the year is clamped instead of
 * wrapping into a nonsensical stamp. UTC is used rather than local time so the
 * same clock and entries give the same bytes on any machine.
 *
 * @param {Date|string|number} [clock]
 * @returns {{date: number, time: number}}
 */
export function dosTimestamp(clock = new Date()) {
  const value = clock instanceof Date ? clock : new Date(clock);
  if (Number.isNaN(value.getTime())) {
    throw new AppError('writer_error', `Cannot timestamp a zip from an invalid clock (${String(clock)})`,
      'The build clock must be a valid Date. This is a jsn defect, not a project problem. Nothing was written.');
  }
  const year = Math.min(Math.max(value.getUTCFullYear(), 1980), 2107);
  const date = ((year - 1980) << 9) | ((value.getUTCMonth() + 1) << 5) | value.getUTCDate();
  const time = (value.getUTCHours() << 11) | (value.getUTCMinutes() << 5) | (value.getUTCSeconds() >> 1);
  return { date: date & 0xffff, time: time & 0xffff };
}

/** A zip name is UTF-8 flagged only when it actually needs the flag. */
function needsUtf8Flag(nameBytes) {
  return nameBytes.some(byte => byte > 0x7f);
}

function writerError(message) {
  return new AppError('writer_error', message,
    'This is a jsn defect, not a project problem. Nothing was written.');
}

/** Validate the entry list before a single byte is produced. */
function checkEntries(entries) {
  if (!Array.isArray(entries)) throw writerError('Zip entries must be an array');
  if (entries.length > MAX_UINT16) {
    throw writerError(`Zip would hold ${entries.length} entries; the format allows ${MAX_UINT16}`);
  }
  const seen = new Set();
  return entries.map((entry) => {
    if (!entry || typeof entry.name !== 'string' || entry.name === '') {
      throw writerError('Every zip entry needs a non-empty name');
    }
    if (seen.has(entry.name)) throw writerError(`Duplicate zip entry name: ${entry.name}`);
    seen.add(entry.name);
    const bytes = Buffer.isBuffer(entry.bytes) ? entry.bytes : Buffer.from(entry.bytes ?? '');
    if (bytes.length > MAX_UINT32) {
      throw writerError(`Zip entry ${entry.name} is ${bytes.length} bytes; the format allows ${MAX_UINT32}`);
    }
    return { name: entry.name, bytes };
  });
}

/**
 * Serialize entries into a ZIP archive.
 *
 * @param {Array<{name: string, bytes: Buffer|string}>} entries — written in the
 *   given order, with names verbatim (a leading slash is preserved).
 * @param {{now?: Date, level?: number}} [options] — `now` is the only clock
 *   source; `level` is the deflate level (fixed by default for determinism).
 * @returns {Buffer}
 */
export function writeZip(entries, { now = new Date(), level = 9 } = {}) {
  const checked = checkEntries(entries);
  const { date, time } = dosTimestamp(now);

  const local = [];
  const central = [];
  let offset = 0;

  for (const entry of checked) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const body = entry.bytes;
    const checksum = crc32(body);
    const compressed = deflateRawSync(body, { level });
    const flags = needsUtf8Flag(nameBytes) ? UTF8_NAME_FLAG : 0;

    const header = Buffer.alloc(LOCAL_HEADER_SIZE);
    header.writeUInt32LE(LOCAL_HEADER, 0);
    header.writeUInt16LE(VERSION_NEEDED, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(DEFLATE, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28); // no extra field
    local.push(header, nameBytes, compressed);

    const record = Buffer.alloc(CENTRAL_HEADER_SIZE);
    record.writeUInt32LE(CENTRAL_HEADER, 0);
    record.writeUInt16LE(VERSION_MADE_BY, 4);
    record.writeUInt16LE(VERSION_NEEDED, 6);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(DEFLATE, 10);
    record.writeUInt16LE(time, 12);
    record.writeUInt16LE(date, 14);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(body.length, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt16LE(0, 30); // no extra field
    record.writeUInt16LE(0, 32); // no comment
    record.writeUInt16LE(0, 34); // first disk
    record.writeUInt16LE(0, 36); // internal attributes
    record.writeUInt32LE(0, 38); // external attributes — permissions are not claimed
    record.writeUInt32LE(offset, 42);
    central.push(record, nameBytes);

    offset += LOCAL_HEADER_SIZE + nameBytes.length + compressed.length;
  }

  if (offset > MAX_UINT32) {
    throw writerError(`Zip would be ${offset} bytes; the format allows ${MAX_UINT32} without ZIP64`);
  }

  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(END_OF_CENTRAL_SIZE);
  end.writeUInt32LE(END_OF_CENTRAL, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the central directory
  end.writeUInt16LE(checked.length, 8);
  end.writeUInt16LE(checked.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // no archive comment

  return Buffer.concat([...local, centralBytes, end]);
}
