// Holographic Reduced Representations (HRR) — phase-vector encoding.
//
// Pure-JS port of Hermes' plugins/memory/holographic/holographic.py.
// A concept is a fixed-width vector of phases in [0, 2π). Tokens become
// deterministic phase vectors (SHA-256 -> uint16 -> angle); a text is the
// "bundle" (circular mean) of its token vectors. Similarity is mean(cos(a-b)).

import { createHash } from 'node:crypto';

const TWO_PI = 2 * Math.PI;
export const DEFAULT_DIM = 512;

export function encodeAtom(word, dim = DEFAULT_DIM) {
  const valuesPerBlock = 16;
  const blocks = Math.ceil(dim / valuesPerBlock);
  const phases = new Float64Array(dim);
  let idx = 0;
  for (let i = 0; i < blocks && idx < dim; i++) {
    const digest = createHash('sha256').update(`${word}:${i}`).digest();
    for (let j = 0; j < 32 && idx < dim; j += 2) {
      const v = digest.readUInt16LE(j);
      phases[idx++] = v * (TWO_PI / 65536);
    }
  }
  return phases;
}

export function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^[.,!?;:"'()[\]{}]+|[.,!?;:"'()[\]{}]+$/g, ''))
    .filter(Boolean);
}

export function bundle(vectors, dim = DEFAULT_DIM) {
  const re = new Float64Array(dim);
  const im = new Float64Array(dim);
  for (const v of vectors) {
    for (let k = 0; k < dim; k++) {
      re[k] += Math.cos(v[k]);
      im[k] += Math.sin(v[k]);
    }
  }
  const out = new Float64Array(dim);
  for (let k = 0; k < dim; k++) {
    let a = Math.atan2(im[k], re[k]);
    if (a < 0) a += TWO_PI;
    out[k] = a;
  }
  return out;
}

export function encodeText(text, dim = DEFAULT_DIM) {
  const tokens = tokenize(text);
  if (tokens.length === 0) return encodeAtom('__hrr_empty__', dim);
  return bundle(tokens.map((t) => encodeAtom(t, dim)), dim);
}

export function similarity(a, b) {
  const dim = a.length;
  let sum = 0;
  for (let k = 0; k < dim; k++) sum += Math.cos(a[k] - b[k]);
  return sum / dim;
}

export function phasesToBytes(phases) {
  const buf = Buffer.allocUnsafe(phases.length * 2);
  for (let k = 0; k < phases.length; k++) {
    let q = Math.round((phases[k] / TWO_PI) * 65536) % 65536;
    if (q < 0) q += 65536;
    buf.writeUInt16LE(q, k * 2);
  }
  return buf;
}

export function bytesToPhases(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const dim = buf.byteLength / 2;
  const phases = new Float64Array(dim);
  for (let k = 0; k < dim; k++) {
    phases[k] = view.getUint16(k * 2, true) * (TWO_PI / 65536);
  }
  return phases;
}

export function docSurface(title, body, maxBodyTokens = 40) {
  const headings = (body || '')
    .split('\n')
    .filter((l) => /^#{1,6}\s/.test(l))
    .map((l) => l.replace(/^#{1,6}\s+/, ''))
    .join(' ');
  const bodyStart = tokenize(body).slice(0, maxBodyTokens).join(' ');
  return [title || '', headings, bodyStart].filter(Boolean).join(' ');
}
