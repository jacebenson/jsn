// Protocol 1 handoff helpers for the browser-extension side of #302.
//
// Deliberately pure: no chrome.* calls, no network, no storage. The receiver in
// `jsn` must re-validate every field, because an extension is untrusted input
// from the CLI's point of view. These helpers exist so the extension can fail
// early with a readable message, and so the wire contract is executable and
// testable without a browser.
//
// See docs/browser-extension-auth-design.md for the design and threat model.

export const HANDOFF_PROTOCOL = 1;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
// Same character class the CLI accepts for cookie names (cli/src/browser-auth.js).
const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;
// Crockford-ish alphabet: no I, L, O, or U, so a code cannot be misread.
const PAIRING_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PAIRING_LENGTH = 8;

export class HandoffError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HandoffError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new HandoffError(code, message);
}

/**
 * Accept a bare origin and return it normalised, or throw.
 *
 * Mirrors the CLI's rule that a profile stores an origin and never a page, API
 * route, query, or fragment (cli/src/config.js normalizeInstanceURL), and the
 * loopback-only rule used for debugging endpoints.
 */
export function parseInstanceOrigin(value) {
  const text = String(value ?? '').trim();
  if (!text) fail('invalid_origin', 'An instance URL is required.');
  let url;
  try {
    url = new URL(text);
  } catch {
    fail('invalid_origin', 'The instance URL is not a valid URL.');
  }
  if (url.username || url.password) fail('invalid_origin', 'The instance URL must not contain credentials.');
  if (url.search || url.hash) fail('invalid_origin', 'The instance URL must not contain a query or fragment.');
  if (url.pathname !== '/' && url.pathname !== '') {
    fail('invalid_origin', 'Select the instance origin, for example https://dev12345.service-now.com.');
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    fail('invalid_origin', 'Only https origins are accepted, except loopback development instances.');
  }
  return url.origin;
}

/** True when the value is a bare, capturable origin. Never throws. */
export function isCapturableOrigin(value) {
  try {
    parseInstanceOrigin(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalise a pairing code copied out of a terminal: case-insensitive, and
 * tolerates spaces or dashes. Returns the compact 8-character form.
 */
export function normalizePairingCode(input) {
  const compact = String(input ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (compact.length !== PAIRING_LENGTH || ![...compact].every(char => PAIRING_ALPHABET.includes(char))) {
    fail('invalid_pairing_code', 'The pairing code is 8 characters, for example 7F3K-2Q9D.');
  }
  return compact;
}

/** Render a compact code the way the CLI prints it. */
export function formatPairingCode(code) {
  const compact = normalizePairingCode(code);
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

/**
 * Compare two pairing codes without an early exit. The code is short-lived and
 * single-use, so this is defence in depth rather than the primary control.
 */
export function pairingCodesMatch(expected, supplied) {
  let left;
  let right;
  try {
    left = normalizePairingCode(expected);
    right = normalizePairingCode(supplied);
  } catch {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < PAIRING_LENGTH; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/** Reject CR/LF and semicolons, which would break or split the Cookie header. */
export function validateCookieHeader(cookies) {
  const text = String(cookies ?? '');
  if (!text) fail('invalid_cookies', 'No cookies were captured for this instance.');
  if (/[\r\n]/.test(text)) fail('invalid_cookies', 'Cookies contain invalid control characters.');
  for (const pair of text.split(';')) {
    const entry = pair.trim();
    if (!entry) continue;
    const separator = entry.indexOf('=');
    if (separator < 1) fail('invalid_cookies', 'Cookies are not in name=value form.');
    const name = entry.slice(0, separator);
    if (!COOKIE_NAME.test(name)) fail('invalid_cookies', `Cookie name is invalid: ${name}`);
  }
  return text;
}

/** Reject a token that cannot be sent as a header value. */
export function validateToken(token) {
  const text = String(token ?? '');
  if (!text) fail('invalid_token', 'No user token was captured for this instance.');
  if (/[\r\n]/.test(text)) fail('invalid_token', 'The user token contains invalid control characters.');
  return text;
}

/**
 * Build the protocol 1 payload posted to the loopback receiver.
 *
 * Field names are part of the contract: `protocol`, `instance`, `token`,
 * `cookies`, `pairing_code`. The receiver rejects anything with a different
 * protocol, a different instance than the pending login, or invalid token and
 * cookie values.
 */
export function buildHandoffPayload({ instance, token, cookies, pairingCode } = {}) {
  return Object.freeze({
    protocol: HANDOFF_PROTOCOL,
    instance: parseInstanceOrigin(instance),
    token: validateToken(token),
    cookies: validateCookieHeader(cookies),
    pairing_code: normalizePairingCode(pairingCode),
  });
}

/**
 * Validate a payload received from an extension. Returns the accepted payload
 * shape or throws a HandoffError with a stable code. Kept here so the extension
 * and the CLI can be tested against one description of the contract.
 */
export function parseHandoffPayload(value, { instance } = {}) {
  if (!value || typeof value !== 'object') fail('invalid_payload', 'The handoff payload is not an object.');
  if (value.protocol !== HANDOFF_PROTOCOL) {
    fail('unsupported_protocol', `This build expects extension protocol ${HANDOFF_PROTOCOL}.`);
  }
  const origin = parseInstanceOrigin(value.instance);
  if (instance !== undefined && origin !== parseInstanceOrigin(instance)) {
    fail('instance_mismatch', 'The capture is for a different instance than this login.');
  }
  return Object.freeze({
    protocol: HANDOFF_PROTOCOL,
    instance: origin,
    token: validateToken(value.token),
    cookies: validateCookieHeader(value.cookies),
    pairing_code: normalizePairingCode(value.pairing_code),
  });
}
