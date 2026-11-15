// Protocol 1 contract tests for the potential browser-extension handoff (#302).
//
// The helpers live under extensions/browser-auth/ and are intentionally free of
// chrome.* calls, so the contract can be exercised without a browser. The
// extension itself is not implemented in this branch; see
// docs/browser-extension-auth-design.md.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  HANDOFF_PROTOCOL,
  buildHandoffPayload,
  formatPairingCode,
  isCapturableOrigin,
  normalizePairingCode,
  pairingCodesMatch,
  parseHandoffPayload,
  parseInstanceOrigin,
  validateCookieHeader,
  validateToken,
} from '../../extensions/browser-auth/lib/handoff.js';

const CODE = '7F3K2Q9D';
const ORIGIN = 'https://dev12345.service-now.com';

function code(fn) {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return null;
}

describe('handoff origin rules', () => {
  it('accepts a bare https origin and normalises it', () => {
    assert.equal(parseInstanceOrigin('https://dev12345.service-now.com'), ORIGIN);
    assert.equal(parseInstanceOrigin('  https://dev12345.service-now.com/  '), ORIGIN);
  });

  it('accepts loopback http for development instances', () => {
    assert.equal(parseInstanceOrigin('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
    assert.equal(parseInstanceOrigin('http://localhost:8080'), 'http://localhost:8080');
  });

  it('rejects plain http for a hosted instance', () => {
    assert.equal(code(() => parseInstanceOrigin('http://dev12345.service-now.com')), 'invalid_origin');
  });

  it('rejects paths, queries, fragments, and credentials', () => {
    assert.equal(code(() => parseInstanceOrigin(`${ORIGIN}/nav/page/incident_list.do`)), 'invalid_origin');
    assert.equal(code(() => parseInstanceOrigin(`${ORIGIN}/?foo=bar`)), 'invalid_origin');
    assert.equal(code(() => parseInstanceOrigin(`${ORIGIN}/#x`)), 'invalid_origin');
    assert.equal(code(() => parseInstanceOrigin('https://user:pass@dev12345.service-now.com')), 'invalid_origin');
  });

  it('rejects empty and non-URL values', () => {
    assert.equal(code(() => parseInstanceOrigin('')), 'invalid_origin');
    assert.equal(code(() => parseInstanceOrigin('not a url')), 'invalid_origin');
  });

  it('exposes a non-throwing predicate', () => {
    assert.equal(isCapturableOrigin(ORIGIN), true);
    assert.equal(isCapturableOrigin('chrome://settings'), false);
    assert.equal(isCapturableOrigin('file:///etc/hosts'), false);
    assert.equal(isCapturableOrigin('http://10.0.0.5'), false);
  });
});

describe('pairing codes', () => {
  it('normalises case, spaces, and dashes', () => {
    assert.equal(normalizePairingCode('7f3k-2q9d'), CODE);
    assert.equal(normalizePairingCode(' 7F3K 2Q9D '), CODE);
    assert.equal(formatPairingCode(CODE), '7F3K-2Q9D');
  });

  it('rejects the wrong length or an ambiguous character', () => {
    assert.equal(code(() => normalizePairingCode('7F3K2Q9')), 'invalid_pairing_code');
    assert.equal(code(() => normalizePairingCode('7F3K2Q9DD')), 'invalid_pairing_code');
    assert.equal(code(() => normalizePairingCode('7F3K2Q9I')), 'invalid_pairing_code');
    assert.equal(code(() => normalizePairingCode('7F3K2Q9O')), 'invalid_pairing_code');
  });

  it('compares without throwing on malformed input', () => {
    assert.equal(pairingCodesMatch(CODE, '7f3k-2q9d'), true);
    assert.equal(pairingCodesMatch(CODE, '7F3K2Q9E'), false);
    assert.equal(pairingCodesMatch(CODE, 'short'), false);
    assert.equal(pairingCodesMatch(CODE, undefined), false);
  });
});

describe('credential shape checks', () => {
  it('accepts a normal cookie header', () => {
    const cookies = 'JSESSIONID=abc123; glide_user=admin; BIGipServerpool=1.2.3.4.443';
    assert.equal(validateCookieHeader(cookies), cookies);
  });

  it('rejects cookie injection and malformed pairs', () => {
    assert.equal(code(() => validateCookieHeader('a=b\r\nX-Evil: 1')), 'invalid_cookies');
    assert.equal(code(() => validateCookieHeader('=no-name')), 'invalid_cookies');
    assert.equal(code(() => validateCookieHeader('novalue')), 'invalid_cookies');
    assert.equal(code(() => validateCookieHeader('')), 'invalid_cookies');
  });

  it('rejects a token that would break the header', () => {
    assert.equal(validateToken('abc.def'), 'abc.def');
    assert.equal(code(() => validateToken('abc\r\nx')), 'invalid_token');
    assert.equal(code(() => validateToken('')), 'invalid_token');
  });
});

describe('protocol 1 payload', () => {
  const payload = {
    instance: ORIGIN,
    token: 'token-value',
    cookies: 'JSESSIONID=abc123; glide_user=admin',
    pairingCode: '7f3k-2q9d',
  };

  it('builds the documented field set', () => {
    assert.deepEqual(buildHandoffPayload(payload), {
      protocol: HANDOFF_PROTOCOL,
      instance: ORIGIN,
      token: 'token-value',
      cookies: 'JSESSIONID=abc123; glide_user=admin',
      pairing_code: CODE,
    });
  });

  it('is immutable so a caller cannot mutate a built payload', () => {
    assert.equal(Object.isFrozen(buildHandoffPayload(payload)), true);
  });

  it('round-trips through the receiver parser', () => {
    const built = buildHandoffPayload(payload);
    assert.deepEqual(parseHandoffPayload(JSON.parse(JSON.stringify(built)), { instance: ORIGIN }), built);
  });

  it('rejects a different instance than the pending login', () => {
    const built = buildHandoffPayload(payload);
    assert.equal(code(() => parseHandoffPayload(built, { instance: 'https://dev99999.service-now.com' })), 'instance_mismatch');
  });

  it('rejects an unknown protocol instead of guessing', () => {
    assert.equal(code(() => parseHandoffPayload({ ...buildHandoffPayload(payload), protocol: 2 })), 'unsupported_protocol');
    assert.equal(code(() => parseHandoffPayload({ protocol: '1' })), 'unsupported_protocol');
  });

  it('rejects non-object input', () => {
    assert.equal(code(() => parseHandoffPayload(null)), 'invalid_payload');
    assert.equal(code(() => parseHandoffPayload('payload')), 'invalid_payload');
  });

  it('re-validates tokens and cookies on the receiving side', () => {
    const built = buildHandoffPayload(payload);
    assert.equal(code(() => parseHandoffPayload({ ...built, cookies: 'a=b\r\nInjected: 1' })), 'invalid_cookies');
    assert.equal(code(() => parseHandoffPayload({ ...built, token: '' })), 'invalid_token');
    assert.equal(code(() => parseHandoffPayload({ ...built, pairing_code: 'wrong' })), 'invalid_pairing_code');
  });

  it('does not require the pending instance to be supplied', () => {
    const built = buildHandoffPayload(payload);
    assert.equal(parseHandoffPayload(built).instance, ORIGIN);
  });
});
