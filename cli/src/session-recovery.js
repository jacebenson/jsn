// Bounded authentication-session recovery: classify the response that ended a
// request, decide whether replaying it is safe, and read just enough of a
// browser-login page to recognise it. Nothing here logs or exposes a body.
//
// Retry contract (see docs/AUTH_LIFECYCLE.md, "Runtime authentication recovery"):
//   * HTTP 401 is a definitive pre-execution rejection for any method — the
//     provider refused the credentials before dispatching the operation.
//   * A login redirect or a login page proves the same thing for reads, but it
//     is a *heuristic* for a write or a stateful processor: JSN does not replay
//     those unless the caller explicitly accepts the risk.
//   * Everything else (403, 5xx, network, abort) is never recoverable here.

export const MAX_SESSION_REPLAYS = 1;
export const LOGIN_BODY_LIMIT = 64 * 1024;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const LOGIN_PATH = /(?:^|\/)login(?:\.do)?(?:\/|$)/i;

export function isSafeMethod(method) {
  return SAFE_METHODS.has(String(method || 'GET').toUpperCase());
}

/** True when a URL (absolute or relative) points at the platform login page. */
export function isLoginURL(value) {
  if (!value) return false;
  try {
    const url = new URL(String(value), 'https://instance.invalid/');
    return LOGIN_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

/**
 * A browser login form, not just any HTML page. Both the user field and either
 * the password field or the login form action must be present, so an ordinary
 * authenticated page that mentions `user_name` is not mistaken for a login.
 */
export function isLoginPage(contentType, bodyText) {
  if (!/text\/html/i.test(String(contentType || ''))) return false;
  const head = String(bodyText || '').slice(0, LOGIN_BODY_LIMIT);
  if (!head) return false;
  const hasUserField = /(?:name|id)=["']user_name["']/i.test(head);
  const hasPasswordField = /(?:name|id)=["']user_password["']/i.test(head);
  if (hasUserField && hasPasswordField) return true;
  return /action=["'][^"']*login\.do/i.test(head);
}

/**
 * Classify a completed response as an authentication rejection.
 * Returns null for every ordinary response, including 403 and 5xx.
 */
export function classifyAuthRejection(response, { bodyText = '' } = {}) {
  if (!response) return null;
  if (response.status === 401) return { kind: 'http_401', status: 401 };
  if (REDIRECT_STATUSES.has(response.status) && isLoginURL(response.headers?.get?.('location'))) {
    return { kind: 'login_redirect', status: response.status };
  }
  if (response.redirected && isLoginURL(response.url)) {
    return { kind: 'login_redirect', status: response.status };
  }
  if (response.ok && isLoginPage(response.headers?.get?.('content-type'), bodyText)) {
    return { kind: 'login_page', status: response.status };
  }
  return null;
}

/**
 * Only 401 is a protocol-level guarantee that nothing ran. Login redirects and
 * login pages are strong evidence for reads; a write is replayed only when the
 * caller opted in explicitly (none of JSN's own write paths do).
 */
export function canReplayAfterRecovery(rejection, { method = 'GET', stateful = false, allowMutationReplay = false } = {}) {
  if (!rejection) return false;
  if (rejection.kind === 'http_401') return true;
  return (!stateful && isSafeMethod(method)) || allowMutationReplay === true;
}

/**
 * Read a bounded prefix of an HTML response so a login page can be recognised
 * without consuming the body the caller needs. Non-HTML responses cost nothing.
 */
export async function sniffLoginBody(response, limit = LOGIN_BODY_LIMIT) {
  const contentType = response?.headers?.get?.('content-type') || '';
  if (!/text\/html/i.test(contentType) || typeof response.clone !== 'function') return '';
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) return '';
  let clone;
  try { clone = response.clone(); } catch { return ''; }
  try {
    const reader = clone.body?.getReader?.();
    if (reader) {
      const chunks = [];
      let received = 0;
      while (received < limit) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        chunks.push(chunk);
        received += chunk.length;
      }
      await reader.cancel().catch(() => {});
      return Buffer.concat(chunks).subarray(0, limit).toString('utf8');
    }
    const text = await clone.text();
    return String(text || '').slice(0, limit);
  } catch {
    return '';
  }
}

/** Pathname only — query strings can carry tokens and are never echoed. */
export function safeRequestLabel(endpoint) {
  try {
    return new URL(String(endpoint), 'https://instance.invalid/').pathname || '/';
  } catch {
    return 'the requested endpoint';
  }
}
